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
    
    // Render Hyper
    const hyperList = document.getElementById('hyper-archive-list');
    if (hyperList) {
      if (filteredHyper.length > 0) {
        let html = '<table class="archive-table"><thead><tr><th>Name</th><th>Key</th><th>Type</th><th>Time</th><th>Action</th></tr></thead><tbody>';
        [...filteredHyper].reverse().forEach(item => {
          const time = new Date(item.timestamp).toLocaleString();
          const safeName = escapeHtml(item.name || 'Unknown');
          const safeKey = escapeHtml(item.key);
          const safeType = escapeHtml(item.type || 'drive');
          const safeTime = escapeHtml(time);
          html += `<tr>
            <td>${safeName}</td>
            <td><code>${safeKey.substring(0, 16)}...</code></td>
            <td>${safeType}</td>
            <td>${safeTime}</td>
            <td>
              <button class="btn btn-secondary btn-sm copy-btn" data-copy="${safeKey}">Copy Key</button>
              <a href="hyper://${safeKey}/" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Open</a>
            </td>
          </tr>`;
        });
        html += '</tbody></table>';
        hyperList.innerHTML = html;
      } else {
        hyperList.innerHTML = '<p class="archive-empty">No Hyperdrives found.</p>';
      }
    }
    
    // Render IPFS
    const ipfsList = document.getElementById('ipfs-archive-list');
    if (ipfsList) {
      if (filteredIpfs.length > 0) {
        let html = '<table class="archive-table"><thead><tr><th>Name</th><th>CID</th><th>Time</th><th>Action</th></tr></thead><tbody>';
        [...filteredIpfs].reverse().forEach(item => {
          const time = new Date(item.timestamp).toLocaleString();
          const safeName = escapeHtml(item.name || 'Unknown');
          const safeCid = escapeHtml(item.cid);
          const safeUrl = escapeHtml(item.url);
          const safeTime = escapeHtml(time);
          html += `<tr>
            <td>${safeName}</td>
            <td><code>${safeCid.substring(0, 16)}...</code></td>
            <td>${safeTime}</td>
            <td>
              <button class="btn btn-secondary btn-sm copy-btn" data-copy="${safeCid}">Copy CID</button>
              <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Open</a>
            </td>
          </tr>`;
        });
        html += '</tbody></table>';
        ipfsList.innerHTML = html;
      } else {
        ipfsList.innerHTML = '<p class="archive-empty">No IPFS uploads found.</p>';
      }
    }
    
    // Render ENS
    const ensList = document.getElementById('ens-archive-list');
    if (ensList) {
      if (filteredEns.length > 0) {
        let html = '<table class="archive-table"><thead><tr><th>Name</th><th>Content Hash</th><th>Action</th></tr></thead><tbody>';
        filteredEns.forEach(item => {
          const safeName = escapeHtml(item.name);
          const safeHash = escapeHtml(item.hash);
          html += `<tr>
            <td>${safeName}</td>
            <td><code>${safeHash.substring(0, 20)}...</code></td>
            <td>
              <button class="btn btn-secondary btn-sm copy-btn" data-copy="${safeHash}">Copy Hash</button>
              <a href="${safeHash}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Open</a>
            </td>
          </tr>`;
        });
        html += '</tbody></table>';
        ensList.innerHTML = html;
      } else {
        ensList.innerHTML = '<p class="archive-empty">No ENS records cached.</p>';
      }
    }
    
    // Add copy functionality
    document.querySelectorAll('.copy-btn').forEach(btn => {
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
          const originalText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = originalText, 2000);
        } catch (err) {
          console.error('Failed to copy to clipboard:', err);
          const originalText = btn.textContent;
          btn.textContent = 'Failed';
          setTimeout(() => btn.textContent = originalText, 2000);
        }
      });
    });
  } catch (err) {
    console.error('Failed to load archive data:', err);
    const hyperList = document.getElementById('hyper-archive-list');
    if (hyperList) hyperList.innerHTML = `<p class="archive-empty error">Error: ${escapeHtml(err.message)}</p>`;
    const ipfsList = document.getElementById('ipfs-archive-list');
    if (ipfsList) ipfsList.innerHTML = `<p class="archive-empty error">Error: ${escapeHtml(err.message)}</p>`;
    const ensList = document.getElementById('ens-archive-list');
    if (ensList) ensList.innerHTML = `<p class="archive-empty error">Error: ${escapeHtml(err.message)}</p>`;
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
