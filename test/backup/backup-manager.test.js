import { expect } from 'chai'
import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import { mkdtemp } from 'fs/promises'
import sinon from 'sinon'
import esmock from 'esmock'

async function loadBackupManager (options = {}) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-bm-'))
  const manifest = options.manifest || { files: { 'tabs.json': 'sha256:test', ipfs: 'sha256:test', hyper: 'sha256:test' } }
  const suspendHyper = sinon.stub().resolves()
  const resumeHyper = sinon.stub().resolves()
  const suspendIPFS = sinon.stub().resolves()
  const resumeIPFS = sinon.stub().resolves()
  const copy = sinon.stub().resolves()
  const readManifest = sinon.stub().resolves(manifest)
  const verifyManifest = options.verifyManifest || sinon.stub().resolves()
  const backupCorePath = path.join(process.cwd(), 'src/backup/backup-core.js')
  const hyperHandlerPath = path.join(process.cwd(), 'src/protocols/hyper-handler.js')
  const ipfsHandlerPath = path.join(process.cwd(), 'src/protocols/ipfs-handler.js')

  class FakeWorker extends EventEmitter {
    constructor () {
      super()
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
    [backupCorePath]: { readManifest, verifyManifest },
    [hyperHandlerPath]: { suspendHyper, resumeHyper },
    [ipfsHandlerPath]: { suspendIPFS, resumeIPFS }
  }

  const module = await esmock.strict('../../src/backup/backup-manager.js', mocks, mocks)

  return {
    backupManager: module.default,
    stubs: {
      copy,
      readManifest,
      verifyManifest,
      resumeHyper,
      resumeIPFS,
      suspendHyper,
      suspendIPFS
    }
  }
}

describe('backup-manager', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('leaves P2P services stopped after a successful restore', async function () {
    const { backupManager, stubs } = await loadBackupManager()

    const result = await backupManager.restoreBackup('/tmp/backup.zip')

    expect(result).to.include({ success: true, requiresRestart: true })
    expect(stubs.suspendHyper.calledOnce).to.equal(true)
    expect(stubs.suspendIPFS.calledOnce).to.equal(true)
    expect(stubs.resumeHyper.called).to.equal(false)
    expect(stubs.resumeIPFS.called).to.equal(false)
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
})
