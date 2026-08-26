/**
 * Cost of keeping the session file up to date.
 *
 * Window move, window resize, navigation and every tab edit each asked for a
 * full session snapshot, and a snapshot is one executeJavaScript round-trip per
 * window plus two JSON writes. A single window drag emits move events
 * continuously, so the browser was doing that work hundreds of times for one
 * gesture — which is what made dragging and resizing stutter.
 *
 * Requests are now coalesced. These tests pin the two properties that matter:
 * a burst collapses into one run, and the last request in a burst is never
 * dropped.
 */

import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import { EventEmitter } from 'events'

import { createCoalescedTask } from '../../src/coalesce.js'

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Session saves are coalesced', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('collapses a drag-sized burst of requests into a single save', async function () {
    const run = sinon.stub().resolves()
    const task = createCoalescedTask({ run, waitMs: 20, maxWaitMs: 200 })

    // A one-second drag at 120Hz is about this many move events.
    for (let i = 0; i < 120; i++) task.schedule()

    expect(run.called, 'saved synchronously during the burst').to.equal(false)
    await tick(60)
    expect(run.callCount, '120 move events must not mean 120 session saves').to.equal(1)
  })

  it('still saves during a burst that never pauses', async function () {
    const run = sinon.stub().resolves()
    const task = createCoalescedTask({ run, waitMs: 30, maxWaitMs: 80 })

    // Keep requesting faster than the quiet period for longer than maxWaitMs.
    const started = Date.now()
    while (Date.now() - started < 140) {
      task.schedule()
      await tick(5)
    }

    expect(run.callCount, 'a continuous drag deferred the save forever').to.be.greaterThan(0)
  })

  it('runs after the last request in a burst, not the first', async function () {
    const seen = []
    let value = 0
    const task = createCoalescedTask({ run: () => seen.push(value), waitMs: 20 })

    for (let i = 1; i <= 5; i++) {
      value = i
      task.schedule()
    }
    await tick(60)

    expect(seen).to.deep.equal([5])
  })

  it('flush runs a pending save immediately, so a quit loses nothing', async function () {
    const run = sinon.stub().resolves('saved')
    const task = createCoalescedTask({ run, waitMs: 5000 })

    task.schedule()
    expect(task.isPending()).to.equal(true)

    await task.flush()

    expect(run.calledOnce).to.equal(true)
    expect(task.isPending()).to.equal(false)
  })

  it('flush is a no-op when nothing is pending', async function () {
    const run = sinon.stub().resolves()
    const task = createCoalescedTask({ run, waitMs: 20 })

    await task.flush()

    expect(run.called).to.equal(false)
  })

  it('cancel drops a pending save, so shutdown cannot be overwritten by a stale one', async function () {
    const run = sinon.stub().resolves()
    const task = createCoalescedTask({ run, waitMs: 20 })

    task.schedule()
    task.cancel()
    await tick(60)

    expect(run.called).to.equal(false)
  })

  it('keeps running after a save fails', async function () {
    const onError = sinon.stub()
    const run = sinon.stub()
    run.onFirstCall().rejects(new Error('disk full'))
    run.onSecondCall().resolves()
    const task = createCoalescedTask({ run, waitMs: 10, onError })

    task.schedule()
    await tick(40)
    task.schedule()
    await tick(40)

    expect(run.callCount).to.equal(2)
    expect(onError.calledOnce).to.equal(true)
  })

  it('does not hold the process open on a pending save', function () {
    const timers = []
    const realSetTimeout = global.setTimeout
    global.setTimeout = (...args) => {
      const handle = realSetTimeout(...args)
      timers.push(handle)
      return handle
    }
    try {
      const task = createCoalescedTask({ run: () => {}, waitMs: 50 })
      task.schedule()
      // Node timers report their unref state through hasRef().
      expect(timers.some((t) => typeof t.hasRef === 'function' && t.hasRef() === false)).to.equal(true)
      task.cancel()
    } finally {
      global.setTimeout = realSetTimeout
      for (const t of timers) clearTimeout(t)
    }
  })
})

