import {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  handleURL,
} from "./utils.js";
const { ipcRenderer } = require("electron");

const DEFAULT_PAGE = "peersky://home";
const webviewContainer = document.querySelector("#webview");
const nav = document.querySelector("#navbox");
const findMenu = document.querySelector("#find");
const pageTitle = document.querySelector("title");

const searchParams = new URL(window.location.href).searchParams;
const toNavigate = searchParams.has("url")
  ? searchParams.get("url")
  : DEFAULT_PAGE;

document.addEventListener("DOMContentLoaded", () => {
  if (webviewContainer && nav) {
    webviewContainer.loadURL(toNavigate);

    focusURLInput();

    // Navigation Button Event Listeners
    nav.addEventListener("back", () => webviewContainer.goBack());
    nav.addEventListener("forward", () => webviewContainer.goForward());
    nav.addEventListener("reload", () => webviewContainer.reload());
    nav.addEventListener("stop", () => webviewContainer.stop());
    nav.addEventListener("home", () => {
      webviewContainer.loadURL("peersky://home");
      nav.querySelector("#url").value = "peersky://home";
    });
    nav.addEventListener("navigate", ({ detail }) => {
      const { url } = detail;
      navigateTo(url);
    });
    nav.addEventListener("new-window", () => {
      ipcRenderer.send("new-window");
    });

    nav.addEventListener("toggle-bookmark", async () => {
      console.log("Toggle bookmark clicked");
      const urlInput = nav.querySelector("#url");
      if (!urlInput || !urlInput.value) {
        console.error("URL input is empty, cannot toggle bookmark.");
        return;
      }
      const url = urlInput.value.trim();
      
      const bookmarks = await ipcRenderer.invoke("get-bookmarks");
      console.log("Current bookmarks:", bookmarks);
      const existingBookmark = bookmarks.find((b) => b.url === url);

      if (existingBookmark) {
        console.log("Deleting existing bookmark:", url);
        ipcRenderer.invoke("delete-bookmark", { url });
      } else {
        const title = pageTitle.innerText
          .replace(" - Peersky Browser", "")
          .trim();
        let favicon = "";
        try {
          const iconLink = document.querySelector(
            'link[rel="icon"], link[rel="shortcut icon"]'
          );
          if (iconLink) {
            favicon = new URL(iconLink.href, url.origin).href;
          }

          if (!favicon) {
        
            favicon = `https://www.google.com/s2/favicons?domain=${url.hostname}`;
          }
        } catch (e) {
          console.error("Error fetching favicon:", e);
          favicon = `https://www.google.com/s2/favicons?domain=${url.hostname}`;
        }
        console.log("Adding new Bookmarks ", url);
        ipcRenderer.send("add-bookmark", { url, title, favicon });
      }
      setTimeout(() => updateBookmarkIcon(url), 100);
    });

    async function updateBookmarkIcon(currentUrl) {
      if (!currentUrl) return;
      try {
        const bookmarks = await ipcRenderer.invoke("get-bookmarks");
        const isBookmarked = bookmarks.some(
          (bookmark) => bookmark.url === currentUrl
        );
        console.log("Bookmark state for", currentUrl, "is", isBookmarked);
        nav.setBookmarkState(isBookmarked);
        console.log("Bookmark icon updated for", currentUrl); 
      } catch (error) {
        console.error("Failed to update bookmark icon:", error);
      }
    }
  
    // Handle webview loading events to toggle refresh/stop button
    if (webviewContainer.webviewElement) {
      webviewContainer.webviewElement.addEventListener(
        "did-start-loading",
        () => {
          nav.setLoading(true);
        }
      );

      webviewContainer.webviewElement.addEventListener(
        "did-stop-loading",
        () => {
          nav.setLoading(false);
          updateNavigationButtons();
        }
      );

      webviewContainer.webviewElement.addEventListener("did-fail-load", () => {
        nav.setLoading(false);
        updateNavigationButtons();
        updateBookmarkIcon(webviewContainer.getURL());
      });

      webviewContainer.webviewElement.addEventListener("did-navigate", () => {
        updateNavigationButtons();
      });
    } else {
      console.error("webviewElement not found in webviewContainer");
    }

    const urlInput = nav.querySelector("#url");
    if (urlInput) {
      urlInput.addEventListener("keypress", async (e) => {
        if (e.key === "Enter") {
          const rawURL = urlInput.value.trim();
          const url = handleURL(rawURL);
          try {
            webviewContainer.loadURL(url);
          } catch (error) {
            console.error("Error loading URL:", error);
          }
        }
      });
    } else {
      console.error("URL input not found within nav-box.");
    }

    // Update URL input and send navigation event
    webviewContainer.addEventListener("did-navigate", (e) => {
      if (urlInput) {
        urlInput.value = e.detail.url;
      }
      ipcRenderer.send("webview-did-navigate", e.detail.url);
      updateBookmarkIcon(e.detail.url);
    });

    // Update page title
    webviewContainer.addEventListener("page-title-updated", (e) => {
      pageTitle.innerText = e.detail.title
        ? `${e.detail.title} - Peersky Browser`
        : "Peersky Browser";
    });

    // Find Menu Event Listeners
    findMenu.addEventListener("next", ({ detail }) => {
      webviewContainer.executeJavaScript(
        `window.find("${detail.value}", ${detail.findNext})`
      );
    });

    findMenu.addEventListener("previous", ({ detail }) => {
      webviewContainer.executeJavaScript(
        `window.find("${detail.value}", ${detail.findNext}, true)`
      );
    });

    findMenu.addEventListener("hide", () => {
      webviewContainer.focus();
    });

    // Initial update of navigation buttons
    updateNavigationButtons();
  } else {
    console.error("webviewContainer or nav not found");
  }
});

function updateNavigationButtons() {
  if (webviewContainer && nav && webviewContainer.webviewElement) {
    const canGoBack = webviewContainer.webviewElement.canGoBack();
    const canGoForward = webviewContainer.webviewElement.canGoForward();
    nav.setNavigationButtons(canGoBack, canGoForward);
  }
}

function navigateTo(url) {
  webviewContainer.loadURL(url);
}

function focusURLInput() {
  const urlInput = nav.querySelector("#url");
  if (urlInput) {
    urlInput.focus();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    findMenu.toggle();
  }
});
