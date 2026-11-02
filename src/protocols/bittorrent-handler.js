import { fork } from 'child_process'
import path from 'path'
import { createLogger } from '../logger.js'
import { fileURLToPath } from 'url'
import fs from 'fs-extra'
import { app, ipcMain, net } from 'electron'
import { generateTorrentUI } from './bt/torrentPage.js'
import { playableContentType } from './file-handler.js'
import settingsManager from '../settings-manager.js'
import parseTorrent from 'parse-torrent'
import { randomBytes } from 'crypto'
import { validProxies, proxyKey } from './bt/proxy-tunnel.js'
const DEFAULT_TRACKERS = fs.readJsonSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'bt', 'trackers.json'))

const log = createLogger('protocols:bt')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let worker = null
let workerReady = false
/** Resolver for the in-flight "wait for worker ready" promise, if any. */
let onWorkerReady = null
const pendingRequests = new Map()
let requestId = 0

// The proxies of the VPN extension that is on (bt/vpn-watch.js), best first,
// or none. The worker goes through them and nothing else; a change starts a
// new worker (setTorrentProxies).
let torrentProxies = []
let proxyCredentials = null
// Logs the browser's own fetches in to the VPN's proxy (proxy-settings.js).
let proxyLogin = null
let networkSwitch = null
// Set when the VPN turns off under torrents. Until it comes back, or a torrent
// is started or resumed on purpose, nothing starts a worker without it: not a
// torrent page loading, nor its status checks.
let heldForVpn = false
let stateSaveTimer = null

// Cached status from worker push updates (no IPC round-trip needed for status)
const statusCache = new Map()
const uiApiTokens = new Map()
const UI_API_TOKEN_TTL_MS = 30 * 60 * 1000
const UI_API_TOKEN_MAX = 1000

// Persist all torrent states (active, paused, completed) so they survive restarts
let torrentStateCachePath = null
function getTorrentStateCachePath () {
  if (!torrentStateCachePath) {
    torrentStateCachePath = path.join(app.getPath('userData'), 'bt-state.json')
  }
  return torrentStateCachePath
}

function loadTorrentStateCache () {
  try {
    const cachePath = getTorrentStateCachePath()
    if (fs.existsSync(cachePath)) {
      const data = fs.readJsonSync(cachePath)
      for (const [hash, status] of Object.entries(data)) {
        statusCache.set(hash, status)
      }
      log.info(`[BT] Loaded ${Object.keys(data).length} torrent(s) from state cache`)
    }
  } catch (err) {
    log.error('[BT] Failed to load torrent state cache:', err.message)
  }
}

// How a torrent is saved for the next start: paused, with no peers or speeds,
// as nothing is connected by then.
function pausedForRestart (status) {
  return { ...status, paused: true, numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, timeRemaining: null }
}

let _savePending = null
const _saveQueue = new Map()
function saveTorrentState (infoHash, status) {
  _saveQueue.set(infoHash, status)
  if (_savePending) return
  _savePending = setTimeout(flushTorrentState, 500)
}

// Writes the queued states now: a worker starting reloads them from disk.
function flushTorrentState () {
  clearTimeout(_savePending)
  _savePending = null
  if (_saveQueue.size === 0) return
  try {
    const cachePath = getTorrentStateCachePath()
    const data = fs.existsSync(cachePath) ? fs.readJsonSync(cachePath) : {}
    for (const [hash, s] of _saveQueue) data[hash] = s
    _saveQueue.clear()
    fs.writeJsonSync(cachePath, data, { spaces: 2 })
  } catch (err) {
    log.error('[BT] Failed to save torrent state:', err.message)
  }
}

// Each torrent's .torrent file, which the worker keeps once its file list
// arrives and starts from when the torrent is seeded or resumed.
function getTorrentFilesPath () {
  return path.join(app.getPath('userData'), 'bt-torrents')
}

function removeTorrentState (infoHash) {
  try {
    const cachePath = getTorrentStateCachePath()
    if (fs.existsSync(cachePath)) {
      const data = fs.readJsonSync(cachePath)
      delete data[infoHash]
      fs.writeJsonSync(cachePath, data, { spaces: 2 })
    }
  } catch (err) {
    log.error('[BT] Failed to remove torrent state:', err.message)
  }
}

async function removeTorrentFilesFromDisk (status) {
  if (!status) return
  const basePath = path.resolve(
    status.downloadPath || path.join(app.getPath('downloads'), 'PeerskyTorrents')
  )

  // If we know the torrent name, remove its folder directly (handles multi-file torrents)
  if (status.name && status.name !== 'Fetching metadata...') {
    const torrentFolder = path.resolve(basePath, status.name)
    if (torrentFolder !== basePath && torrentFolder.startsWith(`${basePath}${path.sep}`)) {
      try {
        if (await fs.pathExists(torrentFolder)) {
          await fs.remove(torrentFolder)
          log.info(`[BT] Removed torrent folder: ${torrentFolder}`)
          return
        }
      } catch (err) {
        log.warn(`[BT] Failed to remove torrent folder ${torrentFolder}: ${err.message}`)
      }
    }
  }

  // Fallback: remove individual files from the files list
  if (!Array.isArray(status.files) || status.files.length === 0) return
  const uniquePaths = new Set()
  for (const file of status.files) {
    if (!file || typeof file.path !== 'string' || !file.path) continue
    const absPath = path.resolve(basePath, file.path)
    if (absPath !== basePath && !absPath.startsWith(`${basePath}${path.sep}`)) {
      continue
    }
    uniquePaths.add(absPath)
  }
  for (const absPath of uniquePaths) {
    try {
      await fs.remove(absPath)
    } catch (err) {
      log.warn(`[BT] Failed to remove file path ${absPath}: ${err.message}`)
    }
  }
}

