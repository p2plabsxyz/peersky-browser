import { Readable } from "stream";
import mime from "mime-types";
import path from "path";
import { directoryListingHtml } from "./helia/directoryListingTemplate.js";
import { createNode } from "./helia/helia.js";
import { unixfs } from "@helia/unixfs";
import { ipns } from "@helia/ipns";
import fs from "fs-extra";

export async function createHandler(ipfsOptions, session) {
  let node, unixFileSystem, name;

  async function initializeIPFSNode() {
    console.log("Initializing IPFS node...");
    const startTime = Date.now();
    node = await createNode(ipfsOptions);
    console.log(`IPFS node initialized in ${Date.now() - startTime}ms`);
    console.log("Peer ID:", node.libp2p.peerId.toString());

    // Patch the peerId to include toBytes() if it doesn't exist
    if (typeof node.libp2p.peerId.toBytes !== "function") {
      node.libp2p.peerId.toBytes = () => node.libp2p.peerId.bytes;
      console.log("Patched peerId to include toBytes() method.");
    }

    unixFileSystem = unixfs(node);
    name = ipns(node);
  }

  await initializeIPFSNode();

  // Function to handle file uploads
  async function handleFileUpload(request, sendResponse) {
    try {
      const entries = [];
      for (const data of request.uploadData || []) {
        if (data.type === "file" && data.file) {
          const fileName = path.basename(data.file);
          entries.push({
            path: fileName,
            content: fs.createReadStream(data.file),
          });
        } else if (data.type === "blob" && data.blobUUID) {
          const blobData = await session.getBlobData(data.blobUUID);
          const fileName = "index.html";
          entries.push({
            path: fileName,
            content: blobData,
          });
        }
      }

      if (entries.length === 0) {
        throw new Error("No files found in the upload data.");
      }

      // Use addAll to upload files with paths
      const options = { wrapWithDirectory: true };
      let rootCid;

      for await (const result of unixFileSystem.addAll(entries, options)) {
        rootCid = result.cid;
      }

      // Return URL without appending filename
      const fileUrl = `ipfs://${rootCid.toString()}/`;

      console.log("Files uploaded with root CID:", rootCid.toString());

      sendResponse({
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          Location: fileUrl,
          "Content-Type": "text/plain",
        },
        data: Readable.from(Buffer.from(fileUrl)),
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

  return async function protocolHandler(request, sendResponse) {
    const { url, method, uploadData, headers } = request;

    if (!node) {
      console.log("IPFS node is not ready yet");
      return;
    }

    // Handle file uploads for ipfs:// URLs
    if (
      (method === "PUT" || method === "POST") &&
      uploadData &&
      url.startsWith("ipfs://")
    ) {
      console.log(`Handling file upload for URL: ${url}`);
      return handleFileUpload({ uploadData, headers }, sendResponse);
    }

    let ipfsPath;
    let data = null;
    let statusCode = 200;
    let responseHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Allow-CSP-From": "*",
      "Cache-Control": "no-cache",
    };

    const urlObj = new URL(url);

    if (urlObj.protocol === "ipns:") {
      // Handle IPNS resolution
      let ipnsName = urlObj.hostname;
      let urlParts = urlObj.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));

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
        sendResponse({ statusCode, headers: responseHeaders, data });
        return;
      }
    } else {
      // Handle IPFS URLs
      const urlObj = new URL(url);
      const cid = urlObj.hostname;
      const pathSegments = urlObj.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      ipfsPath = `${cid}/${pathSegments.join("/")}`;
    }

    try {
      // Try to access the specific file
      const fileStream = [];
      console.log("Starting file retrieval for IPFS path:", ipfsPath);
      for await (const chunk of unixFileSystem.cat(ipfsPath)) {
        fileStream.push(chunk);
      }
      console.log("File retrieval complete for IPFS path:", ipfsPath);
      responseHeaders["Content-Type"] =
        mime.lookup(path.basename(ipfsPath)) || "application/octet-stream";
      data = Readable.from(Buffer.concat(fileStream));
    } catch (e) {
      console.error("Error retrieving file:", e);
      if (e.message.includes("not a file")) {
        // Handle directory listing or index.html retrieval
        try {
          const indexPath = path.posix.join(ipfsPath, "index.html");
          const indexStream = [];
          for await (const chunk of unixFileSystem.cat(indexPath)) {
            indexStream.push(chunk);
          }
          console.log(`Serving index.html for path: ${indexPath}`);
          responseHeaders["Content-Type"] = "text/html";
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
            const encodedFileName = encodeURIComponent(file.name);
            const fileLink = `ipfs://${path.posix.join(
              ipfsPath,
              encodedFileName
            )}`;
            files.push(`<li><a href="${fileLink}">${file.name}</a></li>`);
          }
          const html = directoryListingHtml(ipfsPath, files.join(""));

          console.log(`Serving directory listing for path: ${ipfsPath}`);
          responseHeaders["Content-Type"] = "text/html";
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
      headers: responseHeaders,
      data,
    });
  };
}
