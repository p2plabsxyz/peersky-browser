import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import { app } from 'electron'
import fsExtra from 'fs-extra'
import { createLogger } from '../logger.js'
import { readManifest, verifyManifest } from './backup-core.js'
import { createIdentityTransferZip, decryptIdentityTransferZip, extractAndVerifyIdentityPayload, isIdentityTransferManifest } from './identity-transfer.js'
import { suspendHyper, resumeHyper } from '../protocols/hyper-handler.js'
import { suspendIPFS, resumeIPFS } from '../protocols/ipfs-handler.js'
import { getDeviceKeys, getPublicDeviceInfo } from './device-keys.js'
import { loadDeviceRegistry, saveDeviceRegistry } from './device-registry.js'

const log = createLogger('backup')

const WORKER_PATH = fileURLToPath(new URL('./backup-worker.js', import.meta.url))

function userDataDir () {
  return app.getPath('userData')
}

function timestamp () {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

export function defaultBackupName () {
  return `peersky-backup-${timestamp()}.zip`
}

// Run the backup worker for a single op, forwarding progress to onProgress.
function runWorker (data, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData: data })
    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        if (typeof onProgress === 'function') onProgress(msg.data)
      } else if (msg.type === 'done') {
        resolve(msg.result)
      } else if (msg.type === 'error') {
        reject(new Error(msg.message))
      }
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Backup worker exited with code ${code}`))
    })
  })
}

class BackupManager {
  // Create a .zip of persistent data at outPath. onProgress: ({processedBytes,...}).
  async createBackup (outPath, onProgress) {
    log.info(`Creating backup at ${outPath}`)
    // Suspend P2P stores so the worker sees a consistent snapshot on disk.
    // Services are always resumed in the finally block, even on failure.
    await suspendHyper()
    await suspendIPFS()
    try {
      const result = await runWorker({
        op: 'create',
        userDataDir: userDataDir(),
        outPath,
        peerskyVersion: app.getVersion()
      }, onProgress)
      log.info(`Backup created: ${result.bytes} bytes`)
      return result
    } finally {
      await resumeHyper().catch((err) => log.error(`Failed to resume hyper after backup: ${err.message}`))
      await resumeIPFS().catch((err) => log.error(`Failed to resume IPFS after backup: ${err.message}`))
    }
  }

  async createIdentityTransferBackup (outPath, options = {}) {
    log.info(`Creating identity transfer backup at ${outPath}`)
    await suspendHyper()
    await suspendIPFS()
    try {
      const result = await createIdentityTransferZip(userDataDir(), outPath, {
        ...options,
        peerskyVersion: app.getVersion()
      })
      log.info(`Identity transfer backup created: ${result.bytes} bytes`)
      return result
    } finally {
      await resumeHyper().catch((err) => log.error(`Failed to resume hyper after identity transfer backup: ${err.message}`))
      await resumeIPFS().catch((err) => log.error(`Failed to resume IPFS after identity transfer backup: ${err.message}`))
    }
  }

  // Read the manifest from a backup zip for preview/validation before restoring.
  async inspectBackup (zipPath) {
    return readManifest(zipPath)
  }

  // Extract, verify, then overwrite userData targets from the backup bundle.
  // A full app restart is required after restore to re-init P2P nodes.
  async restoreBackup (zipPath, onProgress) {
    const dest = userDataDir()
    const tempDir = path.join(os.tmpdir(), `peersky-restore-${Date.now()}`)
    let resumeServices = true
    log.info(`Restoring backup from ${zipPath}`)

    await suspendHyper()
    await suspendIPFS()
    try {
      await runWorker({ op: 'extract', zipPath, destDir: tempDir }, onProgress)

      const manifest = await readManifest(zipPath)
      let applyDir = tempDir
      let applyManifest = manifest
      let identityTransfer = null

      if (isIdentityTransferManifest(manifest)) {
        const innerZipPath = path.join(tempDir, 'identity-transfer-inner.zip')
        const innerDir = path.join(tempDir, 'identity-transfer-inner')
        identityTransfer = await decryptIdentityTransferZip(dest, tempDir, manifest, innerZipPath)
        applyManifest = await extractAndVerifyIdentityPayload(innerZipPath, innerDir)
        applyDir = innerDir
      } else {
        await verifyManifest(tempDir, manifest)
      }

      for (const name of Object.keys(applyManifest.files)) {
        const src = path.join(applyDir, name)
        const target = path.join(dest, name)
        await fs.rm(target, { recursive: true, force: true }).catch(() => {})
        await fsExtra.copy(src, target, {
          overwrite: true,
          filter: (srcPath) => {
            const base = path.basename(srcPath)
            if (base === 'LOCK' || base === 'repo.lock' || base === '.DS_Store' || base === 'LOG' || base === 'LOG.old') return false
            if (base.endsWith('.lock')) return false
            return true
          }
        })
      }

      // Drop CORESTORE — its inode/xattr never survive a copy and it is
      // rebuilt cleanly on next launch.
      await fs.rm(path.join(dest, 'hyper', 'CORESTORE'), { force: true }).catch(() => {})

      // If this was an Identity Transfer, assume ownership of the registry.
      // This allows the restoring device (Desktop or Mobile) to manage the identity going forward.
      if (identityTransfer) {
        const slotType = identityTransfer.transfer.targetDeviceType
        const keys = await getDeviceKeys(dest)
        const publicInfo = getPublicDeviceInfo(keys)
        const registry = await loadDeviceRegistry(dest)
        if (registry) {
          registry.ownerSigningPublicKey = publicInfo.signingPublicKey
          registry.devices[slotType] = slotType === 'desktop' ? [] : null
          await saveDeviceRegistry(dest, registry, keys.signing.secretKey)
          log.info(`Assumed ownership of identity registry (cleared ${slotType} slot)`)
        }
      }

      resumeServices = false

      log.info('Backup restored; restart required')
      return {
        success: true,
        requiresRestart: true,
        manifest: applyManifest,
        identityTransfer
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      if (resumeServices) {
        await resumeHyper().catch((err) => log.error(`Failed to resume hyper after failed restore: ${err.message}`))
        await resumeIPFS().catch((err) => log.error(`Failed to resume IPFS after failed restore: ${err.message}`))
      }
    }
  }

  // Relaunch the app so restored P2P data is loaded from a clean process.
  relaunch () {
    app.relaunch()
    app.quit()
  }
}

const backupManager = new BackupManager()
export default backupManager
