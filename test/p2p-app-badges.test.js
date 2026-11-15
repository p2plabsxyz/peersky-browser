import { expect } from 'chai'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import esmock from 'esmock'

// The counts on the apps in the home page's bar: PeerChat's unread messages,
// new files from the person's other devices, and AI Chat's answers that
// finished while it was out of view.
describe('counts on the P2P apps in the home bar', function () {
  async function load () {
    return esmock('../src/p2p-app-badges.js', {}, { electron: { ipcMain: fakeIpc(), BrowserWindow: {} } })
  }

  function fakeIpc () {
    const handlers = new Map()
    const listeners = new Map()
    return {
      handlers,
      listeners,
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, listener) => listeners.set(channel, listener)
    }
  }

  const from = (url, { parent = null } = {}) => ({ senderFrame: { url, parent } })

  it('counts PeerChat as the phone does: a muted room only where you were mentioned', async function () {
    const { peerChatUnreadTotal, MAX_BADGE_COUNT } = await load()
    expect(peerChatUnreadTotal([
      { unreadCount: 3, unreadMentions: 1 },
      { unreadCount: 7, unreadMentions: 2, isMuted: true },
      { unreadCount: 5, unreadMentions: 0, isMuted: true },
      { unreadCount: 4, movedTo: 'b'.repeat(64) },
      { unreadCount: -2 },
      { unreadCount: 1.5 },
      { unreadCount: '9' },
      null
    ])).to.equal(5)
    expect(peerChatUnreadTotal(undefined)).to.equal(0)
    expect(peerChatUnreadTotal([{ unreadCount: 900 }, { unreadCount: 900 }])).to.equal(MAX_BADGE_COUNT)
  })

  it('reads PeerChat once for every home page asking at the same time, and again after a moment', async function () {
    const { createAppBadges, PEERCHAT_CACHE_MS } = await load()
    let reads = 0
    let clock = 1000
    let unread = 2
    const badges = createAppBadges({
      peerChatRooms: async () => { reads++; return [{ unreadCount: unread }] },
      now: () => clock
    })
    const [a, b] = await Promise.all([badges.counts(), badges.counts()])
    expect(a.chat).to.equal(2)
    expect(b.chat).to.equal(2)
    expect(reads).to.equal(1)
    unread = 4
    clock += PEERCHAT_CACHE_MS - 1
    expect((await badges.counts()).chat).to.equal(2)
    clock += 1
    expect((await badges.counts()).chat).to.equal(4)
    expect(reads).to.equal(2)
  })

  it('keeps the last PeerChat count when a read fails, and never fails the answer', async function () {
    const { createAppBadges, PEERCHAT_CACHE_MS } = await load()
    let clock = 0
    let fail = false
    const badges = createAppBadges({
      peerChatRooms: async () => {
        if (fail) throw new Error('chat is restarting')
        return [{ unreadCount: 3 }]
      },
      newDeviceFiles: () => { throw new Error('unreadable') },
      now: () => clock,
      logger: { warn () {} }
    })
    expect(await badges.counts()).to.deep.equal({ chat: 3, upload: 0, 'ai-chat': 0 })
    fail = true
    clock += PEERCHAT_CACHE_MS
    expect(await badges.counts()).to.deep.equal({ chat: 3, upload: 0, 'ai-chat': 0 })
  })

  it('counts an AI Chat answer only when it finished out of view, until AI Chat is looked at', async function () {
    const { createAppBadges } = await load()
    const badges = createAppBadges({ newDeviceFiles: () => 2 })
    badges.aiReplyFinished({ visible: true })
    expect((await badges.counts())['ai-chat']).to.equal(0)
    badges.aiReplyFinished({ visible: false })
    badges.aiReplyFinished()
    expect(await badges.counts()).to.deep.equal({ chat: 0, upload: 2, 'ai-chat': 2 })
    badges.aiChatSeen()
    expect((await badges.counts())['ai-chat']).to.equal(0)
  })

  it('answers the home page alone, and hears AI Chat alone, from its top frame', async function () {
    const ipc = fakeIpc()
    const module = await esmock('../src/p2p-app-badges.js', {
      '../src/protocols/device-sync-state.js': { newDeviceFileCount: () => 1 }
    }, { electron: { ipcMain: ipc, BrowserWindow: {} } })
    // Which pages are in front, as their windows say.
    const inFront = new Set()
    const badges = module.setupAppBadgesIpc({
      userDataDir: '/nowhere',
      peerChatRooms: async () => [{ unreadCount: 6 }],
      electron: { ipcMain: ipc },
      onScreen: async (contents) => inFront.has(contents)
    })
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    const ask = ipc.handlers.get('p2p-app-badges')
    expect(await ask(from('peersky://home'))).to.deep.equal({ chat: 6, upload: 1, 'ai-chat': 0 })
    expect(await ask(from('peersky://home/'))).to.deep.equal({ chat: 6, upload: 1, 'ai-chat': 0 })
    for (const url of ['https://example.com/', 'peersky://p2p/ai-chat/', 'peersky://myapps/home', 'hyper://home/', 'peersky://settings', undefined]) {
      expect(() => ask(from(url)), String(url)).to.throw('Forbidden')
    }

    const finished = ipc.listeners.get('ai-chat-reply-finished')
    const seen = ipc.listeners.get('ai-chat-seen')
    const tab = { name: 'AI Chat tab' }
    const chat = (url = 'peersky://p2p/ai-chat/', options) => ({ ...from(url, options), sender: tab })
    // Behind another tab, whatever the page says about itself.
    finished(chat(), { visible: true })
    finished(chat('peersky://p2p/ai-chat/index.html'))
    // Nobody else adds to it: another app, a page made to look like one, a
    // frame inside AI Chat, or any site.
    finished(chat('peersky://p2p/peerchat/'))
    finished(chat('peersky://p2p/ai-chat-copy/'))
    finished(chat('peersky://p2p/ai-chat/', { parent: {} }))
    finished(chat('https://example.com/'))
    finished(chat('peersky://myapps/ai-chat/'))
    await settle()
    expect((await badges.counts())['ai-chat']).to.equal(2)
    // In front, an answer is read as it comes.
    inFront.add(tab)
    finished(chat())
    await settle()
    expect((await badges.counts())['ai-chat']).to.equal(2)
    // Seen only from AI Chat's own tab in front.
    inFront.delete(tab)
    seen(chat())
    seen(chat('peersky://p2p/peerchat/'))
    inFront.add(tab)
    seen(chat('peersky://p2p/ai-chat/', { parent: {} }))
    await settle()
    expect((await badges.counts())['ai-chat']).to.equal(2)
    seen(chat())
    await settle()
    expect((await badges.counts())['ai-chat']).to.equal(0)
  })

  it('gives the channels to the pages that use them, and no others', async function () {
    const preload = await readFile(new URL('../src/pages/unified-preload.js', import.meta.url), 'utf8')
    // The home page reads the counts.
    const home = preload.slice(preload.indexOf('// Home electronAPI with browser action support'), preload.indexOf('} else if (isBookmarks)'))
    expect(home).to.include("badges: () => ipcRenderer.invoke('p2p-app-badges')")
    expect(preload.match(/'p2p-app-badges'/g)).to.have.length(1)
    // Only AI Chat's own streams are counted, when they finish.
    expect(preload).to.match(/const isAiChatApp = pageProtocol === 'peersky:' && pageHost === 'p2p' && \/\^\\\/ai-chat\(\\\/\|\$\)\/\.test\(pagePath\)/)
    expect(preload).to.include('if (isAiChatApp) chatStreams.add(localId)')
    expect(preload).to.include("if (result?.done && chatStreams.delete(localId)) {\n      ipcRenderer.send('ai-chat-reply-finished')")
    expect(preload).to.include('chatStreams.delete(localId)\n    return ipcRenderer.invoke(\'llm-iterate-return\', { id })')
    expect(preload.match(/'ai-chat-seen'/g)).to.have.length(1)
    expect(preload.match(/'ai-chat-reply-finished'/g)).to.have.length(1)
    // The Hyperdrive app marks its files seen, from the P2P pages' API.
    expect(preload.match(/'device-sync-seen'/g)).to.have.length(1)
  })

  it('shows a count on a pinned app and takes it off at zero', async function () {
    const source = await readFile(new URL('../src/pages/peer-bar.js', import.meta.url), 'utf8')
    const context = {}
    vm.runInNewContext(`${source.slice(source.indexOf('function badgeText'), source.indexOf('class PeerBar'))}; this.badgeText = badgeText; this.badgeLabel = badgeLabel`, context)
    const { badgeText, badgeLabel } = context
    expect(badgeText(7)).to.equal('7')
    expect(badgeText(99)).to.equal('99')
    expect(badgeText(100)).to.equal('99+')
    expect(badgeLabel('chat', 1)).to.equal('1 unread message')
    expect(badgeLabel('chat', 120)).to.equal('99+ unread messages')
    expect(badgeLabel('upload', 2)).to.equal('2 new files from your devices')
    expect(badgeLabel('ai-chat', 1)).to.equal('1 new answer')
    // The number goes in as text.
    expect(source).to.include('badge.textContent = badgeText(count)')
    expect(source).not.to.include('innerHTML = `')
  })
})
