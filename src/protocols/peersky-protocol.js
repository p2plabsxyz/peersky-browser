import path from 'path'
import { createLogger } from '../logger.js'
import { fileURLToPath } from 'url'
import mime from 'mime-types'
import ScopedFS from 'scoped-fs'
import { app, net } from 'electron'
import { randomUUID } from 'crypto'
import fsSync, { createReadStream, promises as fsPromises } from 'fs'
import { Readable } from 'stream'
import extensionManager from '../extensions/index.js'
import { resolveFileCached, respondWithFile } from './static-file.js'

const log = createLogger('protocols:peersky')

const __dirname = fileURLToPath(new URL('./', import.meta.url))

// In packaged builds, serve from app.asar.unpacked so we can read updated P2P apps
let pagesPath
if (app.isPackaged) {
  const appPath = app.getAppPath()
  const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked')
  pagesPath = path.join(unpackedPath, 'src', 'pages')
} else {
  pagesPath = path.join(__dirname, '../pages')
}

const fs = new ScopedFS(pagesPath)

const CHECK_PATHS = [
  (path) => path,
  (path) => path + '/index.html',
  (path) => path + '.html'
]

// request path -> resolved bundle path. The bundle layout is fixed for the life
// of the process, so this turns three stat calls per asset into one.
const resolveCache = new Map()

function resolveFile (filePath) {
  return resolveFileCached({ scopedFs: fs, filePath, candidates: CHECK_PATHS, cache: resolveCache })
}

function findHistoryExtension () {
  const extensions = Array.from(extensionManager.loadedExtensions.values()).filter(ext => ext && ext.enabled)
  const normalize = (value) => (typeof value === 'string' ? value.toLowerCase() : '')
  const isExact = (ext) => {
    const name = normalize(ext.name)
    const displayName = normalize(ext.displayName)
    return name === 'peersky-history' || displayName === 'peersky-history' || name === 'peersky history' || displayName === 'peersky history'
  }
  const exact = extensions.find(isExact)
  if (exact) return exact
  return extensions.find(ext => {
    const name = normalize(ext.name)
    const displayName = normalize(ext.displayName)
    return name.includes('history') || displayName.includes('history')
  }) || null
}

async function handleHistory () {
  const historyExtension = findHistoryExtension()
  if (!historyExtension || !historyExtension.electronId) {
    return new Response('History extension not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' }
    })
  }

  const viewUrl = `chrome-extension://${historyExtension.electronId}/view.html`
  return new Response('', {
    status: 302,
    headers: {
      Location: viewUrl,
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Allow-CSP-From': '*'
    }
  })
}

// Handle wallpaper requests cleanly
async function handleWallpaper (filename) {
  try {
    const wallpaperPath = path.join(app.getPath('userData'), 'wallpapers', filename)
    await fsPromises.access(wallpaperPath)

    const data = Readable.toWeb(createReadStream(wallpaperPath))
    const contentType = mime.lookup(wallpaperPath) || 'image/jpeg'

    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' }
    })
  } catch {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}

