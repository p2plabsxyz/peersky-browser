import { Readable } from "stream";
import mime from "mime-types";
import path from "path";
import { directoryListingHtml } from "./helia/directoryListingTemplate.js";
import { createNode } from "./helia/helia.js";
import { ipfsOptions } from "./config.js";
import { unixfs } from "@helia/unixfs";
import { ipns } from "@helia/ipns";
import { concat as uint8ArrayConcat } from "uint8arrays";
import fs from "fs-extra";

let node, unixFileSystem, name; // Renamed 'fs' to 'unixFileSystem' to avoid conflict

async function initializeIPFSNode() {
  console.log("Initializing IPFS node...");
  const startTime = Date.now();
  node = await createNode(ipfsOptions);
  console.log(`IPFS node initialized in ${Date.now() - startTime}ms`);
  console.log(node.libp2p.peerId);

  unixFileSystem = unixfs(node); // Assigning Helia UnixFS instance to unixFileSystem
  name = ipns(node);
}

initializeIPFSNode();

async function * readBody (body) {
  for (const chunk of body) {
    if (chunk.bytes) {
      yield await Promise.resolve(chunk.bytes)
    } else if (chunk.blobUUID) {
      yield await session.getBlobData(chunk.blobUUID)
    } else if (chunk.file) {
      yield * Readable.from(fs.createReadStream(chunk.file))
    }
  }
}

// Function to handle file uploads
async function handleFileUpload(request, sendResponse, session) {
  try {
    // TODO: detect multipart and upload all files
    const fileStream = readBody(request.uploadData)
    const cid = await unixFileSystem.addByteStream(fileStream); // Add file to IPFS using Helia's UnixFS
    console.log("File uploaded with CID:", cid.toString());

    sendResponse({
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        Location: `ipfs://${cid.toString()}`,
        "Content-Type": "text/plain",
      },
      data: Readable.from(Buffer.from(cid.toString())), // Respond with the CID
    });
  } catch (e) {
    console.error("Error uploading file:", e);
    sendResponse({
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      data: Readable.from(Buffer.from(e.stack)),
    });
  }
}

// Exported function to create a protocol handler
export async function createHandler(session) {
  return async function protocolHandler(
    { url, method, uploadData },
    sendResponse
  ) {
    if (!node) {
      console.log("IPFS node is not ready yet");
      return;
    }

    if ((method === "PUT" || method === "POST") && uploadData) {
      return handleFileUpload({ uploadData }, sendResponse, session);
    }

    let ipfsPath;
    let data = null;
    let statusCode = 200;
    let headers = {
      "Access-Control-Allow-Origin": "*",
      "Allow-CSP-From": "*",
      "Cache-Control": "no-cache",
    };

    const urlObj = new URL(url);

    if (urlObj.protocol === "ipns:") {
      let ipnsName = urlObj.hostname;
      let urlParts = urlObj.pathname.split("/").filter(Boolean);

      // Remove trailing slash if it exists
      if (ipnsName.endsWith("/")) {
        ipnsName = ipnsName.slice(0, -1);
      }
      try {
        console.log("Resolving IPNS for:", ipnsName);
        const resolutionResult = await name.resolveDNSLink(ipnsName, {
          signal: AbortSignal.timeout(5000),
        });
        console.log("Resolution Result:", resolutionResult);
        const resolvedCID = resolutionResult.cid;

        // Convert CID to string, ensuring it's version 1
        const cidV1String = resolvedCID.toV1().toString();
        console.log("Resolved CID String:", cidV1String);

        ipfsPath = `/ipfs/${cidV1String}/${urlParts.join("/")}`;
      } catch (e) {
        console.log("Error resolving IPNS:", e);
        statusCode = 500;
        data = Readable.from([
          Buffer.from("Failed to resolve IPNS name: " + e.toString()),
        ]);
        sendResponse({ statusCode, headers, data });
        return;
      }
    } else {
      ipfsPath = url.replace("ipfs://", "");
    }

    try {
      // Try to access the specific file first
      const fileStream = [];
      console.log("Starting file retrieval for IPFS path:", ipfsPath);
      for await (const chunk of unixFileSystem.cat(ipfsPath)) {
        fileStream.push(chunk);
      }
      console.log("File retrieval complete for IPFS path:", ipfsPath);
      headers["Content-Type"] =
        mime.lookup(ipfsPath) || "application/octet-stream";
      data = Readable.from(Buffer.concat(fileStream));
    } catch (e) {
      if (e.message.includes("not a file")) {
        // If it's not a file, check if it's a directory
        try {
          const indexPath = path.join(ipfsPath, "index.html");
          const indexStream = [];
          for await (const chunk of unixFileSystem.cat(indexPath)) {
            indexStream.push(chunk);
          }
          headers["Content-Type"] = "text/html";
          data = Readable.from(Buffer.concat(indexStream));
        } catch {
          // If no index.html, list the directory
          const files = [];
          const currentPathSections = ipfsPath.split("/").filter(Boolean);

          if (currentPathSections.length > 0) {
            // Check if current directory is not root
            const parentPath =
              currentPathSections.slice(0, -1).join("/") || "/";
            const parentLink =
              currentPathSections.length > 1 ? `ipfs://${parentPath}` : null;
            if (parentLink) {
              files.push(`<li><a href="${parentLink}">../</a></li>`);
            }
          }

          for await (const file of unixFileSystem.ls(ipfsPath)) {
            const fileLink = `ipfs://${path.join(ipfsPath, file.name)}`;
            files.push(`<li><a href="${fileLink}">${file.name}</a></li>`);
          }
          const html = directoryListingHtml(ipfsPath, files.join(""));

          headers["Content-Type"] = "text/html";
          data = Readable.from([Buffer.from(html)]);
        }
      } else {
        // Handle other errors
        statusCode = 500;
        data = Readable.from([Buffer.from(e.stack)]);
      }
    }

    sendResponse({
      statusCode,
      headers,
      data,
    });
  };
}
