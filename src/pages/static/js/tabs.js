class TabsBox extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.render();
    this.loadTabs();

    // Listen for group property updates
    if (window.electronAPI && window.electronAPI.onGroupPropertiesUpdated) {
      window.electronAPI.onGroupPropertiesUpdated((groupId, properties) => {
        console.log('Tabs page received group update:', groupId, properties);
        // Refresh the tabs display
        setTimeout(() => this.loadTabs(), 100);
      });
    }
  }

async loadTabs() {
    try {
      if (!window.electronAPI || !window.electronAPI.getTabs) {
        throw new Error('electronAPI not available');
      }
      const data = await window.electronAPI.getTabs();      
      this.displayTabs(data);
    } catch (e) {
      console.error('Failed to load tabs', e);
      this.displayTabs(null);
    }
}

displayTabs(tabsData) {
  const container = this.shadowRoot.querySelector('.tabs-container');
  container.innerHTML = '<h1>Tab Groups</h1>';

  if (!tabsData) {
    container.innerHTML += '<p>No tabs groups found.</p>';
    return;
  }

  // The data structure is: { windowId: { activeTabId, tabCounter, tabGroups: [...], tabs: [...] } }
  const windows = Object.entries(tabsData);
  
  if (windows.length === 0) {
    container.innerHTML += '<p>No windows found.</p>';
    return;
  }

  // Collect all tab groups from all windows
  const allGroups = new Map();
  const allTabs = [];

  windows.forEach(([windowId, windowData]) => {
    if (!windowData.tabs || !Array.isArray(windowData.tabs)) {
      return;
    }

    // Collect tab groups from this window
    if (Array.isArray(windowData.tabGroups)) {
      windowData.tabGroups.forEach(group => {
        if (!allGroups.has(group.id)) {
          allGroups.set(group.id, { ...group, tabs: [] });
        }
      });
    }

    // Collect all tabs and mark them with window info
    windowData.tabs.forEach(tab => {
      const tabWithWindow = { ...tab, windowId, windowIndex: windows.findIndex(([id]) => id === windowId) + 1 };
      allTabs.push(tabWithWindow);
      
      if (tab.groupId && allGroups.has(tab.groupId)) {
        allGroups.get(tab.groupId).tabs.push(tabWithWindow);
      }
    });
  });

  // Display grouped tabs (cross-window groups)
  allGroups.forEach(group => {
    if (group.tabs.length === 0) return;

    const groupEl = document.createElement('div');
    groupEl.className = 'group';

    // Helper function to escape HTML
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    const header = document.createElement('div');
    header.className = 'group-header';
    header.style.backgroundColor = group.color || '#ccc';
    header.innerHTML = `
      <div class="group-title">${escapeHtml(group.name || 'Unnamed group')} (${group.tabs.length} tabs across ${new Set(group.tabs.map(t => t.windowId)).size} windows)</div>
      <div class="group-actions">
        <button data-action="add-tab" data-id="${escapeHtml(group.id)}">Add tab</button>
        <button data-action="edit" data-id="${escapeHtml(group.id)}">Edit</button>
        <button data-action="toggle" data-id="${escapeHtml(group.id)}">${group.expanded ? 'Collapse' : 'Expand'}</button>
        <button data-action="ungroup" data-id="${escapeHtml(group.id)}">Ungroup</button>
        <button data-action="close-group" data-id="${escapeHtml(group.id)}">Close</button>
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
        <span class="window-indicator">Window ${tab.windowIndex}</span>
        <div class="actions">
          <button class="close-btn" data-id="${tab.id}">×</button>
        </div>`;
      tabsWrap.appendChild(item);
    });

    groupEl.appendChild(tabsWrap);
    container.appendChild(groupEl);
  });

  // Show message if no tabs found
  if (container.children.length === 1) { // Only the h1 title
    container.innerHTML += '<p>No tabs found.</p>';
  }

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
    link.href = 'browser://theme/tabs.css';

    const container = document.createElement('div');
    container.className = 'tabs-container';
    container.innerHTML = '<h1>Tabs</h1>';

    this.shadowRoot.innerHTML = '';
    this.shadowRoot.appendChild(link);
    this.shadowRoot.appendChild(container);
  }
}
customElements.define('tabs-box', TabsBox);