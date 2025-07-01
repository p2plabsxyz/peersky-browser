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
  // Listen for theme changes from main process
  ipcRenderer.on('theme-changed', (event, newTheme) => {
    console.log('Main window: Theme changed to:', newTheme);
    reloadThemeCSS();
    // Dispatch event for nav-box component
    window.dispatchEvent(new CustomEvent('theme-reload', { 
      detail: { theme: newTheme } 
    }));
  });

  if (webviewContainer && nav) {
    // Process the initial URL through handleURL to ensure proper formatting
    handleURL(toNavigate).then(processedURL => {
      webviewContainer.loadURL(processedURL);
    }).catch(error => {
      console.error('Error processing initial URL:', error);
      webviewContainer.loadURL(toNavigate);
    });

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
          handleURL(rawURL).then(url => {
            try {
              webviewContainer.loadURL(url);
            } catch (error) {
              console.error("Error loading URL:", error);
            }
          }).catch(error => {
            console.error("Error processing URL:", error);
            webviewContainer.loadURL(rawURL);
          });
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
    });

    // Update page title
    webviewContainer.addEventListener("page-title-updated", (e) => {
      pageTitle.innerText = e.detail.title ? `${e.detail.title} - Peersky Browser` : "Peersky Browser";
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