// Handle extension icon requests
async function handleExtensionIcon (extensionId, size) {
  try {
    // Path to extension: userData/extensions/{extensionId}/{version}/
    let extensionsPath = path.join(app.getPath('userData'), 'extensions', extensionId)

    // Find the latest extension version directory (format: "<version>_0")
    let versionDirs
    try {
      versionDirs = await fsPromises.readdir(extensionsPath)
    } catch (e) {
      // Backward-compat: try legacy uppercase "Extensions" directory
      const legacyPath = path.join(app.getPath('userData'), 'Extensions', extensionId)
      try {
        versionDirs = await fsPromises.readdir(legacyPath)
        extensionsPath = legacyPath
      } catch (_) {
        throw e // propagate original error if legacy also fails
      }
    }
    if (!versionDirs || versionDirs.length === 0) {
      throw new Error('No version directories')
    }
    const pickLatest = (dirs) => {
      const parseVer = (d) => {
        const base = String(d).split('_')[0]
        return base.split('.').map(n => parseInt(n, 10) || 0)
      }
      return dirs
        .filter(Boolean)
        .sort((a, b) => {
          const va = parseVer(a)
          const vb = parseVer(b)
          const len = Math.max(va.length, vb.length)
          for (let i = 0; i < len; i++) {
            const ai = va[i] || 0; const bi = vb[i] || 0
            if (ai !== bi) return bi - ai
          }
          return 0
        })[0]
    }
    const versionDir = pickLatest(versionDirs)
    if (!versionDir) {
      throw new Error('Extension version directory not found')
    }
    const extensionRoot = path.join(extensionsPath, versionDir)

    // Read manifest to get actual icon path
    const manifestPath = path.join(extensionRoot, 'manifest.json')
    const manifestContent = await fsPromises.readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestContent)

    // Get icon path from manifest for the requested size
    const icons = manifest.icons || {}
    let iconRelativePath = icons[size]

    if (!iconRelativePath) {
      const entries = Object.entries(icons)
      if (!entries.length) {
        throw new Error('No icon entries in manifest')
      }
      const parsed = entries
        .map(([k, v]) => {
          const n = parseInt(k, 10)
          return Number.isFinite(n) ? { size: n, path: v } : null
        })
        .filter(Boolean)

      if (parsed.length) {
        const target = parseInt(size, 10)
        if (Number.isFinite(target)) {
          const sorted = parsed.sort((a, b) => a.size - b.size)
          const best = sorted.find(p => p.size >= target) || sorted[sorted.length - 1]
          iconRelativePath = best.path
        } else {
          const largest = parsed.sort((a, b) => b.size - a.size)[0]
          iconRelativePath = largest.path
        }
      } else {
        const any = entries[0]
        iconRelativePath = any && any[1]
      }
    }

    if (!iconRelativePath) {
      throw new Error('No icon found in manifest')
    }

    // Build full path to icon file
    const iconPath = path.join(extensionRoot, iconRelativePath)
    await fsPromises.access(iconPath)

    const data = Readable.toWeb(createReadStream(iconPath))
    const contentType = mime.lookup(iconPath) || 'image/png'

    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' }
    })
  } catch (error) {
    log.info(`Extension icon not found: ${extensionId}/${size} - ${error.message}`)
    try {
      const defaultIconPath = path.join(pagesPath, 'static/assets/svg/default-extension-icon.svg')
      const data = Readable.toWeb(createReadStream(defaultIconPath))
      const contentType = mime.lookup(defaultIconPath) || 'image/svg+xml'
      return new Response(data, {
        status: 200,
        headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' }
      })
    } catch (_) {
      return new Response('Extension icon not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      })
    }
  }
}

