const webView = document.getElementById("webview");
const backButton = document.getElementById("back");
const forwardButton = document.getElementById("forward");
const refreshButton = document.getElementById("refresh");
const homeButton = document.getElementById("home");
const urlInput = document.getElementById("url");

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
    try {

    if (url.startsWith("ipfs://") || url.startsWith("ipns://")) {
      webView.src = url;
    } else if (url.startsWith("peersky://")) {
      webView.src = url;
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      webView.src = url;
    } else {
      webView.src = `https://duckduckgo.com/?q=${encodeURIComponent(url)}`;
    } 
  } catch (error) {
      console.error('Error loading URL:', error);
    }
  }
});

webView.addEventListener("did-navigate", (e) => {
  urlInput.value = e.url;
});

webView.addEventListener("did-fail-load", (event) => {
  console.error(`Failed to load URL: ${event.validatedURL}`, event.errorCode);
});
