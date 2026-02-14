function escapeForHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function extractDisplayName(magnetUrl) {
  const match = magnetUrl.match(/[?&]dn=([^&]+)/);
  return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
}

export function generateTorrentUI(magnetUrl, torrentId, protocol, displayName, theme = "dark") {
  const name = displayName || extractDisplayName(magnetUrl) || torrentId || "Unknown Torrent";
  const safeInfoHash = escapeForHtml(torrentId);
  const safeName = escapeForHtml(name);
  const safeMagnetUrl = escapeForHtml(magnetUrl);

  // All API calls use bt:// which is a standard URL scheme
  const apiBase = "bt://api";

  return `<!DOCTYPE html>
<html lang="en" data-theme="${escapeForHtml(theme)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="peersky://static/assets/favicon.ico" />
  <title>${safeName} - BitTorrent</title>
  <link rel="stylesheet" href="browser://theme/vars.css">
  <link rel="stylesheet" href="browser://theme/themes.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--browser-theme-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif);
      background: var(--browser-theme-background, #18181b);
      color: var(--browser-theme-text-color, #ffffff);
      padding: 20px; line-height: 1.6;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-size: 1.8rem; margin-bottom: 10px;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      color: var(--browser-theme-text-color, #ffffff);
    }
    .logo { width: 36px; height: 36px; vertical-align: middle; }
    .protocol-badge {
      background: var(--browser-theme-primary-highlight, #3b82f6);
      color: var(--browser-theme-background, #18181b);
      padding: 4px 12px; border-radius: 4px;
      font-size: 0.75rem; text-transform: uppercase; font-weight: 600;
    }
    .torrent-name {
      color: var(--browser-theme-primary-highlight, #3b82f6);
      font-size: 1.6rem; margin: 15px 0;
    }
    .info-section {
      background: var(--peersky-nav-background, #27272a);
      padding: 20px; border-radius: 8px; margin: 20px 0;
    }
    .info-section strong { color: var(--browser-theme-text-color, #ffffff); }
    .info-section code {
      color: var(--browser-theme-primary-highlight, #3b82f6);
      background: var(--browser-theme-background, #18181b);
      padding: 2px 6px; border-radius: 3px;
    }
    .magnet-link {
      background: var(--browser-theme-background, #18181b);
      padding: 12px; border-radius: 4px; word-break: break-all;
      font-family: monospace; font-size: 0.85rem; margin: 10px 0;
      max-height: 80px; overflow-y: auto;
      color: var(--settings-text-secondary, #9ca3af);
      border: 1px solid var(--settings-border, #6b7280);
    }
    .button-group { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; }
    button {
      background: var(--browser-theme-primary-highlight, #3b82f6);
      color: var(--browser-theme-background, #18181b);
      border: none; padding: 12px 24px; border-radius: 6px;
      cursor: pointer; font-size: 1rem; font-weight: 600;
      transition: background 0.2s, opacity 0.2s;
    }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    button.secondary {
      background: var(--peersky-nav-background, #27272a);
      color: var(--browser-theme-text-color, #ffffff);
      border: 1px solid var(--settings-border, #6b7280);
    }
    button.secondary:hover { border-color: var(--settings-border-hover, #9ca3af); }
    .progress-container {
      background: var(--peersky-nav-background, #27272a);
      border-radius: 8px; padding: 20px; margin: 20px 0; display: none;
    }
    .progress-bar {
      width: 100%; height: 30px;
      background: var(--browser-theme-background, #18181b);
      border-radius: 15px; overflow: hidden; margin: 10px 0;
    }
    .progress-fill {
      height: 100%;
      background: var(--browser-theme-primary-highlight, #3b82f6);
      width: 0%; transition: width 0.3s;
      display: flex; align-items: center; justify-content: center;
      color: var(--browser-theme-background, #18181b);
      font-weight: bold; font-size: 0.9rem;
    }
    .stats-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px; margin: 15px 0;
    }
    .stat-item {
      background: var(--browser-theme-background, #18181b);
      padding: 12px; border-radius: 6px;
      border: 1px solid var(--settings-border, #6b7280);
    }
    .stat-label {
      color: var(--settings-text-secondary, #9ca3af);
      font-size: 0.8rem; margin-bottom: 4px;
    }
    .stat-value {
      font-size: 1.1rem; font-weight: 600;
      color: var(--browser-theme-text-color, #ffffff);
    }
    .files-section { margin: 20px 0; }
    .files-section h3 { margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th, td {
      padding: 12px 15px; text-align: left;
      border-bottom: 1px solid var(--settings-border, #6b7280);
    }
    th {
      background: var(--peersky-nav-background, #27272a);
      color: var(--settings-text-secondary, #9ca3af);
      font-size: 0.85rem; text-transform: uppercase;
    }
    td { font-size: 0.95rem; }
    tr:hover { background: var(--peersky-nav-background, #27272a); }
    .status-message { padding: 15px; border-radius: 6px; margin: 10px 0; }
    .status-message.info { background: #1e3a5f; color: #6eb5ff; }
    .status-message.success { background: #1e4d2b; color: #6bff8e; }
    .status-message.error { background: #4d1e1e; color: #ff6b6b; }
    .privacy-warning {
      background: var(--peersky-nav-background, #27272a);
      padding: 15px; border-radius: 6px; margin: 30px 0;
      font-size: 0.85rem;
      color: var(--settings-text-secondary, #9ca3af);
      border: 1px solid var(--settings-border, #6b7280);
    }
    .privacy-warning strong { color: var(--settings-danger-color, #e53935); }
    .open-btn { padding: 6px 14px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>
      <img src="peersky://static/assets/logo.png" class="logo" alt="Peersky" />
      <span>BitTorrent</span>
      <span class="protocol-badge">${escapeForHtml(protocol)}</span>
    </h1>
    <div class="torrent-name" id="torrentDisplayName">${safeName}</div>

    <div class="button-group">
      <button id="startBtn" onclick="startTorrent()">Start Torrent</button>
      <button id="pauseBtn" onclick="pauseTorrent()" disabled style="display:none;">Pause</button>
      <button id="resumeBtn" onclick="resumeTorrent()" disabled style="display:none;">Resume</button>
      <button class="secondary" onclick="copyMagnetLink()">Copy Magnet Link</button>
    </div>

    <div id="statusMessage"></div>

    <div class="progress-container" id="progressContainer">
      <h3>Download Progress</h3>
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill">0%</div>
      </div>
      <div class="stats-grid">
        <div class="stat-item"><div class="stat-label">Downloaded</div><div class="stat-value" id="downloaded">0 B</div></div>
        <div class="stat-item"><div class="stat-label">Download Speed</div><div class="stat-value" id="downloadSpeed">0 B/s</div></div>
        <div class="stat-item"><div class="stat-label">Upload Speed</div><div class="stat-value" id="uploadSpeed">0 B/s</div></div>
        <div class="stat-item"><div class="stat-label">Peers</div><div class="stat-value" id="peers">0</div></div>
        <div class="stat-item"><div class="stat-label">Time Remaining</div><div class="stat-value" id="timeRemaining">-</div></div>
        <div class="stat-item"><div class="stat-label">Ratio</div><div class="stat-value" id="ratio">0.00</div></div>
      </div>

      <div class="files-section" id="filesSection" style="display:none;">
        <h3>Files</h3>
        <table>
          <thead><tr><th>#</th><th>Name</th><th>Action</th><th>Size</th></tr></thead>
          <tbody id="filesList"></tbody>
        </table>
      </div>
    </div>

    <div class="info-section">
      <p><strong>Info Hash:</strong> <code>${safeInfoHash || "will resolve on start"}</code></p>
      <div class="magnet-link">${safeMagnetUrl}</div>
    </div>

    <div class="privacy-warning">
      <strong>Privacy Notice:</strong> BitTorrent is a peer-to-peer protocol. When downloading, your IP address is visible to other peers in the swarm and pieces of data are uploaded to other users during the transfer. PeerSky automatically stops the torrent once the download completes and does not seed. This may bypass your proxy or VPN settings.
    </div>

  </div>

  <script>
    var magnetUrl = ${JSON.stringify(magnetUrl)};
    var torrentId = ${JSON.stringify(torrentId)};
    var apiBase = ${JSON.stringify(apiBase)};
    var currentInfoHash = torrentId;
    var statusInterval = null;
    var filesRendered = false;
    var torrentDownloadPath = '';

    function showStatus(message, type) {
      document.getElementById('statusMessage').innerHTML = '<div class="status-message ' + type + '">' + message + '</div>';
    }

    function showProgressUI() {
      document.getElementById('startBtn').style.display = 'none';
      document.getElementById('progressContainer').style.display = 'block';
      document.getElementById('pauseBtn').style.display = 'inline-block';
      document.getElementById('pauseBtn').disabled = false;
    }

    async function apiCall(action, params) {
      var qs = new URLSearchParams({ action: 'api', api: action });
      if (params) {
        Object.keys(params).forEach(function(k) { qs.set(k, params[k]); });
      }
      var url = apiBase + '?' + qs.toString();
      
      // Use POST for mutations, GET for status
      var mutationActions = ['start', 'pause', 'resume', 'remove'];
      var method = mutationActions.includes(action) ? 'POST' : 'GET';
      
      var resp = await fetch(url, { method: method });
      var text = await resp.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        console.error('[BT-UI] Bad JSON:', text.substring(0, 200));
        return { error: 'Invalid JSON' };
      }
    }

    // On page load, check if torrent is already active (resume UI only)
    (async function checkExisting() {
      try {
        var s = await apiCall('status', { hash: currentInfoHash || '' });
        if (s && !s.error && s.infoHash) {
          currentInfoHash = s.infoHash;
          showProgressUI();
          updateUIFromStatus(s);
          if (s.done) {
            showStatus('Download complete! Files saved to Downloads/PeerskyTorrents.', 'success');
            document.getElementById('pauseBtn').style.display = 'none';
            document.getElementById('resumeBtn').style.display = 'none';
          } else if (s.paused) {
            showStatus('Torrent paused', 'info');
            document.getElementById('pauseBtn').style.display = 'none';
            document.getElementById('resumeBtn').style.display = 'inline-block';
            document.getElementById('resumeBtn').disabled = false;
          } else {
            showStatus('Torrent is active. Downloading...', 'success');
            statusInterval = setInterval(pollStatus, 2000);
          }
        }
      } catch (err) {
        // No active torrent — show start button (default UI)
      }
    })();

    async function startTorrent() {
      var btn = document.getElementById('startBtn');
      btn.disabled = true;
      btn.textContent = 'Starting...';

      try {
        var data = await apiCall('start', { magnet: magnetUrl });
        if (data.success) {
          currentInfoHash = data.infoHash || currentInfoHash;
          showStatus('Torrent started! Connecting to peers...', 'success');
          showProgressUI();
          statusInterval = setInterval(pollStatus, 2000);
        } else {
          showStatus('Failed: ' + (data.error || 'Unknown error'), 'error');
          btn.disabled = false;
          btn.textContent = 'Start Torrent';
        }
      } catch (err) {
        showStatus('Error: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Start Torrent';
      }
    }

    function updateUIFromStatus(s) {
      if (!s || s.error) return;
      if (s.infoHash) currentInfoHash = s.infoHash;
      if (s.downloadPath) torrentDownloadPath = s.downloadPath;

      var pct = Math.round((s.progress || 0) * 100);
      var fill = document.getElementById('progressFill');
      fill.style.width = pct + '%';
      fill.textContent = pct + '%';

      if (s.name && s.name !== 'Fetching metadata...') {
        document.getElementById('torrentDisplayName').textContent = s.name;
        document.title = s.name + ' - BitTorrent';
      }

      document.getElementById('downloaded').textContent = formatBytes(s.downloaded);
      document.getElementById('downloadSpeed').textContent = formatBytes(s.downloadSpeed) + '/s';
      document.getElementById('uploadSpeed').textContent = formatBytes(s.uploadSpeed) + '/s';
      document.getElementById('peers').textContent = s.numPeers || 0;
      document.getElementById('timeRemaining').textContent = formatTime(s.timeRemaining);
      document.getElementById('ratio').textContent = (s.ratio || 0).toFixed(2);

      if (s.files && s.files.length > 0 && !filesRendered) {
        renderFiles(s.files);
        filesRendered = true;
      }
    }

    async function pollStatus() {
      try {
        var s = await apiCall('status', { hash: currentInfoHash || '' });
        if (s.error) return;

        updateUIFromStatus(s);

        if (s.done) {
          clearInterval(statusInterval);
          statusInterval = null;
          showStatus('Download complete! Files saved to Downloads/PeerskyTorrents. Torrent stopped automatically (no seeding).', 'success');
          document.getElementById('pauseBtn').style.display = 'none';
          document.getElementById('resumeBtn').style.display = 'none';
        }
      } catch (err) {
        console.error('[BT-UI] Poll error:', err);
      }
    }

    function renderFiles(files) {
      var tbody = document.getElementById('filesList');
      document.getElementById('filesSection').style.display = 'block';

      tbody.innerHTML = '';
      files.forEach(function(file) {
        var isMedia = /\.(mp4|mkv|avi|mov|webm|mp3|wav|flac|ogg|m4a)$/i.test(file.name);
        var label = isMedia ? 'Play' : 'Open';
        var row = document.createElement('tr');
        row.innerHTML =
          '<td>' + file.index + '</td>' +
          '<td>' + escapeHtml(file.name) + '</td>' +
          '<td><button class="open-btn" onclick="openFile(\\'' + escapeAttr(file.path) + '\\')">' + label + '</button></td>' +
          '<td>' + formatBytes(file.length) + '</td>';
        tbody.appendChild(row);
      });
    }

    function openFile(filePath) {
      var fullPath = torrentDownloadPath + '/' + filePath;
      // Encode path segments to handle spaces, brackets, parentheses in torrent names
      var encoded = fullPath.split('/').map(function(seg) { return encodeURIComponent(seg); }).join('/');
      var fileUrl = 'file://' + encoded;
      // Use IPC bridge - window.open() doesn't work for file:// URLs from custom protocols
      if (window.peersky && window.peersky.openInTab) {
        window.peersky.openInTab(fileUrl);
      } else {
        showStatus('Cannot open file: IPC not available', 'error');
      }
    }

    async function pauseTorrent() {
      await apiCall('pause', { hash: currentInfoHash || '' });
      document.getElementById('pauseBtn').style.display = 'none';
      document.getElementById('resumeBtn').style.display = 'inline-block';
      document.getElementById('resumeBtn').disabled = false;
      clearInterval(statusInterval);
      showStatus('Torrent paused', 'info');
    }

    async function resumeTorrent() {
      await apiCall('resume', { hash: currentInfoHash || '' });
      document.getElementById('resumeBtn').style.display = 'none';
      document.getElementById('pauseBtn').style.display = 'inline-block';
      statusInterval = setInterval(pollStatus, 2000);
      showStatus('Torrent resumed', 'success');
    }

    function copyMagnetLink() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(magnetUrl).then(function() {
          showStatus('Magnet link copied to clipboard!', 'success');
        }).catch(function() {
          fallbackCopy(magnetUrl);
        });
      } else {
        fallbackCopy(magnetUrl);
      }
    }

    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showStatus('Magnet link copied to clipboard!', 'success');
      } catch (e) {
        showStatus('Failed to copy. Please copy manually.', 'error');
      }
      document.body.removeChild(ta);
    }

    function formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 B';
      var k = 1024;
      var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      var i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function formatTime(ms) {
      if (!ms || ms === Infinity) return '-';
      var s = Math.floor(ms / 1000);
      var m = Math.floor(s / 60);
      var h = Math.floor(m / 60);
      if (h > 0) return h + 'h ' + (m % 60) + 'm';
      if (m > 0) return m + 'm ' + (s % 60) + 's';
      return s + 's';
    }

    function escapeHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function escapeAttr(s) {
      return s.replace(/'/g, "\\\\'").replace(/"/g, '&quot;');
    }
  </script>
</body>
</html>`;
}
