import { Readable } from 'stream'
import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { app, safeStorage } from 'electron'
import { create as createSDK } from 'hyper-sdk'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import makeHyperFetch from 'hypercore-fetch'
import hypercoreCrypto from 'hypercore-crypto'
import z32 from 'z32'
import {
  initChat,
  handleChatRequest as handleChatRequestP2P,
  CHAT_STORAGE
} from '../pages/p2p/peerchat/p2p.js'
import { createLogger } from '../logger.js'
import { hyperCache, saveHyperCache } from './config.js'
import { enforceExtensionWritePolicy } from '../extensions/request-policy.js'
import { resolveHyperdriveUploadTarget } from './hyper-drive-visibility.js'
import { rememberPrivateHyperdrive } from './private-hyperdrive-registry.js'
import { openPrivateDriveByName, makePrivateDriveFetcher } from './private-hyperdrive.js'

import { _suspendHyper, _hyperPublishFile, _hyperFetchToFile } from '../backup/hyper-backup.js'

const log = createLogger('protocols:hyper')

// Single SDK and swarm for the app lifecycle (hyper:// browsing + chat share the same swarm).
let sdk, fetch, privateSdk, privateFetch, privateKeyedFetch, savedSdkOptions
const privateDriveHostnames = new Set()
const ephemeralPublishers = new Set()

let privateDeviceOnly = process.env.PEERSKY_PRIVATE_DEVICE_ONLY === '1'

export function setPrivateHyperdriveDeviceOnly (value) {
  privateDeviceOnly = Boolean(value)
}

// keep chunks smaller to avoid oversized blocks.
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_HYPERDRIVE_NAME_LENGTH = 255

// bonjour-service defaults a published service's host to os.hostname(), which
// on macOS is the machine's own <name>.local. Announcing an authoritative A
// record for that name makes macOS believe another device has claimed its
// hostname, so it renames itself and shows the "already in use on this network"
// warning. The service name is already unique per peer key, so advertise that
// as the host instead. Peers resolve each other from the packet's source
// address, so discovery is unaffected.
export function withPeerLocalHost (adapter) {
  const advertise = adapter.advertise.bind(adapter)
  adapter.advertise = (record, handlers) => advertise(
    record?.name ? { ...record, host: `${record.name}.local` } : record,
    handlers
  )
  return adapter
}

function createLANAdapter () {
  const Adapter = HyperDHTmDNS.BonjourAdapter
  if (typeof Adapter !== 'function') return null
  return withPeerLocalHost(new Adapter())
}

function getLANOptions () {
  const port = Number.parseInt(process.env.PEERSKY_LAN_PORT || '', 10)
  const options = Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}
  const adapter = createLANAdapter()
  return adapter ? { ...options, adapter } : options
}

function wireLANEvents (instance) {
  instance.on('warning', (error) => log.warn(`[LAN] ${error.message}`))
  instance.on('error', (error) => log.error(`[LAN] ${error.message}`))
  return instance
}

async function attachLANDiscovery (activeSdk) {
  const instance = await HyperDHTmDNS.attachHyperSDK(activeSdk, getLANOptions())
  return wireLANEvents(instance)
}

function isWebReadableStream (body) {
  return body && typeof body.getReader === 'function'
}

function isAsyncIterable (body) {
  return body && typeof body[Symbol.asyncIterator] === 'function'
}

async function * readWebStream (stream) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) yield value
    }
  } finally {
    if (reader.releaseLock) reader.releaseLock()
  }
}

async function * chunkAsyncIterable (iterable, chunkSize) {
  for await (const chunk of iterable) {
    if (chunk == null) continue
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(chunk)
    for (let offset = 0; offset < buf.length; offset += chunkSize) {
      yield buf.subarray(offset, offset + chunkSize)
    }
  }
}

function getChunkedBody (req) {
  const body = req.body
  if (!body) return body

  const contentType = req.headers?.get?.('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    return body
  }

  const iterable = isWebReadableStream(body)
    ? readWebStream(body)
    : isAsyncIterable(body)
      ? body
      : null

  if (!iterable) {
    if (Buffer.isBuffer(body)) {
      return Readable.from(chunkAsyncIterable([body], MAX_UPLOAD_CHUNK_BYTES))
    }
    if (body instanceof Uint8Array) {
      const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
      return Readable.from(chunkAsyncIterable([buf], MAX_UPLOAD_CHUNK_BYTES))
    }
    if (body instanceof ArrayBuffer) {
      return Readable.from(
        chunkAsyncIterable([Buffer.from(body)], MAX_UPLOAD_CHUNK_BYTES)
      )
    }
    if (typeof body === 'string') {
      return Readable.from(
        chunkAsyncIterable([Buffer.from(body)], MAX_UPLOAD_CHUNK_BYTES)
      )
    }
    return body
  }
  return Readable.from(chunkAsyncIterable(iterable, MAX_UPLOAD_CHUNK_BYTES))
}

