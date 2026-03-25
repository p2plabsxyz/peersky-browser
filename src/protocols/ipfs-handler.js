import { ReadableStream } from "stream/web";
import { createLogger } from '../logger.js';
import mime from "mime-types";
import { directoryListingHtml } from "./helia/directoryListingTemplate.js";
import { createNode } from "./helia/helia.js";
import { unixfs } from "@helia/unixfs";
import { ipns } from "@helia/ipns";
import { dnsLink } from "@helia/dnslink";
import contentHash from "content-hash";
import { CID } from "multiformats/cid";
import { base32 } from "multiformats/bases/base32";
import { base36 } from "multiformats/bases/base36";
import { base58btc } from "multiformats/bases/base58";
import { peerIdFromString, peerIdFromCID } from "@libp2p/peer-id";
import { ensCache, saveEnsCache, RPC_URL, ipfsCache, saveIpfsCache } from "./config.js";
import { JsonRpcProvider } from "ethers";
import { enforceExtensionWritePolicy } from "./request-policy.js";

const log = createLogger('protocols:ipfs');

const P2P_APP_NAMES = {
  "editor": "P2P Editor",
  "p2pmd": "P2P Markdown",
  "chat": "P2P Chat",
  "ai-chat": "AI Chat",
  "wiki": "P2P Wiki",
  "drive": "P2P Drive",
  "extensions": "Extension Archiver",
};

function getAppNameFromPeerskyUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "peersky:") return null;

    const hostname = (parsed.hostname || "").toLowerCase();
    const pathSegments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.toLowerCase());

    const appKey = hostname === "p2p" ? pathSegments[0] : hostname;
    if (!appKey) return null;
    return P2P_APP_NAMES[appKey] || `Peersky App (${appKey})`;
  } catch (_) {
    return null;
  }
}

function getAppNameFromRequest(request) {
  if (request && request.url) {
    try {
      const parsed = new URL(request.url);
      const urlOrigin = parsed.searchParams.get('peerskyOrigin');
      if (urlOrigin) {
        return getAppNameFromPeerskyUrl(urlOrigin);
      }
    } catch (_) {}
  }
  return null;
}

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

