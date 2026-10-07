import { app, powerMonitor, BrowserWindow } from 'electron'
// Read through the namespace: PeerChat is a submodule, and one without the
// setter yet only means nobody sees this computer as away.
import * as peerchat from './pages/p2p/peerchat/p2p.js'

// Another app in front for this long is away. A quick look at another window
// is not, and switching back and forth sends nothing.
export const AWAY_AFTER_MS = 60_000
// No key or mouse anywhere on the computer for this long is away too.
export const SYSTEM_IDLE_SECONDS = 5 * 60
const CHECK_EVERY_MS = 15_000

/**
 * Whether the person is away from PeerSky, as PeerChat shows it to people in a
 * room with them: the screen locked, the computer asleep or untouched for five
 * minutes, or no PeerSky window in front for a minute.
 */
export function isAway ({
  locked = false,
  suspended = false,
  idleState = 'active',
  unfocusedSince = null,
  now = Date.now()
} = {}) {
  if (locked || suspended) return true
  if (idleState === 'idle' || idleState === 'locked') return true
  return unfocusedSince !== null && now - unfocusedSince >= AWAY_AFTER_MS
}

/**
 * Watches for the person going away and coming back, and tells PeerChat each
 * time it changes.
 */
export function startPeerChatPresence ({
  electron = { app, powerMonitor, BrowserWindow },
  setIdle = (idle) => {
    if (typeof peerchat.setPresenceIdle === 'function') peerchat.setPresenceIdle(idle)
  },
  now = () => Date.now(),
  every = setInterval,
  later = setImmediate
} = {}) {
  let locked = false
  let suspended = false
  let unfocusedSince = electron.BrowserWindow.getFocusedWindow() ? null : now()
  let away = null

  const update = () => {
    let idleState = 'active'
    try {
      idleState = electron.powerMonitor.getSystemIdleState(SYSTEM_IDLE_SECONDS)
    } catch {}
    const next = isAway({ locked, suspended, idleState, unfocusedSince, now: now() })
    if (next === away) return
    away = next
    try {
      setIdle(next)
    } catch {}
  }

  electron.app.on('browser-window-focus', () => {
    unfocusedSince = null
    update()
  })
  electron.app.on('browser-window-blur', () => {
    // Moving between PeerSky windows blurs one just before it focuses the next.
    later(() => {
      if (electron.BrowserWindow.getFocusedWindow() || unfocusedSince !== null) return
      unfocusedSince = now()
      update()
    })
  })
  electron.powerMonitor.on('lock-screen', () => {
    locked = true
    update()
  })
  electron.powerMonitor.on('unlock-screen', () => {
    locked = false
    update()
  })
  electron.powerMonitor.on('suspend', () => {
    suspended = true
    update()
  })
  electron.powerMonitor.on('resume', () => {
    suspended = false
    update()
  })

  // Nothing fires when a minute passes in another app, or when the keyboard
  // has sat untouched for five, so this also looks every few seconds.
  const timer = every(update, CHECK_EVERY_MS)
  timer?.unref?.()
  update()
  return { update, stop: () => clearInterval(timer) }
}