// Memoised boot. Without it a burst of hyper:// requests arriving while the SDK
// is still coming up would each start their own corestore.
let sdkStarting = null
let privateSdkStarting = null

// True while a backup has closed the corestore to freeze it on disk. The SDK
// now boots on demand, so requests arriving mid-backup have to be refused
// rather than allowed to reopen the store underneath the copy.
let isSuspended = false

function initializeHyperSDK (options) {
  if (sdk != null && fetch != null) return Promise.resolve(fetch)
  if (options) savedSdkOptions = options
  if (!sdkStarting) {
    sdkStarting = startHyperSDK(savedSdkOptions).catch((err) => {
      sdkStarting = null
      throw err
    })
  }
  return sdkStarting
}

/**
 * Boot the Hyper SDK if it is not up yet. Exported so startup can warm it in
 * the background once the first window is on screen.
 *
 * @returns {Promise<void>}
 */
export async function warmupHyper () {
  if (isSuspended) return
  if (!savedSdkOptions && sdk == null) return
  await initializeHyperSDK()
}

async function startHyperSDK (options) {
  log.info('Initializing Hyper SDK...')

  sdk = await createSDK(options)

  let lan = null
  try {
    lan = await attachLANDiscovery(sdk)
    log.info(`[LAN] Listening on ${lan.host || '0.0.0.0'}:${lan.port}`)
  } catch (err) {
    log.warn(`[LAN] Local discovery unavailable, continuing without it: ${err.message}`)
  }

  if (lan) {
    let lastKnownIP = lan.host
    let cycling = false
    const NETWORK_CHECK_MS = 10_000
    setInterval(async () => {
      if (cycling) return
      try {
        const currentIP = HyperDHTmDNS.selectLocalIPv4()
        if (currentIP === lastKnownIP) return
        log.info(`[LAN] Network change detected: ${lastKnownIP} -> ${currentIP}`)
        cycling = true

        try {
          const previous = lan
          lan = null
          if (previous && !previous.destroyed) await previous.destroy()
          const next = await attachLANDiscovery(sdk)
          lan = next
          lastKnownIP = next.host
          log.info(`[LAN] Restarted discovery on ${next.host}:${next.port}`)
        } catch (err) {
          lan = null
          log.warn(`[LAN] Network change recovery failed: ${err.message}`)
        } finally {
          cycling = false
        }
      } catch {
        // No usable interface, ignore
      }
    }, NETWORK_CHECK_MS).unref()
  }

  fetch = await makeHyperFetch({ sdk, writable: true })

  initChat(sdk, {
    safeStorage,
    storagePath: path.join(app.getPath('userData'), CHAT_STORAGE)
  })

  log.info('Hyper SDK initialized.')
  return fetch
}

function getPrivateSDKOptions (options, deviceOnly) {
  const { corestore, dnsCache, swarm, ...isolatedOptions } = options || {}
  const storage = isolatedOptions.storage || path.join(app.getPath('userData'), 'hyper')
  const privateStorage = path.join(path.dirname(storage), `${path.basename(storage)}-private`)
  if (deviceOnly) {
    return {
      ...isolatedOptions,
      storage: privateStorage,
      autoJoin: false,
      doReplicate: false
    }
  }
  return {
    ...isolatedOptions,
    storage: privateStorage,
    autoJoin: true,
    doReplicate: true
  }
}

function rememberPrivateDrive (drive) {
  try {
    privateDriveHostnames.add(new URL(drive.url).hostname)
  } catch {}
}

function decodeHyperdriveKey (hostname) {
  try {
    if (hostname.length === 52) return z32.decode(hostname)
    if (/^[0-9a-f]{64}$/i.test(hostname)) return Buffer.from(hostname, 'hex')
  } catch {}
  return null
}

