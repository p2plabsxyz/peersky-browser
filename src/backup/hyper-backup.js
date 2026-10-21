import path from 'path'
import { createLogger } from '../logger.js'
import { downloadLimit } from './download-limit.js'

const log = createLogger('backup:hyper')

export async function _suspendHyper (sdk, onSuspend) {
  if (sdk == null) return
  log.info('Closing Hyper SDK entirely for backup...')
  await sdk.close()
  if (onSuspend) onSuspend()
}

export async function _hyperPublishFile (fetchFn, sdk, filePath, fileName = 'backup.zip') {
  const driveName = `peersky-backup-${Date.now()}`

  // Request a new hyperdrive key from hypercore-fetch
  const keyResp = await fetchFn(`hyper://localhost/?key=${driveName}`, { method: 'POST' })
  const keyText = await keyResp.text()
  log.info(`hyperPublishFile ?key= status: ${keyResp.status}, text: ${keyText}`)

  // hypercore-fetch returns the key as a full hyper:// URL, e.g. hyper://key/
  // Extract just the hostname (the actual key) from the response.
  let driveKey = null
  try {
    const url = new URL(keyText.trim())
    if (url.protocol === 'hyper:') driveKey = url.hostname
  } catch (e) {}

  // Fallback: extract alphanumeric key via regex if URL parsing fails
  if (!driveKey || driveKey.length < 52) {
    const match = keyText.match(/([0-9a-zA-Z]{52,64})/)
    driveKey = match ? match[1] : null
  }

  if (!driveKey) throw new Error(`Could not resolve Hyperdrive key. Response status: ${keyResp.status}, text: ${keyText}`)

  const { createReadStream } = await import('fs')
  const body = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
  const putResp = await fetchFn(`hyper://${driveKey}/${encodeURIComponent(fileName)}`, {
    method: 'PUT',
    body,
    duplex: 'half'
  })
  if (!putResp.ok) throw new Error(`Hyperdrive write failed: ${putResp.status}`)

  // Flush swarm announcement so the drive is discoverable before returning
  if (sdk) {
    try {
      const drive = await sdk.getDrive(`hyper://${driveKey}/`)
      await sdk.joinCore(drive.core)
      if (sdk.swarm && typeof sdk.swarm.flush === 'function') {
        await sdk.swarm.flush()
      }
      log.info(`Swarm announcement flushed for drive ${driveKey}`)
    } catch (err) {
      log.error(`Failed to flush swarm announcement for ${driveKey}:`, err)
    }
  }

  log.info(`Backup published to Hyperdrive: ${driveKey}`)
  return { key: driveKey, fileName, address: `hyper://${driveKey}/${fileName}` }
}

// A download that goes quiet is looked for again, then given up on. A phone
// that locks its screen or goes to the background stops sending, and the
// connection it had is gone when it comes back. Without looking again, the
// download sat on its first message until hyperswarm's next refresh, about
// ten minutes later, or for good.
export const STALL_LOOK_AGAIN_MS = 15 * 1000
export const STALL_GIVE_UP_MS = 2 * 60 * 1000
// What has to come within STALL_GIVE_UP_MS for a download to count as going.
// A few bytes now and then is not a transfer, and kept one open for good.
export const PROGRESS_BYTES = 64 * 1024

export const NOBODY_SHARING = 'Nobody is sharing this right now. Open PeerSky on the device that sent it, keep it open with its screen on, then paste the link again. A link from Link Device works for 15 minutes.'
export const STOPPED_SENDING = 'The other device stopped sending. Open PeerSky on it, keep it open with its screen on, then paste the link again.'
export const NOT_ANSWERING = 'The other device is not answering. Open PeerSky on it, keep it open with its screen on, then paste the link again.'
const WAITING = 'Waiting for the other device. Keep PeerSky open on it, with its screen on.'

/**
 * @param {Function} fetchFn
 * @param {Function} waitForDriveReady
 * @param {string} address
 * @param {string} destPath
 * @param {Function} [onStatus] Gets a line of text to show.
 * @param {object} [options]
 * @param {Function} [options.lookAgain] Looks for the drive's peers again.
 * @param {number} [options.retryDelayMs] The wait before the second try,
 *   growing by as much again for each try after.
 * @param {Function} [options.freeBytes] Free bytes in a folder, for tests.
 */
