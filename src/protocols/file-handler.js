import fs from "fs-extra";
import path from "path";
import mime from "mime-types";
import { pathToFileURL } from "url";

function generateDirectoryListing(dirPath, entries, allFilesForPublishing) {
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
        <td><a href="${href}">${icon} ${escapeHtml(name)}</a></td>
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
      <td><a href="${pathToFileURL(parentPath).href}">📁 [${escapeHtml(parentDirName)}]</a></td>
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
    // This list is now pre-compiled by the main process with all recursive files and correct paths!
    const allFiles = ${JSON.stringify(allFilesForPublishing)};
    
    async function publishDirectory() {
      const protocol = document.getElementById('protocolSelect').value;
      const status = document.getElementById('status');
      const result = document.getElementById('result');
      const publishBtn = document.getElementById('publishBtn');
      
      status.textContent = 'Publishing...';
      result.textContent = '';
      publishBtn.disabled = true;
      
      try {
        if (allFiles.length === 0) {
          throw new Error('No files found in this directory or its subdirectories.');
        }
        
        if (protocol === 'hyper') {
          // Hypercore upload
          const hyperdriveUrl = await generateHyperdriveKey('directory-' + Date.now());
          console.log('Hyper base URL:', hyperdriveUrl);
          
          for (const fileEntry of allFiles) {
            const url = hyperdriveUrl + encodeURIComponent(fileEntry.relativePath);
            console.log('Uploading', fileEntry.relativePath, 'to', url);
            
            const fileResponse = await fetch('file://' + fileEntry.path);
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
          // IPFS upload - exactly like upload.html
          const formData = new FormData();
          
          for (const fileEntry of allFiles) {
            console.log('Processing file:', fileEntry.relativePath, 'size:', fileEntry.size);
            
            // Convert base64 back to blob
            const binaryString = atob(fileEntry.base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'application/octet-stream' });
            
            // Use the relative path as the file name to preserve directory structure
            const fileName = fileEntry.relativePath || fileEntry.name;
            console.log('Creating File with name:', fileName);
            const file = new File([blob], fileName, { type: 'application/octet-stream' });
            
            // The third argument to append() is what IPFS uses as the filename.
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
      console.error(`Could not read directory: ${dirPath}`, error);
      return []; // Return empty if directory is unreadable
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;

      if (entry.isDirectory()) {
        const subFiles = await getFilesRecursive(fullPath, relativePath);
        allFiles.push(...subFiles);
      } else {
        // Read the file content and convert to base64 for embedding
        try {
          const fileContent = await fs.readFile(fullPath);
          const base64Content = fileContent.toString('base64');
          allFiles.push({
            name: entry.name,
            path: fullPath,
            relativePath: relativePath,
            base64: base64Content,
            size: fileContent.length
          });
        } catch (err) {
          console.error('Could not read file:', fullPath, err);
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

    console.log('File protocol request:', request.url, '-> decoded path:', filePath);

    try {
      const stats = await fs.stat(filePath);
      console.log('Path stats:', filePath, 'isDirectory:', stats.isDirectory(), 'isFile:', stats.isFile());

      if (stats.isDirectory()) {
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

        // **BEFORE** generating the HTML, read the *entire* directory recursively.
        // This gives the script embedded in the HTML the full list of files to publish.
        // Don't use the directory name as base path - just use empty string
        // so paths are relative to the current directory
        const allFilesForPublishing = await getFilesRecursive(filePath, '');

        const html = generateDirectoryListing(filePath, validEntries, allFilesForPublishing);

        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache'
          }
        });
      } else {
        // For files, serve them directly
        const contentType = mime.lookup(filePath) || 'application/octet-stream';
        const fileBuffer = await fs.readFile(filePath);
        console.log('Serving file:', filePath, 'size:', fileBuffer.length, 'contentType:', contentType);
        return new Response(fileBuffer, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Length': stats.size.toString(),
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }
    } catch (error) {
      console.error('File protocol error:', error);
      const errorHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Error</title>
      <style>body{background-color:#18181C; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:40px;color:#333;}
      h1{font-size:24px;margin-bottom:10px;}p{color:#666;}</style></head><body>
      <h1>Error Loading File</h1><p>${escapeHtml(error.message)}</p><p><code>${escapeHtml(filePath)}</code></p>
      </body></html>`;

      return new Response(errorHtml, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
  };
}