async function isStoredPrivateDrive (hostname) {
  if (privateDriveHostnames.has(hostname)) return true
  const key = decodeHyperdriveKey(hostname)
  if (!key) return false
  await initializePrivateHyperSDK()
  const discoveryKey = hypercoreCrypto.discoveryKey(key)
  if (!await privateSdk.corestore.storage.hasCore(discoveryKey)) return false
  privateDriveHostnames.add(hostname)
  return true
}

function formatHyperUrlForLog (value) {
  try {
    const parsed = new URL(value)
    if (privateDriveHostnames.has(parsed.hostname)) {
      return `hyper://[private]${parsed.pathname}`
    }
  } catch {}
  return value
}

function isValidHyperdriveName (value) {
  if (typeof value !== 'string') return false
  const characters = Array.from(value)
  return characters.length <= MAX_HYPERDRIVE_NAME_LENGTH &&
    !characters.some((character) => {
      const code = character.codePointAt(0)
      return code <= 31 || (code >= 127 && code <= 159)
    })
}

function initializePrivateHyperSDK (options) {
  if (privateSdk != null && privateFetch != null) return privateFetch

  if (!privateSdkStarting) {
    privateSdkStarting = startPrivateHyperSDK(options).catch((error) => {
      privateSdkStarting = null
      throw error
    })
  }
  return privateSdkStarting
}

async function startPrivateHyperSDK (options) {
  const privateOptions = getPrivateSDKOptions(options || savedSdkOptions, privateDeviceOnly)
  const openedSdk = await createSDK(privateOptions)
  try {
    const openedFetch = await makeHyperFetch({ sdk: openedSdk, writable: true })
    privateSdk = openedSdk
    privateFetch = openedFetch
    privateKeyedFetch = makePrivateDriveFetcher(openedSdk, app.getPath('userData'))
    return privateFetch
  } catch (error) {
    await openedSdk.close().catch(() => {})
    throw error
  }
}

async function getHyperRequestContext (url) {
  const hostname = new URL(url).hostname
  if (await isStoredPrivateDrive(hostname)) {
    return {
      sdk: privateSdk,
      fetch: privateDeviceOnly ? privateFetch : privateKeyedFetch,
      private: true
    }
  }
  const publicFetch = await initializeHyperSDK()
  return { sdk, fetch: publicFetch, private: false }
}

// Close the corestore entirely so its RocksDB state is strictly frozen on disk.
// A backup needs the store reopened if closing fails, but a quit does not:
// reopening RocksDB moments before the process exits is how a clean shutdown
// turns back into a torn one, so shutdown passes recover: false.
export async function suspendHyper ({ recover = true } = {}) {
  isSuspended = true
  const results = await Promise.allSettled([
    _suspendHyper(privateSdk, () => {
      privateSdk = null
      privateFetch = null
      privateSdkStarting = null
      privateDriveHostnames.clear()
    }),
    _suspendHyper(sdk, () => {
      sdk = null
      fetch = null
      sdkStarting = null
    })
  ])
  const failure = results.find((result) => result.status === 'rejected')
  if (!failure) return
  if (!recover) throw failure.reason

  isSuspended = false
  await Promise.allSettled([
    initializeHyperSDK(),
    initializePrivateHyperSDK()
  ])
  throw failure.reason
}

// Reopen the corestore after a backup copy completes.
export async function resumeHyper () {
  isSuspended = false
  if (!savedSdkOptions) return
  log.info('Re-initializing Hyper SDK after backup...')
  await initializeHyperSDK()
  await initializePrivateHyperSDK()
}

