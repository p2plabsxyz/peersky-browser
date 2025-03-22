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
  const style = document.createElement("style");
  const cssText = document.createTextNode(`
      :root {
      --peersky-background-color: #000000;
      --peersky-p2p-background-color: #18181b;
      --peersky-text-color: #ffffff;
      --background-nav: #27272a;
      --background-url-input: #171717;
      --background-find-menu: #323440;
      --button-color: #9ca3af;
      --button-hover-color: #e5e7eb;
      --button-active-color: #ffffff;
      --button-inactive-color: #6b7280;
      --peersky-primary-color: #06b6d4;
      --font-family-main: Arial, sans-serif;
      }
  
      html,
      body {
          margin: auto;
          height: 100%;
          width: 100%;
          font-family: var(--font-family-main);
      }
  
      body > pre,
      body > code {
          background: var(--peersky-background-color);
          color: var(--peersky-text-color);
          min-height: calc(100% - 24px);
          margin: 0px;
          padding: 12px;
      }
      `);
  style.appendChild(cssText);
  document.head.appendChild(style);

  // Get the file extension of the current document
  const extension = getFileExtension();

  // Special handling for XML files
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

    // Set the color for elements with the class 'html-tag'
    sheet.insertRule(".html-tag { color: green; }", sheet.cssRules.length);
  }
});
