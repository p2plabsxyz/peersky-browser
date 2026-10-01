import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import { app } from 'electron'
import fsExtra from 'fs-extra'
import { createLogger } from '../logger.js'
import { readManifest, verifyManifest } from './backup-core.js'
import { createIdentityTransferZip, decryptIdentityTransferZip, extractAndVerifyIdentityPayload, isIdentityTransferManifest } from './identity-transfer.js'
import { assertMobilePairingAllowed, setPairedMobile } from './mobile-pairing.js'
import { decryptEncryptedBackupZip, isEncryptedBackupManifest } from './encrypted-backup.js'
import { suspendHyper, resumeHyper, trustPrivateDriveHostname, exportChatForTransfer, importChatFromPhone } from '../protocols/hyper-handler.js'
import { suspendIPFS, resumeIPFS } from '../protocols/ipfs-handler.js'
import { setPrivateDriveOwnership, currentPrivateDriveIds } from '../protocols/private-drive-ownership.js'
import { listPrivateHyperdrives } from '../protocols/private-hyperdrive-registry.js'
import { decodeDriveId } from './private-drive-export.js'
import { applyPhoneSync, isPhoneSyncManifest, readPhoneSyncZip } from './phone-sync.js'
import { forgetPairingNonce, isLivePairingNonce } from './pairing-sessions.js'
import { ensureOwnNetworkKeys } from './network-keys.js'

const log = createLogger('backup')

const WORKER_PATH = fileURLToPath(new URL('./backup-worker.js', import.meta.url))

// Something fetched over the network waits here, checked and decrypted, until
// the person has compared the code on both screens. Inside the profile folder
// rather than the system temp folder, because an identity transfer decrypts
// to secret keys; anything left behind by a crash is cleared at the next start.
const INCOMING_DIR_PREFIX = '.peersky-incoming-'
const STAGED_TTL_MS = 30 * 60 * 1000
const PHONE_SYNC_ELSEWHERE = 'This is tabs and bookmarks from a phone, not a backup. Add it from Settings > Backup & Restore, under Restore from the network.'

function userDataDir () {
  return app.getPath('userData')
}

