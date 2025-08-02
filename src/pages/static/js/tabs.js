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

  if (!tabsData) {
    container.innerHTML = '<p>No tabs found.</p>';
    return;
  }

  if (!tabsData.tabs) {
    const entries = Object.values(tabsData);
    if (entries.length === 0) {
      container.innerHTML = '<p>No tabs found.</p>';
      return;
    }
    tabsData = entries[0];
  }
  
  const groups = new Map();
  if (Array.isArray(tabsData.tabGroups)) {
    tabsData.tabGroups.forEach(g => {
      groups.set(g.id, { ...g, tabs: [] });
    });
  }

  tabsData.tabs.forEach(tab => {
    if (tab.groupId && groups.has(tab.groupId)) {
      groups.get(tab.groupId).tabs.push(tab);
    }
  });

  const hasGroupsWithTabs = Array.from(groups.values()).some(group => group.tabs.length > 0);
  if (!hasGroupsWithTabs) {
    container.innerHTML = '<p>No tab groups found.</p>';
    return;
  }

  groups.forEach(group => {
    if (group.tabs.length === 0) return;

    const groupEl = document.createElement('div');
    groupEl.className = 'group';

    const header = document.createElement('div');
    header.className = 'group-header';
    header.style.backgroundColor = group.color;
    header.innerHTML = `
      <div class="group-title">${group.name || 'Unnamed group'}</div>
      <div class="group-actions">
        <button data-action="add-tab" data-id="${group.id}">Add tab</button>
        <button data-action="edit" data-id="${group.id}">Edit</button>
        <button data-action="toggle" data-id="${group.id}">${group.expanded ? 'Collapse' : 'Expand'}</button>
        <button data-action="ungroup" data-id="${group.id}">Ungroup</button>
        <button data-action="close-group" data-id="${group.id}">Close</button>
      </div>`;
    groupEl.appendChild(header);

    const tabsWrap = document.createElement('div');
    tabsWrap.className = 'group-tabs';
    if (!group.expanded) tabsWrap.style.display = 'none';

    group.tabs.forEach(tab => {
      const item = document.createElement('div');
      item.className = 'tab-item';
      item.dataset.tabId = tab.id;
      item.innerHTML = `
        <span class="title">${tab.title || tab.url}</span>
        <div class="actions">
          <button class="close-btn" data-id="${tab.id}">×</button>
        </div>`;
      tabsWrap.appendChild(item);
    });

    groupEl.appendChild(tabsWrap);
    container.appendChild(groupEl);
  });

  this.attachListeners();
  this.attachGroupListeners();
}

attachListeners() {
  // Handle close button clicks
  this.shadowRoot.querySelectorAll('.close-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.target.dataset.id;
      if (window.electronAPI && window.electronAPI.closeTab) {
        window.electronAPI.closeTab(id);
      }
      setTimeout(() => this.loadTabs(), 200);
    });
  });

  // Handle tab item clicks for switching tabs
  this.shadowRoot.querySelectorAll('.tab-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('close-btn')) return;
      
      const tabId = item.dataset.tabId;
      if (window.electronAPI && window.electronAPI.activateTab) {
        window.electronAPI.activateTab(tabId);
      }
    });
  });
}

  attachGroupListeners() {
    this.shadowRoot.querySelectorAll('.group-actions button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const groupId = e.target.dataset.id;
        const action = e.target.dataset.action;
        if (window.electronAPI && window.electronAPI.groupAction) {
          window.electronAPI.groupAction(action, groupId);
        }
        setTimeout(() => this.loadTabs(), 200);
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