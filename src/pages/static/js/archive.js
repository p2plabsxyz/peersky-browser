const COPY_ICON = '<img src="peersky://static/assets/svg/copy.svg" width="16" height="16" alt="Copy">';
const OPEN_ICON = '<img src="peersky://static/assets/svg/box-arrow-up-right.svg" width="16" height="16" alt="Open">';

// Load archive data for the Archive section
async function loadArchiveData() {
  if (!settingsAPI?.settings?.getArchiveData) return;
  try {
    const data = await settingsAPI.settings.getArchiveData();
    const filter = document.getElementById('export-time-filter')?.value || 'all';
    // Calculate cutoff timestamp
    const now = Date.now();
    const durations = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '1d': 24 * 60 * 60 * 1000, '1w': 7 * 24 * 60 * 60 * 1000 };
    const cutoff = filter === 'all' ? 0 : now - (durations[filter] || 0);
    // Filter data by time
    const filteredHyper = (data.hyper || []).filter(item => item.timestamp >= cutoff);
    const filteredIpfs = (data.ipfs || []).filter(item => item.timestamp >= cutoff);
    const filteredEns = normalizeEnsEntries(data.ens).filter(item => {
      if (!item.timestamp || filter === 'all') return true;
      return item.timestamp >= cutoff;
    });
    
    const attachCopyListeners = (container) => {
      container.querySelectorAll('.copy-btn').forEach(btn => {
        // Prevent duplicate listeners if this is called multiple times, though setup recreates the DOM
        if (btn.dataset.listenerAttached) return;
        btn.dataset.listenerAttached = 'true';
        btn.addEventListener('click', async () => {
          const text = btn.dataset.copy;
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              await navigator.clipboard.writeText(text);
            } else {
              const temp = document.createElement('textarea');
              temp.value = text;
              document.body.appendChild(temp);
              temp.select();
              document.execCommand('copy');
              document.body.removeChild(temp);
            }
            const originalHTML = btn.innerHTML;
            const w = btn.offsetWidth;
            btn.style.width = w + 'px';
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.innerHTML = originalHTML; btn.style.width = ''; }, 2000);
          } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            const originalHTML = btn.innerHTML;
            const w = btn.offsetWidth;
            btn.style.width = w + 'px';
            btn.textContent = 'Failed';
            setTimeout(() => { btn.innerHTML = originalHTML; btn.style.width = ''; }, 2000);
          }
        });
      });
    };

    // Render Hyper
    const hyperPagination = document.getElementById('hyper-pagination');
    if (hyperPagination && typeof hyperPagination.setup === 'function') {
      hyperPagination.setup({
        data: [...filteredHyper].reverse(),
        searchKeys: ['name', 'key'],
        renderWrapper: (itemsHtml) => `<table class="archive-table"><colgroup><col style="width:25%"><col style="width:30%"><col style="width:25%"><col style="width:20%"></colgroup><thead><tr><th>Name</th><th>Key</th><th>Time</th><th>Action</th></tr></thead><tbody>${itemsHtml}</tbody></table>`,
        renderItem: (item) => {
          const date = new Date(item.timestamp);
          const time = date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) + ', ' + 
                       date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          const safeName = escapeHtml(item.name || 'Unknown');
          const safeKey = escapeHtml(item.key);
          const safeTime = escapeHtml(time);
          return `<tr>
            <td>${safeName}</td>
            <td class="archive-hash">${safeKey.substring(0, 16)}...</td>
            <td>${safeTime}</td>
            <td>
              <button class="archive-action-btn copy-btn" data-copy="${safeKey}" title="Copy Key">${COPY_ICON}</button>
              <a href="hyper://${safeKey}/" target="_blank" rel="noopener noreferrer" class="archive-action-btn" title="Open">${OPEN_ICON}</a>
            </td>
          </tr>`;
        },
        emptyMessage: '<p class="archive-empty">No Hyperdrives found.</p>',
        onRendered: attachCopyListeners
      });
    }
    
    // Render IPFS
    const ipfsPagination = document.getElementById('ipfs-pagination');
    if (ipfsPagination && typeof ipfsPagination.setup === 'function') {
      ipfsPagination.setup({
        data: [...filteredIpfs].reverse(),
        searchKeys: ['name', 'cid'],
        renderWrapper: (itemsHtml) => `<table class="archive-table"><colgroup><col style="width:30%"><col style="width:25%"><col style="width:25%"><col style="width:20%"></colgroup><thead><tr><th>Name</th><th>CID</th><th>Time</th><th>Action</th></tr></thead><tbody>${itemsHtml}</tbody></table>`,
        renderItem: (item) => {
          const date = new Date(item.timestamp);
          const time = date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) + ', ' + 
                       date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          const safeName = escapeHtml(item.name || 'Unknown');
          const safeCid = escapeHtml(item.cid);
          const safeUrl = escapeHtml(item.url);
          const safeTime = escapeHtml(time);
          return `<tr>
            <td>${safeName}</td>
            <td class="archive-hash">${safeCid.substring(0, 16)}...</td>
            <td>${safeTime}</td>
            <td>
              <button class="archive-action-btn copy-btn" data-copy="${safeCid}" title="Copy CID">${COPY_ICON}</button>
              <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="archive-action-btn" title="Open">${OPEN_ICON}</a>
            </td>
          </tr>`;
        },
        emptyMessage: '<p class="archive-empty">No IPFS uploads found.</p>',
        onRendered: attachCopyListeners
      });
    }
    
    // Render ENS
    const ensPagination = document.getElementById('ens-pagination');
    if (ensPagination && typeof ensPagination.setup === 'function') {
      ensPagination.setup({
        data: filteredEns,
        searchKeys: ['name', 'hash'],
        renderWrapper: (itemsHtml) => `<table class="archive-table"><colgroup><col style="width:35%"><col style="width:40%"><col style="width:25%"></colgroup><thead><tr><th>Name</th><th>Content Hash</th><th>Action</th></tr></thead><tbody>${itemsHtml}</tbody></table>`,
        renderItem: (item) => {
          const rawHash = item.hash || '';
          const safeName = escapeHtml(item.name);
          const safeHash = escapeHtml(rawHash);
          const openLinkHtml = isSupportedEnsOpenTarget(rawHash)
            ? `<a href="${safeHash}" target="_blank" rel="noopener noreferrer" class="archive-action-btn" title="Open">${OPEN_ICON}</a>`
            : '';
          return `<tr>
            <td>${safeName}</td>
            <td class="archive-hash">${safeHash.substring(0, 20)}...</td>
            <td>
              <button class="archive-action-btn copy-btn" data-copy="${safeHash}" title="Copy Hash">${COPY_ICON}</button>
              ${openLinkHtml}
            </td>
          </tr>`;
        },
        emptyMessage: '<p class="archive-empty">No ENS records cached.</p>',
        onRendered: attachCopyListeners
      });
    }
    
  } catch (err) {
    console.error('Failed to load archive data:', err);
    // On error, create simple elements or find existing generic wrappers
    ['hyper', 'ipfs', 'ens'].forEach(prefix => {
      const el = document.getElementById(`${prefix}-pagination`);
      if (el) {
        if (typeof el.setup === 'function') {
          el.setup({ emptyMessage: `<p class="archive-empty error">Error: ${escapeHtml(err.message)}</p>` });
        } else {
          el.innerHTML = `<p class="archive-empty error">Error: ${escapeHtml(err.message)}</p>`;
        }
      }
    });
  }
}

