/**
 * Cost and correctness of bringing extensions up alongside the first window.
 *
 * Extensions used to load one at a time, and app.whenReady() awaited the whole
 * lot before creating a window — so every installed extension added its own
 * load time to the delay before the browser appeared. They now load together,
 * and window creation no longer waits for them.
 *
 * Not waiting introduces a race: a tab can attach before the extension host
 * exists. Registrations are queued and flushed, and the second half of this
 * file pins that, because losing one would leave the tab invisible to every
 * extension — which looks exactly like "the extension needs a second click".
 */

import { expect } from 'chai'
import sinon from 'sinon'
import { EventEmitter } from 'events'

import os from 'os'
import path from 'path'
import { mkdtemp, rm } from 'fs/promises'

import { loadExtensionsIntoElectron } from '../../src/extensions/services/loader.js'
import { createPendingTabs } from '../../src/extensions/services/pending-tabs.js'

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeExtension (n) {
  return {
    id: `ext-${n}`,
    name: `Extension ${n}`,
    displayName: `Extension ${n}`,
    enabled: true,
    installedPath: `/extensions/ext-${n}`
  }
}

describe('Extensions load in parallel at startup', function () {
  let registryDir
  let consoleLog

  before(async function () {
    registryDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-perf-ext-'))
  })

  after(async function () {
    await rm(registryDir, { recursive: true, force: true })
  })

  beforeEach(function () {
    // The loader narrates each extension; keep the suite output readable.
    consoleLog = sinon.stub(console, 'log')
  })

  afterEach(function () {
    consoleLog?.restore()
    sinon.restore()
  })

  it('loads every enabled extension concurrently', async function () {
    const LOAD_MS = 60
    const COUNT = 6
    let concurrent = 0
    let peakConcurrent = 0

    const loadExtension = sinon.stub().callsFake(async (installedPath) => {
      concurrent++
      peakConcurrent = Math.max(peakConcurrent, concurrent)
      await tick(LOAD_MS)
      concurrent--
      return { id: `electron-${installedPath}` }
    })

    const manager = {
      session: { loadExtension, getExtension: () => null },
      loadedExtensions: new Map(
        Array.from({ length: COUNT }, (_, i) => [`ext-${i}`, makeExtension(i)])
      ),
      extensionsRegistryFile: path.join(registryDir, 'extensions.json')
    }

    const started = Date.now()
    await loadExtensionsIntoElectron(manager)
    const elapsed = Date.now() - started

    expect(peakConcurrent, 'extensions were still loaded one at a time').to.equal(COUNT)
    expect(elapsed, `loading ${COUNT} extensions took as long as doing them in sequence`)
      .to.be.lessThan(LOAD_MS * COUNT)
  })

  it('records the electron id of each loaded extension', async function () {
    const manager = {
      session: {
        loadExtension: async (installedPath) => ({ id: `electron-${installedPath.slice(-1)}` }),
        getExtension: () => null
      },
      loadedExtensions: new Map([['ext-1', makeExtension(1)], ['ext-2', makeExtension(2)]]),
      extensionsRegistryFile: path.join(registryDir, 'extensions.json')
    }

    await loadExtensionsIntoElectron(manager)

    expect(manager.loadedExtensions.get('ext-1').electronId).to.equal('electron-1')
    expect(manager.loadedExtensions.get('ext-2').electronId).to.equal('electron-2')
  })

  it('lets the others load when one extension fails', async function () {
    const loadExtension = sinon.stub().callsFake(async (installedPath) => {
      if (installedPath.endsWith('2')) throw new Error('corrupt manifest')
      return { id: `electron-${installedPath.slice(-1)}` }
    })
    sinon.stub(console, 'error')

    const manager = {
      session: { loadExtension, getExtension: () => null },
      loadedExtensions: new Map([
        ['ext-1', makeExtension(1)],
        ['ext-2', makeExtension(2)],
        ['ext-3', makeExtension(3)]
      ]),
      extensionsRegistryFile: path.join(registryDir, 'extensions.json')
    }

    await loadExtensionsIntoElectron(manager)

    expect(manager.loadedExtensions.get('ext-1').electronId).to.equal('electron-1')
    expect(manager.loadedExtensions.get('ext-2').electronId).to.equal(undefined)
    expect(manager.loadedExtensions.get('ext-3').electronId).to.equal('electron-3')
  })

  it('skips extensions the session already holds', async function () {
    const loadExtension = sinon.stub().resolves({ id: 'never' })
    const already = { ...makeExtension(1), electronId: 'already-loaded' }

    await loadExtensionsIntoElectron({
      session: { loadExtension, getExtension: (id) => (id === 'already-loaded' ? {} : null) },
      loadedExtensions: new Map([['ext-1', already]]),
      extensionsRegistryFile: path.join(registryDir, 'extensions.json')
    })

    expect(loadExtension.called).to.equal(false)
  })
})

describe('Tabs that attach before the extension host is up', function () {
  afterEach(function () {
    sinon.restore()
  })

  function makeTab (id) {
    const wc = new EventEmitter()
    wc.id = id
    wc.isDestroyed = () => false
    return wc
  }

  const liveWindow = () => ({ id: 1, isDestroyed: () => false, webContents: { id: 100 } })

  it('holds them instead of dropping them', function () {
    const pending = createPendingTabs()

    expect(pending.add(liveWindow(), makeTab(101))).to.equal(true)
    expect(pending.add(liveWindow(), makeTab(102))).to.equal(true)
    expect(pending.size()).to.equal(2)

    const drained = pending.drain()
    expect(drained.map(({ webContents }) => webContents.id)).to.deep.equal([101, 102])
    expect(pending.size(), 'draining left tabs behind, so they would register twice').to.equal(0)
  })

  it('holds a given tab once, however many times it attaches', function () {
    const pending = createPendingTabs()
    const tab = makeTab(101)

    pending.add(liveWindow(), tab)
    pending.add(liveWindow(), tab)

    expect(pending.size()).to.equal(1)
  })

  it('forgets a tab that closes before the host is up', function () {
    const pending = createPendingTabs()
    const tab = makeTab(103)
    pending.add(liveWindow(), tab)

    tab.emit('destroyed')

    expect(pending.size(), 'a closed tab stayed queued').to.equal(0)
  })

  it('drops a tab whose window went away while waiting', function () {
    const pending = createPendingTabs()
    const closedWindow = { id: 2, isDestroyed: () => true }
    pending.add(closedWindow, makeTab(104))

    expect(pending.drain()).to.deep.equal([])
  })

  it('refuses the shell window itself, which is not a tab', function () {
    const pending = createPendingTabs()

    expect(pending.add(liveWindow(), undefined)).to.equal(false)
    expect(pending.size()).to.equal(0)
  })

  it('refuses a WebContents that is already gone', function () {
    const pending = createPendingTabs()
    const dead = makeTab(105)
    dead.isDestroyed = () => true

    expect(pending.add(liveWindow(), dead)).to.equal(false)
    expect(pending.size()).to.equal(0)
  })
})
