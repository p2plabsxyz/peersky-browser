import { Readable } from 'stream'
import path from 'path'
import os from 'os'
import { promises as fs } from 'fs'
import { app, safeStorage } from 'electron'
import { create as createSDK } from 'hyper-sdk'
import HyperDHTmDNS from '@p2plabs/hyperdht-mdns'
import makeHyperFetch from 'hypercore-fetch'
import {
  initChat,
  handleChatRequest as handleChatRequestP2P,
  CHAT_STORAGE
} from '../pages/p2p/peerchat/p2p.js'
import { createLogger } from '../logger.js'
import { hyperCache, saveHyperCache } from './config.js'
import { enforceExtensionWritePolicy } from '../extensions/request-policy.js'
import {
  getExistingNamedDrive,
  HYPERDRIVE_PRIVATE_DRIVE_NAME,
  resolveHyperdriveUploadTarget
} from './hyper-drive-visibility.js'

import { _suspendHyper, _hyperPublishFile, _hyperFetchToFile } from '../backup/hyper-backup.js'

const log = createLogger('protocols:hyper')

// Single SDK and swarm for the app lifecycle (hyper:// browsing + chat share the same swarm).
let sdk, fetch, privateSdk, privateFetch, privateDriveHostname, savedSdkOptions
const ephemeralPublishers = new Set()

// keep chunks smaller to avoid oversized blocks.
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_HYPERDRIVE_NAME_LENGTH = 255

function getLANOptions () {
  const port = Number.parseInt(process.env.PEERSKY_LAN_PORT || '', 10)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}
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

async function initializeHyperSDK (options) {
  if (sdk != null && fetch != null) return fetch

  if (options) savedSdkOptions = options
  else options = savedSdkOptions

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

function getPrivateSDKOptions (options) {
  const { corestore, dnsCache, swarm, ...isolatedOptions } = options || {}
  const storage = isolatedOptions.storage || path.join(app.getPath('userData'), 'hyper')
  return {
    ...isolatedOptions,
    storage: path.join(path.dirname(storage), `${path.basename(storage)}-private`),
    autoJoin: false,
    doReplicate: false
  }
}

function rememberPrivateDrive (drive) {
  try {
    privateDriveHostname = new URL(drive.url).hostname
  } catch {
    privateDriveHostname = null
  }
}

function formatHyperUrlForLog (value) {
  try {
    const parsed = new URL(value)
    if (privateDriveHostname && parsed.hostname === privateDriveHostname) {
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

async function initializePrivateHyperSDK (options) {
  if (privateSdk != null && privateFetch != null) return privateFetch

  const privateOptions = getPrivateSDKOptions(options || savedSdkOptions)
  const openedSdk = await createSDK(privateOptions)
  try {
    const openedFetch = await makeHyperFetch({ sdk: openedSdk, writable: true })
    const existingDrive = await getExistingNamedDrive(openedSdk, {
      driveName: HYPERDRIVE_PRIVATE_DRIVE_NAME,
      autoJoin: false
    })
    if (existingDrive) rememberPrivateDrive(existingDrive)
    privateSdk = openedSdk
    privateFetch = openedFetch
    return privateFetch
  } catch (error) {
    await openedSdk.close().catch(() => {})
    throw error
  }
}

async function getHyperRequestContext (url) {
  await initializePrivateHyperSDK()
  const hostname = new URL(url).hostname
  if (privateDriveHostname && hostname === privateDriveHostname) {
    return { sdk: privateSdk, fetch: privateFetch, private: true }
  }
  return { sdk, fetch: await initializeHyperSDK(), private: false }
}

// Close the corestore entirely so its RocksDB state is strictly frozen on disk.
export async function suspendHyper () {
  const results = await Promise.allSettled([
    _suspendHyper(privateSdk, () => {
      privateSdk = null
      privateFetch = null
      privateDriveHostname = null
    }),
    _suspendHyper(sdk, () => {
      sdk = null
      fetch = null
    })
  ])
  const failure = results.find((result) => result.status === 'rejected')
  if (!failure) return

  await Promise.allSettled([
    initializeHyperSDK(),
    initializePrivateHyperSDK()
  ])
  throw failure.reason
}

// Reopen the corestore after a backup copy completes.
export async function resumeHyper () {
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

async function waitForDriveReady (url) {
  if (!sdk) return
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname
    if (!hostname || hostname === 'localhost') return
    const drive = await sdk.getDrive(`hyper://${hostname}/`)
    if (drive.writable || drive.core.length > 0) return

    log.info(`Waiting for peers for ${hostname}...`)
    if (typeof drive.core.findingPeers === 'function') {
      const finding = drive.core.findingPeers()
      await sdk.joinCore(drive.core)
      await finding
    }
    await drive.update()
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

export async function createHandler (options, securityOptions = {}) {
  const { isExtensionWriteAllowed } = securityOptions
  await initializeHyperSDK(options)
  await initializePrivateHyperSDK(options)

  return async function protocolHandler (req) {
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

    log.info(`Handling request: ${method} ${formatHyperUrlForLog(url)}`)

    if (isKeyRequest) {
      try {
        let resp
        const visibility = urlObj.searchParams.get('visibility')
        if (visibility !== null) {
          const target = resolveHyperdriveUploadTarget(visibility)
          if (!target) {
            return new Response('Visibility must be public or private.', {
              status: 400,
              headers: { 'Content-Type': 'text/plain' }
            })
          }
          const targetSdk = visibility === 'private' ? privateSdk : sdk
          const drive = await targetSdk.getDrive(target.driveName, {
            autoJoin: target.autoJoin
          })
          if (visibility === 'private') rememberPrivateDrive(drive)
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
  const { fetch: fetchFn } = await getHyperRequestContext(url)
  const upperMethod = method.toUpperCase()
  const hasBody = upperMethod !== 'GET' && upperMethod !== 'HEAD'

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
