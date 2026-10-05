import { expect } from 'chai'
import { EventEmitter } from 'node:events'
import esmock from 'esmock'

// PeerChat shows a yellow dot and "Idle" for someone away from PeerSky. Only
// PeerSky knows when that is: the screen locked, the computer asleep or left
// alone, or another app in front for a while.
describe('PeerChat away status', function () {
  async function load () {
    return esmock.strict('../src/peerchat-presence.js', {
      '../src/pages/p2p/peerchat/p2p.js': {}
    }, { electron: { app: {}, powerMonitor: {}, BrowserWindow: {} } })
  }

  function harness ({ focused = true } = {}) {
    const app = new EventEmitter()
    const powerMonitor = new EventEmitter()
    powerMonitor.idleState = 'active'
    powerMonitor.getSystemIdleState = (seconds) => {
      powerMonitor.asked = seconds
      return powerMonitor.idleState
    }
    const state = { focused, now: 0, sent: [], tick: null, queued: [] }
    const BrowserWindow = { getFocusedWindow: () => (state.focused ? {} : null) }
    const options = {
      electron: { app, powerMonitor, BrowserWindow },
      setIdle: (idle) => state.sent.push(idle),
      now: () => state.now,
      every: (callback) => { state.tick = callback; return { unref () {} } },
      later: (callback) => state.queued.push(callback)
    }
    const flush = () => state.queued.splice(0).forEach((callback) => callback())
    return { app, powerMonitor, state, options, flush }
  }

  it('is here at the computer, and away when locked, asleep or left alone', async function () {
    const { isAway, AWAY_AFTER_MS } = await load()
    expect(isAway({})).to.equal(false)
    expect(isAway({ locked: true })).to.equal(true)
    expect(isAway({ suspended: true })).to.equal(true)
    expect(isAway({ idleState: 'idle' })).to.equal(true)
    expect(isAway({ idleState: 'locked' })).to.equal(true)
    expect(isAway({ idleState: 'unknown' })).to.equal(false)
    expect(isAway({ unfocusedSince: 0, now: AWAY_AFTER_MS - 1 })).to.equal(false)
    expect(isAway({ unfocusedSince: 0, now: AWAY_AFTER_MS })).to.equal(true)
  })

  it('says here once at the start, and away only after a minute in another app', async function () {
    const { startPeerChatPresence, AWAY_AFTER_MS, SYSTEM_IDLE_SECONDS } = await load()
    const { app, powerMonitor, state, options, flush } = harness()
    startPeerChatPresence(options)
    expect(state.sent).to.deep.equal([false])
    expect(powerMonitor.asked).to.equal(SYSTEM_IDLE_SECONDS)

    // A glance at another app and straight back sends nothing.
    state.focused = false
    app.emit('browser-window-blur')
    flush()
    state.now = 10_000
    state.focused = true
    app.emit('browser-window-focus')
    expect(state.sent).to.deep.equal([false])

    // Away once a minute has gone by in another app, and back on return.
    state.focused = false
    app.emit('browser-window-blur')
    flush()
    state.now = 10_000 + AWAY_AFTER_MS
    state.tick()
    expect(state.sent).to.deep.equal([false, true])
    state.tick()
    expect(state.sent).to.deep.equal([false, true])
    state.focused = true
    app.emit('browser-window-focus')
    expect(state.sent).to.deep.equal([false, true, false])
  })

  it('takes moving between PeerSky windows as staying', async function () {
    const { startPeerChatPresence, AWAY_AFTER_MS } = await load()
    const { app, state, options, flush } = harness()
    startPeerChatPresence(options)
    // One window blurs, and by the time anyone looks the next has focus.
    app.emit('browser-window-blur')
    flush()
    state.now = AWAY_AFTER_MS * 2
    state.tick()
    expect(state.sent).to.deep.equal([false])
  })

  it('goes away at once on lock or sleep, and back when that ends', async function () {
    const { startPeerChatPresence } = await load()
    const { powerMonitor, state, options } = harness()
    startPeerChatPresence(options)
    powerMonitor.emit('lock-screen')
    powerMonitor.emit('unlock-screen')
    powerMonitor.emit('suspend')
    powerMonitor.emit('resume')
    expect(state.sent).to.deep.equal([false, true, false, true, false])

    // Five minutes without a key or the mouse is away too.
    powerMonitor.idleState = 'idle'
    state.tick()
    expect(state.sent.at(-1)).to.equal(true)
  })

  it('starts away when PeerSky opens behind another app', async function () {
    const { startPeerChatPresence, AWAY_AFTER_MS } = await load()
    const { state, options } = harness({ focused: false })
    startPeerChatPresence(options)
    state.now = AWAY_AFTER_MS
    state.tick()
    expect(state.sent).to.deep.equal([false, true])
  })

  it('tells a PeerChat that has the setter, and leaves an older one be', async function () {
    const calls = []
    const withSetter = await esmock.strict('../src/peerchat-presence.js', {
      '../src/pages/p2p/peerchat/p2p.js': { setPresenceIdle: (idle) => calls.push(idle) }
    }, { electron: { app: {}, powerMonitor: {}, BrowserWindow: {} } })
    const { options } = harness()
    delete options.setIdle
    withSetter.startPeerChatPresence(options)
    expect(calls).to.deep.equal([false])

    const older = await load()
    const second = harness()
    delete second.options.setIdle
    expect(() => older.startPeerChatPresence(second.options)).to.not.throw()
  })
})
