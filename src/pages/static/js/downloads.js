class DownloadBox extends HTMLElement {
  constructor() {
    super();
    this.activeDownloads = new Map();
    this.attachShadow({ mode: "open" });
    this.checkApiSupport();
    this.render();
    this.loadDownloads();
    this.setupLiveTracking();
  }

  checkApiSupport() {
    if (!window.electronAPI || !window.electronAPI.downloads) {
      this.shadowRoot.innerHTML =
        "<p>Error: Downloads API is not available.</p>";
    }
  }

  setupLiveTracking() {
    if (window.electronAPI?.downloads?.onProgress) {
      window.electronAPI.downloads.onProgress((data) => {
        this.activeDownloads.set(data.id, data);

        this.updateSingleActiveDownload(data);

        if (data.state === "completed" || data.state === "cancelled") {
          setTimeout(() => {
            this.activeDownloads.delete(data.id);
            const activeContainer = this.shadowRoot.querySelector(
              ".active-downloads-section",
            );
            const itemEl = activeContainer?.querySelector(
              `.active-download-item[data-id="${data.id}"]`,
            );
            if (itemEl) itemEl.remove();

            if (this.activeDownloads.size === 0 && activeContainer) {
              activeContainer.innerHTML = "";
            }

            if (data.state === "completed") {
              this.loadDownloads();
            }
          }, 1500);
        }
      });
    }
  }

  async loadDownloads() {
    try {
      const active = await window.electronAPI.downloads.getActive();
      if (active && active.length > 0) {
        active.forEach(dl => {
          this.activeDownloads.set(dl.id, dl);
          this.updateSingleActiveDownload(dl);
        });
      }
    } catch (e) {
      console.error("Could not fetch active downloads:", e);
    }

    const downloads = await window.electronAPI.downloads.getHistory();
    this.displayDownloads(downloads);
  }

  formatBytes(bytes) {
    if (!+bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  formatTime(timestamp) {
    if (!timestamp) return "Unknown time";
    return new Date(timestamp).toLocaleString();
  }

  escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  updateSingleActiveDownload(dl) {
    const activeContainer = this.shadowRoot.querySelector(
      ".active-downloads-section",
    );
    if (!activeContainer) return;

    let itemEl = activeContainer.querySelector(
      `.active-download-item[data-id="${dl.id}"]`,
    );

    const safeName = this.escapeHtml(dl.filename);
    const isPaused = dl.isPaused || dl.state === "interrupted";
    const statusText =
      dl.state === "completed"
        ? "Done"
        : dl.state === "cancelled"
          ? "Cancelled"
          : isPaused
            ? "Paused"
            : `${this.formatBytes(dl.received)} / ${this.formatBytes(dl.total)}`;

    const fillClass = isPaused ? "paused" : dl.state;

    if (!itemEl) {
      if (activeContainer.innerHTML.trim() === "") {
        activeContainer.innerHTML = `<h3>Active Downloads</h3><div class="active-list"></div>`;
      }
      const listEl = activeContainer.querySelector(".active-list");

      itemEl = document.createElement("div");
      itemEl.className = "active-download-item";
      itemEl.dataset.id = dl.id;

      itemEl.innerHTML = `
        <div class="dl-header">
          <span class="dl-filename" title="${safeName}">${safeName}</span>
          <span class="dl-percent">${dl.percent}%</span>
        </div>
        <div class="dl-progress-bar">
          <div class="dl-progress-fill ${fillClass}" style="width: ${dl.percent}%"></div>
        </div>
        <div class="dl-footer">
          <span class="dl-status-text">${statusText}</span>
          <div class="dl-controls">
            <button class="dl-btn toggle-pause" data-id="${dl.id}">${isPaused ? "Resume" : "Pause"}</button>
            <button class="dl-btn cancel" data-id="${dl.id}">Cancel</button>
          </div>
        </div>
      `;

      itemEl.querySelector(".toggle-pause").addEventListener("click", (e) => {
        const id = e.target.dataset.id;
        const dlItem = this.activeDownloads.get(id);
        if (!dlItem) return;

        if (dlItem.isPaused || dlItem.state === "interrupted") {
          window.electronAPI.downloads.resume(id);
        } else {
          window.electronAPI.downloads.pause(id);
        }
      });

      itemEl.querySelector(".cancel").addEventListener("click", (e) => {
        window.electronAPI.downloads.cancel(e.target.dataset.id);
      });

      listEl.prepend(itemEl);
    } else {
      itemEl.querySelector(".dl-percent").textContent = `${dl.percent}%`;

      const progressFill = itemEl.querySelector(".dl-progress-fill");
      progressFill.style.width = `${dl.percent}%`;
      progressFill.className = `dl-progress-fill ${fillClass}`;

      itemEl.querySelector(".dl-status-text").textContent = statusText;

      const toggleBtn = itemEl.querySelector(".toggle-pause");
      toggleBtn.textContent = isPaused ? "Resume" : "Pause";

      if (dl.state === "completed" || dl.state === "cancelled") {
        itemEl.querySelector(".dl-controls").style.display = "none";
      }
    }
  }

  displayDownloads(downloads) {
    const listContainer = this.shadowRoot.querySelector(".downloads-list");
    listContainer.innerHTML = "";

    if (!downloads || downloads.length === 0) {
      listContainer.innerHTML =
        "<p style='text-align: center; opacity: 0.7; padding: 2rem 0;'>No downloads history found.</p>";
      return;
    }

    downloads.sort((a, b) => b.timestamp - a.timestamp);

    const escapeHtmlAttribute = (text) => {
      if (!text) return "";
      return text
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    };

    downloads.forEach((item) => {
      const downloadElement = document.createElement("div");
      downloadElement.className = "download-item";

      const safeFilename = this.escapeHtml(item.filename);
      const safePathAttr = escapeHtmlAttribute(item.savePath);

      const isMissing = item.fileExists === false;
      const infoClass = isMissing ? "download-info missing" : "download-info";
      const missingHtml = isMissing
        ? `<span class="missing-badge">Deleted or Moved</span>`
        : "";

      downloadElement.innerHTML = `
        <div class="${infoClass}" data-path="${safePathAttr}" title="${safePathAttr}">
          <svg class="file-icon" viewBox="0 0 16 16" fill="currentColor">
            <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/>
          </svg>
          <div class="text-content">
            <div class="filename">${safeFilename || "Unknown File"}</div>
            <div class="meta">
              <span>${this.formatBytes(item.size)}</span>
              <span>${this.formatTime(item.timestamp)}</span>
              ${missingHtml}
            </div>
          </div>
        </div>
        <button class="delete-btn" data-id="${item.id}" title="Remove from history">×</button>
      `;

      const infoEl = downloadElement.querySelector(".download-info");
      if (!isMissing) {
        infoEl.addEventListener("click", (event) => {
          const savePath = event.currentTarget.dataset.path;
          if (savePath) {
            const normalizedPath = savePath.replace(/\\/g, "/");
            window.electronAPI.downloads.openFileUrl(
              `file://${normalizedPath.startsWith("/") ? "" : "/"}${normalizedPath}`,
            );
          }
        });
      }

      const removeBtn = downloadElement.querySelector(".delete-btn");
      removeBtn.addEventListener("click", async (event) => {
        const idToDelete = event.target.dataset.id;
        const result = await window.electronAPI.downloads.remove(idToDelete);
        if (result && result.success) this.loadDownloads();
      });

      listContainer.appendChild(downloadElement);
    });
  }

  render() {
    const link = document.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "peersky://theme/downloads.css");

    const container = document.createElement("div");
    container.className = "downloads-container";
    container.innerHTML = `
      <h1>Downloads</h1>
      <div class="active-downloads-section"></div>
      <div class="downloads-list"></div>
    `;

    this.shadowRoot.innerHTML = "";
    this.shadowRoot.appendChild(link);
    this.shadowRoot.appendChild(container);
  }
}

customElements.define("download-box", DownloadBox);
