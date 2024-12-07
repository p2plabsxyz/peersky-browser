import { Readable } from "stream";
import mime from "mime-types";
import path from "path";
import { directoryListingHtml } from "./helia/directoryListingTemplate.js";
import { createNode } from "./helia/helia.js";
import { unixfs } from "@helia/unixfs";
import { ipns } from "@helia/ipns";
import fs from "fs-extra";
import contentHash from "content-hash";
import { CID } from "multiformats/cid";
import { base32 } from "multiformats/bases/base32";
import { base36 } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import { peerIdFromString } from "@libp2p/peer-id";
import { ensCache, saveEnsCache, RPC_URL, ipfsOptions } from "./config.js";
import { JsonRpcProvider } from "ethers";

// Create a combined multibase decoder to handle base32, base36, and base58btc
const multibaseDecoder = base32.decoder
  .or(base36.decoder)
  .or(base58btc.decoder);

// Ensure CID is CIDv1
function parseCID(cidString) {
  try {
    const cid = CID.parse(cidString, multibaseDecoder);
    return cid.version === 1 ? cid : cid.toV1();
  } catch (error) {
    throw new Error(`Failed to parse CID: ${error.message}`);
  }
}

export async function createHandler(ipfsOptions, session) {
  let node, unixFileSystem, name;

  async function initializeIPFSNode() {
    console.log("Initializing IPFS node...");
    const startTime = Date.now();
    node = await createNode(ipfsOptions);
    console.log(`IPFS node initialized in ${Date.now() - startTime}ms`);
    console.log("Peer ID:", node.libp2p.peerId.toString());

    // Ensure the node's PeerId has toBytes()
    if (typeof node.libp2p.peerId.toBytes !== "function") {
      node.libp2p.peerId.toBytes = () => node.libp2p.peerId.multihash.bytes;
      console.log("Patched node peerId to include toBytes() method.");
    }

    unixFileSystem = unixfs(node);
    name = ipns(node);
  }

  await initializeIPFSNode();

  // Initialize Ethereum provider with configurable RPC URL
  const provider = new JsonRpcProvider(RPC_URL);

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
          entries.push({ path: fileName, content: blobData });
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
        headers: { "Access-Control-Allow-Origin": "*" },
        data: Readable.from(Buffer.from(e.stack)),
      });
    }
  }

  // Function to handle IPNS resolution
  async function handleIPNSResolution(ipnsName, urlParts) {
    // Try peerIdFromString first
    let peerId;
    try {
      peerId = peerIdFromString(ipnsName);
      // Ensure peerId has toBytes()
      if (typeof peerId.toBytes !== "function") {
        peerId.toBytes = () => peerId.multihash.bytes;
        console.log("Patched peerId to include toBytes() method.");
      }
      const resolutionResult = await name.resolve(peerId, {
        signal: AbortSignal.timeout(5000),
      });

      let resolvedCID = resolutionResult.cid;
      if (!(resolvedCID instanceof CID)) {
        // If cid is a string, parse it
        resolvedCID = parseCID(resolvedCID.toString());
      }
      if (resolvedCID.version !== 1) {
        resolvedCID = resolvedCID.toV1();
        console.log("Converted resolved CID to CIDv1:", resolvedCID.toString());
      }
      return [resolvedCID, ...urlParts];
    } catch (e) {
      console.log(`Failed to parse IPNS name as PeerId: ${e}`);
      // If it's not a valid PeerId, it might be a DNS-based IPNS name.
      if (ipnsName.includes(".")) {
        // DNS-based IPNS: Use resolveDNSLink
        console.log(
          "Attempting DNS-based IPNS resolution via resolveDNSLink..."
        );
        try {
          const resolutionResult = await name.resolveDNSLink(ipnsName, {
            signal: AbortSignal.timeout(5000),
          });
          // resolutionResult might contain a cid as a string
          let cid = resolutionResult.cid;
          if (typeof cid === "string") {
            cid = parseCID(cid);
          }
          if (cid.version !== 1) {
            cid = cid.toV1();
          }
          if (resolutionResult.path) {
            // If there's a path in the resolutionResult, split it
            const resolvedParts = resolutionResult.path
              .split("/")
              .filter(Boolean)
              .map(decodeURIComponent);
            return [cid, ...resolvedParts, ...urlParts];
          } else {
            return [cid, ...urlParts];
          }
        } catch (dnsErr) {
          console.error(
            `Failed to resolve DNSLink for IPNS name "${ipnsName}": ${dnsErr}`
          );
          throw new Error(
            `Failed to resolve DNSLink for IPNS name "${ipnsName}": ${dnsErr}`
          );
        }
      } else {
        // Not a PeerId and no dot => unknown format
        throw new Error("Invalid IPNS name: " + ipnsName);
      }
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

    let urlObj;
    let ensName = null;
    try {
      urlObj = new URL(url);
      if (urlObj.hostname.endsWith(".eth")) {
        ensName = urlObj.hostname;
      }
    } catch (e) {
      if (url.endsWith(".eth")) {
        ensName = url;
        try {
          urlObj = new URL("http://" + url);
        } catch (innerErr) {
          throw new Error("Invalid URL format even after prepending http://");
        }
      } else {
        statusCode = 400;
        data = Readable.from([Buffer.from("Invalid URL: " + url)]);
        sendResponse({ statusCode, headers: responseHeaders, data });
        return;
      }
    }

    if (ensName) {
      // ENS resolution with caching
      try {
        const resolver = await provider.getResolver(ensName);
        if (!resolver)
          throw new Error("No resolver found for ENS name " + ensName);

        let contentHashRaw;
        if (ensCache.has(ensName)) {
          contentHashRaw = ensCache.get(ensName);
          console.log(
            `[${new Date().toISOString()}] ENS cache hit for ${ensName}`
          );
        } else {
          contentHashRaw = await resolver.getContentHash();
          ensCache.set(ensName, contentHashRaw);
          saveEnsCache(); // Persist the updated cache
          console.log(
            `[${new Date().toISOString()}] ENS cache miss for ${ensName}, fetched contentHash.`
          );
          console.log(
            `[${new Date().toISOString()}] Current ENS cache size: ${
              ensCache.size
            }`
          );
        }

        if (!contentHashRaw) {
          throw new Error("No content hash set for ENS name " + ensName);
        }

        let cidOrName;
        let codec;
        try {
          codec = contentHash.getCodec(contentHashRaw);
          cidOrName = contentHash.decode(contentHashRaw);
        } catch (err) {
          if (contentHashRaw.startsWith("ipfs://")) {
            codec = "ipfs-ns";
            cidOrName = contentHashRaw.slice(7);
          } else if (contentHashRaw.startsWith("ipns://")) {
            codec = "ipns-ns";
            cidOrName = contentHashRaw.slice(7);
          } else {
            throw new Error(
              "Unsupported content hash format: " + contentHashRaw
            );
          }
        }

        const urlParts = urlObj.pathname
          .split("/")
          .filter(Boolean)
          .map((part) => decodeURIComponent(part));

        if (codec === "ipfs-ns") {
          const cid = parseCID(cidOrName);
          ipfsPath = [cid, ...urlParts];
        } else if (codec === "ipns-ns") {
          ipfsPath = await handleIPNSResolution(cidOrName, urlParts);
        } else {
          throw new Error("Unsupported content hash codec: " + codec);
        }
      } catch (e) {
        console.error("Error resolving ENS name:", e);
        statusCode = 500;
        data = Readable.from([
          Buffer.from("Failed to resolve ENS name: " + e.toString()),
        ]);
        sendResponse({ statusCode, headers: responseHeaders, data });
        return;
      }
    } else if (urlObj.protocol === "ipns:") {
      // IPNS URL
      let ipnsName = urlObj.hostname;
      let urlParts = urlObj.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));

      if (ipnsName.endsWith("/")) {
        ipnsName = ipnsName.slice(0, -1);
      }

      try {
        ipfsPath = await handleIPNSResolution(ipnsName, urlParts);
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
      // IPFS URL
      try {
        const cid = parseCID(urlObj.hostname);
        const pathSegments = urlObj.pathname
          .split("/")
          .filter(Boolean)
          .map((part) => decodeURIComponent(part));
        ipfsPath = [cid, ...pathSegments];
      } catch (e) {
        console.error("Error parsing IPFS CID:", e);
        statusCode = 400;
        data = Readable.from([Buffer.from("Invalid CID in URL.")]);
        sendResponse({ statusCode, headers: responseHeaders, data });
        return;
      }
    }

    // Debug log
    if (Array.isArray(ipfsPath)) {
      console.log(
        "Constructed ipfsPath:",
        ipfsPath.map((part) => (part instanceof CID ? part.toString() : part))
      );
    } else {
      console.log("ipfsPath is not an array:", ipfsPath);
    }

    try {
      const [cid, ...pathSegments] = ipfsPath;
      const pathString = pathSegments.join("/");
      const fileStream = [];

      const options = pathString ? { path: pathString } : {};
      for await (const chunk of unixFileSystem.cat(cid, options)) {
        fileStream.push(chunk);
      }

      console.log("File retrieval complete for IPFS path:", ipfsPath);

      // Determine the content type based on the file name
      const lastSegment = pathSegments[pathSegments.length - 1];
      const contentType = lastSegment
        ? mime.lookup(lastSegment) || "application/octet-stream"
        : "application/octet-stream";
      responseHeaders["Content-Type"] = contentType;

      data = Readable.from(Buffer.concat(fileStream));
    } catch (e) {
      console.error("Error retrieving file:", e);
      if (e.message.includes("not a file")) {
        // Attempt to serve index.html or directory listing
        try {
          const [cid, ...pathSegments] = ipfsPath;
          const indexPathString =
            pathSegments.length > 0
              ? pathSegments.join("/") + "/index.html"
              : "index.html";

          const indexStream = [];
          for await (const chunk of unixFileSystem.cat(cid, {
            path: indexPathString,
          })) {
            indexStream.push(chunk);
          }
          console.log(
            `Serving index.html for path: ${cid.toString()}/${indexPathString}`
          );
          responseHeaders["Content-Type"] = "text/html";
          data = Readable.from(Buffer.concat(indexStream));
        } catch (indexErr) {
          console.log("No index.html found. Attempting directory listing.");

          const files = [];
          const [cid, ...pathSegments] = ipfsPath;
          const pathString = pathSegments.join("/");

          if (pathSegments.length > 0) {
            const parentPathSegments = pathSegments.slice(0, -1);
            const parentLink =
              parentPathSegments.length > 0
                ? `ipfs://${cid.toString()}/${parentPathSegments.join("/")}`
                : `ipfs://${cid.toString()}`;
            files.push(`<li><a href="${parentLink}">../</a></li>`);
          }

          for await (const file of unixFileSystem.ls(cid, {
            path: pathString,
          })) {
            const encodedFileName = encodeURIComponent(file.name);
            const fileLink = pathString
              ? `ipfs://${cid.toString()}/${pathString}/${encodedFileName}`
              : `ipfs://${cid.toString()}/${encodedFileName}`;
            files.push(`<li><a href="${fileLink}">${file.name}</a></li>`);
          }

          const html = directoryListingHtml(pathString, files.join(""));
          console.log(
            `Serving directory listing for path: ${ipfsPath.join("/")}`
          );
          responseHeaders["Content-Type"] = "text/html";
          data = Readable.from([Buffer.from(html)]);
        }
      } else {
        // Handle other errors
        statusCode = 500;
        data = Readable.from([Buffer.from(e.stack)]);
      }
    }

    sendResponse({ statusCode, headers: responseHeaders, data });
  };
}
