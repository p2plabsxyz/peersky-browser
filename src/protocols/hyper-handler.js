import { Readable } from 'stream'
import path from 'path'
import { app, safeStorage } from 'electron'
import { create as createSDK } from 'hyper-sdk'
import makeHyperFetch from 'hypercore-fetch'
import {
  initChat,
  handleChatRequest as handleChatRequestP2P,
  CHAT_STORAGE
} from '../pages/p2p/peerchat/p2p.js'
import { createLogger } from '../logger.js'
import { hyperCache, saveHyperCache } from './config.js'
import { enforceExtensionWritePolicy } from '../extensions/request-policy.js'

const log = createLogger('protocols:hyper')

// Single SDK and swarm for the app lifecycle (hyper:// browsing + chat share the same swarm).
let sdk, fetch, savedSdkOptions

// keep chunks smaller to avoid oversized blocks.
const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024

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
  fetch = makeHyperFetch({ sdk, writable: true })

  initChat(sdk, {
    safeStorage,
    storagePath: path.join(app.getPath('userData'), CHAT_STORAGE)
  })

  log.info('Hyper SDK initialized.')
  return fetch
}

// Close the corestore entirely so its RocksDB state is strictly frozen on disk.
export async function suspendHyper () {
  if (sdk == null) return
  log.info('Closing Hyper SDK entirely for backup...')
  await sdk.close()
  sdk = null
  fetch = null
}

// Reopen the corestore after a backup copy completes.
export async function resumeHyper () {
  log.info('Re-initializing Hyper SDK after backup...')
  await initializeHyperSDK()
}

// Publish a file into a fresh writable Hyperdrive and return its shareable
// hyper:// address. Used by the backup feature to share via a content address.
export async function hyperPublishFile (filePath, fileName = 'backup.zip') {
  const f = await initializeHyperSDK()
  const driveName = `peersky-backup-${Date.now()}`

  // Resolve the drive's public key (hypercore-fetch returns it for ?key=).
  // Use hyper://localhost/ as the host, which is the required format.
  const keyResp = await f(`hyper://localhost/?key=${driveName}`, { method: 'POST' })
  const keyText = await keyResp.text()
  log.info(`hyperPublishFile ?key= status: ${keyResp.status}, text: ${keyText}`)

  const match = keyText.match(/([0-9a-zA-Z]{52,64})/)
  const driveKey = match ? match[1] : null
  if (!driveKey) throw new Error(`Could not resolve Hyperdrive key. Response status: ${keyResp.status}, text: ${keyText}`)

  const { createReadStream } = await import('fs')
  const body = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  const putResp = await f(`hyper://${driveKey}/${encodeURIComponent(fileName)}`, {
    method: 'PUT',
    body,
    duplex: 'half'
  })
  if (!putResp.ok) throw new Error(`Hyperdrive write failed: ${putResp.status}`)

  log.info(`Backup published to Hyperdrive: ${driveKey}`)
  return { key: driveKey, fileName, address: `hyper://${driveKey}/${fileName}` }
}

// Stream a hyper:// file address to destPath on disk.
export async function hyperFetchToFile (address, destPath) {
  const f = await initializeHyperSDK()
  const resp = await f(address)
  if (!resp.ok || !resp.body) {
    if (resp.status === 404) {
      throw new Error(`Hyper fetch failed: 404. The file was not found at the address '${address}'. This typically means either the peer hosting the file is offline, or the file doesn't exist on that drive.`)
    }
    throw new Error(`Hyper fetch failed: ${resp.status}`)
  }
  const { createWriteStream } = await import('fs')
  const { Readable } = await import('stream')
  const { pipeline } = await import('stream/promises')
  await pipeline(Readable.fromWeb(resp.body), createWriteStream(destPath))
  return destPath
}

export async function createHandler (options, securityOptions = {}) {
  const { isExtensionWriteAllowed } = securityOptions
  await initializeHyperSDK(options)

  return async function protocolHandler (req) {
    const { url, method } = req
    const urlObj = new URL(url)
    const protocol = urlObj.protocol.replace(':', '')
    const pathname = urlObj.pathname

    log.info(`Handling request: ${method} ${url}`)

    // Intercept Hyperdrive key generation/retrieval
    if (method === 'POST' && urlObj.searchParams.has('key')) {
      const keyName = urlObj.searchParams.get('key')
      try {
        const fetchFn = await initializeHyperSDK()
        const resp = await fetchFn(url, {
          method,
          headers: req.headers,
          body: getChunkedBody(req),
          duplex: 'half'
        })
        if (resp.status === 200) {
          const buffer = await resp.arrayBuffer()
          const driveKeyStr = Buffer.from(buffer).toString()
          log.info('Extracted raw key response:', driveKeyStr)

          const match = driveKeyStr.match(/([0-9a-zA-Z]{52,64})/)
          if (match) {
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
              log.info(`Logged Hyperdrive to cache: ${keyName} (${driveKey})`)
            } else {
              existingEntry.timestamp = timestamp
              if (keyName && (existingEntry.name === 'Drive' || !existingEntry.name)) {
                existingEntry.name = keyName
              }
              saveHyperCache()
              log.info(`Updated Hyperdrive in cache: ${keyName} (${driveKey})`)
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
  const fetchFn = await initializeHyperSDK()
  const upperMethod = method.toUpperCase()
  const hasBody = upperMethod !== 'GET' && upperMethod !== 'HEAD'

  try {
    log.info(`[handleHyperRequest] Fetching: ${method} ${url}`)
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
