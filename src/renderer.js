import {
  IPFS_PREFIX,
  IPNS_PREFIX,
  HYPER_PREFIX,
  WEB3_PREFIX,
  handleURL,
} from "./utils.js";

const DEFAULT_PAGE = "peersky://home";
const webviewContainer = document.querySelector("#webview");
const nav = document.querySelector("#navbox");
const findMenu = document.querySelector("#find");
const pageTitle = document.querySelector("title");

const searchParams = new URL(window.location.href).searchParams;
const toNavigate = searchParams.has("url") ? searchParams.get("url") : DEFAULT_PAGE;

document.addEventListener("DOMContentLoaded", () => {
  if (webviewContainer && nav) {
    webviewContainer.loadURL(toNavigate);

    nav.addEventListener("back", () => webviewContainer.goBack());
    nav.addEventListener("forward", () => webviewContainer.goForward());
    nav.addEventListener("refresh", () => webviewContainer.reload());
    nav.addEventListener("home", () => {
      webviewContainer.loadURL("peersky://home");
      nav.querySelector("#url").value = "peersky://home";
    });
    nav.addEventListener("navigate", ({ detail }) => {
      const { url } = detail;
      navigateTo(url);
    });

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
    }

    webviewContainer.addEventListener("did-navigate", (e) => {
      if (urlInput) {
        urlInput.value = e.detail.url;
      }
    });

    webviewContainer.addEventListener("page-title-updated", (e) => {
      pageTitle.innerText = e.detail.title + " - Peersky Browser";
    });

    findMenu.addEventListener('next', ({ detail }) => {
      webviewContainer.executeJavaScript(`window.find("${detail.value}", ${detail.findNext})`);
    });

    findMenu.addEventListener('previous', ({ detail }) => {
      webviewContainer.executeJavaScript(`window.find("${detail.value}", ${detail.findNext}, true)`);
    });

    findMenu.addEventListener('hide', () => {
      webviewContainer.focus();
    });
  } else {
    console.error("webviewContainer or nav not found");
  }
});

function navigateTo(url) {
  webviewContainer.loadURL(url);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "f" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    findMenu.toggle();
  }
});