function buildTrackerList (magnetUri) {
  const seen = new Set(DEFAULT_TRACKERS)
  const merged = [...DEFAULT_TRACKERS]
  try {
    const url = new URL(magnetUri)
    for (const tr of url.searchParams.getAll('tr')) {
      const t = (tr || '').trim()
      if (t && !seen.has(t)) {
        seen.add(t)
        merged.push(t)
      }
    }
  } catch {}
  return merged
}

function createUiApiToken () {
  pruneUiApiTokens()
  if (uiApiTokens.size >= UI_API_TOKEN_MAX) {
    const oldestToken = uiApiTokens.keys().next().value
    if (oldestToken) uiApiTokens.delete(oldestToken)
  }
  const token = randomBytes(24).toString('hex')
  uiApiTokens.set(token, Date.now() + UI_API_TOKEN_TTL_MS)
  return token
}

function pruneUiApiTokens () {
  const now = Date.now()
  for (const [token, expiresAt] of uiApiTokens.entries()) {
    if (expiresAt <= now) {
      uiApiTokens.delete(token)
    }
  }
}

function isValidUiApiToken (token) {
  if (!token) return false
  const expiresAt = uiApiTokens.get(token)
  if (!expiresAt) return false
  if (expiresAt <= Date.now()) {
    uiApiTokens.delete(token)
    return false
  }
  return true
}

// Memoised worker boot so a burst of bt:// requests forks exactly one worker.
let workerStarting = null

/**
 * Fork the WebTorrent worker if it is not running yet.
 *
 * Every entry point that talks to the worker goes through here, so the worker
 * can be forked on first use rather than at startup.
 *
 * @returns {Promise<void>}
 */
export function warmupBittorrent () {
  // While the VPN changes, the old worker is on its way out: wait for the new one.
  if (networkSwitch) return networkSwitch.then(startUnlessHeld, startUnlessHeld)
  return startUnlessHeld()
}

function startUnlessHeld () {
  return heldForVpn ? Promise.resolve() : startWorker()
}

function startWorker () {
  if (worker) return Promise.resolve()
  if (!workerStarting) {
    workerStarting = initializeWorker().catch((err) => {
      workerStarting = null
      throw err
    })
  }
  return workerStarting
}

async function initializeWorker () {
  if (worker) return

  loadTorrentStateCache()

  const downloadPath = path.join(app.getPath('downloads'), 'PeerskyTorrents')
  await fs.ensureDir(downloadPath)

  log.info('[BT] Forking WebTorrent worker process...')
  // Advanced serialization carries the bytes of a file read as they are,
  // where JSON would spell out every byte.
  // The VPN's proxies go in the environment, not the arguments, which any
  // process can list. They are no secret either way: the login is asked for
  // separately and kept in memory.
  const env = { ...process.env }
  delete env.PEERSKY_BT_PROXIES
  if (torrentProxies.length) env.PEERSKY_BT_PROXIES = JSON.stringify(torrentProxies)
  worker = fork(path.join(__dirname, 'bt', 'worker.js'), [downloadPath, getTorrentFilesPath()], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
    env
  })
  const child = worker

  // Forward worker stdout/stderr to main process console
  worker.stdout.on('data', (data) => {
    process.stdout.write(data)
  })
  worker.stderr.on('data', (data) => {
    process.stderr.write(data)
  })

  worker.on('message', (msg) => {
    if (msg.type === 'proxy-credentials-request') {
      answerProxyCredentials(child, msg)
      return
    }

    if (msg.type === 'ready') {
      log.info('[BT] Worker process ready')
      workerReady = true
      onWorkerReady?.()
      return
    }

    // Cache status updates from worker push
    if (msg.type === 'status-update' && msg.infoHash) {
      statusCache.set(msg.infoHash, msg)
      return
    }

    // Cache bulk status updates (multiple torrents in one message)
    if (msg.type === 'status-update-bulk' && msg.torrents) {
      msg.torrents.forEach(status => {
        if (status.infoHash) {
          statusCache.set(status.infoHash, { ...status, type: 'status-update' })
        }
      })
      return
    }

    // Cache done events — torrent is already destroyed in worker
    if (msg.type === 'done' && msg.infoHash) {
      const cached = statusCache.get(msg.infoHash)
      if (cached) {
        cached.done = true
        cached.downloadSpeed = 0
        cached.uploadSpeed = 0
        // Persist completed status to disk so it survives restarts
        saveTorrentState(msg.infoHash, cached)
      }
      return
    }

    // Clean up cache on torrent removal
    if (msg.type === 'removed' && msg.infoHash) {
      statusCache.delete(msg.infoHash)
      removeTorrentState(msg.infoHash)
    }

    if (msg.type === 'stopped' && msg.infoHash) {
      const prev = statusCache.get(msg.infoHash) || {}
      const merged = {
        ...prev,
        ...msg,
        mode: 'download',
        paused: true,
        stopped: true,
        isSeeding: false,
        seedingSince: null
      }
      statusCache.set(msg.infoHash, merged)
      saveTorrentState(msg.infoHash, merged)
    }

    // Resolve pending request if this message has an id
    if (msg.id && pendingRequests.has(msg.id)) {
      const resolve = pendingRequests.get(msg.id)
      pendingRequests.delete(msg.id)
      resolve(msg)
    }
  })

  worker.on('error', (err) => {
    log.error('[BT] Worker error:', err)
  })

  worker.on('exit', (code) => {
    log.info(`[BT] Worker exited with code ${code}`)
    worker = null
    workerReady = false
    // Clear the memo so the next torrent request forks a fresh worker.
    workerStarting = null

    // Save all active torrents to disk before clearing cache
    // Mark them as paused so they show resume button on restart
    try {
      const cachePath = getTorrentStateCachePath()
      const data = fs.existsSync(cachePath) ? fs.readJsonSync(cachePath) : {}
      for (const [hash, status] of statusCache.entries()) {
        if (!status.done) {
          data[hash] = pausedForRestart(status)
        }
      }
      fs.writeJsonSync(cachePath, data, { spaces: 2 })
      log.info(`[BT] Saved ${Object.keys(data).length} torrent state(s) on worker exit`)
    } catch (err) {
      log.error('[BT] Failed to save torrent states on exit:', err.message)
    }

    statusCache.clear()
    for (const resolve of pendingRequests.values()) resolve({ error: 'The torrent worker stopped' })
    pendingRequests.clear()
    // Reload persisted torrent states so they survive worker restarts
    loadTorrentStateCache()
  })

  // Wait for the worker's "ready" message (max 10s). Resolved by the message
  // handler above rather than polled, so a fast worker costs no extra latency.
  await new Promise((resolve) => {
    if (workerReady) return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      onWorkerReady = null
      resolve()
    }
    const timer = setTimeout(finish, 10000)
    timer.unref?.()
    onWorkerReady = finish
  })

  // Periodically save in-progress torrent states as crash safety net. Once:
  // a worker that starts again keeps the one timer.
  if (!stateSaveTimer) {
    stateSaveTimer = setInterval(() => {
      const active = Array.from(statusCache.entries()).filter(([, s]) => !s.done && s.progress > 0)
      if (active.length === 0) return
      try {
        const cachePath = getTorrentStateCachePath()
        const data = fs.existsSync(cachePath) ? fs.readJsonSync(cachePath) : {}
        for (const [hash, status] of active) data[hash] = pausedForRestart(status)
        fs.writeJsonSync(cachePath, data, { spaces: 2 })
      } catch {}
    }, 30000)
    stateSaveTimer.unref?.()
  }

  log.info('[BT] Worker initialized. Download path:', downloadPath)
}