async function handleUserP2PAppAsset (assetPath) {
  try {
    const [rawAppId, ...restPath] = String(assetPath || '').split('/')
    const appId = String(rawAppId || '').trim()
    if (!/^[a-z0-9-]{1,64}$/.test(appId)) {
      throw new Error('Invalid app id')
    }

    let relativePath = restPath.join('/')
    if (!relativePath) relativePath = 'index.html'
    if (relativePath.endsWith('/')) relativePath += 'index.html'

    // All web assets are stored in the 'app/' subfolder except the app icon
    if (relativePath !== 'icon.svg') {
      relativePath = 'app/' + relativePath
    }

    const normalizedRelative = relativePath.replace(/\\/g, '/')
    if (normalizedRelative.includes('\0')) throw new Error('Invalid path')
    const baseDir = path.join(app.getPath('userData'), 'myapps', appId)
    const resolvedPath = path.resolve(baseDir, normalizedRelative)
    const baseResolved = path.resolve(baseDir)
    if (!resolvedPath.startsWith(baseResolved + path.sep) && resolvedPath !== baseResolved) {
      throw new Error('Path traversal blocked')
    }

    await fsPromises.access(resolvedPath)
    const stat = await fsPromises.stat(resolvedPath)
    if (!stat.isFile()) throw new Error('Not a file')

    return new Response(Readable.toWeb(createReadStream(resolvedPath)), {
      status: 200,
      headers: {
        'Content-Type': mime.lookup(resolvedPath) || 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}

// PDFs the browser decided to open in the bundled viewer. The viewer asks for
// them by id rather than by URL, so this never becomes a general URL fetcher
// reachable from any peersky:// page. Persisted because a restored tab keeps
// its viewer URL, and its id has to still resolve after a restart.
const PDF_SOURCES_FILE = path.join(app.getPath('userData'), 'pdf-sources.json')
const PDF_SOURCES_LIMIT = 32
const pdfSources = new Map(loadPdfSources())

function loadPdfSources () {
  try {
    const raw = JSON.parse(fsSync.readFileSync(PDF_SOURCES_FILE, 'utf8'))
    return Array.isArray(raw) ? raw.filter((e) => Array.isArray(e) && e.length === 2) : []
  } catch (_) {
    return []
  }
}

function savePdfSources () {
  try {
    fsSync.writeFileSync(PDF_SOURCES_FILE, JSON.stringify([...pdfSources]), { mode: 0o600 })
  } catch (error) {
    log.warn(`Could not persist PDF sources: ${error.message}`)
  }
}

/**
 * Register a PDF for the viewer and return its opaque id.
 *
 * @param {string} url
 * @returns {string}
 */
export function registerPdfSource (url) {
  for (const [id, known] of pdfSources) {
    if (known === url) return id
  }
  const id = randomUUID()
  pdfSources.set(id, url)
  while (pdfSources.size > PDF_SOURCES_LIMIT) pdfSources.delete(pdfSources.keys().next().value)
  savePdfSources()
  return id
}

async function handlePdfSource (id) {
  const url = pdfSources.get(id)
  if (!url) return new Response('Unknown PDF', { status: 404 })
  try {
    const upstream = await net.fetch(url)
    if (!upstream.ok) return new Response(`Upstream ${upstream.status}`, { status: upstream.status })
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': upstream.headers.get('content-length') ?? '',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (error) {
    log.error(`PDF fetch failed: ${error.message}`)
    return new Response('Could not fetch the PDF', { status: 502 })
  }
}

export async function createHandler () {
  return async function protocolHandler (request) {
    const { url } = request
    const parsedUrl = new URL(url)
    let filePath = (parsedUrl.hostname + parsedUrl.pathname)
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')

    if (!filePath || filePath === 'home' || filePath === '/') filePath = 'home'
    if (filePath === 'history' || filePath.startsWith('history/')) return handleHistory()
    if (filePath.startsWith('pdf-source/')) return handlePdfSource(filePath.slice('pdf-source/'.length))
    if (filePath.startsWith('wallpaper/')) return handleWallpaper(filePath.slice(10))
    if (filePath.startsWith('extension-icon/')) {
      const iconPath = filePath.slice(15) // Remove 'extension-icon/'
      const [extensionId, size] = iconPath.split('/')
      return handleExtensionIcon(extensionId, size || '64')
    }
    if (filePath.startsWith('myapps/')) {
      return handleUserP2PAppAsset(filePath.slice('myapps/'.length))
    }

    // Handle settings subpaths - map all /settings/* to settings.html
    if (filePath.startsWith('settings/')) {
      filePath = 'settings'
    }

    try {
      const { resolvedPath, stat } = await resolveFile(filePath)
      const format = path.extname(resolvedPath)

      if (!['', '.html', '.js', '.mjs', '.css', '.json', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff2', '.woff', '.ttf', '.mp3', '.mp4', '.webm', '.ogg'].includes(format)) {
        throw new Error('Unsupported file type')
      }

      return respondWithFile({
        scopedFs: fs,
        resolvedPath,
        stat,
        request,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Allow-CSP-From': '*'
        }
      })
    } catch (e) {
      if (filePath !== 'error' && filePath !== 'error.html') {
        log.error(`Error handling protocol request for ${filePath}: ${e.message}`)
        return Response.error()
      }

      // Guard for missing error page itself.
      return new Response('File not found', {
        status: 404,
        headers: {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-cache'
        }
      })
    }
  }
}
