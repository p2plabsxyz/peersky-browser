import { createLogger } from '../logger.js'

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

export async function _hyperFetchToFile (fetchFn, waitForDriveReady, address, destPath, onStatus) {
  // The Hyperswarm DHT needs time to discover the hosting peer, especially
  // across different networks. Retry with backoff before giving up.
  const MAX_ATTEMPTS = 5
  const BASE_DELAY_MS = 3000
  let lastError

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Wait for drive readiness INSIDE the retry loop so peers are re-discovered
    await waitForDriveReady(address)

    const resp = await fetchFn(address)
    if (resp.ok && resp.body) {
      const { createWriteStream } = await import('fs')
      const { Readable } = await import('stream')
      const { pipeline } = await import('stream/promises')
      await pipeline(Readable.fromWeb(resp.body), createWriteStream(destPath))
      return destPath
    }

    lastError = new Error(
      resp.status === 404
        ? `Hyper fetch failed: 404. The file was not found at the address '${address}'.`
        : `Hyper fetch failed: ${resp.status}`
    )

    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_DELAY_MS * attempt
      if (typeof onStatus === 'function') {
        onStatus(`Attempt ${attempt} of ${MAX_ATTEMPTS} failed (status ${resp.status}). Retrying in ${delay / 1000}s...`)
      }
      log.info(`Hyper fetch attempt ${attempt}/${MAX_ATTEMPTS} returned ${resp.status}, retrying in ${delay}ms...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}
