import Hyperdrive from 'hyperdrive'
import z32 from 'z32'
import { getOrCreatePrivateDriveKey } from '../backup/private-drive-key.js'
import { decodeDriveId } from '../backup/private-drive-export.js'
import { listPrivateHyperdrives } from './private-hyperdrive-registry.js'
import { isOwnedPrivateDrive } from './private-drive-ownership.js'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.gz': 'application/gzip'
}

function contentTypeFor (name) {
  const extension = name.match(/\.([^.]+)$/)?.[1]
  return MIME_TYPES[extension ? `.${extension.toLowerCase()}` : ''] ||
    'application/octet-stream'
}

function escapeHtml (value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character])
}

function renderPrivateListing (hostname, children, { readOnly = false } = {}) {
  const rows = children.map((entry) => {
    const name = typeof entry === 'string' ? entry : entry.name
    const kind = typeof entry === 'string' ? 'file' : entry.type
    const suffix = kind === 'directory' ? '/' : ''
    return `<li><a href="hyper://${hostname}/${encodeURIComponent(name)}${suffix}">${escapeHtml(name)}</a></li>`
  }).join('\n')
  const banner = readOnly
    ? '<p class="private-drive-readonly">Read-only: the original drive stays writable only on the device that created it.</p>'
    : ''
  return `<html><head><title>${hostname}</title></head><body>${banner}<ul>${rows}</ul></body></html>`
}

function decodeHostname (hostname) {
  if (!hostname) return null
  if (/^[a-z0-9]{52}$/i.test(hostname)) {
    return Buffer.from(z32.decode(hostname.toLowerCase()))
  }
  if (/^[0-9a-f]{64}$/i.test(hostname)) {
    return Buffer.from(hostname, 'hex')
  }
  return null
}

export async function openPrivateDriveByName (sdk, name, { userDataDir, autoJoin = false }) {
  const encryptionKey = await getOrCreatePrivateDriveKey(userDataDir)
  const corestore = sdk.corestore.namespace(name)
  const drive = new Hyperdrive(corestore, null, { encryptionKey })
  await drive.ready()
  if (autoJoin && encryptionKey) sdk.joinCore(drive.core)
  return drive
}

export async function openPrivateDriveByHostname (sdk, hostname, { userDataDir, autoJoin = false, encrypted = false, name = null }) {
  const key = decodeHostname(hostname)
  if (!key) throw new Error('Invalid private Hyperdrive address')
  // Legacy drives (no `encrypted` flag in the registry) stay unencrypted and
  // device-only: opening them with the current profile key would fail to
  // decrypt, and announcing a plaintext core would leak it to the DHT.
  const encryptionKey = encrypted ? await getOrCreatePrivateDriveKey(userDataDir) : null
  const corestore = name
    ? sdk.corestore.namespace(name)
    : sdk.corestore.namespace(key.toString('hex'))
  const drive = new Hyperdrive(corestore, key, { encryptionKey })
  await drive.ready()
  if (autoJoin && encryptionKey) sdk.joinCore(drive.core)
  return drive
}

async function statDrive (drive, pathname) {
  if (pathname === '/') return { isDirectory: () => true }
  const node = await drive.entry(pathname, { wait: false }).catch(() => null)
  if (!node) return null
  return { isDirectory: () => node.value.blob === null }
}

export function makePrivateDriveFetcher (sdk, userDataDir) {
  const opened = new Map()

  function register (hostname, drive) {
    opened.set(hostname, Promise.resolve({ drive, owned: true }))
  }

  async function open (url) {
    const hostname = new URL(url).hostname
    if (!opened.has(hostname)) {
      const entries = await listPrivateHyperdrives(userDataDir).catch(() => [])
      const match = entries.find((entry) => entry.url === `hyper://${hostname}/`)
      opened.set(hostname, (async () => {
        const drive = await openPrivateDriveByHostname(sdk, hostname, {
          userDataDir,
          autoJoin: true,
          encrypted: match ? match.encrypted === true : false,
          name: match ? match.name : null
        })
        const owned = await isOwnedPrivateDrive(userDataDir, decodeDriveId(`hyper://${hostname}/`))
        return { drive, owned }
      })())
    }
    return opened.get(hostname)
  }

  async function handle (url, options = {}) {
    const parsed = new URL(url)
    const { drive, owned } = await open(url)
    const pathname = parsed.pathname === '' || parsed.pathname === '/' ? '/' : parsed.pathname
    const method = (options.method || 'GET').toUpperCase()

    if (method === 'PUT' || method === 'POST') {
      if (!owned) {
        return new Response('This private drive is read-only on this device', { status: 403 })
      }
      const body = options.body
      if (body == null) {
        await drive.putEntry(pathname, {})
      } else {
        const buffer = typeof body === 'string' ? Buffer.from(body) : Buffer.from(await new Response(body).arrayBuffer())
        await drive.put(pathname, buffer)
      }
      return new Response('', { status: 200 })
    }

    if (method === 'DELETE') {
      if (!owned) {
        return new Response('This private drive is read-only on this device', { status: 403 })
      }
      await drive.del(pathname).catch(() => {})
      return new Response('', { status: 200 })
    }

    const name = pathname === '/' ? '' : pathname.split('/').pop()
    const stat = await statDrive(drive, pathname)

    if (!stat) {
      return new Response('File not found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
    }

    if (stat.isDirectory()) {
      const children = []
      for await (const child of await drive.readdir(pathname)) {
        children.push(typeof child === 'string' ? child : child.name)
      }
      const listing = renderPrivateListing(parsed.hostname, children, { readOnly: !owned })
      return new Response(listing, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }

    const buffer = await drive.get(pathname)
    return new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentTypeFor(name),
        'Accept-Ranges': 'none'
      }
    })
  }

  handle.register = register
  return handle
}
