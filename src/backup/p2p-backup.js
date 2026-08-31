import path from 'path'
import os from 'os'
import { ipfsPublishFile, ipfsFetchToFile } from '../protocols/ipfs-handler.js'
import { hyperPublishFile, hyperFetchToFile } from '../protocols/hyper-handler.js'
import { createLogger } from '../logger.js'
import { ipfsCache, hyperCache, saveIpfsCache, saveHyperCache } from '../protocols/config.js'
import { validateUploadEnvelope } from './backup-envelope.js'

const log = createLogger('backup')

// Extract a bare CID from a user-supplied content address. Accepts a raw CID,
// "ipfs://<cid>", or "ipfs://<cid>/path"; rejects anything else.
export function parseIpfsAddress (input) {
  if (!input || typeof input !== 'string') throw new Error('A CID or ipfs:// link is required')
  let value = input.trim()
  if (value.startsWith('ipfs://')) {
    value = value.slice('ipfs://'.length)
  } else if (value.includes('://')) {
    throw new Error('Only raw CIDs or ipfs:// links are supported')
  }
  value = value.replace(/^\/+/, '').split('/')[0].split('?')[0]
  if (!value) throw new Error('Could not read a CID from the input')
  return value
}

// Publish a backup zip to a P2P network and return its content address.
// protocol: 'ipfs' (default) returns a CID, 'hyper' returns a hyper:// URL.
export async function uploadBackup (zipPath, protocol = 'ipfs', options = {}) {
  await validateUploadEnvelope(zipPath)
  const uploadName = 'Backup ' + new Date().toLocaleString()

  if (protocol === 'hyper') {
    const res = await hyperPublishFile(zipPath, 'backup.zip', options)
    log.info(`Backup published to Hyper: ${res.address}`)
    if (!options.ephemeral) {
      hyperCache.push({
        name: uploadName,
        key: res.key,
        url: res.address,
        timestamp: Date.now(),
        type: 'drive'
      })
      saveHyperCache()
    }
    return { protocol: 'hyper', key: res.key, address: res.address }
  }
  const cid = await ipfsPublishFile(zipPath)
  log.info(`Backup published to IPFS: ${cid}`)
  ipfsCache.push({
    cid,
    timestamp: Date.now(),
    url: `ipfs://${cid}/`,
    name: uploadName
  })
  saveIpfsCache()
  return { protocol: 'ipfs', cid, address: `ipfs://${cid}` }
}

// Download a backup from a CID/ipfs:// or hyper:// address to a temp .zip.
// onStatus receives { message } updates for UI display.
export async function downloadBackupFromAddress (address, onStatus) {
  const dest = path.join(os.tmpdir(), `peersky-cid-restore-${Date.now()}.zip`)
  let trimmed = (address || '').trim()
  const restoreName = 'Restored Backup ' + new Date().toLocaleString()
  const notify = (message) => {
    if (typeof onStatus === 'function') onStatus({ message })
  }

  if (trimmed.startsWith('hyper://')) {
    let hostname = ''
    try {
      const urlObj = new URL(trimmed)
      hostname = urlObj.hostname
      if (urlObj.pathname === '/' || urlObj.pathname === '') {
        trimmed = `hyper://${urlObj.hostname}/backup.zip`
      }
    } catch (e) {}
    notify('Connecting to Hyper peer...')
    log.info(`Fetching backup from Hyper: ${trimmed}`)
    await hyperFetchToFile(trimmed, dest, notify)

    if (hostname) {
      const existing = hyperCache.find(entry => entry.key === hostname)
      if (existing) {
        existing.timestamp = Date.now()
      } else {
        hyperCache.push({
          name: restoreName,
          key: hostname,
          url: trimmed,
          timestamp: Date.now(),
          type: 'drive'
        })
      }
      saveHyperCache()
    }
    return dest
  }

  const cid = parseIpfsAddress(trimmed)
  notify('Connecting to IPFS network...')
  log.info(`Fetching backup from IPFS: ${cid}`)
  notify('Downloading backup from IPFS...')
  await ipfsFetchToFile(cid, dest, notify)
  notify('Download complete, verifying...')

  const existingIpfs = ipfsCache.find(entry => entry.cid === cid)
  if (existingIpfs) {
    existingIpfs.timestamp = Date.now()
  } else {
    ipfsCache.push({
      cid,
      timestamp: Date.now(),
      url: `ipfs://${cid}/`,
      name: restoreName
    })
  }
  saveIpfsCache()

  return dest
}
