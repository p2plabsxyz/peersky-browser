export class DownloadsPopup {
  constructor(ipc) {
    this.popup = null;
    this.isVisible = false;
    this.targetButton = null;
    this.activeDownloads = new Map();

    this.hide = this.hide.bind(this);
    this.handleClickOutside = this.handleClickOutside.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);
    this._handleWindowBlur = this._handleWindowBlur.bind(this);

    this.ipc = ipc;

    this.injectStyles();
    this.setupDownloadListeners();
  }

  setupDownloadListeners() {
    this.ipc.on("download-progress", (event, data) => {
      this.handleProgress(data);
    });
  }

  createPopup() {
    const popup = document.createElement("div");
    popup.className = "extensions-popup downloads-popup";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", "Active Downloads");
    popup.setAttribute("aria-modal", "true");

    popup.innerHTML = `
      <div class="extensions-popup-header">
        <h3>Downloads</h3>
        <div class="header-controls">
          <button class="open-full-page" type="button" aria-label="Open full downloads page" title="History">
            <div class="svg-container"></div>
          </button>
          <button class="close-button" type="button" aria-label="Close downloads popup" title="Close">
            <div class="svg-container"></div>
          </button>
        </div>
      </div>
      <div class="extensions-popup-list downloads-popup-list" role="list"></div>
    `;

    document.body.appendChild(popup);
    this.loadPopupSVGs(popup);

    return popup;
  }

  escapeHtml(text) {
    if (!text || typeof text !== "string") return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  escapeHtmlAttribute(text) {
    if (!text || typeof text !== "string") return "";
    return text
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  formatBytes(bytes) {
    if (!+bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  handleProgress(data) {
    this.activeDownloads.set(data.id, data);

    if (!this.isVisible && data.percent === 0 && data.state === "progressing") {
      const navBox = document.querySelector("nav-box");
      const dlBtn =
        navBox?.shadowRoot?.querySelector("#downloads") ||
        navBox?.querySelector("#downloads");
      if (dlBtn) this.show(dlBtn);
    }

    if (this.isVisible && this.popup) {
      this.updateSingleDownloadUI(data);
    }

    if (data.state === "completed" || data.state === "cancelled") {
      setTimeout(() => {
        this.activeDownloads.delete(data.id);
        if (this.isVisible && this.popup) {
          const itemEl = this.popup.querySelector(
            `.popup-download-item[data-id="${data.id}"]`,
          );
          if (itemEl) itemEl.remove();

          if (this.activeDownloads.size === 0) {
            const listContainer = this.popup.querySelector(
              ".downloads-popup-list",
            );
            if (listContainer)
              listContainer.innerHTML = `<div class="extensions-empty"><p>No active downloads</p></div>`;
          }
        }
      }, 1500);
    }
  }

  updateSingleDownloadUI(dl) {
    const listContainer = this.popup.querySelector(".downloads-popup-list");
    if (!listContainer) return;

    let itemEl = listContainer.querySelector(
      `.popup-download-item[data-id="${dl.id}"]`,
    );

    const isPaused = dl.isPaused || dl.state === "interrupted";
    const fillClass = isPaused ? "paused" : dl.state;
    const statusText =
      dl.state === "completed"
        ? "Completed"
        : dl.state === "cancelled"
          ? "Cancelled"
          : isPaused
            ? "Paused"
            : `${this.formatBytes(dl.received)} / ${this.formatBytes(dl.total)}`;

    if (!itemEl) {
      const emptyState = listContainer.querySelector(".extensions-empty");
      if (emptyState) emptyState.remove();

      itemEl = document.createElement("div");
      itemEl.className = "extension-item popup-download-item";
      itemEl.dataset.id = dl.id;

      itemEl.innerHTML = `
        <div class="extension-icon" role="img">
          <div class="svg-container file-svg"></div>
        </div>
        <div class="download-details" title="${this.escapeHtmlAttribute(dl.filename)}">
          <div class="extension-name">${this.escapeHtml(dl.filename)}</div>
          <div class="dl-progress-bar">
            <div class="dl-progress-fill ${fillClass}" style="width: ${dl.percent}%"></div>
          </div>
          <div class="dl-status">
            <span class="status-text">${statusText}</span>
            <div class="ctrl-buttons" style="display: flex; gap: 6px;">
              <button class="ctrl-btn toggle-pause" data-id="${dl.id}" style="background:transparent; border:none; color:inherit; cursor:pointer;">
                ${isPaused ? "▶" : "⏸"}
              </button>
              <button class="ctrl-btn cancel" data-id="${dl.id}" style="background:transparent; border:none; color:#ef4444; cursor:pointer;">✖</button>
            </div>
          </div>
        </div>
      `;
      listContainer.prepend(itemEl);

      const fileIcon = itemEl.querySelector(".file-svg");
      if (fileIcon)
        this.loadSVG(fileIcon, "peersky://static/assets/svg/download.svg");
    } else {
      itemEl.querySelector(".dl-progress-fill").style.width = `${dl.percent}%`;
      itemEl.querySelector(".dl-progress-fill").className =
        `dl-progress-fill ${fillClass}`;
      itemEl.querySelector(".status-text").textContent = statusText;
      itemEl.querySelector(".toggle-pause").textContent = isPaused ? "▶" : "⏸";

      if (dl.state === "completed" || dl.state === "cancelled") {
        itemEl.querySelector(".ctrl-buttons").style.display = "none";
      }
    }
  }

  refreshDownloadsList() {
    if (!this.popup) return;
    const listContainer = this.popup.querySelector(".downloads-popup-list");
    if (!listContainer) return;

    if (this.activeDownloads.size === 0) {
      listContainer.innerHTML = `<div class="extensions-empty"><p>No active downloads</p></div>`;
      return;
    }

    Array.from(this.activeDownloads.values()).forEach((dl) =>
      this.updateSingleDownloadUI(dl),
    );
  }

  positionPopup() {
    if (!this.popup || !this.targetButton) return;

    const buttonRect = this.targetButton.getBoundingClientRect();
    const popupRect = this.popup.getBoundingClientRect();
    let left = buttonRect.right - popupRect.width;
    let top = buttonRect.bottom + 8;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (left < 20) left = 20;
    else if (left + popupRect.width > viewportWidth - 20)
      left = viewportWidth - popupRect.width - 20;
    if (top + popupRect.height > viewportHeight - 20)
      top = buttonRect.top - popupRect.height - 8;

    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  show(targetButton) {
    if (this.isVisible) return;
    this.targetButton = targetButton;

    if (!this.popup) {
      this.popup = this.createPopup();
      this.setupEventListeners();
    }

    this.popup.classList.add("open");
    this.isVisible = true;

    requestAnimationFrame(() => this.positionPopup());
    document.addEventListener("click", this.handleClickOutside);
    document.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("blur", this._handleWindowBlur);
    this.refreshDownloadsList();
  }

  hide() {
    if (!this.isVisible) return;
    this.popup?.classList.remove("open");
    this.isVisible = false;

    document.removeEventListener("click", this.handleClickOutside);
    document.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("blur", this._handleWindowBlur);
  }

  _handleWindowBlur() {
    if (!this.isVisible) return;
    this.hide();
  }

  toggle(targetButton) {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show(targetButton);
    }
  }

  setupEventListeners() {
    if (!this.popup) return;

    this.popup.addEventListener("click", (event) => {
      const ctrlBtn = event.target.closest(".ctrl-btn");
      if (ctrlBtn) {
        event.preventDefault();
        event.stopPropagation();
        const id = ctrlBtn.dataset.id;

        if (ctrlBtn.classList.contains("toggle-pause")) {
          const dl = this.activeDownloads.get(id);
          if (dl.isPaused || dl.state === "interrupted")
            this.ipc.send("download-resume", id);
          else this.ipc.send("download-pause", id);
        }

        if (ctrlBtn.classList.contains("cancel")) {
          this.ipc.send("download-cancel", id);
        }
        return;
      }

      if (event.target.closest(".close-button")) {
        event.preventDefault();
        event.stopPropagation();
        this.hide();
      }

      if (event.target.closest(".open-full-page")) {
        event.preventDefault();
        event.stopPropagation();
        this.hide();
        const navBox = document.querySelector("nav-box");
        if (navBox) {
          navBox.dispatchEvent(
            new CustomEvent("navigate", {
              detail: { url: "peersky://downloads" },
            }),
          );
        }
      }
    });
  }

  handleClickOutside(event) {
    if (!this.popup || !this.isVisible) return;
    if (
      this.popup.contains(event.target) ||
      (this.targetButton && this.targetButton.contains(event.target))
    )
      return;
    this.hide();
  }

  handleKeyDown(event) {
    if (!this.isVisible) return;
    if (event.key === "Escape") {
      event.preventDefault();
      this.hide();
      if (this.targetButton) this.targetButton.focus();
    }
  }

  destroy() {
    this.hide();
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    this.targetButton = null;
  }

  loadPopupSVGs(popup) {
    const closeButton = popup.querySelector(".close-button .svg-container");
    if (closeButton)
      this.loadSVG(closeButton, "peersky://static/assets/svg/close.svg");
    const historyButton = popup.querySelector(".open-full-page .svg-container");
    if (historyButton)
      this.loadSVG(
        historyButton,
        "peersky://static/assets/svg/box-arrow-up-right.svg",
      );
    const fileIcons = popup.querySelectorAll(".file-svg");
    fileIcons.forEach((container) =>
      this.loadSVG(container, "peersky://static/assets/svg/download.svg"),
    );
  }

  loadSVG(container, svgPath) {
    fetch(svgPath)
      .then((response) => response.text())
      .then((svgContent) => {
        container.innerHTML = svgContent;
        const svgElement = container.querySelector("svg");
        if (svgElement) {
          if (container.closest(".header-controls")) {
            svgElement.setAttribute("width", "14");
            svgElement.setAttribute("height", "14");
          } else {
            svgElement.setAttribute("width", "16");
            svgElement.setAttribute("height", "16");
          }
          svgElement.setAttribute("fill", "currentColor");
          svgElement
            .querySelectorAll("[stroke]")
            .forEach((el) => el.setAttribute("stroke", "currentColor"));
        }
      })
      .catch((error) =>
        console.error(`Error loading SVG from ${svgPath}:`, error),
      );
  }

  injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .downloads-popup {
        position: absolute;
        width: 340px;
        background-color: var(--browser-theme-background, #18181b);
        border: 1px solid var(--browser-theme-border, #3f3f46);
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
        color: var(--browser-theme-text-color, #ffffff);
        z-index: 10000;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: system-ui, -apple-system, sans-serif;
        visibility: hidden;
        opacity: 0;
        transform: translateY(-5px);
        transition: opacity 0.2s ease, transform 0.2s ease, visibility 0.2s;
      }
      .downloads-popup.open {
        visibility: visible;
        opacity: 1;
        transform: translateY(0);
      }
      .extensions-popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--browser-theme-border, #3f3f46);
        background-color: var(--browser-theme-background-hover, rgba(255,255,255,0.02));
      }
      .extensions-popup-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
      .header-controls { display: flex; gap: 8px; }
      .header-controls button {
        background: transparent; border: none; color: inherit; cursor: pointer; opacity: 0.6;
        padding: 4px; display: flex; align-items: center; justify-content: center;
        border-radius: 4px; transition: opacity 0.15s, background-color 0.15s;
      }
      .header-controls button:hover { opacity: 1; background-color: var(--browser-theme-background-active, rgba(255,255,255,0.1)); }
      .downloads-popup-list { max-height: 380px; overflow-y: auto; padding: 8px 0; }
      .popup-download-item { display: flex; align-items: center; padding: 10px 16px; gap: 12px; }
      .popup-download-item:hover { background-color: var(--browser-theme-background-hover, rgba(255,255,255,0.05)); }
      .download-details { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
      .extension-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dl-progress-bar { height: 4px; background: var(--browser-theme-background-active, rgba(255,255,255,0.1)); border-radius: 2px; overflow: hidden; }
      .dl-progress-fill { height: 100%; background: #3b82f6; transition: width 0.15s ease; }
      .dl-progress-fill.completed { background: #10b981; }
      .dl-progress-fill.interrupted { background: #ef4444; }
      .dl-progress-fill.paused { background: #f59e0b; }
      .dl-status { font-size: 11px; opacity: 0.6; display: flex; justify-content: space-between; }
    `;
    document.head.appendChild(style);
  }
}
