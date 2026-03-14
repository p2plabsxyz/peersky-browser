class PeerBar extends HTMLElement {
  constructor() {
    super();
    this.appsData = null;
    this._building = false;
  }

  connectedCallback() {
    this.build();

    // Listen for pinned apps changes via IPC (same pattern as onShowClockChanged)
    if (window.electronAPI?.onPinnedAppsChanged) {
      window.electronAPI.onPinnedAppsChanged(() => this.build());
    }
  }

  async fetchApps() {
    if (!this.appsData) {
      try {
        const module = await import('peersky://p2p/p2p-list.js');
        this.appsData = module.default;
      } catch (e) {
        console.error("Failed to load p2p apps data", e);
        this.appsData = [];
      }
    }
  }



  async build() {
    if (this._building) return;
    this._building = true;
    try {
      await this.fetchApps();
      this.innerHTML = '';
      
      const container = document.createElement('div');
      container.className = 'peerbar';

      // 1. Always visible P2P base icon
      const baseLink = document.createElement('a');
      baseLink.href = 'peersky://p2p/';
      baseLink.setAttribute('aria-label', 'P2P Apps');
      const baseDiv = document.createElement('div');
      baseDiv.className = 'p2p-base-icon'; 
      baseDiv.title = 'P2P Apps';
      baseLink.appendChild(baseDiv);
      container.appendChild(baseLink);

      // 2. Pinned P2P apps
      const module = await import('peersky://p2p/p2p-list.js');
      const pinnedIds = await module.getPinnedApps();
      const pinnedApps = this.appsData.filter(app => pinnedIds.includes(app.id));
    
    pinnedApps.forEach((app, index) => {
      const a = document.createElement('a');
      a.href = app.url;
      const img = document.createElement('img');
      img.src = `peersky://static/assets/svg/${app.icon}`;
      img.title = app.name;
      img.alt = app.name;
      img.style.animationDelay = `${(index + 1) * 0.1}s`; 
      a.appendChild(img);
      container.appendChild(a);
    });

    this.appendChild(container);
    } finally {
      this._building = false;
    }
  }
}

window.customElements.define('peer-bar', PeerBar);

