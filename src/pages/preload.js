// Waits for the DOM to be fully loaded before executing the script.
document.addEventListener("DOMContentLoaded", () => {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = "peersky://static/css/index.css";
  // Append the created <link> element to the document's <head> to apply the styles.
  document.head.appendChild(link);
});
