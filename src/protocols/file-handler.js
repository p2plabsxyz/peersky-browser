import fs from 'fs-extra'
import path from 'path'
import mime from 'mime-types'
import { pathToFileURL } from 'url'
import { LISTING_HEADER, LISTING_PARAM, isListingRead, listingToken } from './request-gate.js'

function generateDirectoryListing (dirPath, entries, token) {
  const parentPath = path.dirname(dirPath)
  const parentDirName = path.basename(parentPath) || 'Parent Directory'

  const sortedEntries = entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1
    return a.name.localeCompare(b.name)
  })

  const rows = sortedEntries.map(entry => {
    const icon = entry.isDirectory ? '📁' : '📄'
    const name = entry.isDirectory ? entry.name + '/' : entry.name
    const size = entry.isDirectory ? '-' : formatBytes(entry.size)
    const modified = new Date(entry.mtime).toLocaleString()
    const fullPath = path.join(dirPath, entry.name)
    let href = pathToFileURL(fullPath).href
    if (entry.isDirectory && !href.endsWith('/')) {
      href += '/'
    }

    return `
      <tr>
        <td><a href="${escapeHtml(href)}">${icon} ${escapeHtml(name)}</a></td>
        <td class="size">${size}</td>
        <td class="modified">${modified}</td>
      </tr>
    `
  }).join('')

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
    #visibilityHelp {
      color: #9ca3af;
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
    ${parentPath !== dirPath
? `
    <tr>
      <td><a href="${escapeHtml(pathToFileURL(parentPath).href)}">📁 [${escapeHtml(parentDirName)}]</a></td>
      <td class="size">-</td>
      <td class="modified">-</td>
    </tr>
    `
: ''}
    ${rows}
  </table>
  
  <hr>
  
  <p>
    <strong>🌐 Publish to P2P:</strong>
    <select id="protocolSelect">
      <option value="hyper">Hypercore</option>
      <option value="ipfs">IPFS</option>
    </select>
    <select id="visibilitySelect" aria-label="Who can open it">
      <option value="public">Public</option>
      <option value="private">Private</option>
    </select>
    <button id="publishBtn" onclick="publishDirectory()">📤 Publish</button>
    <span id="status"></span>
  </p>
  <p id="visibilityHelp"></p>

  <div id="result"></div>

  <script>
    let manifestCache = null;
    // The token PeerSky put in this listing (request-gate.js). It reads this
    // folder's files, and lets the listing make a private drive.
    const listingToken = '${token || ''}';
    const protocolSelect = document.getElementById('protocolSelect');
    const visibilitySelect = document.getElementById('visibilitySelect');
    const visibilityHelp = document.getElementById('visibilityHelp');

    // Who can open a hyper:// upload, as in the Hyperdrive app. IPFS has no
    // private uploads.
    function updateVisibility() {
      const usesHyper = protocolSelect.value === 'hyper';
      visibilitySelect.hidden = !usesHyper;
      visibilityHelp.hidden = !usesHyper;
      visibilityHelp.textContent = visibilitySelect.value === 'private'
        ? "Encrypted with this profile's key, so only your own linked devices can open it."
        : 'Anyone you send the link to can open it, straight from this computer.';
    }
    protocolSelect.onchange = updateVisibility;
    visibilitySelect.onchange = updateVisibility;
    updateVisibility();

    function withListingToken(href) {
      const url = new URL(href);
      url.hash = '';
      url.searchParams.set('${LISTING_PARAM}', listingToken);
      return url.toString();
    }

    // The folder's own name: a private upload goes in under it, and an IPFS
    // upload names its files with it.
    function folderName() {
      const names = window.location.pathname.split('/').filter(Boolean);
      return decodeURIComponent(names[names.length - 1] || '') || 'folder';
    }

    async function loadManifest() {
      if (manifestCache) return manifestCache;

      const manifestUrl = new URL(withListingToken(window.location.href));
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
          const visibility = visibilitySelect.value;
          const hyperdriveUrl = await generateHyperdriveKey('directory-' + Date.now(), visibility);
          // A private upload goes in under the folder's name, so it is one
          // folder among your private uploads, as from the Hyperdrive app.
          const baseUrl = visibility === 'private'
            ? hyperdriveUrl + encodeURIComponent(folderName()) + '/'
            : hyperdriveUrl;

          for (const fileEntry of files) {
            const url = baseUrl + fileEntry.relativePath.split('/').map(encodeURIComponent).join('/');
            console.log('Uploading', fileEntry.relativePath);

            const fileResponse = await fetch(fileEntry.fileUrl);
            if (!fileResponse.ok) {
              throw new Error('Failed to read ' + fileEntry.relativePath);
            }
            const blob = await fileResponse.blob();

            const headers = {
              'Content-Type': 'application/octet-stream',
              '${LISTING_HEADER}': withListingToken(window.location.href)
            };
            // The file keeps its own date in the drive, as from the Hyperdrive app.
            if (fileEntry.lastModified > 0) {
              headers['Last-Modified'] = new Date(fileEntry.lastModified).toUTCString();
            }
            const uploadResponse = await fetch(url, {
              method: 'PUT',
              body: blob,
              headers
            });

            if (!uploadResponse.ok) {
              throw new Error('Failed to upload ' + fileEntry.relativePath);
            }
          }

          status.textContent = '✅ Published!';
          result.textContent = '';
          const hyperAnchor = document.createElement('a');
          hyperAnchor.href = baseUrl;
          hyperAnchor.target = '_blank';
          hyperAnchor.rel = 'noopener noreferrer';
          hyperAnchor.textContent = baseUrl;
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

            // Under the folder's name, as the Hyperdrive app sends a folder:
            // the IPFS handler drops that first part and keeps the rest.
            const fileName = folderName() + '/' + fileEntry.relativePath;
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
    
    async function generateHyperdriveKey(name, visibility) {
      const params = new URLSearchParams({ key: name, visibility });
      const response = await fetch('hyper://localhost/?' + params, {
        method: 'POST',
        headers: { '${LISTING_HEADER}': withListingToken(window.location.href) }
      });
      if (!response.ok) {
        throw new Error('Failed to generate Hyperdrive key: ' + ((await response.text()) || response.status));
      }
      return await response.text();
    }
  </script>
</body>
</html>`
}

function formatBytes (bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

function escapeHtml (text) {
  if (typeof text !== 'string') return ''
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }
  return text.replace(/[&<>"']/g, m => map[m])
}

// Containers Chromium won't play inline, named as their playable equivalents.
const PLAYABLE_REMAPS = {
  'video/x-matroska': 'video/webm', // MKV → WebM (same Matroska container)
  'video/quicktime': 'video/mp4', // MOV → MP4 (same H.264/AAC codecs)
  'audio/x-flac': 'audio/flac' // normalize x-flac to standard flac
}

export function playableContentType (filePath) {
  const contentType = mime.lookup(filePath) || 'application/octet-stream'
  return PLAYABLE_REMAPS[contentType] || contentType
}

export async function createHandler () {
  async function getFilesRecursive (dirPath, basePath = '') {
    const allFiles = []
    let entries
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch (error) {
    //   log.error(`Could not read directory: ${dirPath}`, error);
      return [] // Return empty if directory is unreadable
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      // With / on every system: the listing puts it in a hyper:// or ipfs:// path.
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        const subFiles = await getFilesRecursive(fullPath, relativePath)
        allFiles.push(...subFiles)
      } else {
        try {
          const stat = await fs.stat(fullPath)
          allFiles.push({
            name: entry.name,
            path: fullPath,
            relativePath,
            size: stat.size,
            lastModified: stat.mtimeMs,
            fileUrl: pathToFileURL(fullPath).href
          })
        } catch (err) {
        //   log.error('Could not stat file:', fullPath, err);
        }
      }
    }
    return allFiles
  }

  return async function handleFileProtocol (request) {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)

    // On Windows, pathname starts with a slash, e.g., /C:/Users/...
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.substring(1)
    }

    // log.info('File protocol request:', request.url, '-> decoded path:', filePath);

    try {
      const stats = await fs.stat(filePath)
      //   log.info('Path stats:', filePath, 'isDirectory:', stats.isDirectory(), 'isFile:', stats.isFile());

      if (stats.isDirectory()) {
        // Every file under the folder, for its listing's Publish button, with
        // the listing's token on each file's URL so it may read them.
        if (url.searchParams.get('__publishManifest') === '1') {
          if (!isListingRead(url)) {
            return new Response('Forbidden', { status: 403, headers: { 'Content-Type': 'text/plain' } })
          }
          const manifest = (await getFilesRecursive(filePath, '')).map((file) => {
            const fileUrl = new URL(file.fileUrl)
            fileUrl.searchParams.set(LISTING_PARAM, url.searchParams.get(LISTING_PARAM))
            return { ...file, fileUrl: fileUrl.href }
          })
          return new Response(JSON.stringify({ files: manifest }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-cache'
            }
          })
        }

        // For directories, read entries for the current level to display
        const dirEntries = await fs.readdir(filePath)
        const entryStats = await Promise.all(
          dirEntries.map(async (name) => {
            try {
              const entryPath = path.join(filePath, name)
              const stat = await fs.stat(entryPath)

              // Hide entries that cannot be opened to avoid dead links (e.g. protected system folders).
              if (stat.isDirectory()) {
                await fs.readdir(entryPath)
              } else {
                await fs.access(entryPath, fs.constants.R_OK)
              }

              return {
                name,
                isDirectory: stat.isDirectory(),
                size: stat.size,
                mtime: stat.mtime
              }
            } catch (err) {
              return null // Skip files we can't read
            }
          })
        )

        const validEntries = entryStats.filter(e => e !== null)

        const html = generateDirectoryListing(filePath, validEntries, listingToken(url))

        // nosniff: the listing holds its token, so it never loads as a script
        // or a stylesheet.
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff'
          }
        })
      } else {
        // For files, serve them directly with Range request support for streaming
        const contentType = playableContentType(filePath)

        const fileSize = stats.size
        const rangeHeader = request.headers.get('Range')

        // Force inline display for media files (prevents download dialog)
        const isMedia = contentType.startsWith('video/') || contentType.startsWith('audio/')
        const baseHeaders = {
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=3600',
          ...(isMedia && { 'Content-Disposition': 'inline' })
        }

        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/)
          if (match) {
            const start = parseInt(match[1], 10)
            const end = match[2] ? parseInt(match[2], 10) : fileSize - 1
            const chunkSize = end - start + 1

            const stream = fs.createReadStream(filePath, { start, end })
            return new Response(stream, {
              status: 206,
              headers: {
                ...baseHeaders,
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Content-Length': chunkSize.toString()
              }
            })
          }
        }

        const stream = fs.createReadStream(filePath)
        return new Response(stream, {
          status: 200,
          headers: {
            ...baseHeaders,
            'Content-Length': fileSize.toString()
          }
        })
      }
    } catch (error) {
    //   log.error('File protocol error:', error);
      const errorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
      <style>body{background-color:#18181C; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px;color:#333;}
      h1{font-size:24px;margin-bottom:10px;}p{color:#666;}</style></head><body>
      <h1>Error Loading File</h1><p>${escapeHtml(error.message)}</p><p><code>${escapeHtml(filePath)}</code></p>
      </body></html>`

      let status = 500
      if (error.code === 'ENOENT') status = 404
      else if (error.code === 'EACCES' || error.code === 'EPERM') status = 403

      return new Response(errorHtml, {
        status,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    }
  }
}
