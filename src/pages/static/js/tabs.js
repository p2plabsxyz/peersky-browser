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

  if (!tabsData || !tabsData.tabs) {
    container.innerHTML = '<p>No tabs found.</p>';
    return;
  }

  const groups = new Map();
  if (Array.isArray(tabsData.tabGroups)) {
    tabsData.tabGroups.forEach(g => {
      groups.set(g.id, { ...g, tabs: [] });
    });
  }

  groups.set('ungrouped', { id: 'ungrouped', name: 'Ungrouped', color: '#6b7280', expanded: true, tabs: [] });

  tabsData.tabs.forEach(tab => {
    const gId = tab.groupId && groups.has(tab.groupId) ? tab.groupId : 'ungrouped';
    if (!groups.has(gId)) {
      groups.set(gId, { id: gId, name: 'Group', color: '#6b7280', expanded: true, tabs: [] });
    }
    groups.get(gId).tabs.push(tab);
  });

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
      item.innerHTML = `
        <span class="title">${tab.title || tab.url}</span>
        <div class="actions">
          <button class="activate-btn" data-id="${tab.id}">Switch</button>
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