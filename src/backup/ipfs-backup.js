import { CID } from 'multiformats/cid'
import { createLogger } from '../logger.js'

const log = createLogger('backup:ipfs')

export async function provideCidWithRetry (node, cid, options = {}) {
  const {
    maxAttempts = 3,
    retryDelayMs = 10_000,
    timeoutMs,
    label = cid.toString(),
    startTime = Date.now()
  } = options

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const peerCount = typeof node.libp2p.getPeers === 'function' ? node.libp2p.getPeers().length : 0
    log.info(`Providing ${label} (attempt ${attempt}/${maxAttempts}, peers: ${peerCount})`)
    try {
      const provideOptions = timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined
      await node.libp2p.contentRouting.provide(cid, provideOptions)
      log.info(`Provided ${label} in ${Date.now() - startTime}ms`)
      return true
    } catch (err) {
      log.warn(`Provide attempt ${attempt} failed for ${label}: ${err.message}`)
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, retryDelayMs))
      }
    }
  }

  log.error(`Failed to provide ${label} after ${maxAttempts} attempts`)
  return false
}

export async function _suspendIPFS (node) {
  if (node) {
    log.info('Stopping IPFS node for backup...')
    await node.stop()
  }
}

export async function _resumeIPFS (node) {
  if (node) {
    log.info('Resuming IPFS node after backup...')
    await node.start()
  }
}

export async function _ipfsPublishFile (node, unixFs, filePath) {
  if (!unixFs || !node) throw new Error('IPFS node is not ready yet')
  const { createReadStream } = await import('fs')
  const startTime = Date.now()
  const cid = await unixFs.addByteStream(createReadStream(filePath))
  try {
    for await (const pinned of node.pins.add(cid, { recursive: true })) {
      if (!pinned) continue
    }
  } catch (e) {
    log.warn(`Failed to pin backup CID ${cid.toString()}: ${e.message}`)
  }

  provideCidWithRetry(node, cid, {
    label: cid.toString(),
    startTime,
    timeoutMs: 60_000
  }).catch((err) => {
    log.warn(`Failed to provide backup CID ${cid.toString()}: ${err.message}`)
  })

  return cid.toString()
}

export async function _ipfsFetchToFile (unixFs, cidStr, destPath, onStatus) {
  if (!unixFs) throw new Error('IPFS node is not ready yet')
  const { createWriteStream } = await import('fs')
  const { pipeline } = await import('stream/promises')
  const { Readable } = await import('stream')
  const cid = CID.parse(cidStr)

  let totalBytes = 0
  const notify = (msg) => {
    if (typeof onStatus === 'function') onStatus(msg)
  }

  async function * trackProgress (iterable) {
    for await (const chunk of iterable) {
      totalBytes += chunk.length
      notify(`Downloading from IPFS... ${totalBytes} bytes received`)
      yield chunk
    }
  }

  await pipeline(
    Readable.from(trackProgress(unixFs.cat(cid))),
    createWriteStream(destPath)
  )
  return destPath
}
