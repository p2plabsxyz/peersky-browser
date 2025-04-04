function getFileExtension() {
  const path = window.location.pathname;
  const segments = path.split(".");
  if (segments.length > 1) {
    const extension = segments.pop().toLowerCase();
    return extension;
  }
  return "";
}

document.addEventListener("DOMContentLoaded", function () {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "peersky://static/css/base.css";
  link.type = "text/css";
  document.head.appendChild(link);

  const extension = getFileExtension();
  if (extension === "xml") {
    const sheet = document.styleSheets[0];
    sheet.insertRule(
      "body { background: #000000; color: #ffffff; }",
      sheet.cssRules.length
    );
    sheet.insertRule(
      "div.header { border-color: #ffffff; }",
      sheet.cssRules.length
    );
    sheet.insertRule(".html-tag { color: green; }", sheet.cssRules.length);
  }
});
