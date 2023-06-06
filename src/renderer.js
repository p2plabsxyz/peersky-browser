const webView = document.getElementById("webview");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const refreshButton = document.getElementById("refresh");
const homeButton = document.getElementById("home");
const urlInput = document.getElementById("url");
const $ = require("jquery");

backButton.addEventListener("click", () => webView.goBack());
forwardButton.addEventListener("click", () => webView.goForward());
refreshButton.addEventListener("click", () => webView.reload());
homeButton.addEventListener("click", () => {
  webView.loadURL("peersky://home");
  urlInput.value = "peersky://home";
});

urlInput.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    const url = urlInput.value.trim();
    if (url.startsWith("ipfs://") || url.startsWith("ipns://")) {
      $("#webview").attr("src", url);
    } else if (url.startsWith("peersky://")) {
      $("#webview").attr("src", url);
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      $("#webview").attr("src", url);
    } else {
      $("#webview").attr(
        "src",
        `https://duckduckgo.com/?q=${encodeURIComponent(url)}`
      );
    }
  }
});

webView.addEventListener("did-navigate", (e) => {
  urlInput.value = e.url;
});
