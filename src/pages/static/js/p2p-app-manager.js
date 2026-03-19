import { setPinnedState, getPinnedApps, getAllApps } from "peersky://p2p/p2p-list.js";

class P2PAppManager extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.statusMessage = "";
    this.statusType = "info";
    this.iconUploadTargetId = null;
  }

  connectedCallback() {
    this.render();
    // Listen for pinned apps changes from other windows
    if (window.electronAPI?.onPinnedAppsChanged) {
      window.electronAPI.onPinnedAppsChanged(() => this.render());
    }
  }

  async render() {
    if (this._rendering) return;
    this._rendering = true;
    try {
      const p2pApps = await getAllApps();
      const style = `
        <style>
          :host {
            display: block;
          }
          h2 {
            color: var(--browser-theme-text-color, #fff);
            margin-top: 0;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 12px;
          }
          th, td {
            padding: 5px 8px;
            text-align: left;
            border-bottom: 1px solid var(--browser-theme-border, #333);
          }
          th {
            color: var(--browser-theme-text-color, #fff);
            font-weight: 600;
            font-size: 0.9rem;
            opacity: 0.7;
          }
          a {
            color: var(--browser-theme-primary-highlight, #00ffff);
            text-decoration: none;
          }
          a:hover {
            text-decoration: underline;
          }
          .pin-btn {
            background: none;
            border: 1px solid var(--browser-theme-primary-highlight, #00ffff);
            color: var(--browser-theme-primary-highlight, #00ffff);
            padding: 4px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.85rem;
            transition: background 0.2s, color 0.2s;
          }
          .pin-btn:hover {
            background: var(--browser-theme-primary-highlight, #00ffff);
            color: var(--browser-theme-background, #18181b);
          }
          .pin-btn.pinned {
            background: var(--browser-theme-primary-highlight, #00ffff);
            color: var(--browser-theme-background, #18181b);
          }
          .open-link {
            font-size: 0.9rem;
          }
          .status {
            margin: 10px 0 0;
            font-size: 0.9rem;
            opacity: 0.95;
          }
          .status.info {
            color: var(--browser-theme-text-color, #fff);
          }
          .status.error {
            color: #f87171;
          }
          .drop-zone {
            margin: 0 0 14px;
            padding: 14px 16px;
            border: 1px dashed var(--browser-theme-primary-highlight, #00ffff);
            border-radius: 8px;
            background: color-mix(in srgb, var(--browser-theme-primary-highlight, #00ffff) 8%, transparent);
            color: var(--browser-theme-text-color, #fff);
          }
          .drop-zone.dragover {
            border-style: solid;
          }
          .drop-title {
            font-weight: 600;
            margin-bottom: 6px;
          }
          .drop-help {
            opacity: 0.75;
            font-size: 0.88rem;
          }
          .url-row {
            margin-top: 10px;
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }
          .url-input {
            flex: 1 1 340px;
            min-width: 240px;
            background: var(--browser-theme-background, #111);
            color: var(--browser-theme-text-color, #fff);
            border: 1px solid var(--browser-theme-border, #333);
            border-radius: 6px;
            padding: 6px 10px;
            font-size: 0.9rem;
          }
          .url-input:focus {
            outline: none;
            border-color: var(--browser-theme-primary-highlight, #00ffff);
          }
          .icon-cell {
            width: 36px;
          }
          .icon-cell img {
            width: 20px;
            height: 20px;
            display: block;
          }
          .icon-upload-btn {
            background: transparent;
            border: 1px solid var(--browser-theme-border, #333);
            color: var(--browser-theme-text-color, #fff);
            padding: 2px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.8rem;
          }
          .icon-upload-btn:hover {
            border-color: var(--browser-theme-primary-highlight, #00ffff);
          }
          .icon-upload-btn[disabled] {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .builtin-label {
            opacity: 0.55;
            font-size: 0.8rem;
          }
        </style>
      `;

      // Get all pinned apps once
      const pinnedIds = await getPinnedApps();
      const pinnedStates = p2pApps.map(app => pinnedIds.includes(app.id));

      const sorted = p2pApps
        .map((app, i) => ({ ...app, pinned: pinnedStates[i] }))
        .sort((a, b) => a.name.localeCompare(b.name));

      let tableHtml = `
        <h2>P2P Apps</h2>
        <div class="drop-zone" id="drop-zone">
          <div class="drop-title">Drop a URL here to add a P2P app</div>
          <div class="drop-help">Three input methods: (1) paste a P2P URL, (2) drag and drop a P2P URL, (3) upload a local folder with HTML/CSS/JS files.</div>
          <div class="url-row">
            <input id="url-input" class="url-input" type="url" placeholder="Paste P2P URL (peersky://, ipfs://, ipns://, hyper://, hs://, web3://)" />
            <button class="icon-upload-btn" id="add-url-btn">Add URL</button>
          </div>
          <div style="margin-top:8px;">
            <button class="icon-upload-btn" id="folder-upload-btn">Upload Folder (HTML/CSS/JS)</button>
          </div>
        </div>
        ${this.statusMessage ? `<div class="status ${this.statusType}">${this.statusMessage}</div>` : ""}
        <input id="icon-file-input" type="file" accept=".svg,image/svg+xml" style="display:none;" />
        <input id="folder-file-input" type="file" webkitdirectory directory multiple style="display:none;" />
        <table>
          <thead>
            <tr>
              <th>Icon</th>
              <th>Pin / Unpin</th>
              <th>App Name</th>
              <th>Icon Upload</th>
              <th>Open</th>
            </tr>
          </thead>
          <tbody>
      `;

      sorted.forEach(app => {
        const btnLabel = app.pinned ? 'Unpin' : 'Pin';
        const btnClass = app.pinned ? 'pin-btn pinned' : 'pin-btn';
        tableHtml += `
          <tr>
            <td class="icon-cell"><img src="${app.iconUrl}" alt="${app.name} icon" /></td>
            <td><button class="${btnClass}" data-id="${app.id}" data-pinned="${app.pinned}">${btnLabel}</button></td>
            <td><a href="${app.url}">${app.name}</a></td>
            <td>
              ${app.source === "user"
                ? `<button class="icon-upload-btn" data-upload-id="${app.id}">Upload SVG</button>`
                : `<span class="builtin-label">Built-in</span>`
              }
            </td>
            <td><a class="open-link" href="${app.url}">Open &#x2192;</a></td>
          </tr>
        `;
      });

      tableHtml += `
          </tbody>
        </table>
      `;

      this.shadowRoot.innerHTML = style + tableHtml;

      // Attach event listeners to pin/unpin buttons
      this.shadowRoot.querySelectorAll('.pin-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const appId = e.target.getAttribute('data-id');
          const currentlyPinned = e.target.getAttribute('data-pinned') === 'true';
          await setPinnedState(appId, !currentlyPinned);
          // Re-render manually to provide immediate feedback on the originating page
          this.render();
        });
      });

      this.setupDragAndDrop();
      this.setupUrlInput();
      this.setupIconUpload();
      this.setupFolderUpload();
    } finally {
      this._rendering = false;
    }
  }

  setupDragAndDrop() {
    const dropZone = this.shadowRoot.getElementById("drop-zone");
    if (!dropZone) return;

    dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropZone.classList.add("dragover");
    });
    dropZone.addEventListener("dragleave", () => {
      dropZone.classList.remove("dragover");
    });
    dropZone.addEventListener("drop", async (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragover");
      const droppedUrl = this.extractDroppedUrl(event.dataTransfer);
      if (!droppedUrl) {
        this.setStatus("Drop a valid URL to add an app.", "error");
        return;
      }
      await this.addUrlApp(droppedUrl);
    });
  }

  setupUrlInput() {
    const input = this.shadowRoot.getElementById("url-input");
    const button = this.shadowRoot.getElementById("add-url-btn");
    if (!input || !button) return;

    const submit = async () => {
      const value = input.value.trim();
      if (!value) {
        this.setStatus("Enter a URL to add an app.", "error");
        this.render();
        return;
      }
      await this.addUrlApp(value);
      input.value = "";
    };

    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
  }

  async addUrlApp(url) {
    const addFn = window.electronAPI?.p2pApps?.addFromUrl;
    if (!addFn) {
      this.setStatus("App registry API is unavailable on this page.", "error");
      this.render();
      return;
    }
    const result = await addFn(url);
    if (!result?.success) {
      this.setStatus(result?.error || "Failed to add app.", "error");
      this.render();
      return;
    }
    this.setStatus(`Added app "${result.app?.name || url}". Upload an SVG icon next.`, "info");
    this.render();
  }

  setupIconUpload() {
    const fileInput = this.shadowRoot.getElementById("icon-file-input");
    if (!fileInput) return;

    this.shadowRoot.querySelectorAll(".icon-upload-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.iconUploadTargetId = btn.getAttribute("data-upload-id");
        fileInput.value = "";
        fileInput.click();
      });
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      const appId = this.iconUploadTargetId;
      this.iconUploadTargetId = null;
      if (!file || !appId) return;
      if (!file.name.toLowerCase().endsWith(".svg")) {
        this.setStatus("Please upload an SVG file.", "error");
        return;
      }
      const uploadFn = window.electronAPI?.p2pApps?.uploadIcon;
      if (!uploadFn) {
        this.setStatus("Icon upload API is unavailable on this page.", "error");
        return;
      }
      const buffer = await file.arrayBuffer();
      const result = await uploadFn(appId, file.name, buffer);
      if (!result?.success) {
        this.setStatus(result?.error || "Icon upload failed.", "error");
        return;
      }
      this.setStatus(`Icon updated for "${result.app?.name || appId}".`, "info");
      this.render();
    });
  }

  setupFolderUpload() {
    const triggerBtn = this.shadowRoot.getElementById("folder-upload-btn");
    const folderInput = this.shadowRoot.getElementById("folder-file-input");
    if (!triggerBtn || !folderInput) return;

    triggerBtn.addEventListener("click", () => {
      folderInput.value = "";
      folderInput.click();
    });

    folderInput.addEventListener("change", async () => {
      const files = Array.from(folderInput.files || []);
      if (!files.length) return;

      const importFn = window.electronAPI?.p2pApps?.importFolder;
      if (!importFn) {
        this.setStatus("Folder import API is unavailable on this page.", "error");
        this.render();
        return;
      }

      const folderName = this.inferFolderName(files);
      const payloadFiles = [];
      for (const file of files) {
        const relPath = file.webkitRelativePath || file.name;
        payloadFiles.push({
          path: relPath,
          data: await file.arrayBuffer()
        });
      }

      const result = await importFn(folderName, payloadFiles);
      if (!result?.success) {
        this.setStatus(result?.error || "Failed to import folder.", "error");
        this.render();
        return;
      }

      this.setStatus(`Imported folder app "${result.app?.name || folderName}". You can now pin it and upload an SVG icon.`, "info");
      this.render();
    });
  }

  extractDroppedUrl(dataTransfer) {
    if (!dataTransfer) return null;
    const uriList = dataTransfer.getData("text/uri-list");
    if (uriList) {
      const candidate = uriList.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
      if (this.isValidUrl(candidate)) return candidate;
    }
    const plain = dataTransfer.getData("text/plain");
    if (plain) {
      const candidate = plain.trim().split(/\s+/).find((token) => this.isValidUrl(token));
      if (candidate) return candidate;
    }
    return null;
  }

  isValidUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      return ["peersky:", "ipfs:", "ipns:", "hyper:", "hs:", "web3:"].includes(url.protocol);
    } catch {
      return false;
    }
  }

  setStatus(message, type = "info") {
    this.statusMessage = message;
    this.statusType = type;
  }

  inferFolderName(files) {
    const first = files[0];
    const rel = first?.webkitRelativePath || "";
    const top = rel.split("/").filter(Boolean)[0];
    return top || "Local App";
  }
}

customElements.define('p2p-app-manager', P2PAppManager);
