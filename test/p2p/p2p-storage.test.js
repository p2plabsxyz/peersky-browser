import { expect } from 'chai'
import esmock from 'esmock'
import { execFileSync } from 'child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { fileURLToPath } from 'url'
import { measureP2PStorage, oneAtATime, P2P_STORAGE_PARTS } from '../../src/p2p-storage.js'

const PAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/pages')

function write (file, bytes) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes, 1))
}

// A profile as PeerSky leaves it, with the browser's own data beside the P2P
// data.
function makeProfile (profile) {
  write(path.join(profile, 'hyper', 'db', '000001.sst'), 64 * 1024)
  write(path.join(profile, 'hyper', 'swarm-keypair.json'), 200)
  write(path.join(profile, 'hyper-private', 'db', '000002.sst'), 32 * 1024)
  write(path.join(profile, 'ipfs', 'blocks', '000003.ldb'), 16 * 1024)
  write(path.join(profile, 'ipfs', 'libp2p-key'), 100)
  write(path.join(profile, 'myapps', 'notes', 'app', 'index.html'), 3000)
  write(path.join(profile, 'peersky-chat-rooms.json'), 900)
  write(path.join(profile, 'privateHyperdrives.json'), 300)
  write(path.join(profile, 'private-drive-key.json'), 100)
  // The browser's own data, which is not P2P data.
  write(path.join(profile, 'Cache', 'Cache_Data', 'data_1'), 512 * 1024)
  write(path.join(profile, 'settings.json'), 400)
  write(path.join(profile, 'llm.json'), 4000)
}

describe('how much space P2P data takes', function () {
  let root, profile

  beforeEach(function () {
    root = mkdtempSync(path.join(os.tmpdir(), 'peersky-p2p-storage-'))
    profile = path.join(root, 'profile')
    makeProfile(profile)
  })

  afterEach(function () {
    rmSync(root, { recursive: true, force: true })
  })

  it('adds up each part, and nothing else in the profile', async function () {
    const storage = await measureP2PStorage(profile)
    expect(Object.keys(storage.parts)).to.deep.equal(['hyper', 'hyperPrivate', 'ipfs', 'other'])
    expect(storage.total).to.equal(Object.values(storage.parts).reduce((sum, bytes) => sum + bytes, 0))
    expect(storage.parts.hyper).to.be.at.least(64 * 1024 + 200)
    expect(storage.parts.hyperPrivate).to.be.at.least(32 * 1024)
    expect(storage.parts.ipfs).to.be.at.least(16 * 1024 + 100)
    expect(storage.parts.other).to.be.at.least(3000 + 900 + 300 + 100)
    // The 512 KB browser cache would show here.
    expect(storage.total).to.be.below(512 * 1024)
  })

  it('agrees with du, which counts the blocks a file takes', async function () {
    if (process.platform === 'win32') this.skip()
    const parts = { hyper: ['hyper'], hyperPrivate: ['hyper-private'], ipfs: ['ipfs'] }
    const storage = await measureP2PStorage(profile)
    for (const [id, folders] of Object.entries(parts)) {
      const kilobytes = Number(execFileSync('du', ['-sk', ...folders], { cwd: profile, encoding: 'utf8' }).trim().split(/\s+/)[0])
      expect(Math.ceil(storage.parts[id] / 1024), id).to.equal(kilobytes)
    }
  })

  it('counts a file with two names once, and never follows a link out of the profile', async function () {
    const before = await measureP2PStorage(profile)
    linkSync(path.join(profile, 'hyper', 'db', '000001.sst'), path.join(profile, 'hyper-private', 'same.sst'))
    const elsewhere = path.join(root, 'movie.mp4')
    write(elsewhere, 1024 * 1024)
    try {
      symlinkSync(elsewhere, path.join(profile, 'ipfs', 'movie.mp4'))
    } catch (error) {
      // Windows makes links only with a privilege.
      if (process.platform !== 'win32') throw error
    }
    const after = await measureP2PStorage(profile)
    expect(after.total - before.total).to.be.below(64 * 1024)
  })

  it('takes a part that is not there as empty', async function () {
    rmSync(path.join(profile, 'ipfs'), { recursive: true })
    rmSync(path.join(profile, 'myapps'), { recursive: true })
    const storage = await measureP2PStorage(profile)
    expect(storage.parts.ipfs).to.equal(0)
    expect(storage.parts.other).to.be.above(0)
    expect(await measureP2PStorage(path.join(root, 'no-profile'))).to.deep.equal({
      total: 0,
      parts: { hyper: 0, hyperPrivate: 0, ipfs: 0, other: 0 }
    })
  })

  // A walk that ends after it was asked for is waited on, not started again.
  function deferredWalks () {
    const walks = []
    const measure = oneAtATime(() => new Promise((resolve) => walks.push(resolve)))
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    return { walks, measure, settle }
  }

  it('walks the folders once for requests that come while it does', async function () {
    const { walks, measure, settle } = deferredWalks()
    const first = measure()
    const second = measure()
    await settle()
    walks[0]({ total: 1 })
    expect(await first).to.deep.equal({ total: 1 })
    expect(await second).to.deep.equal({ total: 1 })
    expect(walks).to.have.length(1)
    const third = measure()
    await settle()
    walks[1]({ total: 2 })
    expect(await third).to.deep.equal({ total: 2 })
    expect(walks).to.have.length(2)
  })

  it('walks again after a reset, though the walk before it has not ended', async function () {
    const { walks, measure, settle } = deferredWalks()
    const before = measure()
    await settle()
    measure.forget()
    const after = measure()
    await settle()
    expect(walks).to.have.length(2)
    walks[0]({ total: 9 })
    expect(await before).to.deep.equal({ total: 9 })
    // The old walk ending leaves the new one to answer what is asked next.
    const again = measure()
    await settle()
    expect(walks).to.have.length(2)
    walks[1]({ total: 0 })
    expect(await after).to.deep.equal({ total: 0 })
    expect(await again).to.deep.equal({ total: 0 })
  })
})

