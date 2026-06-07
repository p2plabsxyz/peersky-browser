import path from 'path'
import os from 'os'
import { ipfsPublishFile, ipfsFetchToFile } from '../protocols/ipfs-handler.js'
import { hyperPublishFile, hyperFetchToFile } from '../protocols/hyper-handler.js'
import { createLogger } from '../logger.js'

const log = createLogger('backup')

// Extract a bare CID from a user-supplied content address. Accepts a raw CID,
// "ipfs://<cid>", or "ipfs://<cid>/path"; rejects anything else.
export function parseIpfsAddress (input) {
  if (!input || typeof input !== 'string') throw new Error('A CID or ipfs:// link is required')
  let value = input.trim()
  if (value.startsWith('ipfs://')) value = value.slice('ipfs://'.length)
  value = value.replace(/^\/+/, '').split('/')[0].split('?')[0]
  if (!value) throw new Error('Could not read a CID from the input')
  return value
}

// Publish a backup zip to a P2P network and return its content address.
// protocol: 'ipfs' (default) returns a CID, 'hyper' returns a hyper:// URL.
export async function uploadBackup (zipPath, protocol = 'ipfs') {
  if (protocol === 'hyper') {
    const res = await hyperPublishFile(zipPath)
    log.info(`Backup published to Hyper: ${res.address}`)
    return { protocol: 'hyper', key: res.key, address: res.address }
  }
  const cid = await ipfsPublishFile(zipPath)
  log.info(`Backup published to IPFS: ${cid}`)
  return { protocol: 'ipfs', cid, address: `ipfs://${cid}` }
}

// Download a backup from a CID/ipfs:// or hyper:// address to a temp .zip.
export async function downloadBackupFromAddress (address) {
  const dest = path.join(os.tmpdir(), `peersky-cid-restore-${Date.now()}.zip`)
  const trimmed = (address || '').trim()
  if (trimmed.startsWith('hyper://')) {
    log.info(`Fetching backup from Hyper: ${trimmed}`)
    await hyperFetchToFile(trimmed, dest)
    return dest
  }
  const cid = parseIpfsAddress(trimmed)
  log.info(`Fetching backup from IPFS: ${cid}`)
  await ipfsFetchToFile(cid, dest)
  return dest
}
