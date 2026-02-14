import fs from "fs-extra";
import path from "path";
import mime from "mime-types";
import { pathToFileURL } from "url";

function generateDirectoryListing(dirPath, entries) {
  const parentPath = path.dirname(dirPath);
  const parentDirName = path.basename(parentPath) || 'Parent Directory';

  const sortedEntries = entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  const rows = sortedEntries.map(entry => {
    const icon = entry.isDirectory ? '📁' : '📄';
    const name = entry.isDirectory ? entry.name + '/' : entry.name;
    const size = entry.isDirectory ? '-' : formatBytes(entry.size);
    const modified = new Date(entry.mtime).toLocaleString();
    const fullPath = path.join(dirPath, entry.name);
    let href = pathToFileURL(fullPath).href;
    if (entry.isDirectory && !href.endsWith("/")) {
      href += "/";
    }
    
    return `
      <tr>
        <td><a href="${escapeHtml(href)}">${icon} ${escapeHtml(name)}</a></td>
        <td class="size">${size}</td>
        <td class="modified">${modified}</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="icon" type="image/png" href="peersky://static/assets/favicon.ico" />
  <title>Index of ${escapeHtml(dirPath)}</title>
  <style>
    body {
      background: #18181C;
      color: white;
      font-family: monospace;
    }
    a {
      color: #6495ED;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    th.size, th.modified, td.size, td.modified {
      padding-left: 16px;
    }
    td.size, td.modified {
      text-align: right;
    }
    table, tr, td, th {
      margin: 0;
      padding: 0;
    }
  </style>
</head>
<body>
  <h1>Index of ${escapeHtml(dirPath)}</h1>
  <hr>
  
  <table>
    <tr>
      <th>Name</th>
      <th class="size">Size</th>
      <th class="modified">Date Modified</th>
    </tr>
    ${parentPath !== dirPath ? `
    <tr>
      <td><a href="${escapeHtml(pathToFileURL(parentPath).href)}">📁 [${escapeHtml(parentDirName)}]</a></td>
      <td class="size">-</td>
      <td class="modified">-</td>
    </tr>
    ` : ''}
    ${rows}
  </table>
  
  <hr>
  
  <p>
    <strong>🌐 Publish to P2P:</strong>
    <select id="protocolSelect">
      <option value="ipfs">IPFS</option>
      <option value="hyper">Hypercore</option>
    </select>
    <button id="publishBtn" onclick="publishDirectory()">📤 Publish</button>
    <span id="status"></span>
  </p>
  
  <div id="result"></div>
  
  <script>
    let manifestCache = null;

    async function loadManifest() {
      if (manifestCache) return manifestCache;

      const manifestUrl = new URL(window.location.href);
      manifestUrl.searchParams.set('__publishManifest', '1');

      const response = await fetch(manifestUrl.toString(), {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        throw new Error('Failed to load directory manifest');
      }

      const data = await response.json();
      manifestCache = data.files || [];
      return manifestCache;
    }
    
    async function publishDirectory() {
      const protocol = document.getElementById('protocolSelect').value;
      const status = document.getElementById('status');
      const result = document.getElementById('result');
      const publishBtn = document.getElementById('publishBtn');
      
      status.textContent = 'Publishing...';
      result.textContent = '';
      publishBtn.disabled = true;
      
      try {
        const files = await loadManifest();

        if (files.length === 0) {
          throw new Error('No files found in this directory or its subdirectories.');
        }

        if (protocol === 'hyper') {
          const hyperdriveUrl = await generateHyperdriveKey('directory-' + Date.now());
          console.log('Hyper base URL:', hyperdriveUrl);

          for (const fileEntry of files) {
            const url = hyperdriveUrl + encodeURIComponent(fileEntry.relativePath);
            console.log('Uploading', fileEntry.relativePath, 'to', url);

            const fileResponse = await fetch(fileEntry.fileUrl);
            const blob = await fileResponse.blob();
            
            const uploadResponse = await fetch(url, {
              method: 'PUT',
              body: blob,
              headers: { 'Content-Type': 'application/octet-stream' }
            });
            
            if (!uploadResponse.ok) {
              throw new Error('Failed to upload ' + fileEntry.relativePath);
            }
          }
          
          status.textContent = '✅ Published!';
          result.textContent = '';
          const hyperAnchor = document.createElement('a');
          hyperAnchor.href = hyperdriveUrl;
          hyperAnchor.target = '_blank';
          hyperAnchor.rel = 'noopener noreferrer';
          hyperAnchor.textContent = hyperdriveUrl;
          result.appendChild(hyperAnchor);
          
        } else {
          const formData = new FormData();

          for (const fileEntry of files) {
            console.log('Processing file:', fileEntry.relativePath);

            const response = await fetch(fileEntry.fileUrl);
            if (!response.ok) {
              throw new Error('Failed to read ' + fileEntry.relativePath);
            }
            const blob = await response.blob();

            const fileName = fileEntry.relativePath || fileEntry.name;
            const file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });

            formData.append('file', file, fileName);
          }
          
          const url = 'ipfs://bafyaabakaieac/';
          console.log('Uploading to IPFS...');
          
          const response = await fetch(url, {
            method: 'PUT',
            body: formData,
          });
          
          if (!response.ok) {
            throw new Error('IPFS upload failed: ' + await response.text());
          }
          
          const locationHeader = response.headers.get('Location');
          status.textContent = '✅ Published!';
          result.textContent = '';
          if (locationHeader) {
            const anchor = document.createElement('a');
            anchor.href = locationHeader;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.textContent = locationHeader;
            result.appendChild(anchor);
          } else {
            result.textContent = 'Upload succeeded but no Location header was returned.';
          }
        }
        
      } catch (error) {
        console.error('Publish error:', error);
        status.textContent = '❌ Error: ' + error.message;
      } finally {
        publishBtn.disabled = false;
      }
    }
    
    async function generateHyperdriveKey(name) {
      const response = await fetch('hyper://localhost/?key=' + name, { method: 'POST' });
      if (!response.ok) {
        throw new Error('Failed to generate Hyperdrive key: ' + response.statusText);
      }
      return await response.text();
    }
  </script>
</body>
</html>`;
}

function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

export async function createHandler() {
  async function getFilesRecursive(dirPath, basePath = '') {
    const allFiles = [];
    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch (error) {
    //   console.error(`Could not read directory: ${dirPath}`, error);
      return []; // Return empty if directory is unreadable
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        const subFiles = await getFilesRecursive(fullPath, relativePath);
        allFiles.push(...subFiles);
      } else {
        try {
          const stat = await fs.stat(fullPath);
          allFiles.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            size: stat.size,
            fileUrl: pathToFileURL(fullPath).href
          });
        } catch (err) {
        //   console.error('Could not stat file:', fullPath, err);
        }
      }
    }
    return allFiles;
  }

  return async function handleFileProtocol(request) {
    const url = new URL(request.url);
    let filePath = decodeURIComponent(url.pathname);

    // On Windows, pathname starts with a slash, e.g., /C:/Users/...
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.substring(1);
    }

    // console.log('File protocol request:', request.url, '-> decoded path:', filePath);

    try {
      const stats = await fs.stat(filePath);
    //   console.log('Path stats:', filePath, 'isDirectory:', stats.isDirectory(), 'isFile:', stats.isFile());

      if (stats.isDirectory()) {
        // Handle manifest requests first (used for publishing)
        if (url.searchParams.get('__publishManifest') === '1') {
          const manifest = await getFilesRecursive(filePath, '');
          return new Response(JSON.stringify({ files: manifest }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-cache'
            }
          });
        }

        // For directories, read entries for the current level to display
        const dirEntries = await fs.readdir(filePath);
        const entryStats = await Promise.all(
          dirEntries.map(async (name) => {
            try {
              const entryPath = path.join(filePath, name);
              const stat = await fs.stat(entryPath);
              return {
                name,
                isDirectory: stat.isDirectory(),
                size: stat.size,
                mtime: stat.mtime
              };
            } catch (err) {
              return null; // Skip files we can't read
            }
          })
        );

        const validEntries = entryStats.filter(e => e !== null);

        const html = generateDirectoryListing(filePath, validEntries);

        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
          }
        });
      } else {
        // For files, serve them directly with Range request support for streaming
        let contentType = mime.lookup(filePath) || 'application/octet-stream';

        // Remap container types that Chromium won't play inline to compatible equivalents
        const mimeRemaps = {
          'video/x-matroska': 'video/webm', // MKV → WebM (same Matroska container)
          'video/quicktime': 'video/mp4', // MOV → MP4 (same H.264/AAC codecs)
          'audio/x-flac': 'audio/flac', // normalize x-flac to standard flac
        };
        if (mimeRemaps[contentType]) contentType = mimeRemaps[contentType];

        const fileSize = stats.size;
        const rangeHeader = request.headers.get('Range');

        // Force inline display for media files (prevents download dialog)
        const isMedia = contentType.startsWith('video/') || contentType.startsWith('audio/');
        const baseHeaders = {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          ...(isMedia && { 'Content-Disposition': 'inline' })
        };

        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (match) {
            const start = parseInt(match[1], 10);
            const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
            const chunkSize = end - start + 1;

            const stream = fs.createReadStream(filePath, { start, end });
            return new Response(stream, {
              status: 206,
              headers: {
                ...baseHeaders,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunkSize.toString(),
              }
            });
          }
        }

        const stream = fs.createReadStream(filePath);
        return new Response(stream, {
          status: 200,
          headers: {
            ...baseHeaders,
            'Content-Length': fileSize.toString(),
          }
        });
      }
    } catch (error) {
    //   console.error('File protocol error:', error);
      const errorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
      <style>body{background-color:#18181C; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px;color:#333;}
      h1{font-size:24px;margin-bottom:10px;}p{color:#666;}</style></head><body>
      <h1>Error Loading File</h1><p>${escapeHtml(error.message)}</p><p><code>${escapeHtml(filePath)}</code></p>
      </body></html>`;

      let status = 500;
      if (error.code === 'ENOENT') status = 404;
      else if (error.code === 'EACCES' || error.code === 'EPERM') status = 403;
      
      return new Response(errorHtml, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
  };
}
