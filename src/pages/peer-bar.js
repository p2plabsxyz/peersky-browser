class PeerBar extends HTMLElement {
  constructor() {
    super();
    this.appsData = null;
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

  async getPinnedIds() {
    try {
      const stored = await window.electronAPI.settings.get('pinnedP2PApps');
      // null means all apps pinned (default)
      if (stored === null || stored === undefined) return this.appsData.map(a => a.id);
      return stored;
    } catch (e) {
      console.warn("Failed to read pinnedP2PApps from settings", e);
      return this.appsData.map(a => a.id);
    }
  }

  async build() {
    await this.fetchApps();
    this.innerHTML = '';
    
    const container = document.createElement('div');
    container.className = 'peerbar';

    // 1. Always visible P2P base icon
    const baseLink = document.createElement('a');
    baseLink.href = 'peersky://p2p/';
    const baseDiv = document.createElement('div');
    baseDiv.className = 'p2p-base-icon'; 
    baseDiv.title = 'P2P Apps';
    baseLink.appendChild(baseDiv);
    container.appendChild(baseLink);
    const links = [
      { href: 'peersky://p2p/ai-chat/', img: 'robot.svg', alt: 'Peersky LLM Chat' },
      { href: 'peersky://p2p/chat/', img: 'chat.svg', alt: 'Peersky Chat' },
      { href: 'peersky://p2p/editor/', img: 'file-code.svg', alt: 'Peersky Build' },
      { href: 'peersky://p2p/p2pmd/', img: 'markdown.svg', alt: 'P2P Markdown' },
      { href: 'peersky://p2p/upload/', img: 'file-upload.svg', alt: 'Peersky Upload' },
      { href: 'peersky://p2p/wiki/', img: 'wikipedia.svg', alt: 'Peersky Wiki' },
      { href: 'https://reader.distributed.press/', img: 'people.svg', alt: 'Social Reader' }
    ];

    // 2. Pinned P2P apps
    const pinnedIds = await this.getPinnedIds();
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

    // 3. Social Reader
    const socialReader = document.createElement('a');
    socialReader.href = 'https://reader.distributed.press/';
    const socialImg = document.createElement('img');
    socialImg.src = 'peersky://static/assets/svg/people.svg';
    socialImg.title = 'Social Reader';
    socialImg.alt = 'Social Reader';
    socialImg.style.animationDelay = `${(pinnedApps.length + 1) * 0.1}s`;
    socialReader.appendChild(socialImg);
    container.appendChild(socialReader);

    this.appendChild(container);
  }
}

window.customElements.define('peer-bar', PeerBar);