describe('Settings, P2P data', function () {
  const settings = readFileSync(path.join(PAGES, 'settings.html'), 'utf8')
  // One section's markup, up to the next section.
  const section = (id) => {
    const start = settings.indexOf(`<div id="${id}-section" class="settings-page`)
    const next = settings.slice(start + 1).search(/<div id="[\w-]+-section" class="settings-page/)
    return next === -1 ? settings.slice(start) : settings.slice(start, start + 1 + next)
  }
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  it('is in the sidebar where Archive was, with Reset P2P data and the space it takes', function () {
    expect(settings).to.match(/<a href="#p2p-data" class="nav-item" data-section="p2p-data">\s*<img [^>]+>\s*<span>P2P data<\/span>/)
    expect(settings).to.not.match(/<span>Archive<\/span>/)
    const p2pData = section('p2p-data')
    expect(p2pData).to.contain('<h1 class="section-title">P2P data</h1>')
    expect(p2pData).to.contain('id="reset-p2p"')
    expect(section('search')).to.not.contain('id="reset-p2p"')
    expect(settings.match(/id="reset-p2p"/g)).to.have.length(1)
    expect(p2pData).to.contain('id="p2p-storage-total"')
    // One line for each part the main process measures.
    const shown = [...p2pData.matchAll(/data-storage-part="([^"]+)"/g)].map((match) => match[1])
    expect(shown).to.deep.equal(P2P_STORAGE_PARTS.map((part) => part.id))
  })

  it('says plainly where torrent downloads go, and that the total and the reset leave them out', function () {
    const words = text(section('p2p-data'))
    expect(words).to.contain('Torrent downloads are saved in your Downloads folder (Downloads/PeerskyTorrents), outside P2P data. They are not part of this total, and Reset P2P data does not delete them.')
    expect(words).to.not.contain('are not counted')
  })

  // settings.js is a page script: it runs here with only what its top level
  // touches, and the sections it reads off settings.html.
  function loadSettingsScript () {
    const ids = [...settings.matchAll(/<div id="([\w-]+)-section" class="settings-page/g)].map((match) => `${match[1]}-section`)
    const context = {
      console,
      window: { electronAPI: { on () {} }, addEventListener () {} },
      document: {
        addEventListener () {},
        querySelectorAll: (selector) => selector === '.settings-page' ? ids.map((id) => ({ id })) : []
      }
    }
    vm.createContext(context)
    vm.runInContext(readFileSync(path.join(PAGES, 'static/js/settings.js'), 'utf8'), context)
    return context
  }

  it('still opens from a link to Archive, by address or by anchor', function () {
    const { sectionForLocation } = loadSettingsScript()
    const at = (href) => {
      const url = new URL(href)
      return sectionForLocation({ href, pathname: url.pathname, hash: url.hash })
    }
    expect(at('peersky://settings/archive')).to.equal('p2p-data')
    expect(at('peersky://settings#archive')).to.equal('p2p-data')
    expect(at('peersky://settings/p2p-data')).to.equal('p2p-data')
    expect(at('peersky://settings#p2p-data')).to.equal('p2p-data')
    expect(at('peersky://settings/search')).to.equal('search')
    expect(at('peersky://settings/llm')).to.equal('llm')
    expect(at('peersky://settings')).to.equal('appearance')
    expect(at('peersky://settings/nothing-here')).to.equal('appearance')
    expect(at('peersky://settings/constructor')).to.equal('appearance')
  })

  it('writes sizes the way they read once rounded', function () {
    const { formatStorageSize } = loadSettingsScript()
    expect(formatStorageSize(0)).to.equal('0 B')
    expect(formatStorageSize(undefined)).to.equal('0 B')
    expect(formatStorageSize(900)).to.equal('900 B')
    expect(formatStorageSize(88 * 1024)).to.equal('88 KB')
    expect(formatStorageSize(1023.8 * 1024)).to.equal('1.0 MB')
    expect(formatStorageSize(604.4 * 1024 * 1024)).to.equal('604.4 MB')
    expect(formatStorageSize(1023.97 * 1024 * 1024)).to.equal('1.00 GB')
    expect(formatStorageSize(2.5 * 1024 * 1024 * 1024)).to.equal('2.50 GB')
  })

  it('points the P2P apps page at Reset P2P data where it is now', function () {
    const manager = readFileSync(path.join(PAGES, 'static/js/p2p-app-manager.js'), 'utf8')
    expect(manager).to.contain('<a href="peersky://settings/p2p-data">Settings -&gt; P2P data</a> -&gt; Reset P2P Data')
    expect(manager).to.not.contain('settings/search')
  })
})

// The settings manager on a profile in a temporary folder, with the real
// files: what Reset P2P data removes and keeps, and the space read after it.
describe('Reset P2P data, and the space read after it', function () {
  this.timeout(20000)
  let root, profile, downloads, handlers, manager

  beforeEach(async function () {
    root = mkdtempSync(path.join(os.tmpdir(), 'peersky-p2p-reset-'))
    profile = path.join(root, 'profile')
    downloads = path.join(root, 'Downloads')
    makeProfile(profile)
    write(path.join(downloads, 'PeerskyTorrents', 'Big Buck Bunny', 'movie.mp4'), 128 * 1024)
    handlers = new Map()
    const electron = {
      app: { getPath: (name) => name === 'downloads' ? downloads : profile, on () {}, whenReady: () => new Promise(() => {}) },
      ipcMain: {
        handle (channel, handler) {
          // A second settings manager would answer in place of this one.
          if (handlers.has(channel)) throw new Error(`${channel} is handled twice`)
          handlers.set(channel, handler)
        },
        on () {},
        removeHandler () {}
      },
      BrowserWindow: { getAllWindows: () => [] },
      session: { defaultSession: {} },
      safeStorage: { isEncryptionAvailable: () => false },
      dialog: {},
      webContents: { getAllWebContents: () => [] }
    }
    // The debug log goes to the home folder, which is the temporary one here.
    const home = () => root
    // .p, as the reset imports AI memory when it runs.
    manager = await esmock.strict.p('../../src/settings-manager.js', {
      '../../src/protocols/config.js': { ensCache: [], ipfsCache: [], hyperCache: [], saveEnsCache () {}, saveIpfsCache () {}, saveHyperCache () {} },
      '../../src/ens-utils.js': { normalizeEnsHash: (value) => value },
      '../../src/permissions.js': { clearPersistedPermissions () {} },
      '../../src/p2p-app-registry.js': { default: { reset: async () => rmSync(path.join(profile, 'myapps'), { recursive: true, force: true }) } },
      '../../src/llm-memory.js': { resetCache () {} }
    }, { electron, os: { default: { homedir: home }, homedir: home } })
  })

  afterEach(function () {
    esmock.purge(manager)
    rmSync(root, { recursive: true, force: true })
  })

  const fromSettings = { senderFrame: { url: 'peersky://settings/p2p-data' } }

  it('keeps private drives and torrent downloads, and the space read next is what is left', async function () {
    const before = await handlers.get('settings-get-p2p-storage')(fromSettings)
    expect(before.parts.hyper).to.be.at.least(64 * 1024)

    await handlers.get('settings-reset-p2p')(fromSettings, {})

    expect(existsSync(path.join(downloads, 'PeerskyTorrents', 'Big Buck Bunny', 'movie.mp4'))).to.equal(true)
    expect(existsSync(path.join(profile, 'hyper-private', 'db', '000002.sst'))).to.equal(true)
    expect(existsSync(path.join(profile, 'privateHyperdrives.json'))).to.equal(true)
    expect(existsSync(path.join(profile, 'private-drive-key.json'))).to.equal(true)
    // Identities are kept unless asked.
    expect(existsSync(path.join(profile, 'hyper', 'swarm-keypair.json'))).to.equal(true)
    expect(existsSync(path.join(profile, 'ipfs', 'libp2p-key'))).to.equal(true)
    expect(existsSync(path.join(profile, 'hyper', 'db'))).to.equal(false)
    expect(existsSync(path.join(profile, 'ipfs', 'blocks'))).to.equal(false)
    expect(existsSync(path.join(profile, 'peersky-chat-rooms.json'))).to.equal(false)

    const after = await handlers.get('settings-get-p2p-storage')(fromSettings)
    expect(after.parts.hyper).to.be.below(64 * 1024)
    expect(after.parts.ipfs).to.be.below(16 * 1024)
    expect(after.parts.hyperPrivate).to.equal(before.parts.hyperPrivate)
    expect(after.total).to.be.below(before.total)
  })

  it('keeps them as well when the identities go too', async function () {
    await handlers.get('settings-reset-p2p')(fromSettings, { resetIdentities: true })
    expect(existsSync(path.join(profile, 'hyper'))).to.equal(false)
    expect(existsSync(path.join(profile, 'ipfs'))).to.equal(false)
    expect(existsSync(path.join(downloads, 'PeerskyTorrents', 'Big Buck Bunny', 'movie.mp4'))).to.equal(true)
    expect(existsSync(path.join(profile, 'hyper-private', 'db', '000002.sst'))).to.equal(true)
    expect(existsSync(path.join(profile, 'private-drive-key.json'))).to.equal(true)
  })

  it('resets only when Settings asks', async function () {
    const reset = handlers.get('settings-reset-p2p')
    for (const url of ['peersky://p2p/hyperdrive/', 'peersky://myapps/notes/', 'peersky://home/', 'hyper://settings/', 'https://example.com/', undefined]) {
      let error = null
      await reset({ senderFrame: { url } }, { resetIdentities: true }).catch((caught) => { error = caught })
      expect(error?.message, String(url)).to.equal('Forbidden')
    }
    expect(existsSync(path.join(profile, 'ipfs')), 'nothing was deleted').to.equal(true)
  })

  it('tells only Settings how much space P2P data takes', async function () {
    const measure = handlers.get('settings-get-p2p-storage')
    expect((await measure({ senderFrame: { url: 'peersky://settings' } })).total).to.be.above(0)
    for (const url of ['peersky://p2p/hyperdrive/', 'peersky://home/', 'hyper://settings/', 'https://example.com/', undefined]) {
      let error = null
      await measure({ senderFrame: { url } }).catch((caught) => { error = caught })
      expect(error?.message, String(url)).to.equal('Forbidden')
    }
  })
})
