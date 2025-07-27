class TabsBox extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.render();
      this.loadTabs();
    }
  
    async loadTabs() {
      try {
        if (!window.electronAPI || !window.electronAPI.getTabs) {
          throw new Error('electronAPI not available');
        }
        const data = await window.electronAPI.getTabs();
        const parsed = data ? JSON.parse(data) : null;
        this.displayTabs(parsed);
      } catch (e) {
        console.error('Failed to load tabs', e);
        this.displayTabs(null);
      }
    }
  
    displayTabs(tabsData) {
      const container = this.shadowRoot.querySelector('.tabs-container');
      container.innerHTML = '';
  
      if (!tabsData || !tabsData.tabs || tabsData.tabs.length === 0) {
        container.innerHTML = '<p>No tabs found.</p>';
        return;
      }
  
      tabsData.tabs.forEach(tab => {
        const item = document.createElement('div');
        item.className = 'tab-item';
        item.innerHTML = `
          <span class="title">${tab.title || tab.url}</span>
          <div class="actions">
            <button class="activate-btn" data-id="${tab.id}">Switch</button>
            <button class="close-btn" data-id="${tab.id}">×</button>
          </div>
        `;
        container.appendChild(item);
      });
  
      this.attachListeners();
    }
  
    attachListeners() {
      this.shadowRoot.querySelectorAll('.close-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.target.dataset.id;
          if (window.electronAPI && window.electronAPI.closeTab) {
            window.electronAPI.closeTab(id);
          }
          setTimeout(() => this.loadTabs(), 200);
        });
      });
  
      this.shadowRoot.querySelectorAll('.activate-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = e.target.dataset.id;
          if (window.electronAPI && window.electronAPI.activateTab) {
            window.electronAPI.activateTab(id);
          }
        });
      });
    }
  
    render() {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'peersky://theme/tabs.css';
  
      const container = document.createElement('div');
      container.className = 'tabs-container';
      container.innerHTML = '<h1>Tabs</h1>';
  
      this.shadowRoot.innerHTML = '';
      this.shadowRoot.appendChild(link);
      this.shadowRoot.appendChild(container);
    }
  }
  
  customElements.define('tabs-box', TabsBox);