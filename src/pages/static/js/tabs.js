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
      console.log('Raw tabs data:', data);
      
      // Don't parse JSON - data is already an object
      this.displayTabs(data);
    } catch (e) {
      console.error('Failed to load tabs', e);
      this.displayTabs(null);
    }
}

displayTabs(tabsData) {
  const container = this.shadowRoot.querySelector('.tabs-container');
  container.innerHTML = '<h1>Tabs</h1>';

  console.log('Displaying tabs:', tabsData);

  if (!tabsData) {
    container.innerHTML += '<p>No tabs found.</p>';
    return;
  }

  // The data structure is: { windowId: { activeTabId, tabCounter, tabGroups: [...], tabs: [...] } }
  const windows = Object.values(tabsData);
  
  if (windows.length === 0) {
    container.innerHTML += '<p>No windows found.</p>';
    return;
  }

  // Process each window
  windows.forEach((windowData, windowIndex) => {
    if (!windowData.tabs || !Array.isArray(windowData.tabs)) {
      return;
    }

    // Create window section
    const windowEl = document.createElement('div');
    windowEl.className = 'window-section';
    windowEl.innerHTML = `<h4>Window ${windowIndex + 1}</h4>`;

    // Create groups map for this window
    const groups = new Map();
    if (Array.isArray(windowData.tabGroups)) {
      windowData.tabGroups.forEach(group => {
        groups.set(group.id, { ...group, tabs: [] });
      });
    }

    const groupedTabs = [];

    windowData.tabs.forEach(tab => {
      if (tab.groupId && groups.has(tab.groupId)) {
        groups.get(tab.groupId).tabs.push(tab);
        groupedTabs.push(tab);
      }
    });

    // Display grouped tabs
    groups.forEach(group => {
      if (group.tabs.length === 0) return;

      const groupEl = document.createElement('div');
      groupEl.className = 'group';

      const header = document.createElement('div');
      header.className = 'group-header';
      header.style.backgroundColor = group.color || '#ccc';
      header.innerHTML = `
        <div class="group-title">${group.name || 'Unnamed group'} (${group.tabs.length} tabs)</div>
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
        
        // Check if this is the active tab
        const isActive = tab.id === windowData.activeTabId;
        if (isActive) {
          item.classList.add('active');
        }

        item.innerHTML = `
          <span class="title">${tab.title || tab.url}</span>
          <span class="url">${tab.url}</span>
          ${isActive ? '<span class="active-indicator">●</span>' : ''}
          <div class="actions">
            <button class="close-btn" data-id="${tab.id}">×</button>
          </div>`;
        tabsWrap.appendChild(item);
      });

      groupEl.appendChild(tabsWrap);
      windowEl.appendChild(groupEl);
    });

    container.appendChild(windowEl);
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