describe('WindowManager routes high-frequency events through the coalescer', function () {
  let harness

  beforeEach(async function () {
    harness = await loadWindowManager()
  })

  afterEach(function () {
    harness?.manager.stopSaver()
    sinon.restore()
  })

  it('writes the session once for a burst of tab edits from the renderer', async function () {
    const { ipcListeners, saveCompleteState } = harness

    const onSaveState = ipcListeners.get('save-state')
    expect(onSaveState, 'no save-state listener registered').to.be.a('function')

    for (let i = 0; i < 50; i++) onSaveState()
    await tick(600)

    expect(saveCompleteState.callCount, '50 tab edits must not mean 50 session writes').to.equal(1)
  })

  it('writes the session once for a window drag and resize', async function () {
    const { manager, saveCompleteState } = harness

    const peerskyWindow = manager.open({ url: 'peersky://home' })
    saveCompleteState.resetHistory()

    for (let i = 0; i < 200; i++) peerskyWindow.window.emit('move')
    for (let i = 0; i < 60; i++) peerskyWindow.window.emit('resize')
    await tick(600)

    expect(saveCompleteState.callCount, 'a drag saved once per move event').to.equal(1)
  })

  it('ignores requests once shutdown has begun', async function () {
    const { manager, saveCompleteState } = harness

    manager.setQuitting(true)
    for (let i = 0; i < 10; i++) manager.requestSave()
    await tick(600)

    expect(saveCompleteState.called).to.equal(false)
  })
})

/** Build a WindowManager over stubbed Electron, with the disk writes stubbed out. */
async function loadWindowManager () {
  const ipcListeners = new Map()
  const ipcHandlers = new Map()
  const appEvents = new Map()

  const makeWebContents = (id) => {
    const wc = new EventEmitter()
    wc.id = id
    wc.isDestroyed = () => false
    wc.send = sinon.stub()
    wc.executeJavaScript = sinon.stub().resolves(null)
    wc.session = { getPartition: () => '' }
    return wc
  }

  let nextId = 1
  class FakeBrowserWindow extends EventEmitter {
    constructor () {
      super()
      this.id = nextId
      this.webContents = makeWebContents(nextId++)
      this.isDestroyed = () => false
      this.loadFile = sinon.stub()
      this.setVibrancy = sinon.stub()
      this.setBackgroundMaterial = sinon.stub()
      this.getPosition = () => [0, 0]
      this.getSize = () => [1280, 800]
      this.close = sinon.stub()
    }

    static getAllWindows () { return [] }
    static fromWebContents () { return null }
  }

  // strict so the real extensions/index.js is not merged in: it pulls
  // electron-chrome-web-store, which cannot be imported outside Electron.
  const module = await esmock.strict('../../src/window-manager.js', {
    electron: {
      app: {
        getPath: () => '.test-perf-windows',
        isPackaged: true,
        on: (event, handler) => appEvents.set(event, handler)
      },
      BrowserWindow: FakeBrowserWindow,
      ipcMain: {
        on: (channel, handler) => ipcListeners.set(channel, handler),
        handle: (channel, handler) => ipcHandlers.set(channel, handler),
        removeListener: sinon.stub()
      },
      webContents: { getAllWebContents: () => [] },
      session: { defaultSession: { clearStorageData: sinon.stub().resolves() } }
    },
    'fs-extra': {
      default: {
        pathExists: sinon.stub().resolves(false),
        readFile: sinon.stub().resolves('[]'),
        outputJson: sinon.stub().resolves(),
        move: sinon.stub().resolves(),
        readFileSync: sinon.stub().returns('[]'),
        writeFileSync: sinon.stub(),
        existsSync: sinon.stub().returns(false)
      }
    },
    'scoped-fs': { default: class { stat (_p, cb) { cb(new Error('nope')) } } },
    '../../src/context-menu.js': { attachContextMenus: sinon.stub(), setWindowManager: sinon.stub() },
    '../../src/extensions/index.js': { default: { addWindow: sinon.stub() } },
    '../../src/session.js': { getPartition: () => '' },
    '../../src/logger.js': {
      createLogger: () => ({ info () {}, warn () {}, error () {}, debug () {} })
    }
  })

  const WindowManager = module.default
  const manager = new WindowManager()
  // The write itself is not what is being measured; how often it is asked for is.
  const saveCompleteState = sinon.stub(manager, 'saveCompleteState').resolves()

  return { manager, ipcListeners, ipcHandlers, saveCompleteState }
}