// A login for the VPN's proxy, for the worker. Only for a proxy the browser
// picked, so the worker cannot ask the extension for any other server's.
async function answerProxyCredentials (child, msg) {
  let credentials = null
  try {
    const [proxy] = validProxies([msg.proxy])
    const known = proxy && torrentProxies.some((p) => proxyKey(p) === proxyKey(proxy))
    if (known && proxyCredentials) {
      credentials = await proxyCredentials(proxy, { realm: msg.realm, target: msg.target, stale: !!msg.stale })
    }
  } catch (err) {
    log.warn('[BT] Could not get the VPN proxy login:', err.message)
  }
  try {
    child.send({ type: 'proxy-credentials', requestId: msg.requestId, credentials: credentials || null })
  } catch {}
}

/**
 * Where the VPN extension's proxy logins come from:
 * (proxy, { realm, target, stale }) => { username, password } or null.
 */
export function setTorrentProxyCredentials (fn) {
  proxyCredentials = typeof fn === 'function' ? fn : null
}

/**
 * fn() logs the browser's own fetches in to the VPN's proxy, resolving true
 * when it did. A torrent file fetched before that is fetched again after it.
 */
export function setProxyLogin (fn) {
  proxyLogin = typeof fn === 'function' ? fn : null
}

/** The proxies torrents go through, best first; none means directly. */
export function getTorrentProxies () {
  return torrentProxies.map((p) => ({ ...p }))
}

/**
 * Torrents go through these proxies, a VPN extension's, or directly with
 * none. A change starts a new worker, so no connection made before it stays
 * open. Torrents that were running carry on through the new VPN. When the VPN
 * turns off they pause instead, so nothing goes on without it unnoticed, and
 * pick up again when it comes back on.
 */
export function setTorrentProxies (list) {
  const next = validProxies(list)
  if (JSON.stringify(next) === JSON.stringify(torrentProxies)) return Promise.resolve()
  const wasThroughVpn = torrentProxies.length > 0
  const nowThroughVpn = next.length > 0
  torrentProxies = next
  log.info(nowThroughVpn
    ? `[BT] Torrents go through the VPN extension (${next.length} proxy server${next.length === 1 ? '' : 's'})`
    : '[BT] No VPN extension on: torrents connect directly')
  const previous = networkSwitch || Promise.resolve()
  const current = previous.catch(() => {}).then(() => restartWorkerForNetwork(wasThroughVpn, nowThroughVpn))
  networkSwitch = current
  return current
    .catch((err) => log.error('[BT] Switching torrents to the new network failed:', err.message))
    .finally(() => { if (networkSwitch === current) networkSwitch = null })
}

// Torrents a new worker takes back up: those running, and those the VPN
// turning off paused.
function torrentsToCarryOver () {
  const list = []
  for (const [hash, s] of statusCache) {
    if (!s.magnetURI) continue
    const seeding = !!(s.isSeeding || (s.mode === 'seed' && s.done))
    const running = !s.paused && !s.stopped && (!s.done || seeding)
    if (!running && !s.pausedForVpn) continue
    list.push({ hash, magnetURI: s.magnetURI, mode: (seeding || s.mode === 'seed') ? 'seed' : 'download', running })
  }
  return list
}

// Lets the worker close its torrents and exit; forced after 5 s.
function stopWorkerForSwitch () {
  const child = worker
  if (!child) return Promise.resolve()
  return new Promise((resolve) => {
    const force = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000)
    force.unref?.()
    child.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    try {
      child.disconnect()
    } catch {
      try { child.kill() } catch {}
    }
  })
}

