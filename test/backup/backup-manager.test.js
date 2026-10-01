import { expect } from 'chai'
import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import { access, mkdtemp, mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import crypto from 'crypto'
import archiver from 'archiver'
import sinon from 'sinon'
import esmock from 'esmock'

async function loadBackupManager (options = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-bm-'))
  const manifest = options.manifest || { files: { 'tabs.json': 'sha256:test', hyper: 'sha256:test' } }
  const suspendHyper = sinon.stub().resolves()
  const resumeHyper = sinon.stub().resolves()
  const suspendIPFS = sinon.stub().resolves()
  const resumeIPFS = sinon.stub().resolves()
  const copy = options.copy || sinon.stub().callsFake(async (_src, dest) => {
    await mkdir(dest, { recursive: true })
  })
  const readManifest = options.readManifest || sinon.stub().resolves(manifest)
  const verifyManifest = options.verifyManifest || sinon.stub().resolves()
  const trustPrivateDriveHostname = sinon.stub()
  const exportChatForTransfer = sinon.stub().returns(null)
  const importChatFromPhone = options.importChatFromPhone || sinon.stub().resolves({ ok: true, added: 0 })
  const exportP2pmdNotes = options.exportP2pmdNotes || sinon.stub().resolves(null)
  const importP2pmdNotes = options.importP2pmdNotes || sinon.stub().resolves({ ok: true, added: 0 })
  const assertMobilePairingAllowed = sinon.stub().resolves(null)
  const setPairedMobile = sinon.stub().resolves()
  const isLivePairingNonce = options.isLivePairingNonce || sinon.stub().returns(true)
  const forgetPairingNonce = sinon.stub()
  const identityTransfer = {
    createIdentityTransferZip: sinon.stub(),
    decodePairingString: sinon.stub().returns({ deviceType: 'desktop', chat: false, notes: false }),
    decryptIdentityTransferZip: sinon.stub(),
    extractAndVerifyIdentityPayload: sinon.stub(),
    isIdentityTransferManifest: sinon.stub().returns(false),
    ...options.identityTransfer
  }
  // Relative specifiers, not absolute paths: path.join yields native separators,
  // and esmock fails to detect an ESM module behind a Windows path, falling back
  // to a CommonJS wrapper that expects a default export.
  const backupCorePath = '../../src/backup/backup-core.js'
  const hyperHandlerPath = '../../src/protocols/hyper-handler.js'
  const ipfsHandlerPath = '../../src/protocols/ipfs-handler.js'
  const identityTransferPath = '../../src/backup/identity-transfer.js'
  const encryptedBackupPath = '../../src/backup/encrypted-backup.js'
  const workerCalls = []

  class FakeWorker extends EventEmitter {
    constructor (_workerPath, workerOptions) {
      super()
      workerCalls.push(workerOptions.workerData)
      queueMicrotask(() => {
        if (options.workerError) {
          this.emit('message', { type: 'error', message: options.workerError })
        } else {
          this.emit('message', { type: 'done', result: {} })
        }
        this.emit('exit', 0)
      })
    }
  }

  const mocks = {
    electron: {
      app: {
        getPath: sinon.stub().withArgs('userData').returns(userData),
        getVersion: sinon.stub().returns('1.0.0-test'),
        relaunch: sinon.stub(),
        quit: sinon.stub()
      }
    },
    worker_threads: { Worker: FakeWorker },
    'fs-extra': { default: { copy } },
    [backupCorePath]: {
      readManifest,
      verifyManifest
    },
    [identityTransferPath]: identityTransfer,
    '../../src/backup/pairing-sessions.js': { isLivePairingNonce, forgetPairingNonce },
    [encryptedBackupPath]: {
      decryptEncryptedBackupZip: sinon.stub(),
      isEncryptedBackupManifest: sinon.stub().returns(false)
    },
    [hyperHandlerPath]: { suspendHyper, resumeHyper, trustPrivateDriveHostname, exportChatForTransfer, importChatFromPhone },
    '../../src/backup/p2pmd-notes.js': { exportP2pmdNotes, importP2pmdNotes },
    '../../src/backup/mobile-pairing.js': { assertMobilePairingAllowed, setPairedMobile },
    [ipfsHandlerPath]: { suspendIPFS, resumeIPFS }
  }

  const module = await esmock.strict('../../src/backup/backup-manager.js', mocks)

  return {
    backupManager: module.default,
    module,
    userData,
    stubs: {
      copy,
      readManifest,
      verifyManifest,
      resumeHyper,
      resumeIPFS,
      suspendHyper,
      suspendIPFS,
      trustPrivateDriveHostname,
      importChatFromPhone,
      exportP2pmdNotes,
      importP2pmdNotes,
      isLivePairingNonce,
      forgetPairingNonce,
      identityTransfer
    },
    workerCalls
  }
}

// The decrypted inner zip of a transfer from a phone.
async function writePhoneInnerZip (zipPath, files) {
  const output = createWriteStream(zipPath)
  const archive = archiver('zip')
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve)
    archive.on('error', reject)
  })
  archive.pipe(output)
  const listed = {}
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(JSON.stringify(value))
    archive.append(bytes, { name })
    listed[name] = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`
  }
  archive.append(JSON.stringify({ version: '1.0.0', source: 'mobile', files: listed }), { name: 'manifest.json' })
  await archive.finalize()
  await done
}

async function exists (filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const TRANSFER_MANIFEST = { kind: 'peersky-identity-transfer', identityTransfer: { nonce: 'ab'.repeat(16) } }

// A phone transfer as the manager sees it once the outer layer is checked:
// readManifest answers for the wrapper, then for the decrypted inner zip.
function phoneTransferOptions (extraFiles = {}) {
  const readManifest = sinon.stub()
  readManifest.onFirstCall().resolves(TRANSFER_MANIFEST)
  readManifest.resolves({ version: '1.0.0', source: 'mobile', files: {} })
  return {
    readManifest,
    identityTransfer: {
      isIdentityTransferManifest: sinon.stub().callsFake((manifest) => manifest?.kind === 'peersky-identity-transfer'),
      decryptIdentityTransferZip: sinon.stub().callsFake(async (_userData, _dir, _manifest, innerZipPath) => {
        await mkdir(path.dirname(innerZipPath), { recursive: true })
        await writePhoneInnerZip(innerZipPath, {
          'phone-tabs.json': { version: 1, tabs: [{ url: 'https://t.example/', title: 'T' }] },
          'phone-bookmarks.json': { version: 1, bookmarks: [{ url: 'https://b.example/', title: 'B', createdAt: 1700000000000 }] },
          'phone-private-drives.json': { version: 1, drives: [{ driveId: 'e'.repeat(64) }] },
          ...extraFiles
        })
        return { verificationCode: 'ABC123' }
      })
    }
  }
}

async function downloadedZip () {
  const zipPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'peersky-bm-dl-')), 'backup.zip')
  await writeFile(zipPath, 'downloaded')
  return zipPath
}

describe('backup-manager', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('leaves P2P services stopped after a successful restore', async function () {
    const { backupManager, stubs, userData } = await loadBackupManager()

    const result = await backupManager.restoreBackup('/tmp/backup.zip')

    expect(result).to.include({ success: true, requiresRestart: true })
    expect(stubs.suspendHyper.calledOnce).to.equal(true)
    expect(stubs.suspendIPFS.calledOnce).to.equal(true)
    expect(stubs.resumeHyper.called).to.equal(false)
    expect(stubs.resumeIPFS.called).to.equal(false)
    // A backup is this same desktop again, on the keys it had.
    expect(await exists(path.join(userData, 'peersky-network-keys.json'))).to.equal(false)
  })

  it('resumes P2P services when restore fails before data is applied', async function () {
    const verifyManifest = sinon.stub().rejects(new Error('bad manifest'))
    const { backupManager, stubs } = await loadBackupManager({ verifyManifest })

    try {
      await backupManager.restoreBackup('/tmp/backup.zip')
      throw new Error('restore should have failed')
    } catch (error) {
      expect(error.message).to.equal('bad manifest')
    }

    expect(stubs.resumeHyper.calledOnce).to.equal(true)
    expect(stubs.resumeIPFS.calledOnce).to.equal(true)
  })

  it('surfaces worker errors during backup creation', async function () {
    const { backupManager, stubs } = await loadBackupManager({ workerError: 'disk full' })

    try {
      await backupManager.createBackup('/tmp/backup.zip')
      throw new Error('create should have failed')
    } catch (error) {
      expect(error.message).to.equal('disk full')
    }

    expect(stubs.suspendHyper.calledOnce).to.equal(true)
    expect(stubs.suspendIPFS.calledOnce).to.equal(true)
    expect(stubs.resumeHyper.calledOnce).to.equal(true)
    expect(stubs.resumeIPFS.calledOnce).to.equal(true)
  })

  it('forwards the private-upload choice to the backup worker', async function () {
    const { backupManager, workerCalls } = await loadBackupManager()

    await backupManager.createBackup('/tmp/backup.zip', 'passphrase', null, {
      includePrivate: true
    })

    expect(workerCalls).to.have.length(1)
    expect(workerCalls[0]).to.include({ op: 'create', includePrivate: true })
  })

  it('preserves live data when staging the restore fails', async function () {
    const copy = sinon.stub().rejects(new Error('disk full'))
    const { backupManager, userData } = await loadBackupManager({
      copy,
      manifest: { files: { 'tabs.json': 'sha256:test' } }
    })
    await writeFile(path.join(userData, 'tabs.json'), 'live tabs')

    let error
    try {
      await backupManager.restoreBackup('/tmp/backup.zip')
    } catch (caught) {
      error = caught
    }

    expect(error?.message).to.equal('disk full')
    expect(await readFile(path.join(userData, 'tabs.json'), 'utf-8')).to.equal('live tabs')
  })

  it('rolls back earlier swaps when a later rename fails', async function () {
    const copy = sinon.stub().callsFake(async (_src, dest) => {
      if (dest.endsWith('tabs.json')) {
        await writeFile(dest, 'restored tabs')
      }
    })
    const { backupManager, userData } = await loadBackupManager({
      copy,
      manifest: {
        files: {
          'tabs.json': 'sha256:test',
          'lastOpened.json': 'sha256:test'
        }
      }
    })
    await writeFile(path.join(userData, 'tabs.json'), 'live tabs')
    await writeFile(path.join(userData, 'lastOpened.json'), 'live window')

    let error
    try {
      await backupManager.restoreBackup('/tmp/backup.zip')
    } catch (caught) {
      error = caught
    }

    expect(error?.code).to.equal('ENOENT')
    expect(await readFile(path.join(userData, 'tabs.json'), 'utf-8')).to.equal('live tabs')
    expect(await readFile(path.join(userData, 'lastOpened.json'), 'utf-8')).to.equal('live window')
  })

  it('stages tabs and bookmarks from a phone with its code, and adds them without a restart', async function () {
    const { backupManager, userData, stubs } = await loadBackupManager(phoneTransferOptions())
    await writeFile(path.join(userData, 'bookmarks.json'), JSON.stringify([
      { url: 'https://mine.example/', title: 'Mine', dateAdded: '2025-01-01T00:00:00.000Z' }
    ]))
    const zipPath = await downloadedZip()

    const staged = await backupManager.stageRestore(zipPath)
    expect(staged).to.include({ kind: 'phone', verificationCode: 'ABC123', tabs: 1, bookmarks: 1, privateDrives: 1 })
    expect(stubs.isLivePairingNonce.calledWith('ab'.repeat(16))).to.equal(true)
    // Nothing is decided yet: the download is gone, the profile untouched.
    expect(await exists(zipPath)).to.equal(false)
    expect(JSON.parse(await readFile(path.join(userData, 'bookmarks.json'), 'utf8'))).to.have.length(1)
    // A phone's tabs are read into memory; nothing decrypted is left on disk.
    expect((await readdir(userData)).filter((name) => name.startsWith('.peersky-incoming-'))).to.deep.equal([])

    const openTabs = sinon.stub()
    const result = await backupManager.applyStaged(staged.stageId, { openTabs })
    expect(result).to.deep.include({ success: true, requiresRestart: false })
    expect(result.added).to.deep.equal({ tabs: 1, bookmarks: 1, privateDrives: 1, chatRooms: 0, notes: 0 })
    expect(stubs.importChatFromPhone.called).to.equal(false)
    expect(stubs.importP2pmdNotes.called).to.equal(false)
    expect(openTabs.calledOnceWith([{ url: 'https://t.example/', title: 'T' }])).to.equal(true)
    expect(JSON.parse(await readFile(path.join(userData, 'bookmarks.json'), 'utf8')).map((b) => b.url))
      .to.deep.equal(['https://mine.example/', 'https://b.example/'])
    expect(stubs.trustPrivateDriveHostname.calledOnce).to.equal(true)
    expect(stubs.forgetPairingNonce.calledWith('ab'.repeat(16))).to.equal(true)
    expect(stubs.suspendHyper.called).to.equal(false)

    // Used once: the same stage cannot be applied again.
    const again = await backupManager.applyStaged(staged.stageId).catch((error) => error)
    expect(again.message).to.match(/no longer waiting/)
  })

  it('shows the PeerChat name and rooms a phone sends, and hands them to PeerChat once confirmed', async function () {
    const chat = { version: 1, label: 'desktop', link: { key: 'ab'.repeat(32) }, profile: { username: 'ada' }, rooms: [{ roomKey: 'aa'.repeat(32) }, { roomKey: 'bb'.repeat(32) }] }
    const importChatFromPhone = sinon.stub().resolves({ ok: true, added: 1, label: 'desktop' })
    const { backupManager } = await loadBackupManager({ ...phoneTransferOptions({ 'phone-peerchat.json': chat }), importChatFromPhone })

    const staged = await backupManager.stageRestore(await downloadedZip())
    expect(staged).to.include({ chatRooms: 2, chatName: 'ada' })
    expect(importChatFromPhone.called).to.equal(false)

    const result = await backupManager.applyStaged(staged.stageId, { openTabs: async () => 1 })
    expect(importChatFromPhone.calledOnce).to.equal(true)
    expect(importChatFromPhone.firstCall.args[0]).to.deep.include({ label: 'desktop' })
    expect(result.added.chatRooms).to.equal(1)
  })

  it('shows how many P2PMD notes a phone sends, and hands them to P2PMD once confirmed', async function () {
    const notes = {
      version: 1,
      name: 'Bea',
      notes: [{ key: `hs://${'q'.repeat(52)}`, role: 'host', content: '# Trip' }, { key: 'not a key', role: 'client' }]
    }
    const importP2pmdNotes = sinon.stub().resolves({ ok: true, added: 1 })
    const { backupManager } = await loadBackupManager({ ...phoneTransferOptions({ 'phone-p2pmd.json': notes }), importP2pmdNotes })

    const staged = await backupManager.stageRestore(await downloadedZip())
    expect(staged).to.include({ notes: 1 })
    expect(importP2pmdNotes.called).to.equal(false)

    const result = await backupManager.applyStaged(staged.stageId, { openTabs: async () => 1 })
    expect(importP2pmdNotes.calledOnce).to.equal(true)
    expect(importP2pmdNotes.firstCall.args[0].notes.map((note) => note.key)).to.deep.equal([`hs://${'q'.repeat(52)}`])
    expect(result.added.notes).to.equal(1)
  })

  it('reads P2PMD notes only for a phone whose code says it takes them, before the stores close', async function () {
    const notes = { version: 1, name: 'Ada', notes: [] }
    const cases = [
      [{ deviceType: 'mobile', notes: true }, notes],
      [{ deviceType: 'mobile', notes: false }, null],
      [{ deviceType: 'desktop', notes: true }, null]
    ]
    for (const [pairing, expected] of cases) {
      const exportP2pmdNotes = sinon.stub().resolves(notes)
      const { backupManager, stubs } = await loadBackupManager({
        exportP2pmdNotes,
        identityTransfer: {
          decodePairingString: sinon.stub().returns(pairing),
          createIdentityTransferZip: sinon.stub().resolves({ bytes: 1 })
        }
      })
      await backupManager.createIdentityTransferBackup(path.join(os.tmpdir(), 'unused.zip'), { targetPairingPayload: 'code' })
      const options = stubs.identityTransfer.createIdentityTransferZip.firstCall.args[2]
      expect(options.notes).to.deep.equal(expected)
      if (expected) {
        expect(exportP2pmdNotes.calledBefore(stubs.suspendHyper)).to.equal(true)
      } else {
        expect(exportP2pmdNotes.called).to.equal(false)
      }
    }
  })

  it('counts only the phone tabs that were opened, not those already open here', async function () {
    const { backupManager } = await loadBackupManager(phoneTransferOptions())
    const staged = await backupManager.stageRestore(await downloadedZip())
    expect(staged.tabs).to.equal(1)

    // The page was already open, so the window opened none of them.
    const result = await backupManager.applyStaged(staged.stageId, { openTabs: async () => 0 })
    expect(result.added.tabs).to.equal(0)
  })

  it('refuses a transfer made for a code this desktop is not showing, before decrypting it', async function () {
    const options = phoneTransferOptions()
    const { backupManager, stubs } = await loadBackupManager({ ...options, isLivePairingNonce: sinon.stub().returns(false) })
    const zipPath = await downloadedZip()

    const error = await backupManager.stageRestore(zipPath).catch((caught) => caught)
    expect(error.message).to.match(/code this desktop is no longer showing/)
    expect(stubs.identityTransfer.decryptIdentityTransferZip.called).to.equal(false)
    expect(await exists(zipPath)).to.equal(false)
  })

  it('shows the code of a transfer from another desktop, and replaces the profile only once confirmed', async function () {
    const readManifest = sinon.stub()
    readManifest.onFirstCall().resolves(TRANSFER_MANIFEST)
    readManifest.resolves({ version: '1.0.0', files: { 'tabs.json': 'sha256:test' } })
    const { backupManager, userData, stubs } = await loadBackupManager({
      readManifest,
      identityTransfer: {
        isIdentityTransferManifest: sinon.stub().callsFake((manifest) => manifest?.kind === 'peersky-identity-transfer'),
        decryptIdentityTransferZip: sinon.stub().resolves({ verificationCode: 'DEF456' }),
        extractAndVerifyIdentityPayload: sinon.stub().resolves({ files: { 'tabs.json': 'sha256:test' } })
      }
    })
    await writeFile(path.join(userData, 'tabs.json'), 'live tabs')

    const staged = await backupManager.stageRestore(await downloadedZip())
    expect(staged).to.deep.include({ kind: 'transfer', verificationCode: 'DEF456', contents: ['tabs.json'] })
    expect(stubs.suspendHyper.called).to.equal(false)
    expect(await readFile(path.join(userData, 'tabs.json'), 'utf8')).to.equal('live tabs')

    const result = await backupManager.applyStaged(staged.stageId)
    expect(result).to.include({ success: true, requiresRestart: true })
    expect(stubs.suspendHyper.calledOnce).to.equal(true)
    expect(stubs.resumeHyper.called).to.equal(false)
    expect(stubs.forgetPairingNonce.calledWith('ab'.repeat(16))).to.equal(true)
    // The other desktop's stores came with its network keys. This one
    // connects with its own from the restart on.
    expect(await exists(path.join(userData, 'peersky-network-keys.json'))).to.equal(true)
  })

  it('holds a backup download until the person says to restore it', async function () {
    const { backupManager } = await loadBackupManager()
    const zipPath = await downloadedZip()

    const staged = await backupManager.stageRestore(zipPath)
    expect(staged).to.include({ kind: 'backup', encrypted: false })
    expect(await exists(zipPath)).to.equal(true)

    backupManager.discardStaged('some other id')
    expect(await exists(zipPath)).to.equal(true)

    const result = await backupManager.applyStaged(staged.stageId)
    expect(result).to.include({ success: true, requiresRestart: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await exists(zipPath)).to.equal(false)
  })

  it('a cancel drops what was fetched', async function () {
    const { backupManager } = await loadBackupManager()
    const zipPath = await downloadedZip()
    const staged = await backupManager.stageRestore(zipPath)

    backupManager.discardStaged(staged.stageId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await exists(zipPath)).to.equal(false)
    const error = await backupManager.applyStaged(staged.stageId).catch((caught) => caught)
    expect(error.message).to.match(/no longer waiting/)
  })

  it('says where to add a phone\'s tabs when one is opened as a backup', async function () {
    const options = phoneTransferOptions()
    const { backupManager, stubs } = await loadBackupManager(options)

    const error = await backupManager.restoreBackup('/tmp/backup.zip').catch((caught) => caught)
    expect(error.message).to.match(/tabs and bookmarks from a phone, not a backup/)
    expect(stubs.resumeHyper.calledOnce).to.equal(true)
  })

  it('a stage being put in place is not dropped by a cancel, or replaced by a new fetch', async function () {
    let finishRestore
    const copy = sinon.stub().callsFake(async (_src, dest) => {
      await new Promise((resolve) => { finishRestore = resolve })
      await mkdir(dest, { recursive: true })
    })
    const readManifest = sinon.stub()
    readManifest.onFirstCall().resolves(TRANSFER_MANIFEST)
    readManifest.resolves({ version: '1.0.0', files: { 'tabs.json': 'sha256:test' } })
    const { backupManager } = await loadBackupManager({
      copy,
      readManifest,
      identityTransfer: {
        isIdentityTransferManifest: sinon.stub().callsFake((manifest) => manifest?.kind === 'peersky-identity-transfer'),
        decryptIdentityTransferZip: sinon.stub().resolves({ verificationCode: 'DEF456' }),
        extractAndVerifyIdentityPayload: sinon.stub().callsFake(async (_zip, dir) => {
          await mkdir(path.join(dir, 'tabs.json'), { recursive: true })
          return { files: { 'tabs.json': 'sha256:test' } }
        })
      }
    })

    const staged = await backupManager.stageRestore(await downloadedZip())
    const applying = backupManager.applyStaged(staged.stageId)
    await new Promise((resolve) => setTimeout(resolve, 20))

    backupManager.discardStaged(staged.stageId)
    const second = await backupManager.stageRestore(await downloadedZip()).catch((error) => error)
    expect(second.message).to.match(/Still putting the last restore in place/)

    finishRestore()
    const result = await applying
    expect(result).to.include({ success: true, requiresRestart: true })
    expect(backupManager.staged).to.equal(null)
  })

  it('clears staging a crash left behind', async function () {
    const { backupManager, userData } = await loadBackupManager()
    await mkdir(path.join(userData, '.peersky-incoming-abc123', 'inner'), { recursive: true })
    await writeFile(path.join(userData, 'tabs.json'), 'live tabs')

    await backupManager.clearLeftoverStaging()
    expect(await exists(path.join(userData, '.peersky-incoming-abc123'))).to.equal(false)
    expect(await exists(path.join(userData, 'tabs.json'))).to.equal(true)
  })

  it('marks drives new to this device as adopted after a restore', async function () {
    const { module, userData } = await loadBackupManager()
    const drive = 'c'.repeat(64)
    const existing = 'd'.repeat(64)
    await writeFile(path.join(userData, 'privateHyperdrives.json'), JSON.stringify([
      { name: 'new', url: `hyper://${drive}/`, timestamp: 2, encrypted: true },
      { name: 'existing', url: `hyper://${existing}/`, timestamp: 1, encrypted: true }
    ]))

    await module.adoptRestoredPrivateDriveCopies(userData, new Set([existing]))

    const ownership = JSON.parse(await readFile(path.join(userData, 'private-drive-owners.json'), 'utf8'))
    expect(ownership[drive]).to.deep.equal({ owned: false })
    expect(ownership[existing]).to.equal(undefined)
  })
})