export async function createHandler(ipfsOptions, session, securityOptions = {}) {
  const { isExtensionWriteAllowed } = securityOptions;
  let node, unixFileSystem, name, dnsLinkResolver;

  async function initializeIPFSNode() {
    log.info("Initializing IPFS node...");
    const startTime = Date.now();
    node = await createNode(ipfsOptions);
    log.info(`IPFS node initialized in ${Date.now() - startTime}ms`);
    unixFileSystem = unixfs(node);
    name = ipns(node);
    dnsLinkResolver = dnsLink(node);
  }

  await initializeIPFSNode();

  // Initialize Ethereum provider with configurable RPC URL
  const provider = new JsonRpcProvider(RPC_URL);

  // Function to handle file and directory uploads
  async function handleFileUpload(request) {
    try {
      const startTime = Date.now();
      const entries = [];
      const uploadedFileNames = [];

      if (request.body) {
        const contentType = request.headers.get('content-type') || '';
        log.info('Upload Content-Type:', contentType);
        
        // Check if it's FormData
        if (contentType.includes('multipart/form-data')) {
          const formData = await request.formData();
          
          for (const [fieldName, value] of formData.entries()) {
            if (value instanceof File) {
              let fileName = value.name || "index.html";
              const pathParts = fileName.split('/').filter(Boolean);
              if (pathParts.length > 1) {
                fileName = pathParts.slice(1).join('/');
              }
              
              uploadedFileNames.push(fileName);
              
              // Stream the file content instead of buffering
              log.info(`Processing file: ${fileName} (${value.size} bytes)`);
              entries.push({
                path: fileName,
                content: value.stream(),
              });
            }
          }
        } else {
          // Handle raw body (single file upload without FormData)
          // Try to extract filename from URL or use default
          const url = new URL(request.url);
          const pathParts = url.pathname.split('/').filter(Boolean);
          const rawFileName = pathParts[pathParts.length - 1] || "index.html";
          let fileName = rawFileName;
          try {
            fileName = decodeURIComponent(rawFileName);
          } catch (decodeErr) {
            log.warn(`Failed to decode upload filename "${rawFileName}": ${decodeErr.message}`);
          }
          
          uploadedFileNames.push(fileName);
          log.info(`Processing raw upload: ${fileName}`);
          
          entries.push({
            path: fileName,
            content: request.body,
          });
        }
      }
  
      if (entries.length === 0) {
        throw new Error("No files found in the upload data.");
      }
  
      // Use addAll to upload files with paths, wrapping with a directory
      const options = { wrapWithDirectory: true };
      let rootCid;
  
      for await (const result of unixFileSystem.addAll(entries, options)) {
        log.info("Added:", result.path, result.cid.toString());
        rootCid = result.cid;
      }
      log.info(`Added all files in ${Date.now() - startTime}ms`);
  
      // Pin the root CID recursively
      await node.pins.add(rootCid, { recursive: true });
      log.info(`Pinned in ${Date.now() - startTime}ms`);
  
      const fileUrl = `ipfs://${rootCid.toString()}/`;
      log.info("Files uploaded with root CID:", rootCid.toString());
      
      try {
        const cidStr = rootCid.toString();
        const appName = getAppNameFromRequest(request);
        
        // Determine upload name
        let uploadName;
        if (uploadedFileNames.length === 1) {
          uploadName = uploadedFileNames[0];
        } else if (uploadedFileNames.length > 1) {
          uploadName = `${uploadedFileNames[0]} + ${uploadedFileNames.length - 1} files`;
        } else {
          uploadName = "Upload " + new Date().toLocaleString();
        }
        
        // Add app context to name if available
        if (appName) {
          const salt = Math.random().toString(36).substring(2, 6);
          if (!uploadName || uploadName === 'index.html' || uploadName === 'untitled') {
            uploadName = `${appName}-index.html-${salt}`;
          } else {
            uploadName = `${appName}-${uploadName}-${salt}`;
          }
        }
        
        // Update or create cache entry
        const existingEntry = ipfsCache.find((entry) => entry.cid === cidStr);
        if (!existingEntry) {
          ipfsCache.push({
            cid: cidStr,
            timestamp: Date.now(),
            url: fileUrl,
            name: uploadName,
          });
          saveIpfsCache();
          log.info(`Logged upload to IPFS cache: ${cidStr}`);
        } else {
          const existingName = String(existingEntry.name || "").trim().toLowerCase();
          const isGenericExistingName =
            !existingName || existingName === "index.html" || existingName === "untitled";
          if (uploadName && existingEntry.name !== uploadName && (isGenericExistingName || (appName && !existingName.includes(appName.toLowerCase())))) {
            existingEntry.name = uploadName;
            if (!existingEntry.url) existingEntry.url = fileUrl;
            saveIpfsCache();
            log.info(`Updated IPFS cache label: ${cidStr} -> ${uploadName}`);
          }
        }
      } catch (logErr) {
        log.error("Error logging to IPFS cache:", logErr);
      }
      
      // Return response immediately after pinning
      const response = new Response(fileUrl, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          Location: fileUrl,
          "Content-Type": "text/plain",
        },
      });

      // Provide the root CID to the DHT in the background with retry.
      // On fresh startup the DHT routing table may be empty; retry after
      // a short delay to give bootstrap peers time to connect.
      (async () => {
        const maxAttempts = 3;
        const retryDelayMs = 10_000;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const peerCount = node.libp2p.getPeers().length;
          log.info(`Providing ${rootCid} (attempt ${attempt}/${maxAttempts}, peers: ${peerCount})`);
          try {
            await node.libp2p.contentRouting.provide(rootCid);
            log.info(`Provided ${rootCid} in ${Date.now() - startTime}ms`);
            break;
          } catch (err) {
            log.warn(`Provide attempt ${attempt} failed: ${err.message}`);
            if (attempt < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            } else {
              log.error(`Failed to provide ${rootCid} after ${maxAttempts} attempts`);
            }
          }
        }
      })();
  
      return response;
    } catch (e) {
      log.error("Error uploading file:", e);
      return new Response(e.stack, {
        status: 500,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" },
      });
    }
  }

  // Function to handle IPNS resolution
  async function handleIPNSResolution(ipnsName, urlParts) {
    let peerId;
    try {
      peerId = getPeerIdFromString(ipnsName);
      // Ensure the resolved PeerID has a proper toBytes() method
      if (typeof peerId.toBytes !== "function") {
        peerId.toBytes = () => peerId.multihash.bytes;
        log.info("Patched peerId to include toBytes() method.");
      }
      // Also ensure the PeerID has a 'bytes' property
      if (!peerId.bytes) {
        peerId.bytes = peerId.toBytes();
        log.info("Patched peerId to include bytes property.");
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
        log.info("Converted resolved CID to CIDv1:", resolvedCID.toString());
      }
      return [resolvedCID, ...urlParts];
    } catch (e) {
      log.info(`Failed to parse IPNS name as PeerId: ${e}`);
      // If it's not a valid PeerId, it might be a DNS-based IPNS name.
      if (ipnsName.includes(".")) {
        // DNS-based IPNS: Use @helia/dnslink (separated from @helia/ipns in Helia v6)
        log.info(
          "Attempting DNS-based IPNS resolution via @helia/dnslink..."
        );
        try {
          // dnsLinkResolver.resolve() returns an array of results
          const results = await dnsLinkResolver.resolve(ipnsName, {
            signal: AbortSignal.timeout(5000),
          });
          
          if (!results || results.length === 0) {
            throw new Error(`No DNSLink records found for ${ipnsName}`);
          }
          
          const result = results[0];
          log.info(`DNSLink resolved: namespace=${result.namespace}, answer=${JSON.stringify(result.answer?.data)}`);
          
          if (result.namespace === "ipfs" && result.cid) {
            // Direct IPFS CID result
            let cid = result.cid;
            if (cid.version !== 1) {
              cid = cid.toV1();
            }
            if (result.path) {
              const resolvedParts = result.path
                .split("/")
                .filter(Boolean)
                .map(decodeURIComponent);
              return [cid, ...resolvedParts, ...urlParts];
            } else {
              return [cid, ...urlParts];
            }
          } else if (result.namespace === "ipns" && result.peerId) {
            // IPNS result - resolve the peerId further
            log.info(`DNSLink points to IPNS peerId: ${result.peerId}`);
            const ipnsResult = await name.resolve(result.peerId, {
              signal: AbortSignal.timeout(5000),
            });
            let cid = ipnsResult.cid;
            if (cid.version !== 1) {
              cid = cid.toV1();
            }
            const allParts = [];
            if (result.path) {
              allParts.push(...result.path.split("/").filter(Boolean));
            }
            if (ipnsResult.path) {
              allParts.push(...ipnsResult.path.split("/").filter(Boolean));
            }
            allParts.push(...urlParts);
            return [cid, ...allParts];
          } else {
            const data = result.answer?.data || "";
            const match = data.match(/\/ipfs\/([^\s/]+)(.*)/);
            if (match) {
              let cid = parseCID(match[1]);
              if (cid.version !== 1) cid = cid.toV1();
              const pathParts = match[2] ? match[2].split("/").filter(Boolean) : [];
              return [cid, ...pathParts, ...urlParts];
            }
            throw new Error(`Unsupported DNSLink namespace: ${result.namespace}`);
          }
        } catch (dnsErr) {
          log.error(
            `Failed to resolve DNSLink for IPNS name "${ipnsName}": ${dnsErr}`
          );
          throw new Error(
            `Failed to resolve DNSLink for IPNS name "${ipnsName}": ${dnsErr}`
          );
        }
      } else {
        throw new Error("Invalid IPNS name: " + ipnsName);
      }
    }
  }

  const handler = async function protocolHandler(request) {
    const { url, method, headers } = request;
    if (!node) {
      log.info("IPFS node is not ready yet");
      return new Response("IPFS node is not ready yet", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Handle file uploads for ipfs:// URLs
    // Enforce extension write policy first (mirrors hyper-handler.js).
    const writeBlocked = await enforceExtensionWritePolicy({
      request,
      scheme: "ipfs",
      isExtensionWriteAllowed,
    });
    if (writeBlocked) {
      return writeBlocked;
    }

    if (
      (method === "PUT" || method === "POST") &&
      request.body &&
      url.startsWith("ipfs://")
    ) {
      log.info(`Handling file upload for URL: ${url}`);
      return handleFileUpload(request);
    }

    let ipfsPath;
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
        return new Response("Invalid URL: " + url, {
          status: 400,
          headers: responseHeaders,
        });
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
          const cachedEntry = ensCache.get(ensName);
          contentHashRaw = typeof cachedEntry === 'object' ? cachedEntry.hash : cachedEntry;
          log.info(
            `[${new Date().toISOString()}] ENS cache hit for ${ensName}`
          );
        } else {
          contentHashRaw = await resolver.getContentHash();
          if (!contentHashRaw) {
            throw new Error("No content hash set for ENS name " + ensName);
          }
          ensCache.set(ensName, {
            hash: contentHashRaw,
            timestamp: Date.now()
          });
          saveEnsCache(); // Persist the updated cache
          log.info(
            `[${new Date().toISOString()}] ENS cache miss for ${ensName}, fetched contentHash.`
          );
          log.info(
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
        log.error("Failed to resolve ENS name:", e);
        return new Response("Failed to resolve ENS name: " + e.toString(), {
          status: 500,
          headers: responseHeaders,
        });
      }
    } else if (urlObj.protocol === "ipns:") {
      let ipnsName = urlObj.hostname;
      const urlParts = urlObj.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));

      if (ipnsName.endsWith("/")) {
        ipnsName = ipnsName.slice(0, -1);
      }

      try {
        ipfsPath = await handleIPNSResolution(ipnsName, urlParts);
      } catch (e) {
        log.error("Failed to resolve IPNS name:", e);
        return new Response("Failed to resolve IPNS name: " + e.toString(), {
          status: 500,
          headers: responseHeaders,
        });
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
        log.error("Error parsing IPFS CID:", e);
        return new Response("Invalid CID in URL.", {
          status: 400,
          headers: responseHeaders,
        });
      }
    }

    if (Array.isArray(ipfsPath)) {
      log.info(
        "Constructed ipfsPath:",
        ipfsPath.map((part) => (part instanceof CID ? part.toString() : part))
      );
    } else {
      log.info("ipfsPath is not an array:", ipfsPath);
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

        let indexFirstChunk, indexIterator;
        try {
          indexIterator = unixFileSystem.cat(cid, { path: indexPath });
          const firstResult = await indexIterator.next();
          if (!firstResult.done) indexFirstChunk = firstResult.value;
        } catch (_) {}

        if (indexFirstChunk !== undefined) {
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue(indexFirstChunk);
              try {
                for await (const chunk of indexIterator) {
                  controller.enqueue(chunk);
                }
              } finally {
                controller.close();
              }
            }
          });
          return new Response(stream, {
            status: 200,
            headers: { ...responseHeaders, "Content-Type": "text/html" },
          });
        }

        const files = [];
        for await (const file of unixFileSystem.ls(cid, { path: pathString })) {
          const encoded = encodeURIComponent(file.name);
          const fileLink = pathString
            ? `ipfs://${cid.toString()}/${pathString}/${encoded}`
            : `ipfs://${cid.toString()}/${encoded}`;
          files.push(`<li><a href="${fileLink}">${file.name}</a></li>`);
        }
        const html = directoryListingHtml(cid.toString(), files.join("\n"));
        return new Response(html, {
          status: 200,
          headers: { ...responseHeaders, "Content-Type": "text/html" },
        });
      } else {
        let contentType = mime.lookup(pathString) || "application/octet-stream";
        
        if (contentType === "application/octet-stream") {
          const iterator = unixFileSystem.cat(cid, { path: pathString });
          const firstResult = await iterator.next();
          
          if (!firstResult.done && firstResult.value) {
            const snippet = new TextDecoder().decode(firstResult.value.slice(0, 512)).toLowerCase();
            if (
              snippet.includes("<html") ||
              snippet.includes("<!doctype html") ||
              snippet.includes("<head>") ||
              snippet.includes("<body>")
            ) {
              contentType = "text/html; charset=utf-8";
            }
            
            const stream = new ReadableStream({
              async start(controller) {
                controller.enqueue(firstResult.value);
                try {
                  for await (const chunk of iterator) {
                    controller.enqueue(chunk);
                  }
                } finally {
                  controller.close();
                }
              }
            });
            
            return new Response(stream, {
              status: 200,
              headers: { ...responseHeaders, "Content-Type": contentType },
            });
          }
        }
        
        // For known MIME types, stream directly without peeking
        const stream = new ReadableStream({
          async start(controller) {
            try {
              for await (const chunk of unixFileSystem.cat(cid, { path: pathString })) {
                controller.enqueue(chunk);
              }
            } finally {
              controller.close();
            }
          }
        });

        return new Response(stream, {
          status: 200,
          headers: { ...responseHeaders, "Content-Type": contentType },
        });
      }
    } catch (e) {
      log.error("Error retrieving file:", e);
      if (e.message.includes("not a file")) {
        // Attempt to serve index.html or directory listing
        const [cid, ...pathSegments] = ipfsPath;
        const pathString = pathSegments.join("/");
        const indexPathString =
          pathSegments.length > 0
            ? pathSegments.join("/") + "/index.html"
            : "index.html";

        let indexFirstChunk2, indexIterator2;
        try {
          indexIterator2 = unixFileSystem.cat(cid, { path: indexPathString });
          const firstResult = await indexIterator2.next();
          if (!firstResult.done) indexFirstChunk2 = firstResult.value;
        } catch (_) {}

        if (indexFirstChunk2 !== undefined) {
          log.info(`Serving index.html for path: ${cid.toString()}/${indexPathString}`);
          const stream = new ReadableStream({
            async start(controller) {
              controller.enqueue(indexFirstChunk2);
              try {
                for await (const chunk of indexIterator2) {
                  controller.enqueue(chunk);
                }
              } finally {
                controller.close();
              }
            }
          });
          return new Response(stream, {
            status: 200,
            headers: { ...responseHeaders, "Content-Type": "text/html" },
          });
        }

        log.info("No index.html found. Attempting directory listing.");
        const files = [];

        if (pathSegments.length > 0) {
          const parentPathSegments = pathSegments.slice(0, -1);
          const parentLink =
            parentPathSegments.length > 0
              ? `ipfs://${cid.toString()}/${parentPathSegments.join("/")}`
              : `ipfs://${cid.toString()}`;
          files.push(`<li><a href="${parentLink}">../</a></li>`);
        }

        for await (const file of unixFileSystem.ls(cid, { path: pathString })) {
          const encodedFileName = encodeURIComponent(file.name);
          const fileLink = pathString
            ? `ipfs://${cid.toString()}/${pathString}/${encodedFileName}`
            : `ipfs://${cid.toString()}/${encodedFileName}`;
          files.push(`<li><a href="${fileLink}">${file.name}</a></li>`);
        }

        const html = directoryListingHtml(cid.toString(), files.join(""));
        log.info(`Serving directory listing for path: ${ipfsPath.join("/")}`);
        return new Response(html, {
          status: 200,
          headers: { ...responseHeaders, "Content-Type": "text/html" },
        });
      } else {
        return new Response(e.stack, {
          status: 500,
          headers: responseHeaders,
        });
      }
    }
  };

  // Expose the node for integration tests (non-breaking; ignored in prod).
  handler.__node = node;

  return handler;
}
