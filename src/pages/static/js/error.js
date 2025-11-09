/**
 * Error Page Handler
 * Dynamically renders network error details from URL parameters.
 */
(function () {
  const params = new URLSearchParams(location.search);

  const errorCode = params.get("code");
  const errorName = params.get("name");
  const errorMsg = params.get("msg");
  const errorUrl = params.get("url");

  // Set document title
  document.title = `${errorName || "Error"} - Peersky`;

  const titleEl = document.getElementById("errorTitle");
  const codeEl = document.getElementById("errorCode");
  const msgEl = document.getElementById("errorMessage");
  const urlEl = document.getElementById("errorUrl");
  const retryBtn = document.getElementById("retryButton");
  const homeBtn = document.getElementById("homeButton");

  // Update DOM safely
  if (titleEl) titleEl.textContent = errorName || "Connection Error";
  if (msgEl) msgEl.textContent = errorMsg || "Unable to connect to the server.";
  if (codeEl && errorCode) codeEl.textContent = `Error Code: ${errorCode}`;
  if (urlEl && errorUrl) {
    try {
      urlEl.textContent = decodeURIComponent(errorUrl);
    } catch {
      urlEl.textContent = errorUrl;
    }
  }

  // Button actions
  retryBtn?.addEventListener("click", () => window.location.reload());
  homeBtn?.addEventListener("click", () => (window.location.href = "peersky://home"));
})();
