import { Readable } from "stream";
import mime from "mime-types";
import path from "path";
import { directoryListingHtml } from "./helia/directoryListingTemplate.js";
import { createNode } from "./helia/helia.js";
import { unixfs, globSource } from "@helia/unixfs";
import { ipns } from "@helia/ipns";
import fs from "fs-extra";
import contentHash from "content-hash";
import { CID } from "multiformats/cid";
import { base32 } from "multiformats/bases/base32";
import { base36 } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import { peerIdFromString, peerIdFromCID } from "@libp2p/peer-id";
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

function getPeerIdFromString(peerIdString) {
  // If the first character is '1' or 'Q', treat it as base58btc encoded PeerId.
  if (peerIdString.charAt(0) === '1' || peerIdString.charAt(0) === 'Q') {
    return peerIdFromString(peerIdString);
  }
  // Otherwise, assume it's a CID-encoded PeerId and parse it accordingly.
  return peerIdFromCID(CID.parse(peerIdString, multibaseDecoder));
}

export async function createHandler(ipfsOptions, session) {
  let node, unixFileSystem, name;

  async function initializeIPFSNode() {
    console.log("Initializing IPFS node...");
    const startTime = Date.now();
    node = await createNode(ipfsOptions);
    console.log(`IPFS node initialized in ${Date.now() - startTime}ms`);

    // Ensure the node's PeerId has toBytes()
    if (typeof node.libp2p.peerId.toBytes !== "function") {
      node.libp2p.peerId.toBytes = () => node.libp2p.peerId.multihash.bytes;
      console.log("Patched node peerId to include toBytes() method.");
    }
    // Also ensure the PeerID has a 'bytes' property (required by IPNS)
    if (!node.libp2p.peerId.bytes) {
      node.libp2p.peerId.bytes = node.libp2p.peerId.toBytes();
      console.log("Patched node peerId to include bytes property.");
    }
    
    unixFileSystem = unixfs(node);
    name = ipns(node);
  }

  await initializeIPFSNode();

  // Initialize Ethereum provider with configurable RPC URL
  const provider = new JsonRpcProvider(RPC_URL);

  // Function to handle file and directory uploads
  async function handleFileUpload(request, sendResponse) {
    try {
      const startTime = Date.now();
      const entries = [];
      let currentFileName = null;
      
      for (const data of request.uploadData || []) {
        console.log("Upload data entry:", JSON.stringify(Object.keys(data)), "type:", data.type);
        
        if (data.type === "file" && data.file) {
          const filePath = data.file;
          const stats = await fs.stat(filePath);
          if (stats.isDirectory()) {
            // Handle directory with globSource for recursive upload
            const source = globSource(filePath, '**/*');
            for await (const entry of source) {
              entries.push({
                path: entry.path,
                content: entry.content, // Readable stream for file content
              });
            }
          } else {
            // Handle individual file
            const fileName = path.basename(filePath);
            entries.push({
              path: fileName,
              content: fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 }),
            });
          }
        } else if (data.type === "rawData" && data.bytes) {
          // This contains the FormData field name/filename metadata
          // Parse the rawData to extract the filename
          const rawDataString = Buffer.from(data.bytes).toString('utf-8');
          console.log("Raw data string:", rawDataString);
          
          // Extract filename from Content-Disposition header in the rawData
          const filenameMatch = rawDataString.match(/filename="([^"]+)"/);
          if (filenameMatch) {
            currentFileName = filenameMatch[1];
            console.log("Extracted filename from rawData:", currentFileName);
          }
        } else if (data.type === "blob" && data.blobUUID) {
          // Handle blob data from FormData - use the filename from previous rawData entry
          const blobData = await session.getBlobData(data.blobUUID);
          const fileName = currentFileName || "index.html";
          console.log("Processing blob with filename:", fileName, "blobUUID:", data.blobUUID);
          entries.push({ path: fileName, content: blobData });
          currentFileName = null; // Reset for next file
        }
      }
  
      if (entries.length === 0) {
        throw new Error("No files found in the upload data.");
      }
  
      // Use addAll to upload files with paths, wrapping with a directory
      const options = { wrapWithDirectory: true };
      let rootCid;
  
      for await (const result of unixFileSystem.addAll(entries, options)) {
        console.log("Added:", result.path, result.cid.toString());
        rootCid = result.cid;
      }
      console.log(`Added all files in ${Date.now() - startTime}ms`);
  
      // Pin the root CID recursively
      await node.pins.add(rootCid, { recursive: true });
      console.log(`Pinned in ${Date.now() - startTime}ms`);
  
      const fileUrl = `ipfs://${rootCid.toString()}/`;
  
      // Send response immediately after pinning
      sendResponse({
        statusCode: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          Location: fileUrl,
          "Content-Type": "text/plain",
        },
        data: Readable.from(Buffer.from(fileUrl)),
      });

      const peerCount = node.libp2p.getPeers().length;
      console.log(`Providing ${rootCid} with ${peerCount} peers connected`);
  
      // Provide the root CID to the DHT in the background
      node.libp2p.contentRouting.provide(rootCid).then(() => {
        console.log(`Provided ${rootCid} to DHT in ${Date.now() - startTime}ms`);
      }).catch(err => {
        console.log('Error providing to DHT (non-critical):', err.message);
      });
  
      console.log("Files uploaded with root CID:", rootCid.toString());
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
      // Use the helper function instead of directly calling peerIdFromString
      peerId = getPeerIdFromString(ipnsName);
      // Ensure the resolved PeerID has a proper toBytes() method
      if (typeof peerId.toBytes !== "function") {
        peerId.toBytes = () => peerId.multihash.bytes;
        console.log("Patched peerId to include toBytes() method.");
      }
      // Also ensure the PeerID has a 'bytes' property
      if (!peerId.bytes) {
        peerId.bytes = peerId.toBytes();
        console.log("Patched peerId to include bytes property.");
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
          if (!contentHashRaw) {
            throw new Error("No content hash set for ENS name " + ensName);
          }
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

      const stats = await unixFileSystem.stat(cid, { path: pathString });
      if (stats.type === "directory") {
        // Directory => try "index.html" or show directory listing
        const indexPath = pathString
          ? pathString.replace(/\/+$/, "") + "/index.html"
          : "index.html";

        try {
          // If index.html exists, serve it as HTML
          const indexStream = [];
          for await (const chunk of unixFileSystem.cat(cid, {
            path: indexPath,
          })) {
            indexStream.push(chunk);
          }
          responseHeaders["Content-Type"] = "text/html";
          data = Readable.from(Buffer.concat(indexStream));
        } catch (err) {
          // Otherwise, generate a directory listing
          const files = [];
          for await (const file of unixFileSystem.ls(cid, {
            path: pathString,
          })) {
            const encoded = encodeURIComponent(file.name);
            const fileLink = pathString
              ? `ipfs://${cid.toString()}/${pathString}/${encoded}`
              : `ipfs://${cid.toString()}/${encoded}`;
            files.push(`<li><a href="${fileLink}">${file.name}</a></li>`);
          }
          const html = directoryListingHtml(pathString, files.join("\n"));
          responseHeaders["Content-Type"] = "text/html";
          data = Readable.from([Buffer.from(html)]);
        }
      } else {
        // File => read and sniff MIME. If the path has no extension or "application/octet-stream",
        // check the first bytes for an <html> or <!doctype> and set Content-Type to text/html
        const fileChunks = [];
        for await (const chunk of unixFileSystem.cat(cid, {
          path: pathString,
        })) {
          fileChunks.push(chunk);
        }
        const fileBuffer = Buffer.concat(fileChunks);

        let contentType = mime.lookup(pathString) || "application/octet-stream";
        if (contentType === "application/octet-stream") {
          const snippet = fileBuffer
            .slice(0, 512)
            .toString("utf8")
            .toLowerCase();
          if (
            snippet.includes("<html") ||
            snippet.includes("<!doctype html") ||
            snippet.includes("<head>") ||
            snippet.includes("<body>")
          ) {
            contentType = "text/html; charset=utf-8";
          }
        }

        responseHeaders["Content-Type"] = contentType;
        data = Readable.from(fileBuffer);
      }
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
