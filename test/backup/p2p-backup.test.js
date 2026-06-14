import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import path from 'path'

const ipfsHandlerPath = path.join(process.cwd(), 'src/protocols/ipfs-handler.js')
const hyperHandlerPath = path.join(process.cwd(), 'src/protocols/hyper-handler.js')
const configPath = path.join(process.cwd(), 'src/protocols/config.js')

function buildMocks (overrides = {}) {
  const ipfsCache = overrides.ipfsCache || []
  const hyperCache = overrides.hyperCache || []
  const saveIpfsCache = sinon.stub()
  const saveHyperCache = sinon.stub()
  const ipfsPublishFile = overrides.ipfsPublishFile || sinon.stub().resolves('bafybeifake123')
  const ipfsFetchToFile = overrides.ipfsFetchToFile || sinon.stub().resolves('/tmp/out.zip')
  const hyperPublishFile = overrides.hyperPublishFile || sinon.stub().resolves({
    key: 'abc123def456',
    fileName: 'backup.zip',
    address: 'hyper://abc123def456/backup.zip'
  })
  const hyperFetchToFile = overrides.hyperFetchToFile || sinon.stub().resolves('/tmp/out.zip')

  const mocks = {
    [ipfsHandlerPath]: { ipfsPublishFile, ipfsFetchToFile },
    [hyperHandlerPath]: { hyperPublishFile, hyperFetchToFile },
    [configPath]: { ipfsCache, hyperCache, saveIpfsCache, saveHyperCache }
  }

  return {
    mocks,
    stubs: {
      ipfsPublishFile,
      ipfsFetchToFile,
      hyperPublishFile,
      hyperFetchToFile,
      saveIpfsCache,
      saveHyperCache,
      ipfsCache,
      hyperCache
    }
  }
}

async function loadModule (overrides = {}) {
  const { mocks, stubs } = buildMocks(overrides)
  const mod = await esmock.strict('../../src/backup/p2p-backup.js', mocks, mocks)
  return { mod, stubs }
}

