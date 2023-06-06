const path = require("path");
const fs = require("fs");
const mime = require("mime-types");

module.exports = async function createHandler() {
  return async function protocolHandler({ url }, sendResponse) {
    const pagePath = url.split("peersky://")[1] || "home";
    const targetPage = path.join(__dirname, `../pages/${pagePath}.html`);

    if (!fs.existsSync(targetPage)) {
      sendResponse({
        statusCode: 404,
        headers: {
          "Content-Type": "text/html",
        },
        data: fs.createReadStream(path.join(__dirname, "../pages/404.html")),
      });
      return;
    }

    const statusCode = 200;
    const data = fs.createReadStream(targetPage);

    const contentType = mime.lookup(targetPage) || "text/plain";

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Allow-CSP-From": "*",
      "Cache-Control": "no-cache",
      "Content-Type": contentType,
    };

    sendResponse({
      statusCode,
      headers,
      data,
    });
  };
};