function timestamp () {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

function shouldCopyRestorePath (srcPath) {
  const base = path.basename(srcPath)
  if (base === 'LOCK' || base === 'repo.lock' || base === '.DS_Store' || base === 'LOG' || base === 'LOG.old' || base === 'CORESTORE') return false
  return !base.endsWith('.lock')
}

async function pathExists (filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export async function applyRestoreTransaction (dest, applyDir, names) {
  const token = `${process.pid}-${Date.now()}`
  const stagingRoot = path.join(dest, `.peersky-restore-stage-${token}`)
  const previousRoot = path.join(dest, `.peersky-restore-previous-${token}`)
  const swapped = []

  await fs.mkdir(stagingRoot, { recursive: true })
  await fs.mkdir(previousRoot, { recursive: true })

  try {
    for (const name of names) {
      await fsExtra.copy(path.join(applyDir, name), path.join(stagingRoot, name), {
        overwrite: false,
        errorOnExist: true,
        filter: shouldCopyRestorePath
      })
    }

    for (const name of names) {
      const target = path.join(dest, name)
      const staged = path.join(stagingRoot, name)
      const previous = path.join(previousRoot, name)
      const hadPrevious = await pathExists(target)

      if (hadPrevious) await fs.rename(target, previous)
      try {
        await fs.rename(staged, target)
        swapped.push({ name, hadPrevious })
      } catch (error) {
        if (hadPrevious) await fs.rename(previous, target)
        throw error
      }
    }
  } catch (error) {
    for (const item of swapped.reverse()) {
      const target = path.join(dest, item.name)
      const previous = path.join(previousRoot, item.name)
      await fs.rm(target, { recursive: true, force: true })
      if (item.hadPrevious) await fs.rename(previous, target)
    }
    await fs.rm(previousRoot, { recursive: true, force: true })
    throw error
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }

  await fs.rm(previousRoot, { recursive: true, force: true })
}

// A restored registry replaces the local one, so any drive that was not on
// this device before the restore arrived from the backed-up profile. Drives
// new to this device are recorded as adopted (read-only), leaving the
// original device as the single writer; drives already present here stay
// owned, so restoring the same device keeps its own drives writable.
export async function adoptRestoredPrivateDriveCopies (dest, previousIds) {
  const restoredEntries = await listPrivateHyperdrives(dest).catch(() => [])
  for (const entry of restoredEntries) {
    const driveId = decodeDriveId(entry.url)
    if (driveId && !previousIds.has(driveId)) {
      await setPrivateDriveOwnership(dest, driveId, false)
    }
  }
}

// Puts an extracted and verified restore in place. The caller has suspended
// the P2P services and restarts once this returns.
async function applyVerifiedRestore (dest, applyDir, applyManifest, { identityTransfer = false } = {}) {
  const names = Object.keys(applyManifest.files)
  const previousPrivateDriveIds = await currentPrivateDriveIds(dest)
  await applyRestoreTransaction(dest, applyDir, names)
  if (names.includes('privateHyperdrives.json')) {
    await adoptRestoredPrivateDriveCopies(dest, previousPrivateDriveIds)
  }
  // Another desktop's stores, and with them its network keys. This desktop
  // connects with its own from its next start, so the two are two members.
  // A backup is this same desktop again and keeps its keys.
  if (identityTransfer) await ensureOwnNetworkKeys(dest)
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
  constructor () {
    this.staged = null
    // The stage being put in place. It cannot be dropped, or replaced by a
    // new fetch, until that finishes.
    this.applying = null
  }

  // Create a .zip of persistent data at outPath. onProgress: ({processedBytes,...}).
  async createBackup (outPath, passphrase, onProgress, options = {}) {
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
        peerskyVersion: app.getVersion(),
        passphrase,
        includePrivate: options.includePrivate === true
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

    // Checked before any work is done, so a refused pairing costs nothing and
    // never leaves a half-built transfer behind.
    const mobileKey = await assertMobilePairingAllowed(
      userDataDir(),
      options.targetPairingPayload || options.targetEncryptionPublicKey
    )

    await suspendHyper()
    await suspendIPFS()
    try {
      const result = await createIdentityTransferZip(userDataDir(), outPath, {
        ...options,
        peerskyVersion: app.getVersion(),
        exportChat: exportChatForTransfer
      })
      // Recorded only once the transfer exists. A failure part way through
      // must not leave the identity looking paired to a phone that never got
      // it, or the user would have to move-to-new-phone to retry.
      if (mobileKey) await setPairedMobile(userDataDir(), mobileKey)
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
  async restoreBackup (zipPath, onProgress, options = {}) {
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
        if (isPhoneSyncManifest(await readManifest(innerZipPath))) throw new Error(PHONE_SYNC_ELSEWHERE)
        applyManifest = await extractAndVerifyIdentityPayload(innerZipPath, innerDir)
        applyDir = innerDir
      } else if (isEncryptedBackupManifest(manifest)) {
        const innerZipPath = path.join(tempDir, 'encrypted-backup-inner.zip')
        const innerDir = path.join(tempDir, 'encrypted-backup-inner')
        await decryptEncryptedBackupZip(tempDir, manifest, innerZipPath, options.passphrase)
        applyManifest = await extractAndVerifyIdentityPayload(innerZipPath, innerDir)
        applyDir = innerDir
      } else {
        await verifyManifest(tempDir, manifest)
      }

      await applyVerifiedRestore(dest, applyDir, applyManifest, { identityTransfer: !!identityTransfer })
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

  /**
   * The first half of a restore from the network: the download is read and,
   * for a transfer, checked, decrypted and verified, but nothing in the
   * profile changes. Returns what the page shows before asking to go ahead,
   * including the code for a transfer. Takes ownership of zipPath.
   */
  async stageRestore (zipPath, onProgress) {
    if (this.applying) {
      await fs.rm(zipPath, { force: true }).catch(() => {})
      throw new Error('Still putting the last restore in place. Try again when it finishes.')
    }
    this.discardStaged()
    const id = crypto.randomBytes(8).toString('hex')
    let dir = null

    try {
      let manifest
      try {
        manifest = await readManifest(zipPath)
      } catch {
        throw new Error('That address does not lead to a PeerSky backup or transfer.')
      }
      if (!isIdentityTransferManifest(manifest)) {
        // A backup. It is only decrypted once the person says to restore it,
        // with the passphrase they give then.
        this.staged = { id, kind: 'backup', zipPath, stagedAt: Date.now() }
        return {
          stageId: id,
          kind: 'backup',
          encrypted: isEncryptedBackupManifest(manifest),
          createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null
        }
      }

      // Sent over the network to the code this desktop is showing. One made
      // for any other code is refused before it is decrypted.
      const nonce = manifest.identityTransfer?.nonce
      if (!isLivePairingNonce(nonce)) {
        throw new Error('This transfer was made for a code this desktop is no longer showing. Open Backup & Restore again and send it to the code shown there.')
      }

      dir = await fs.mkdtemp(path.join(userDataDir(), INCOMING_DIR_PREFIX))
      await runWorker({ op: 'extract', zipPath, destDir: dir }, onProgress)
      const innerZipPath = path.join(dir, 'identity-transfer-inner.zip')
      const decrypted = await decryptIdentityTransferZip(userDataDir(), dir, manifest, innerZipPath)

      if (isPhoneSyncManifest(await readManifest(innerZipPath))) {
        const sync = await readPhoneSyncZip(innerZipPath)
        await fs.rm(dir, { recursive: true, force: true })
        dir = null
        this.staged = { id, kind: 'phone', sync, nonce, stagedAt: Date.now() }
        return {
          stageId: id,
          kind: 'phone',
          verificationCode: decrypted.verificationCode,
          tabs: sync.tabs.length,
          bookmarks: sync.bookmarks.length,
          privateDrives: sync.privateDrives.length,
          chatRooms: sync.chat ? sync.chat.rooms.length : 0,
          chatName: sync.chat?.profile?.username || ''
        }
      }

      const applyDir = path.join(dir, 'identity-transfer-inner')
      const applyManifest = await extractAndVerifyIdentityPayload(innerZipPath, applyDir)
      this.staged = { id, kind: 'transfer', dir, applyDir, applyManifest, nonce, stagedAt: Date.now() }
      return {
        stageId: id,
        kind: 'transfer',
        verificationCode: decrypted.verificationCode,
        contents: Object.keys(applyManifest.files)
      }
    } catch (error) {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw error
    } finally {
      if (this.staged?.id !== id || this.staged.kind !== 'backup') {
        await fs.rm(zipPath, { force: true }).catch(() => {})
      }
    }
  }

  /**
   * The second half, once the person has said to go ahead. A phone's tabs and
   * bookmarks are added in place and nothing restarts; tabs go to openTabs.
   * A transfer or backup replaces the profile and needs a restart. Whatever
   * goes wrong, the staged copy is kept so the person can try again or cancel.
   */
  async applyStaged (stageId, { passphrase, onProgress, openTabs } = {}) {
    const staged = this.staged
    if (!staged || staged.id !== stageId || this.applying) throw new Error('That restore is no longer waiting. Fetch it again.')
    if (Date.now() - staged.stagedAt > STAGED_TTL_MS) {
      this.discardStaged()
      throw new Error('That restore waited too long. Fetch it again.')
    }

    this.applying = staged.id
    try {
      return await this.applyStagedNow(staged, { passphrase, onProgress, openTabs })
    } finally {
      this.applying = null
    }
  }

  async applyStagedNow (staged, { passphrase, onProgress, openTabs }) {
    if (staged.kind === 'phone') {
      const applied = await applyPhoneSync(userDataDir(), staged.sync)
      for (const hostname of applied.privateHostnames) trustPrivateDriveHostname(hostname)
      // openTabs says how many it opened: a tab already open here is left out.
      let tabsAdded = 0
      if (typeof openTabs === 'function' && staged.sync.tabs.length > 0) {
        const opened = await openTabs(staged.sync.tabs)
        tabsAdded = Number.isInteger(opened) ? opened : staged.sync.tabs.length
      }
      // PeerChat runs, so it takes the phone's name and rooms itself.
      const chat = staged.sync.chat ? await importChatFromPhone(staged.sync.chat) : null
      forgetPairingNonce(staged.nonce)
      this.dropStaged(staged)
      log.info(`Added ${applied.bookmarksAdded} bookmarks, ${tabsAdded} tabs and ${chat?.added || 0} chat rooms from a phone`)
      return {
        success: true,
        requiresRestart: false,
        added: {
          tabs: tabsAdded,
          bookmarks: applied.bookmarksAdded,
          privateDrives: applied.privateDrivesAdded,
          chatRooms: chat?.added || 0
        }
      }
    }

    if (staged.kind === 'backup') {
      const result = await this.restoreBackup(staged.zipPath, onProgress, { passphrase })
      this.dropStaged(staged)
      return result
    }

    const dest = userDataDir()
    await suspendHyper()
    await suspendIPFS()
    try {
      await applyVerifiedRestore(dest, staged.applyDir, staged.applyManifest, { identityTransfer: true })
    } catch (error) {
      await resumeHyper().catch((err) => log.error(`Failed to resume hyper after failed restore: ${err.message}`))
      await resumeIPFS().catch((err) => log.error(`Failed to resume IPFS after failed restore: ${err.message}`))
      throw error
    }
    forgetPairingNonce(staged.nonce)
    this.dropStaged(staged)
    log.info('Identity transfer restored; restart required')
    return { success: true, requiresRestart: true, manifest: staged.applyManifest }
  }

  discardStaged (stageId) {
    const staged = this.staged
    if (!staged || (stageId !== undefined && staged.id !== stageId)) return
    if (this.applying === staged.id) return
    this.dropStaged(staged)
  }

  dropStaged (staged) {
    if (this.staged === staged) this.staged = null
    if (staged.dir) fs.rm(staged.dir, { recursive: true, force: true }).catch(() => {})
    if (staged.zipPath) fs.rm(staged.zipPath, { force: true }).catch(() => {})
  }

  // Staging left behind by a crash or a quit part way through.
  async clearLeftoverStaging () {
    const dest = userDataDir()
    const names = await fs.readdir(dest).catch(() => [])
    for (const name of names) {
      if (name.startsWith(INCOMING_DIR_PREFIX)) {
        await fs.rm(path.join(dest, name), { recursive: true, force: true }).catch(() => {})
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