async function restartWorkerForNetwork (wasThroughVpn, nowThroughVpn) {
  if (workerStarting) await workerStarting.catch(() => {})
  const torrents = torrentsToCarryOver()
  // The exit handler saves what was running as paused and reloads the cache.
  if (worker) await stopWorkerForSwitch()
  heldForVpn = wasThroughVpn && !nowThroughVpn
  if (heldForVpn) {
    for (const t of torrents) {
      if (!t.running) continue
      const s = statusCache.get(t.hash)
      if (!s) continue
      const paused = { ...pausedForRestart(s), isSeeding: false, seedingSince: null, pausedForVpn: true }
      statusCache.set(t.hash, paused)
      saveTorrentState(t.hash, paused)
    }
    flushTorrentState()
    return
  }
  // What was running carries on; what the VPN turning off paused waits for a VPN.
  const carried = torrents.filter((t) => t.running || nowThroughVpn)
  if (!carried.length) return
  await startWorker()
  for (const t of carried) {
    const result = await sendCommand(t.mode === 'seed' ? 'seed' : 'start', {
      magnetUri: t.magnetURI,
      announce: buildTrackerList(t.magnetURI)
    }, { duringSwitch: true })
    if (result.error) {
      log.warn(`[BT] Could not carry ${t.hash} over to the new network:`, result.error)
      continue
    }
    const s = statusCache.get(t.hash)
    if (s) {
      delete s.pausedForVpn
      s.paused = false
      s.stopped = false
      // As a resume does: a download's saved state comes back with the next
      // save. A finished torrent's stays, or it would drop out of the list.
      if (!s.done) removeTorrentState(t.hash)
    }
  }
}

// Commands that run a torrent, and so may start a worker while the VPN is held off.
const RUNS_A_TORRENT = new Set(['start', 'seed', 'resume'])

async function sendCommand (action, params = {}, { timeout = 30000, duringSwitch = false } = {}) {
  // The worker is forked on first use, so any command may be the one that
  // starts it. A command from the VPN switch itself must not wait for it.
  await (duringSwitch ? startWorker() : warmupBittorrent())
  if (!worker && heldForVpn && !duringSwitch) {
    // Nothing runs while the VPN is held off, so there is nothing to pause,
    // stop or remove from a worker, and a file is read from disk.
    if (!RUNS_A_TORRENT.has(action)) {
      return action === 'read' ? { error: 'Torrents are paused while your VPN extension is off' } : { type: 'ok', infoHash: params.hash }
    }
    // Started or resumed on purpose: it goes on without the VPN.
    heldForVpn = false
    await startWorker()
  }
  return new Promise((resolve, reject) => {
    if (!worker) {
      return reject(new Error('Worker not initialized'))
    }
    const id = ++requestId
    pendingRequests.set(id, resolve)
    worker.send({ id, action, ...params })

    // A file read waits for its pieces as long as they take.
    if (!timeout) return
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id)
        resolve({ error: 'Request timed out' })
      }
    }, timeout)
  })
}

const WEBTORRENT_PREFIX = 'webtorrent:'
const MAX_TORRENT_FILE_BYTES = 10 * 1024 * 1024
const TORRENT_FILE_TIMEOUT_MS = 30000

/**
 * A magnet link for a read .torrent file, carrying what makes it quick to get:
 * its trackers, its web seeds (ws), and where the file itself is (xs), which
 * the worker fetches the file list from when no peer has it yet. The Internet
 * Archive's torrents are mostly web seeds.
 */
export function magnetFromTorrent (parsed, { source = null } = {}) {
  let magnetUri = `magnet:?xt=urn:btih:${parsed.infoHash}`
  if (parsed.name) magnetUri += `&dn=${encodeURIComponent(parsed.name)}`
  for (const tracker of parsed.announce || []) magnetUri += `&tr=${encodeURIComponent(tracker)}`
  for (const seed of parsed.urlList || []) magnetUri += `&ws=${encodeURIComponent(seed)}`
  if (source) magnetUri += `&xs=${encodeURIComponent(source)}`
  return magnetUri
}

/**
 * webtorrent:<http(s) address of a .torrent file>, the form the Internet
 * Archive and other sites link. The file is fetched and read here, and its
 * torrent opens on the same page a magnet link does.
 */
export async function resolveWebtorrentUrl (rawUrl, { fetch = net.fetch, logIn = proxyLogin } = {}) {
  const source = String(rawUrl || '').slice(WEBTORRENT_PREFIX.length).trim()
  let sourceUrl
  try {
    sourceUrl = new URL(source)
  } catch {
    throw new Error('A webtorrent: link needs the http or https address of a .torrent file after it.')
  }
  if (sourceUrl.protocol !== 'https:' && sourceUrl.protocol !== 'http:') {
    throw new Error('A webtorrent: link needs the http or https address of a .torrent file after it.')
  }

  const get = () => fetch(sourceUrl.href, { signal: AbortSignal.timeout(TORRENT_FILE_TIMEOUT_MS) })
  let response = await get()
  // A VPN extension's proxy that the browser has not logged in to yet.
  if (response.status === 407 && logIn && await logIn()) response = await get()
  if (!response.ok) throw new Error(`The torrent file could not be fetched (${response.status}).`)
  const declared = Number(response.headers.get('content-length'))
  if (declared > MAX_TORRENT_FILE_BYTES) throw new Error('That torrent file is too big to be one.')
  // Read in pieces, so a server that lies about the length cannot fill memory.
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_TORRENT_FILE_BYTES) throw new Error('That torrent file is too big to be one.')
    chunks.push(Buffer.from(chunk))
  }

  let parsed
  try {
    parsed = await parseTorrent(Buffer.concat(chunks))
  } catch {
    parsed = null
  }
  if (!parsed?.infoHash) throw new Error('That address did not give a .torrent file.')
  return {
    infoHash: parsed.infoHash,
    name: parsed.name || null,
    magnetUri: magnetFromTorrent(parsed, { source: sourceUrl.href })
  }
}

