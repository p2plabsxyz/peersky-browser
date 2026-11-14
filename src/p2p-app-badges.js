import { ipcMain } from 'electron'
import { isPeerskyAppPage, isPeerskyPage } from './backup/ipc-caller.js'
import { newDeviceFileCount } from './protocols/device-sync-state.js'
import { isTabOnScreen } from './tab-on-screen.js'

// The counts on the P2P apps in the home page's bar, by the ids in
// pages/p2p/p2p-list.js: PeerChat's unread messages, the files the person's
// other devices added in Hyperdrive, and AI Chat's answers that finished
// while it was out of view. Only the home page reads them.

export const BADGE_APPS = Object.freeze({ peerchat: 'chat', hyperdrive: 'upload', aiChat: 'ai-chat' })
// Past this the bar shows 99+, and nothing needs the real number.
export const MAX_BADGE_COUNT = 999
// One look at PeerChat's rooms serves every home page asking within this long.
export const PEERCHAT_CACHE_MS = 2000

function countOf (value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Unread messages across PeerChat's rooms, the way the phone counts them for
 * its PeerChat shortcut: a muted room counts only where you were mentioned.
 */
export function peerChatUnreadTotal (rooms) {
  let total = 0
  for (const room of Array.isArray(rooms) ? rooms : []) {
    if (!room || typeof room !== 'object' || room.movedTo) continue
    total += countOf(room.isMuted === true ? room.unreadMentions : room.unreadCount)
    if (total >= MAX_BADGE_COUNT) return MAX_BADGE_COUNT
  }
  return total
}

/**
 * The counts, kept in the main process. `peerChatRooms` reads PeerChat's
 * rooms; `newDeviceFiles` counts what the other devices added. AI Chat tells
 * of its own answers, and that it is in view again.
 */
export function createAppBadges ({
  peerChatRooms = async () => [],
  newDeviceFiles = () => 0,
  now = () => Date.now(),
  logger = console
} = {}) {
  let aiReplies = 0
  let peerChat = { at: -Infinity, total: 0, reading: null }

  async function peerChatCount () {
    if (now() - peerChat.at < PEERCHAT_CACHE_MS) return peerChat.total
    if (!peerChat.reading) {
      peerChat.reading = Promise.resolve()
        .then(() => peerChatRooms())
        .then((rooms) => {
          peerChat = { at: now(), total: peerChatUnreadTotal(rooms), reading: null }
        }, (error) => {
          logger.warn?.(`[badges] PeerChat's unread count was not read: ${error?.message || error}`)
          peerChat = { ...peerChat, reading: null }
        })
    }
    await peerChat.reading
    return peerChat.total
  }

  function deviceFileCount () {
    try {
      return Math.min(countOf(newDeviceFiles()), MAX_BADGE_COUNT)
    } catch {
      return 0
    }
  }

  return {
    async counts () {
      return {
        [BADGE_APPS.peerchat]: await peerChatCount(),
        [BADGE_APPS.hyperdrive]: deviceFileCount(),
        [BADGE_APPS.aiChat]: aiReplies
      }
    },
    // An answer AI Chat finished: one more to look at when it was not in view.
    aiReplyFinished ({ visible = false } = {}) {
      if (visible !== true) aiReplies = Math.min(aiReplies + 1, MAX_BADGE_COUNT)
    },
    get aiReplies () {
      return aiReplies
    },
    aiChatSeen () {
      aiReplies = 0
    }
  }
}

const isHomePage = (event) => isPeerskyPage(event?.senderFrame?.url, 'home')
const isAiChatPage = (event) => isPeerskyAppPage(event?.senderFrame?.url, 'p2p', 'ai-chat')

export function setupAppBadgesIpc ({ userDataDir, peerChatRooms, electron = { ipcMain }, onScreen = isTabOnScreen } = {}) {
  const badges = createAppBadges({
    peerChatRooms,
    newDeviceFiles: () => newDeviceFileCount(userDataDir)
  })
  electron.ipcMain.handle('p2p-app-badges', (event) => {
    if (!isHomePage(event)) throw new Error('Forbidden')
    return badges.counts()
  })
  // From AI Chat's own page alone, and only its top frame. Whether it is in
  // view is asked of its window, not of the page (tab-on-screen.js).
  electron.ipcMain.on('ai-chat-reply-finished', (event) => {
    if (!isAiChatPage(event) || event.senderFrame?.parent) return
    Promise.resolve(onScreen(event.sender))
      .catch(() => false)
      .then((visible) => badges.aiReplyFinished({ visible: visible === true }))
  })
  // AI Chat taken up again: its answers are seen once its tab is in front.
  electron.ipcMain.on('ai-chat-seen', (event) => {
    if (!isAiChatPage(event) || event.senderFrame?.parent || badges.aiReplies === 0) return
    Promise.resolve(onScreen(event.sender))
      .catch(() => false)
      .then((visible) => { if (visible === true) badges.aiChatSeen() })
  })
  return badges
}