// Export archive data as JSON with time filtering
async function exportArchiveData() {
  if (!settingsAPI?.settings?.getArchiveData) return;
  try {
    const data = await settingsAPI.settings.getArchiveData();
    const filter = document.getElementById('export-time-filter')?.value || 'all';
    // Calculate cutoff timestamp
    const now = Date.now();
    const durations = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '1d': 24 * 60 * 60 * 1000, '1w': 7 * 24 * 60 * 60 * 1000 };
    const cutoff = filter === 'all' ? 0 : now - (durations[filter] || 0);
    const filteredEns = normalizeEnsEntries(data.ens).filter(item => !item.timestamp || item.timestamp >= cutoff);
    // Filter each category by timestamp
    const filtered = {
      hyperdrives: (data.hyper || []).filter(item => item.timestamp >= cutoff).map(item => ({
        name: item.name,
        key: item.key,
        type: item.type || 'drive',
        timestamp: new Date(item.timestamp).toISOString()
      })),
      ipfs: (data.ipfs || []).filter(item => item.timestamp >= cutoff).map(item => ({
        name: item.name,
        cid: item.cid,
        url: item.url,
        timestamp: new Date(item.timestamp).toISOString()
      })),
      ens: filteredEns.map(item => ({
        name: item.name,
        contentHash: item.hash,
        ...(item.timestamp ? { timestamp: new Date(item.timestamp).toISOString() } : {})
      }))
    };
    const totalEntries = filtered.hyperdrives.length + filtered.ipfs.length + filtered.ens.length;
    if (totalEntries === 0) {
      showSettingsSavedMessage('No data found for the selected time range', 'error');
      return;
    }
    const jsonContent = JSON.stringify(filtered, null, 2);
    if (settingsAPI?.settings?.exportArchive) {
      // Use IPC to show native save dialog
      const result = await settingsAPI.settings.exportArchive(jsonContent);
      if (result && !result.canceled) {
        showSettingsSavedMessage(`Exported ${totalEntries} entries to ${result.filePath}`);
      }
    } else {
      // Fallback: browser download
      const blob = new Blob([jsonContent], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `peersky-archive-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showSettingsSavedMessage(`Exported ${totalEntries} entries`);
    }
  } catch (err) {
    console.error('Failed to export archive data:', err);
    showSettingsSavedMessage('Export failed: ' + err.message, 'error');
  }
}

function normalizeEnsEntries(rawEns) {
  if (!Array.isArray(rawEns)) return [];
  const normalized = [];

  for (const entry of rawEns) {
    // Tuple format: [name, hash, timestamp?]
    if (Array.isArray(entry)) {
      const [name, second, third] = entry;
      if (typeof second === 'object' && second !== null) {
        // Legacy map value object: [name, { hash|contentHash, timestamp }]
        const hash = second.hash ?? second.contentHash;
        const ts = second.timestamp ?? third ?? null;
        if (name && hash) normalized.push({ name, hash, timestamp: ts });
      } else if (name && second) {
        normalized.push({ name, hash: second, timestamp: third ?? null });
      }
      continue;
    }

    // Object format: { name, hash|contentHash, timestamp? }
    if (entry && typeof entry === 'object') {
      const name = entry.name;
      const hash = entry.hash ?? entry.contentHash;
      const ts = entry.timestamp ?? null;
      if (name && hash) normalized.push({ name, hash, timestamp: ts });
    }
  }

  return normalized;
}

function isSupportedEnsOpenTarget(value) {
  if (typeof value !== 'string') return false;

  return (
    value.startsWith('ipfs://') ||
    value.startsWith('ipns://') ||
    value.startsWith('IPFS://') ||
    value.startsWith('IPNS://')
  );
}