describe('p2p-backup', function () {
  afterEach(function () {
    sinon.restore()
  })

  describe('parseIpfsAddress', function () {
    let parseIpfsAddress

    before(async function () {
      const { mod } = await loadModule()
      parseIpfsAddress = mod.parseIpfsAddress
    })

    it('accepts a raw CID string', function () {
      expect(parseIpfsAddress('bafybeifake123')).to.equal('bafybeifake123')
    })

    it('strips ipfs:// prefix', function () {
      expect(parseIpfsAddress('ipfs://bafybeifake123')).to.equal('bafybeifake123')
    })

    it('strips path after CID in an ipfs:// URL', function () {
      expect(parseIpfsAddress('ipfs://bafybeifake123/file.zip')).to.equal('bafybeifake123')
    })

    it('strips query string after CID', function () {
      expect(parseIpfsAddress('ipfs://bafybeifake123?download=true')).to.equal('bafybeifake123')
    })

    it('strips leading slashes from bare CID', function () {
      expect(parseIpfsAddress('///bafybeifake123')).to.equal('bafybeifake123')
    })

    it('trims whitespace', function () {
      expect(parseIpfsAddress('  bafybeifake123  ')).to.equal('bafybeifake123')
    })

    it('throws on empty input', function () {
      expect(() => parseIpfsAddress('')).to.throw()
    })

    it('throws on null input', function () {
      expect(() => parseIpfsAddress(null)).to.throw()
    })

    it('throws on non-ipfs URL scheme', function () {
      expect(() => parseIpfsAddress('https://example.com/cid')).to.throw(/Only raw CIDs/)
    })

    it('throws on hyper:// scheme', function () {
      expect(() => parseIpfsAddress('hyper://abc123')).to.throw(/Only raw CIDs/)
    })
  })

  describe('uploadBackup', function () {
    it('publishes to IPFS by default and wires cache', async function () {
      const { mod, stubs } = await loadModule()
      const result = await mod.uploadBackup('/tmp/backup.zip')

      expect(result.protocol).to.equal('ipfs')
      expect(result.cid).to.equal('bafybeifake123')
      expect(result.address).to.equal('ipfs://bafybeifake123')
      expect(stubs.ipfsPublishFile.calledOnceWith('/tmp/backup.zip')).to.equal(true)

      expect(stubs.ipfsCache).to.have.length(1)
      expect(stubs.ipfsCache[0].cid).to.equal('bafybeifake123')
      expect(stubs.ipfsCache[0].url).to.equal('ipfs://bafybeifake123/')
      expect(stubs.saveIpfsCache.calledOnce).to.equal(true)
    })

    it('publishes to Hyper and wires cache', async function () {
      const { mod, stubs } = await loadModule()
      const result = await mod.uploadBackup('/tmp/backup.zip', 'hyper')

      expect(result.protocol).to.equal('hyper')
      expect(result.key).to.equal('abc123def456')
      expect(result.address).to.equal('hyper://abc123def456/backup.zip')
      expect(stubs.hyperPublishFile.calledOnceWith('/tmp/backup.zip')).to.equal(true)

      expect(stubs.hyperCache).to.have.length(1)
      expect(stubs.hyperCache[0].key).to.equal('abc123def456')
      expect(stubs.hyperCache[0].type).to.equal('drive')
      expect(stubs.saveHyperCache.calledOnce).to.equal(true)
    })
  })

  describe('downloadBackupFromAddress', function () {
    it('downloads from IPFS CID and adds to ipfsCache', async function () {
      const { mod, stubs } = await loadModule()
      const dest = await mod.downloadBackupFromAddress('bafybeifake123')

      expect(dest).to.be.a('string')
      expect(stubs.ipfsFetchToFile.calledOnce).to.equal(true)
      const callArgs = stubs.ipfsFetchToFile.firstCall.args
      expect(callArgs[0]).to.equal('bafybeifake123')

      expect(stubs.ipfsCache).to.have.length(1)
      expect(stubs.ipfsCache[0].cid).to.equal('bafybeifake123')
      expect(stubs.saveIpfsCache.calledOnce).to.equal(true)
    })

    it('downloads from ipfs:// URL and adds to ipfsCache', async function () {
      const { mod, stubs } = await loadModule()
      await mod.downloadBackupFromAddress('ipfs://bafybeifake123')

      expect(stubs.ipfsFetchToFile.calledOnce).to.equal(true)
      expect(stubs.ipfsCache).to.have.length(1)
      expect(stubs.ipfsCache[0].cid).to.equal('bafybeifake123')
    })

    it('updates existing ipfsCache entry timestamp', async function () {
      const existing = { cid: 'bafybeifake123', timestamp: 1000, url: 'ipfs://bafybeifake123/', name: 'old' }
      const { mod, stubs } = await loadModule({ ipfsCache: [existing] })
      await mod.downloadBackupFromAddress('bafybeifake123')

      expect(stubs.ipfsCache).to.have.length(1)
      expect(stubs.ipfsCache[0].timestamp).to.be.greaterThan(1000)
      expect(stubs.saveIpfsCache.calledOnce).to.equal(true)
    })

    it('downloads from hyper:// address and adds to hyperCache', async function () {
      const { mod, stubs } = await loadModule()
      await mod.downloadBackupFromAddress('hyper://abc123def456/backup.zip')

      expect(stubs.hyperFetchToFile.calledOnce).to.equal(true)
      expect(stubs.hyperCache).to.have.length(1)
      expect(stubs.hyperCache[0].key).to.equal('abc123def456')
      expect(stubs.saveHyperCache.calledOnce).to.equal(true)
    })

    it('appends /backup.zip when hyper:// path is empty', async function () {
      const { mod, stubs } = await loadModule()
      await mod.downloadBackupFromAddress('hyper://abc123def456')

      const fetchedAddress = stubs.hyperFetchToFile.firstCall.args[0]
      expect(fetchedAddress).to.equal('hyper://abc123def456/backup.zip')
    })

    it('updates existing hyperCache entry timestamp', async function () {
      const existing = { key: 'abc123def456', timestamp: 1000, url: 'hyper://abc123def456/', name: 'old' }
      const { mod, stubs } = await loadModule({ hyperCache: [existing] })
      await mod.downloadBackupFromAddress('hyper://abc123def456/backup.zip')

      expect(stubs.hyperCache).to.have.length(1)
      expect(stubs.hyperCache[0].timestamp).to.be.greaterThan(1000)
    })

    it('forwards status messages via onStatus callback', async function () {
      const { mod } = await loadModule()
      const messages = []
      await mod.downloadBackupFromAddress('bafybeifake123', (status) => {
        messages.push(status.message)
      })

      expect(messages.length).to.be.greaterThan(0)
      expect(messages.some(m => m.includes('IPFS'))).to.equal(true)
    })
  })
})
