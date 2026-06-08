import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import { app } from 'electron'
import fsExtra from 'fs-extra'
import { createLogger } from '../logger.js'
import { BACKUP_TARGETS, readManifest, verifyManifest } from './backup-core.js'
import { suspendHyper, resumeHyper } from '../protocols/hyper-handler.js'
import { suspendIPFS, resumeIPFS } from '../protocols/ipfs-handler.js'

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
    // Freeze the hyper corestore and IPFS on disk so the worker copies a consistent
    // RocksDB/LevelDB; otherwise live compaction yields a manifest that references
    // SST files missing from the bundle. Always resumed, even on failure.
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

  // Read the manifest from a backup zip for preview/validation before restoring.
  async inspectBackup (zipPath) {
    return readManifest(zipPath)
  }

  // Restore a backup: extract to temp, verify checksums, then overwrite targets
  // in userData. Existing ipfs/ and hyper/ dirs are removed first so old and new
  // repositories never mix. A restart is required to re-init P2P nodes.
  async restoreBackup (zipPath, onProgress) {
    const dest = userDataDir()
    const tempDir = path.join(os.tmpdir(), `peersky-restore-${Date.now()}`)
    log.info(`Restoring backup from ${zipPath}`)

    try {
      await runWorker({ op: 'extract', zipPath, destDir: tempDir }, onProgress)

      const manifest = await readManifest(zipPath)
      await verifyManifest(tempDir, manifest)

      for (const name of Object.keys(manifest.files)) {
        const meta = BACKUP_TARGETS.find((t) => t.name === name)
        const src = path.join(tempDir, name)
        const target = path.join(dest, name)
        if (meta.type === 'dir') {
          await fs.rm(target, { recursive: true, force: true }).catch(() => {})
        }
        await fsExtra.copy(src, target, { overwrite: true })
      }

      // Drop the hypercore-storage device file carried in the bundle. Its
      // recorded inode/xattr never survive a copy, so the move-guard would
      // abort the process on next launch; it is rebuilt cleanly on open.
      await fs.rm(path.join(dest, 'hyper', 'CORESTORE'), { force: true }).catch(() => {})

      log.info('Backup restored; restart required')
      return { success: true, requiresRestart: true, manifest }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
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