export async function _hyperFetchToFile (fetchFn, waitForDriveReady, address, destPath, onStatus, options = {}) {
  // The Hyperswarm DHT needs time to discover the hosting peer, especially
  // across different networks. Retry with backoff before giving up.
  const MAX_ATTEMPTS = 5
  const BASE_DELAY_MS = options.retryDelayMs ?? 3000
  const status = (message) => { if (typeof onStatus === 'function') onStatus(message) }
  let lastError

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Wait for drive readiness INSIDE the retry loop so peers are re-discovered
    await waitForDriveReady(address)

    // A device found but not answering, such as a phone whose screen locked,
    // holds the request open, so it is watched like a quiet download.
    const resp = await untilAnswered(fetchFn(address), status, options)
    if (resp.ok && resp.body) {
      try {
        await saveDownload(resp, destPath, status, options)
      } catch (error) {
        // What came is of no use, and can be large.
        const { rm } = await import('fs/promises')
        await rm(destPath, { force: true }).catch(() => {})
        throw error
      }
      return destPath
    }

    lastError = new Error(resp.status === 404 ? NOBODY_SHARING : `Hyper fetch failed: ${resp.status}`)

    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * attempt
      status(resp.status === 404
        ? `Looking for the device that sent it (try ${attempt + 1} of ${MAX_ATTEMPTS})...`
        : `Attempt ${attempt} of ${MAX_ATTEMPTS} failed (status ${resp.status}). Retrying in ${delay / 1000}s...`)
      log.info(`Hyper fetch attempt ${attempt}/${MAX_ATTEMPTS} returned ${resp.status}, retrying in ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

function watchOptions (options) {
  return {
    lookAgain: options.lookAgain || (async () => {}),
    stallMs: options.stallMs ?? STALL_LOOK_AGAIN_MS,
    giveUpMs: options.giveUpMs ?? STALL_GIVE_UP_MS,
    tickMs: options.tickMs ?? 1000
  }
}

function lookAgainNow (lookAgain) {
  Promise.resolve().then(lookAgain).catch((error) => log.warn(`Looking for peers again failed: ${error.message}`))
}

async function untilAnswered (request, status, options) {
  const { lookAgain, stallMs, giveUpMs, tickMs } = watchOptions(options)
  const started = Date.now()
  let lookedAt = 0
  let watch = null
  const gaveUp = new Promise((resolve, reject) => {
    watch = setInterval(() => {
      const waited = Date.now() - started
      if (waited >= giveUpMs) {
        reject(new Error(NOT_ANSWERING))
      } else if (waited >= stallMs && Date.now() - lookedAt >= stallMs) {
        lookedAt = Date.now()
        status(WAITING)
        lookAgainNow(lookAgain)
      }
    }, tickMs)
  })
  try {
    return await Promise.race([request, gaveUp])
  } finally {
    clearInterval(watch)
  }
}

async function saveDownload (resp, destPath, status, options) {
  const { lookAgain, stallMs, giveUpMs, tickMs } = watchOptions(options)
  const { createWriteStream } = await import('fs')
  const { Readable, Transform } = await import('stream')
  const { pipeline } = await import('stream/promises')

  const total = Number(resp.headers?.get?.('content-length')) || 0
  const { limit, overLimit } = await downloadLimit(path.dirname(destPath), total, options.freeBytes)
  let received = 0
  let lastByteAt = Date.now()
  let progressAt = lastByteAt
  let progressBytes = 0
  let shownAt = 0
  let lookedAt = 0
  let stopped = null
  const controller = new AbortController()

  status(describeDownload(0, total))
  const counter = new Transform({
    transform (chunk, _encoding, done) {
      received += chunk.length
      if (received > limit) {
        stopped = new Error(overLimit)
        done(stopped)
        return
      }
      lastByteAt = Date.now()
      if (received - progressBytes >= PROGRESS_BYTES) {
        progressAt = lastByteAt
        progressBytes = received
      }
      if (lastByteAt - shownAt >= 500) {
        shownAt = lastByteAt
        status(describeDownload(received, total))
      }
      done(null, chunk)
    }
  })
  const watch = setInterval(() => {
    const quiet = Date.now() - lastByteAt
    if (Date.now() - progressAt >= giveUpMs) {
      stopped = new Error(STOPPED_SENDING)
      controller.abort(stopped)
    } else if (quiet >= stallMs && Date.now() - lookedAt >= stallMs) {
      lookedAt = Date.now()
      status(WAITING)
      lookAgainNow(lookAgain)
    }
  }, tickMs)

  try {
    await pipeline(Readable.fromWeb(resp.body), counter, createWriteStream(destPath), { signal: controller.signal })
  } catch (error) {
    throw stopped || error
  } finally {
    clearInterval(watch)
  }
}

export function describeDownload (received, total) {
  const mb = (bytes) => {
    const value = bytes / (1024 * 1024)
    return value < 10 ? value.toFixed(1) : String(Math.round(value))
  }
  if (total > 0) return `Downloading: ${mb(received)} of ${mb(total)} MB`
  return received > 0 ? `Downloading: ${mb(received)} MB` : 'Downloading...'
}