/**
 * Build the bt:// / bittorrent:// / magnet: / webtorrent: protocol handler.
 *
 * @param {object} [options]
 * @param {boolean} [options.lazy] - Fork the WebTorrent worker on the first
 *   torrent request instead of before this resolves. The browser passes this so
 *   startup never waits on the worker handshake.
 */
export async function createHandler ({ lazy = false } = {}) {
  if (!lazy) await warmupBittorrent()

  return async function protocolHandler (request) {
    await warmupBittorrent()
    const rawUrl = request.url
    log.debug(`[BT] Handling request: ${request.method} ${rawUrl}`)

    try {
      if (rawUrl.startsWith(WEBTORRENT_PREFIX)) {
        const torrent = await resolveWebtorrentUrl(rawUrl)
        const html = generateTorrentUI(torrent.magnetUri, torrent.infoHash, 'webtorrent', torrent.name, settingsManager.settings.theme || 'dark')
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        })
      }

      // Determine protocol from the raw URL
      let protocol; let infoHash; let magnetUri; let queryParams; let requestedTorrentPath = ''

      if (rawUrl.startsWith('magnet:')) {
        protocol = 'magnet'
        infoHash = extractInfoHash(rawUrl)
        magnetUri = rawUrl
        // Parse query params manually for magnet URLs
        const qIndex = rawUrl.indexOf('?')
        queryParams = qIndex >= 0 ? new URLSearchParams(rawUrl.slice(qIndex)) : new URLSearchParams()
      } else {
        // bt:// or bittorrent://
        const urlObj = new URL(rawUrl)
        protocol = urlObj.protocol.replace(':', '')
        queryParams = urlObj.searchParams
        if (urlObj.hostname) {
          infoHash = urlObj.hostname
          requestedTorrentPath = urlObj.pathname.replace(/^\/+/, '')
        } else {
          const fullPath = urlObj.pathname.replace(/^\/+/, '')
          const slashIndex = fullPath.indexOf('/')
          if (slashIndex >= 0) {
            infoHash = fullPath.slice(0, slashIndex)
            requestedTorrentPath = fullPath.slice(slashIndex + 1)
          } else {
            infoHash = fullPath
          }
        }
      }

      infoHash = await normalizeInfoHash(infoHash)

      const action = queryParams.get('action')

      // Handle API requests
      if (action === 'api') {
        const api = queryParams.get('api')
        return await handleAPI(api, queryParams, infoHash, request)
      }

      // Serve bt://<infohash>/<path> directly from downloaded torrent files when available.
      if (protocol !== 'magnet' && requestedTorrentPath) {
        return await serveTorrentFile(infoHash, requestedTorrentPath, request)
      }

      // Serve UI page (imported from bt/torrentPage.js)
      if (protocol === 'magnet') {
        magnetUri = magnetUri || rawUrl
      } else {
        magnetUri = `magnet:?xt=urn:btih:${infoHash}`
      }

      const displayName = queryParams.get('dn') || null
      const currentTheme = settingsManager.settings.theme || 'dark'
      const html = generateTorrentUI(magnetUri, infoHash, protocol, displayName, currentTheme)
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    } catch (err) {
      log.error('[BT] Failed to handle request:', err)
      return new Response(`Error: ${err.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      })
    }
  }
}

export function shutdownBittorrent () {
  // Save in-progress torrent states so they survive app restart
  try {
    const cachePath = getTorrentStateCachePath()
    const data = fs.existsSync(cachePath) ? fs.readJsonSync(cachePath) : {}
    for (const [hash, status] of statusCache.entries()) {
      if (!status.done) {
        data[hash] = pausedForRestart(status)
      }
    }
    fs.writeJsonSync(cachePath, data, { spaces: 2 })
    log.info(`[BT] Saved ${Object.keys(data).length} torrent state(s) on shutdown`)
  } catch (err) {
    log.error('[BT] Failed to save torrent states on shutdown:', err.message)
  }

  // Kill worker immediately — no async wait
  if (worker) {
    try { worker.kill('SIGKILL') } catch {}
    worker = null
    workerReady = false
    workerStarting = null
  }
}

export function setupBittorrentIpc () {
  ipcMain.handle('resolve-torrent-file', async (event, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.torrent')) {
        throw new Error('Invalid .torrent file path')
      }

      const buffer = await fs.readFile(filePath)
      const parsed = await parseTorrent(buffer)

      if (!parsed || !parsed.infoHash) {
        throw new Error('Could not extract infoHash from file')
      }

      return magnetFromTorrent(parsed)
    } catch (err) {
      log.error('[BT] IPC Error resolving torrent:', err.message)
      return null
    }
  })

  // The API token is handed out here rather than over bt:// because any web
  // page can fetch bt:// and read a response carrying CORS *.
  ipcMain.handle('bt-api-token', (event) => {
    if (!isTorrentUiUrl(event.senderFrame?.url)) throw new Error('Forbidden')
    return createUiApiToken()
  })
}

// The torrent pages and the manager. bt://<infohash>/<path> is a file the
// torrent holds, which gets no token: it may be a page from anyone.
function isTorrentUiUrl (rawUrl) {
  try {
    const { protocol, hostname, pathname } = new URL(rawUrl)
    if (protocol === 'peersky:') return hostname === 'bt-manager'
    if (protocol === 'bt:' || protocol === 'bittorrent:') return pathname === '' || pathname === '/'
    return protocol === 'magnet:' || protocol === 'webtorrent:'
  } catch {
    return false
  }
}

async function handleAPI (api, queryParams, infoHash, request) {
  const rawHash = queryParams.get('hash') || infoHash
  const hash = await normalizeInfoHash(rawHash)
  const token = request.headers?.get('x-bt-token')

  // This only rejects non-bt URLs; it cannot tell which page made the request.
  // Any origin can reach this API, so the token is what gates access.
  const requestUrl = request.url || ''
  const isBTRequest = requestUrl.startsWith('bt://') || requestUrl.startsWith('bittorrent://') || requestUrl.startsWith('magnet:')

  if (!isBTRequest) {
    log.warn(`[BT] API blocked: request not from BitTorrent protocol - url: ${requestUrl}`)
    return jsonResponse({ error: 'Forbidden: API only accessible from BitTorrent protocol' }, 403)
  }

  // Handle CORS preflight for custom headers
  if (request.method === 'OPTIONS') {
    return jsonResponse({ success: true }, 200, { allowCors: true })
  }

  // Security: mutations require POST method
  const mutationActions = ['start', 'seed', 'unseed', 'pause', 'resume', 'stop', 'remove']
  const isMutation = mutationActions.includes(api)
  // A torrent page asks for its status every two seconds.
  if (isMutation) log.info(`[BT] API call: ${api}${hash && hash !== 'api' ? `, hash: ${hash}` : ''}`)
  else log.debug(`[BT] API call: ${api}, hash: ${hash}`)
  if (isMutation && request.method !== 'POST') {
    return jsonResponse({ error: `${api} requires POST method` }, 405, { allowCors: false })
  }
  if ((isMutation || api === 'list') && !isValidUiApiToken(token)) {
    return jsonResponse({ error: 'Forbidden: invalid API token' }, 403, { allowCors: false })
  }

  try {
    if (api === 'start') {
      const magnetUri = queryParams.get('magnet')
      return await startTorrent(magnetUri, { allowCors: true })
    } else if (api === 'seed') {
      const magnetUri = queryParams.get('magnet')
      return await seedTorrent(magnetUri, hash, { allowCors: true })
    } else if (api === 'unseed') {
      return await unseedTorrent(hash, { allowCors: true })
    } else if (api === 'status') {
      // Serve from cache instantly — no IPC round-trip
      return getCachedStatus(hash)
    } else if (api === 'list') {
      // Return all cached torrents for manager pages.
      return getCachedTorrentList()
    } else if (api === 'pause') {
      return await pauseResumeTorrent('pause', hash, { allowCors: true })
    } else if (api === 'resume') {
      return await pauseResumeTorrent('resume', hash, { allowCors: true })
    } else if (api === 'stop') {
      return await stopTorrentSession(hash, { allowCors: true })
    } else if (api === 'remove') {
      return await removeTorrent(hash, { allowCors: true })
    } else {
      return jsonResponse({ error: 'Unknown API action' }, 400)
    }
  } catch (err) {
    log.error('[BT] API error:', err)
    return jsonResponse({ error: err.message }, 500)
  }
}

function jsonResponse (data, status = 200, { allowCors = true } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }
  if (allowCors) {
    headers['Access-Control-Allow-Origin'] = '*'
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-BT-Token'
  }
  return new Response(JSON.stringify(data), {
    status,
    headers
  })
}

async function addTorrentCommand (action, magnetUri, hash, responseOptions = {}) {
  try {
    let resolvedMagnet = magnetUri || null
    if (!resolvedMagnet && hash) {
      const cached = statusCache.get(hash)
      if (cached?.magnetURI) resolvedMagnet = cached.magnetURI
    }
    if (!resolvedMagnet) {
      return jsonResponse({ error: `${action} requires magnet URI` }, 400, responseOptions)
    }

    const decoded = decodeURIComponent(resolvedMagnet)
    const result = await sendCommand(action, {
      magnetUri: decoded,
      announce: buildTrackerList(decoded)
    })

    if (result.error) {
      return jsonResponse({ error: result.error }, 400, responseOptions)
    }

    const infoHash = result.infoHash || extractInfoHash(decoded)
    if (infoHash && !statusCache.has(infoHash)) {
      statusCache.set(infoHash, {
        infoHash,
        name: result.name || 'Fetching metadata...',
        mode: action === 'seed' ? 'seed' : 'download',
        magnetURI: decoded,
        downloadPath: path.join(app.getPath('downloads'), 'PeerskyTorrents'),
        progress: 0,
        downloaded: 0,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        done: false,
        paused: false,
        files: []
      })
    }

    return jsonResponse({
      success: true,
      infoHash,
      magnetURI: decoded,
      mode: action === 'seed' ? 'seed' : 'download'
    }, 200, responseOptions)
  } catch (err) {
    log.error(`[BT] ${action} error:`, err)
    return jsonResponse({ error: err.message }, 500, responseOptions)
  }
}

const startTorrent = (magnetUri, opts) => addTorrentCommand('start', magnetUri, null, opts)
const seedTorrent = (magnetUri, hash, opts) => addTorrentCommand('seed', magnetUri, hash, opts)

async function unseedTorrent (hash, responseOptions = {}) {
  try {
    if (!hash) {
      return jsonResponse({ error: 'unseed requires hash' }, 400, responseOptions)
    }
    const result = await sendCommand('unseed', { hash })
    if (result.error) return jsonResponse({ error: result.error }, 404, responseOptions)
    const cached = statusCache.get(hash)
    if (cached) {
      cached.mode = 'download'
      cached.isSeeding = false
      cached.seedingSince = null
      cached.paused = true
      cached.downloadSpeed = 0
      cached.uploadSpeed = 0
      cached.numPeers = 0
      cached.timeRemaining = null
      saveTorrentState(hash, cached)
    }
    return jsonResponse({ success: true, infoHash: hash, mode: 'download', paused: true }, 200, responseOptions)
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, responseOptions)
  }
}

function getCachedStatus (hash) {
  if (!hash) {
    // Return first available torrent status
    if (statusCache.size > 0) {
      const first = statusCache.values().next().value
      const { type: _t, ...data } = first
      return jsonResponse({ ...data, throughVpn: torrentProxies.length > 0 })
    }
    return jsonResponse({ error: 'No active torrents' }, 404)
  }

  const cached = statusCache.get(hash)
  if (cached) {
    const { type: _t, ...data } = cached
    return jsonResponse({ ...data, throughVpn: torrentProxies.length > 0 })
  }

  return jsonResponse({ error: 'Torrent not found in cache' }, 404)
}

function getCachedTorrentList () {
  const torrents = Array.from(statusCache.values())
    .map((cached) => {
      const { type: _t, ...data } = cached
      return data
    })
    .sort((a, b) => {
      const nameA = (a.name || '').toLowerCase()
      const nameB = (b.name || '').toLowerCase()
      if (nameA !== nameB) return nameA.localeCompare(nameB)
      return (a.infoHash || '').localeCompare(b.infoHash || '')
    })

  return jsonResponse({ torrents, throughVpn: torrentProxies.length > 0 })
}

async function pauseResumeTorrent (action, hash, responseOptions = {}) {
  try {
    const result = await sendCommand(action, { hash })
    if (result.error) {
      // Resume failed — torrent may not be in worker after restart
      if (action === 'resume') {
        const cached = statusCache.get(hash)
        if (cached && cached.magnetURI) {
          const activeSeederExists = Array.from(statusCache.entries()).some(([otherHash, status]) => {
            if (otherHash === hash) return false
            return status && (status.isSeeding || status.mode === 'seed') && !status.paused
          })
          if (activeSeederExists) {
            return jsonResponse({ error: 'Cannot resume while another torrent is actively seeding. Stop that seeding session first.' }, 409, responseOptions)
          }
          log.info(`[BT] Torrent not in worker, re-starting from cache: ${hash}`)
          removeTorrentState(hash)
          statusCache.delete(hash)
          if (cached.mode === 'seed') {
            return await seedTorrent(cached.magnetURI, hash, responseOptions)
          }
          return await startTorrent(cached.magnetURI, responseOptions)
        }
      }
      return jsonResponse({ error: result.error }, 404, responseOptions)
    }
    // Persist paused status so it survives restarts
    if (action === 'pause') {
      const cached = statusCache.get(hash)
      if (cached) {
        cached.paused = true
        saveTorrentState(hash, cached)
      }
    } else if (action === 'resume') {
      removeTorrentState(hash)
    }
    return jsonResponse({ success: true, paused: action === 'pause' }, 200, responseOptions)
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, responseOptions)
  }
}

async function removeTorrent (hash, responseOptions = {}) {
  try {
    if (!hash) return jsonResponse({ error: 'remove requires hash' }, 400, responseOptions)
    const cached = statusCache.get(hash)
    const result = await sendCommand('remove', { hash })
    if (result.error && !cached) {
      return jsonResponse({ error: result.error }, 404, responseOptions)
    }
    if (cached) {
      await removeTorrentFilesFromDisk(cached)
      statusCache.delete(hash)
      removeTorrentState(hash)
    }
    await fs.remove(path.join(getTorrentFilesPath(), `${hash}.torrent`)).catch(() => {})
    return jsonResponse({ success: true, removed: true, filesDeleted: !!cached }, 200, responseOptions)
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, responseOptions)
  }
}

async function stopTorrentSession (hash, responseOptions = {}) {
  try {
    if (!hash) return jsonResponse({ error: 'stop requires hash' }, 400, responseOptions)
    const result = await sendCommand('stop', { hash })
    if (result.error) return jsonResponse({ error: result.error }, 404, responseOptions)
    const cached = statusCache.get(hash)
    if (cached) {
      cached.mode = 'download'
      cached.paused = true
      cached.stopped = true
      cached.isSeeding = false
      cached.seedingSince = null
      cached.downloadSpeed = 0
      cached.uploadSpeed = 0
      cached.numPeers = 0
      saveTorrentState(hash, cached)
    }
    return jsonResponse({ success: true, stopped: true, infoHash: hash }, 200, responseOptions)
  } catch (err) {
    return jsonResponse({ error: err.message }, 500, responseOptions)
  }
}

function extractInfoHash (magnetUrl) {
  try {
    // First try to decode the URL to handle URL-encoded parameters
    const decodedUrl = decodeURIComponent(magnetUrl)

    // Extract using regex
    const match = decodedUrl.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
    if (match) {
      return match[1].toLowerCase()
    }

    // If that fails, try to parse as URL
    const url = new URL(decodedUrl)
    const xt = url.searchParams.get('xt')
    if (xt) {
      const btihMatch = xt.match(/^urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})$/i)
      if (btihMatch) {
        return btihMatch[1].toLowerCase()
      }
    }

    return null
  } catch (err) {
    log.warn('[BT] Failed to extract infoHash:', err.message)
    return null
  }
}

function normalizeTorrentPath (input) {
  if (!input) return ''
  let decoded = input
  try {
    decoded = decodeURIComponent(input)
  } catch (err) {
    // Keep raw input if decode fails; we'll still normalize separators.
  }
  const normalized = path.posix.normalize(decoded.replace(/\\/g, '/')).replace(/^\/+/, '')
  if (normalized.startsWith('..')) return null
  return normalized
}

async function normalizeInfoHash (rawHash) {
  if (!rawHash || typeof rawHash !== 'string') return rawHash
  const trimmed = rawHash.trim()
  if (!trimmed) return trimmed
  try {
    const parsed = await parseTorrent(`magnet:?xt=urn:btih:${trimmed}`)
    if (parsed && parsed.infoHash) {
      return parsed.infoHash.toLowerCase()
    }
  } catch (_err) {
    // Fallback for plain hex values parse-torrent doesn't accept in this context.
  }
  if (/^[a-fA-F0-9]{40}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  return trimmed
}

// A file a torrent holds opens in a tab at bt://<infohash>/<path>, the torrent
// page's own origin. It runs sandboxed, in an origin of its own, so a page in a
// torrent cannot reach the torrent controls, and it gets no access to local
// files the way a file:// page does. The PDF viewer cannot run sandboxed, and
// a PDF runs no page script.
const TORRENT_FILE_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads'

/**
 * The byte range a video or audio player asks for: start-end, start- or
 * -suffix. null serves the whole file; false is a range past its end.
 */
export function parseByteRange (header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match || (match[1] === '' && match[2] === '')) return null
  let start
  let end = size - 1
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]))
  } else {
    start = Number(match[1])
    if (match[2] !== '') end = Math.min(Number(match[2]), size - 1)
  }
  if (start >= size || start > end) return false
  return { start, end }
}

async function serveTorrentFile (infoHash, requestedPath, request) {
  const cached = statusCache.get(infoHash)
  if (!cached) {
    return new Response('Torrent not found. Start or resume it first.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }

  const relativePath = normalizeTorrentPath(requestedPath)
  if (!relativePath) {
    return new Response('Invalid torrent file path', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }

  const files = Array.isArray(cached.files) ? cached.files : []
  const match = files.find((f) => normalizeTorrentPath(f.path) === relativePath)
  if (!match) {
    return new Response(`File not found in torrent: ${relativePath}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }

  const basePath = path.resolve(cached.downloadPath || path.join(app.getPath('downloads'), 'PeerskyTorrents'))
  const filePath = path.resolve(basePath, match.path)
  if (filePath !== basePath && !filePath.startsWith(`${basePath}${path.sep}`)) {
    return new Response('Forbidden path', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }

  const contentType = playableContentType(filePath)
  const headers = {
    'Content-Type': contentType.startsWith('text/') ? `${contentType}; charset=utf-8` : contentType,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff'
  }
  if (contentType !== 'application/pdf') headers['Content-Security-Policy'] = TORRENT_FILE_CSP

  const fromWorker = await serveThroughWorker(infoHash, cached, match, filePath, request, headers)
  if (fromWorker) return fromWorker

  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile()) {
    return new Response(`File not available on disk yet: ${relativePath}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }

  const range = parseByteRange(request?.headers?.get('range'), stat.size)
  if (range === false) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } })
  }
  if (range) {
    return new Response(fs.createReadStream(filePath, range), {
      status: 206,
      headers: {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
        'Content-Length': String(range.end - range.start + 1)
      }
    })
  }
  return new Response(fs.createReadStream(filePath), {
    status: 200,
    headers: { ...headers, 'Content-Length': String(stat.size) }
  })
}

let fileReadCount = 0

// A file of a torrent still downloading in the worker is read through it, as
// its bytes on disk may not have arrived yet (see bt/file-reads.js). A finished
// file, or a torrent the worker does not have, such as a stopped one, is read
// from disk.
async function serveThroughWorker (infoHash, cached, file, filePath, request, headers) {
  if (!worker || cached.done || cached.stopped || file.progress >= 1 || !(file.length > 0)) return null
  const range = parseByteRange(request?.headers?.get('range'), file.length)
  if (range === false) {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${file.length}` } })
  }
  const { start, end } = range || { start: 0, end: file.length - 1 }
  const stream = ++fileReadCount
  let offset = start
  const readNext = async () => {
    const result = await sendCommand('read', { stream, hash: infoHash, path: file.path, start: offset, end }, { timeout: 0 })
    return result.data?.length ? result.data : null
  }

  const first = await readNext()
  if (!first) return null
  let pending = first
  let disk = null
  const body = new ReadableStream({
    async pull (controller) {
      try {
        let chunk = pending
        pending = null
        // The torrent finished or stopped partway, so the rest is read from disk.
        if (!chunk && !disk) chunk = await readNext()
        if (!chunk) {
          disk = disk || fs.createReadStream(filePath, { start: offset, end })[Symbol.asyncIterator]()
          const next = await disk.next()
          if (next.done) return controller.close()
          chunk = next.value
        }
        offset += chunk.length
        controller.enqueue(chunk)
        if (offset > end) controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
    cancel () {
      if (disk) disk.return()
      else {
        try { worker?.send({ action: 'read-close', stream }) } catch {}
      }
    }
  })

  if (!range) {
    return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(file.length) } })
  }
  return new Response(body, {
    status: 206,
    headers: {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${file.length}`,
      'Content-Length': String(end - start + 1)
    }
  })
}
