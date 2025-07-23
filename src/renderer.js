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

document.addEventListener("DOMContentLoaded", async () => {
  // Initialize theme on page load
  try {
    const currentTheme = await ipcRenderer.invoke('settings-get', 'theme');
    if (currentTheme) {
      document.documentElement.setAttribute('data-theme', currentTheme);
      
      // Enable transitions after initial theme is loaded
      setTimeout(() => {
        const urlDisplay = document.querySelector('#url');
        if (urlDisplay) {
          urlDisplay.classList.remove('transition-disabled');
        }
      }, 50);
    }
  } catch (error) {
    console.warn('Failed to load theme on startup:', error);
    // Fallback: enable transitions even if theme loading fails
    setTimeout(() => {
      const urlDisplay = document.querySelector('#url');
      if (urlDisplay) {
        urlDisplay.classList.remove('transition-disabled');
      }
    }, 100);
  }
  
  // Listen for theme changes from main process
  ipcRenderer.on('theme-changed', (event, newTheme) => {
    console.log('Main window: Theme changed to:', newTheme);
    reloadThemeCSS();
    
    // Apply theme data attribute for unified theme system
    document.documentElement.setAttribute('data-theme', newTheme);
    
    // Dispatch event for nav-box component
    window.dispatchEvent(new CustomEvent('theme-reload', { 
      detail: { theme: newTheme } 
    }));
  });

  if (webviewContainer && nav) {
    // Process the initial URL through handleURL to ensure proper formatting
    (async () => {
      try {
        const processedURL = await handleURL(toNavigate);
        webviewContainer.loadURL(processedURL);
      } catch (error) {
        console.error('Error processing initial URL:', error);
        webviewContainer.loadURL(toNavigate);
      }
    })();

    focusURLInput();

    // Navigation Button Event Listeners
    nav.addEventListener("back", () => webviewContainer.goBack());
    nav.addEventListener("forward", () => webviewContainer.goForward());
    nav.addEventListener("reload", () => webviewContainer.reload());
    nav.addEventListener("stop", () => webviewContainer.stop());
    nav.addEventListener("home", () => {
      webviewContainer.loadURL("peersky://home");
      nav.setStyledUrl("");
    });
    nav.addEventListener("navigate", ({ detail }) => {
      const { url } = detail;
      navigateTo(url);
    });
    nav.addEventListener("new-window", () => {
      ipcRenderer.send("new-window");
    });
    nav.addEventListener("toggle-bookmark", async () => {
      const url = webviewContainer.getURL();
      if (!url || url.trim() === '') {
        console.error("No current URL available, cannot toggle bookmark.");
        return;
      }
      const bookmarks = await ipcRenderer.invoke("get-bookmarks");
      const existingBookmark = bookmarks.find((b) => b.url === url);

      if (existingBookmark) {
        ipcRenderer.invoke("delete-bookmark", { url });
      } else {
        const title = pageTitle.innerText
          .replace(" - Peersky Browser", "")
          .trim();

        const parsedUrl = new URL(url);
        const favicon = await getFavicon(parsedUrl);
        ipcRenderer.send("add-bookmark", { url, title, favicon });
      }

      setTimeout(() => updateBookmarkIcon(url), 100);

    });

    async function getFavicon(parsedUrl) {
      const defaultFavicon = "peersky://static/assets/svg/globe.svg";

      if (parsedUrl.protocol === "peersky:") {
        return 'peersky://static/assets/favicon.ico';
      }

      const iconLink = document.querySelector(
        'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
      );

      if (iconLink?.href) {
        try {
          const iconUrl = new URL(
            iconLink.getAttribute("href"),
            parsedUrl.origin
          ).href;
          console.log("Using favicon from link tag:", iconUrl);
          const response = await fetch(iconUrl);

          if (
            response.ok &&
            response.headers.get("content-type")?.startsWith("image")
          ) {
            return iconUrl;
          }
        } catch (error) {
          console.warn("Error fetching favicon from link tag:", error);
        }
      }

      try {
        const fallbackUrl = new URL("/favicon.ico", parsedUrl.origin).href;
        const response = await fetch(fallbackUrl);

        if (
          response.ok &&
          response.headers.get("content-type")?.startsWith("image")
        ) {
          return fallbackUrl;
        }
      } catch (error) {
        console.warn("Error fetching fallback favicon:", error);
      }

      return defaultFavicon;
    }

    async function updateBookmarkIcon(currentUrl) {
      if (!currentUrl) return;
      try {
        const bookmarks = await ipcRenderer.invoke("get-bookmarks");
        const isBookmarked = bookmarks.some(
          (bookmark) => bookmark.url === currentUrl
        );
        nav.setBookmarkState(isBookmarked);
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
          const rawURL = urlInput.textContent.trim();
          try {
            const processedURL = await handleURL(rawURL);
            webviewContainer.loadURL(processedURL);
          } catch (error) {
            console.error("Error processing URL:", error);
            webviewContainer.loadURL(rawURL);
          }
        }
      });
    } else {
      console.error("URL input not found within nav-box.");
    }

    // Update URL display and send navigation event
    webviewContainer.addEventListener("did-navigate", (e) => {
      if (nav) {
        // Hide peersky://home URL, show all others
        if (e.detail.url === "peersky://home") {
          nav.setStyledUrl("");
        } else {
          nav.setStyledUrl(e.detail.url);
        }
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
  if (webviewContainer && nav) {
    // Use TrackedBox's safe navigation methods that handle both webview and iframe
    const canGoBack = webviewContainer.canGoBack();
    const canGoForward = webviewContainer.canGoForward();
    nav.setNavigationButtons(canGoBack, canGoForward);
  }
}

async function navigateTo(url) {
  try {
    // Process URL through handleURL to ensure proper formatting
    const processedURL = await handleURL(url);
    webviewContainer.loadURL(processedURL);
  } catch (error) {
    console.error('Error processing URL:', error);
    webviewContainer.loadURL(url);
  }
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

function reloadThemeCSS() {
  // Reload CSS imports for theme files
  const styleElements = document.querySelectorAll('style');
  styleElements.forEach(style => {
    const text = style.textContent || style.innerText;
    if (text && text.includes('browser://theme/')) {
      const newStyle = document.createElement('style');
      newStyle.textContent = text;
      style.parentNode.replaceChild(newStyle, style);
    }
  });
  
  // Reload CSS links with cache busting
  const linkElements = document.querySelectorAll('link[href*="browser://theme/"]');
  linkElements.forEach(link => {
    const href = link.href.split('?')[0];
    link.href = `${href}?t=${Date.now()}`;
  });
  
  console.log('Main window: Theme CSS reloaded');
}
