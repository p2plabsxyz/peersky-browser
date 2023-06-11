const { Readable } = require("stream");
const mime = require("mime-types");
const path = require("path");
const { directoryListingHtml } = require("../utils/directoryListingTemplate");

let node;
async function initializeIPFSNode() {
  const { node: nodePromise } = await import('./ipfs.mjs');
  node = await nodePromise;
  const id = await node.id();
  console.log(id);
}
initializeIPFSNode();


module.exports = async function createHandler() {
  return async function protocolHandler({ url }, sendResponse) {
    if (!node) {
      console.log("IPFS node is not ready yet");
      return;
    }
    let data = null;
    let statusCode = 200;
    let headers = {
      "Access-Control-Allow-Origin": "*",
      "Allow-CSP-From": "*",
      "Cache-Control": "no-cache",
    };

    let ipfsPath;
    if (url.startsWith("ipns://")) {
      const ipnsPath = url.replace("ipns://", "");
      ipfsPath = await node.resolve(`/ipns/${ipnsPath}`);
    } else {
      ipfsPath = url.replace("ipfs://", "");
    }
    console.log(ipfsPath);

    const chunks = [];
    let isDirectory = false;
    // File handling
    try {
      for await (const chunk of node.cat(ipfsPath)) {
        chunks.push(chunk);
      }
    } catch (e) {
      if (e.message.includes("this dag node is a directory")) {
        // Treat this as a directory
        isDirectory = true;
      } else {
        statusCode = 500;
        data = Readable.from([Buffer.from(e.stack)]);
      }
    }

    // Directory handling
    if (isDirectory) {
      const indexPath = path.join(ipfsPath, "index.html");
      chunks.length = 0; // Clear chunks array
      let foundIndex = false;

      try {
        for await (const chunk of node.cat(indexPath)) {
          chunks.push(chunk);
          foundIndex = true;
        }
        headers["Content-Type"] = "text/html";
      } catch (e) {
        console.log("Failed to read index.html:", e);
      }

      // If index.html does not exist in the directory
      if (!foundIndex) {
        const shortCID = `${ipfsPath.slice(0, 4)}...${ipfsPath.slice(-5)}`;
        let filesHtml = '<li><a href="../">../</a></li>';
        for await (const file of node.ls(ipfsPath)) {
          const fileLink = `./${file.name}${file.type === "dir" ? "/" : ""}`;
          const fileHref =
            ipfsPath === "/"
              ? `/${file.name}${file.type === "dir" ? "/" : ""}`
              : `${file.name}${file.type === "dir" ? "/" : ""}`;
          filesHtml += `<li><a href="ipfs://${ipfsPath}${fileHref}">${fileLink}</a></li>`;
        }
        const html = directoryListingHtml(shortCID, filesHtml);
        chunks.push(Buffer.from(html));
        headers["Content-Type"] = "text/html";
      }
    }
    if (headers["Content-Type"] === undefined) {
      headers["Content-Type"] = mime.lookup(ipfsPath) || "text/plain";
    }
    if (statusCode !== 500) {
      data = Readable.from(Buffer.concat(chunks));
    }

    sendResponse({
      statusCode,
      headers,
      data,
    });
  };
};