// Publish a file into a fresh writable Hyperdrive and return its shareable
// hyper:// address. Used by the backup feature to share via a content address.
export async function hyperPublishFile (filePath, fileName = 'backup.zip', options = {}) {
  if (options.ephemeral) {
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-transfer-hyper-'))
    let publisher
    try {
      const publisherSdk = await createSDK({ ...(savedSdkOptions || {}), storage })
      const publisherFetch = await makeHyperFetch({ sdk: publisherSdk, writable: true })
      const result = await _hyperPublishFile(publisherFetch, publisherSdk, filePath, fileName)
      const cleanup = async () => {
        if (!publisher || !ephemeralPublishers.delete(publisher)) return
        clearTimeout(publisher.timer)
        await publisherSdk.close().catch(() => {})
        await fs.rm(storage, { recursive: true, force: true }).catch(() => {})
      }
      const ttlMs = Math.max(1000, Number(options.ttlMs) || 10 * 60 * 1000)
      publisher = { sdk: publisherSdk, storage, cleanup, timer: setTimeout(cleanup, ttlMs) }
      publisher.timer.unref()
      ephemeralPublishers.add(publisher)
      return result
    } catch (error) {
      if (publisher) await publisher.cleanup()
      else await fs.rm(storage, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }
  const f = await initializeHyperSDK()
  return _hyperPublishFile(f, sdk, filePath, fileName)
}

// A drive nobody is seeding must not hold a tab open forever, so the wait is
// bounded and the caller serves whatever the drive has once it expires.
const PEER_WAIT_MS = 15000

export async function waitForDriveReady (url, timeoutMs = PEER_WAIT_MS) {
  if (!sdk) return
  try {
    const { hostname } = new URL(url)
    if (!hostname || hostname === 'localhost') return
    const drive = await sdk.getDrive(`hyper://${hostname}/`)
    if (drive.writable || drive.core.length > 0) return

    log.info(`Waiting for peers for ${hostname}...`)
    // findingPeers() hands back the release callback, and holding it open is
    // the only thing that makes update() wait for a peer rather than return
    // straight away against a core that has replicated nothing yet. Awaiting
    // the callback instead of calling it, as this did before, both skipped the
    // wait and leaked the counter. Releasing twice is safe: it is once-guarded.
    const done = typeof drive.core.findingPeers === 'function'
      ? drive.core.findingPeers()
      : null

    let timer = null
    try {
      // Inside the try: if the SDK is torn down by a backup between here and
      // the race, the throw must still reach the finally that releases the
      // counter, or this drive waits the full timeout on every later request.
      if (done) sdk.swarm.flush().then(done, done)
      await Promise.race([
        drive.core.update({ wait: true }),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
      ])
    } finally {
      if (timer) clearTimeout(timer)
      if (done) done()
    }
    log.info(`Finished waiting for peers for ${hostname}, core length is now ${drive.core.length}`)
  } catch (err) {
    log.error(`Error waiting for peers for ${url}:`, err)
  }
}

// Stream a hyper:// file address to destPath on disk.
export async function hyperFetchToFile (address, destPath, onStatus) {
  const context = await getHyperRequestContext(address)
  const prepare = context.private ? async () => {} : waitForDriveReady
  return _hyperFetchToFile(context.fetch, prepare, address, destPath, onStatus)
}

/**
 * Build the hyper:// protocol handler.
 *
 * @param {object} options - hyper-sdk options.
 * @param {object} [securityOptions]
 * @param {Function} [securityOptions.isExtensionWriteAllowed]
 * @param {boolean} [securityOptions.lazy] - Start the SDK on the first hyper://
 *   request instead of before this resolves. The browser passes this so the
 *   first window paints without waiting on the swarm.
 */
export async function createHandler (options, securityOptions = {}) {
  const { isExtensionWriteAllowed, lazy = false } = securityOptions
  if (options) savedSdkOptions = options
  if (!lazy) {
    await Promise.all([
      initializeHyperSDK(options),
      initializePrivateHyperSDK(options)
    ])
  }

  return async function protocolHandler (req) {
    if (isSuspended) {
      return new Response('Hyper is unavailable while a backup is in progress', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' }
      })
    }
    await initializeHyperSDK()
    const { url, method } = req
    const urlObj = new URL(url)
    const protocol = urlObj.protocol.replace(':', '')
    const pathname = urlObj.pathname

    // Intercept Hyperdrive key generation/retrieval
    const isKeyRequest = method === 'POST' && urlObj.searchParams.has('key')
    const keyName = isKeyRequest ? urlObj.searchParams.get('key') : null
    if (isKeyRequest && !isValidHyperdriveName(keyName)) {
      return new Response('Hyperdrive name is invalid or too long.', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' }
      })
    }

    if (!isKeyRequest) await isStoredPrivateDrive(urlObj.hostname)
    log.info(`Handling request: ${method} ${formatHyperUrlForLog(url)}`)

    if (isKeyRequest) {
      try {
        let resp
        const visibility = urlObj.searchParams.get('visibility')
        if (visibility !== null) {
          const target = resolveHyperdriveUploadTarget(visibility, keyName)
          if (!target) {
            return new Response('Visibility must be public or private.', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' }
            })
          }
          let drive
          if (visibility === 'private') {
            await initializePrivateHyperSDK()
            drive = privateDeviceOnly
              ? await privateSdk.getDrive(target.driveName, { autoJoin: target.autoJoin })
              : await openPrivateDriveByName(privateSdk, target.driveName, {
                userDataDir: app.getPath('userData'),
                autoJoin: true
              })
            rememberPrivateDrive(drive)
            if (privateKeyedFetch?.register) {
              privateKeyedFetch.register(new URL(drive.url).hostname, drive)
            }
            await rememberPrivateHyperdrive(app.getPath('userData'), {
              name: keyName,
              url: drive.url,
              timestamp: Date.now(),
              encrypted: !privateDeviceOnly
            })
          } else {
            drive = await sdk.getDrive(target.driveName, { autoJoin: target.autoJoin })
          }
          resp = new Response(drive.url, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' }
          })
        } else {
          const fetchFn = await initializeHyperSDK()
          resp = await fetchFn(url, {
            method,
            headers: req.headers,
            body: getChunkedBody(req),
            duplex: 'half'
          })
        }
        if (resp.status === 200) {
          const buffer = await resp.arrayBuffer()
          const driveKeyStr = Buffer.from(buffer).toString()
          log.info('Extracted raw key response:', formatHyperUrlForLog(driveKeyStr))

          const match = driveKeyStr.match(/([0-9a-zA-Z]{52,64})/)
          if (match && visibility !== 'private') {
            const driveKey = match[1]
            const timestamp = Date.now()
            const existingEntry = hyperCache.find(entry => entry.key === driveKey)
            if (!existingEntry) {
              hyperCache.push({
                name: keyName || 'Drive',
                key: driveKey,
                timestamp,
                type: 'drive'
              })
              saveHyperCache()
              log.info(`Logged Hyperdrive to cache: ${keyName} (${visibility === 'private' ? 'private' : driveKey})`)
            } else {
              existingEntry.timestamp = timestamp
              if (keyName && (existingEntry.name === 'Drive' || !existingEntry.name)) {
                existingEntry.name = keyName
              }
              saveHyperCache()
              log.info(`Updated Hyperdrive in cache: ${keyName} (${visibility === 'private' ? 'private' : driveKey})`)
            }
          }
          return new Response(buffer, {
            status: resp.status,
            headers: Object.fromEntries(resp.headers)
          })
        }
        return resp
      } catch (err) {
        log.error('Error handling Hyperdrive key request:', err)
        return new Response(`Error handling Hyperdrive key request: ${err.message}`, {
          status: 500,
          headers: { 'Content-Type': 'text/plain' }
        })
      }
    }

    try {
      const denied = await enforceExtensionWritePolicy({
        request: req,
        scheme: 'hyper',
        isExtensionWriteAllowed
      })
      if (denied) return denied

      if (
        protocol === 'hyper' &&
        (urlObj.hostname === 'chat' || pathname.startsWith('/chat'))
      ) {
        return await handleChatRequestP2P(req, sdk)
      } else {
        return await handleHyperRequest(req)
      }
    } catch (err) {
      log.error('Failed to handle Hyper request:', err)
      return new Response(`Error handling Hyper request: ${err.message}`, {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      })
    }
  }
}

// Handle general hyper:// requests (not chat API).
async function handleHyperRequest (req) {
  const { url, method = 'GET', headers } = req
  const context = await getHyperRequestContext(url)
  const fetchFn = context.fetch
  const upperMethod = method.toUpperCase()
  const hasBody = upperMethod !== 'GET' && upperMethod !== 'HEAD'

  // Without this the first read of a drive races replication and hypercore-fetch
  // answers "Peers Not Found" against a core of length zero, which is why a page
  // only appeared after two or three refreshes. A private drive is local, and a
  // write creates content rather than reading it, so neither needs to wait.
  if (!context.private && !hasBody) {
    await waitForDriveReady(url)
  }

  try {
    log.info(`[handleHyperRequest] Fetching: ${method} ${formatHyperUrlForLog(url)}`)
    const resp = await fetchFn(url, {
      method,
      headers,
      body: hasBody ? getChunkedBody(req) : undefined,
      ...(hasBody ? { duplex: 'half' } : {})
    })

    log.info('Response received:', resp.status)
    return resp
  } catch (err) {
    log.error('Failed to fetch from Hyper SDK:', err)
    return new Response(`Error fetching data: ${err.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    })
  }
}
