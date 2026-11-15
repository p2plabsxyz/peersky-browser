// window.prompt() showed nothing and answered null, and alert() and confirm()
// came up in a sheet over the whole window that named no site. Chrome shows
// all three over the tab, naming the page's origin, and the page waits.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import { readFile } from 'fs/promises'
import vm from 'vm'
import esmock from 'esmock'

const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

function contents (id, { type = 'webview', host = null } = {}) {
  const wc = new EventEmitter()
  wc.id = id
  wc.destroyed = false
  wc.isDestroyed = () => wc.destroyed
  wc.getType = () => type
  wc.hostWebContents = host
  return wc
}

describe('page dialogs', function () {
  let dialogs, asked, closed, ipc

  beforeEach(async function () {
    asked = []
    closed = []
    ipc = new EventEmitter()
    dialogs = await esmock.strict('../src/page-dialogs.js', {
      electron: { ipcMain: ipc },
      '../src/tab-dialogs.js': {
        tabHost: (wc) => (wc && !wc.isDestroyed() && wc.getType() === 'webview' ? wc.hostWebContents : null),
        askInTab: (guest, dialog) => new Promise((resolve) => asked.push({ guest, dialog, resolve })),
        closeTabDialogs: (id, kinds) => closed.push([id, kinds])
      }
    })
  })

  const settle = () => new Promise((resolve) => setImmediate(resolve))
  const page = (id = 2, origin = 'https://example.com') => ({
    sender: contents(id, { host: contents(1, { type: 'window' }) }),
    senderFrame: { parent: null, origin }
  })

  // Asks, and answers the dialog with what the window would send.
  async function ask (event, request, answer) {
    const reply = dialogs.answerPageDialog(event, request)
    await settle()
    if (answer !== undefined) asked[asked.length - 1].resolve(answer)
    return reply
  }

  describe('who says it', function () {
    it("names a web page's host, as Chrome does", function () {
      expect(dialogs.dialogTitle('https://example.com')).to.equal('example.com says')
      expect(dialogs.dialogTitle('http://example.com:8080')).to.equal('example.com:8080 says')
    })

    it("names any other address's scheme and host", function () {
      expect(dialogs.dialogTitle('peersky://settings')).to.equal('peersky://settings says')
      expect(dialogs.dialogTitle('hyper://abc123')).to.equal('hyper://abc123 says')
    })

    it('says "This page" for a file or a page with no origin of its own', function () {
      expect(dialogs.dialogTitle('file://')).to.equal('This page says')
      expect(dialogs.dialogTitle('null')).to.equal('This page says')
      expect(dialogs.dialogTitle(undefined)).to.equal('This page says')
    })

    it('takes the origin from the frame, never from the page', async function () {
      const reply = ask(page(2, 'https://real.example'), { type: 'alert', message: 'evil.example says' }, { ok: true })
      await reply
      expect(asked[0].dialog.title).to.equal('real.example says')
      expect(asked[0].dialog.message).to.equal('evil.example says')
    })
  })

  describe('what the page gets', function () {
    it("a prompt's text on OK, and nothing on Cancel", async function () {
      expect(await ask(page(), { type: 'prompt', message: 'Name?', value: 'Ada' }, { ok: true, value: 'Grace' })).to.deep.equal({ ok: true, value: 'Grace' })
      expect(asked[0].dialog).to.include({ kind: 'prompt', message: 'Name?', value: 'Ada', offerStop: false })
      expect(await ask(page(), { type: 'prompt', message: 'Name?' }, { ok: false, value: 'ignored' })).to.deep.equal({ ok: false })
    })

    it("a confirm's choice, and an alert's OK", async function () {
      expect(await ask(page(), { type: 'confirm', message: 'Sure?' }, { ok: true })).to.deep.equal({ ok: true })
      expect(await ask(page(), { type: 'confirm', message: 'Sure?' }, { ok: false })).to.deep.equal({ ok: false })
      expect(await ask(page(), { type: 'alert', message: 'Hi' }, { ok: true })).to.deep.equal({ ok: true })
      expect(asked[2].dialog).to.not.have.property('value')
    })

    it('a cancel when the tab closes or goes to another page first', async function () {
      expect(await ask(page(), { type: 'confirm', message: 'Sure?' }, null)).to.deep.equal({ ok: false })
    })

    it("Chrome's limits on what is shown", async function () {
      await ask(page(), { type: 'prompt', message: 'm'.repeat(5000), value: 'v'.repeat(5000) }, { ok: false })
      expect(asked[0].dialog.message).to.have.length(dialogs.MESSAGE_LIMIT + 1)
      expect(asked[0].dialog.value).to.have.length(dialogs.VALUE_LIMIT + 1)
    })

    it("Electron's own dialog for what is not a tab's top frame", async function () {
      const window = { sender: contents(3, { type: 'window' }), senderFrame: { parent: null, origin: 'https://a.example' } }
      expect(await dialogs.answerPageDialog(window, { type: 'alert', message: 'x' })).to.deep.equal({ native: true })
      const frame = { ...page(), senderFrame: { parent: {}, origin: 'https://a.example' } }
      expect(await dialogs.answerPageDialog(frame, { type: 'alert', message: 'x' })).to.deep.equal({ native: true })
      expect(asked).to.deep.equal([])
    })

    it('nothing for a kind of dialog it does not know', async function () {
      expect(await dialogs.answerPageDialog(page(), { type: 'print' })).to.deep.equal({ ok: false })
      expect(asked).to.deep.equal([])
    })
  })

  describe('a tab not on screen', function () {
    it('gets no confirm or prompt, as in Chrome', async function () {
      expect(await ask(page(), { type: 'confirm', message: '?' }, { background: true })).to.deep.equal({ ok: false, background: true })
    })

    it('does not wait on an alert, which comes up with the tab', async function () {
      expect(await ask(page(), { type: 'alert', message: '!' }, { later: true })).to.deep.equal({ ok: true, later: true })
    })
  })

  describe('a page that keeps making dialogs', function () {
    it('can be stopped from its second dialog on, until it goes to another page', async function () {
      const event = page(4)
      await ask(event, { type: 'alert', message: '1' }, { ok: true, stop: true })
      expect(asked[0].dialog.offerStop).to.equal(false)
      expect(await ask(event, { type: 'alert', message: '2' }, { ok: true, stop: true })).to.deep.equal({ ok: true, stopped: true })
      expect(asked[1].dialog.offerStop).to.equal(true)
      expect(await dialogs.answerPageDialog(event, { type: 'confirm', message: '3' })).to.deep.equal({ ok: false, stopped: true })
      expect(asked).to.have.length(2)
      event.sender.emit('did-navigate')
      await ask(event, { type: 'alert', message: 'new page' }, { ok: true })
      expect(asked[2].dialog.offerStop).to.equal(false)
    })

    it('gets one dialog at a time', async function () {
      const event = page(5)
      const first = ask(event, { type: 'alert', message: '1' })
      expect(await dialogs.answerPageDialog(event, { type: 'alert', message: '2' })).to.deep.equal({ ok: false })
      asked[0].resolve({ ok: true })
      await first
      expect(asked).to.have.length(1)
    })

    it('loses its dialog when the tab goes to another page', async function () {
      const event = page(6)
      await ask(event, { type: 'alert', message: '1' }, { ok: true })
      event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
      event.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
      expect(closed).to.deep.equal([])
      event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      expect(closed).to.deep.equal([[6, ['alert', 'confirm', 'prompt']]])
    })
  })

  it('answers the page that waits on it', async function () {
    dialogs.setupPageDialogs()
    const event = page()
    ipc.emit('page-dialog', event, { type: 'confirm', message: '?' })
    await settle()
    asked[0].resolve({ ok: true })
    await settle()
    expect(event.returnValue).to.deep.equal({ ok: true })
  })
})

// The preload's own code, run on a stand-in window: what alert(), confirm()
// and prompt() give the page for each answer.
describe("the page's alert, confirm and prompt", function () {
  let install

  before(async function () {
    const preload = await source('../src/pages/unified-preload.js')
    const start = preload.indexOf('func: (ask) => {') + 'func: '.length
    const end = preload.indexOf('\n    },\n    args: [(kind, message, value) => {', start)
    expect(start).to.be.above(5)
    expect(end).to.be.above(start)
    install = preload.slice(start, end + '\n    }'.length)
  })

  function stage (answers = []) {
    const calls = []
    const native = []
    const listeners = {}
    const logged = []
    const timers = []
    const window = {
      alert: (...args) => native.push(['alert', ...args]),
      confirm: (...args) => { native.push(['confirm', ...args]); return true },
      prompt: (...args) => { native.push(['prompt', ...args]); return 'native' },
      setTimeout: (fn) => timers.push(fn),
      addEventListener: (type, fn) => { listeners[type] = fn }
    }
    let clock = 1000
    const sandbox = {
      window,
      Date: { now: () => clock },
      console: { error: (...a) => logged.push(['error', ...a]), warn: (...a) => logged.push(['warn', ...a]) },
      Object
    }
    const run = vm.runInNewContext(`(${install})`, sandbox)
    run((kind, message, value) => {
      calls.push([kind, message, value])
      return answers.length ? answers.shift() : { ok: false }
    })
    return { window, calls, native, listeners, logged, timers, tick: (ms) => { clock += ms } }
  }

  it('replaces all three on the window, shaped like the real ones', function () {
    const { window } = stage()
    for (const name of ['alert', 'confirm', 'prompt']) {
      const descriptor = Object.getOwnPropertyDescriptor(window, name)
      expect(descriptor, name).to.include({ writable: true, enumerable: true, configurable: true })
      expect(window[name].name).to.equal(name)
      expect(window[name].length, `${name}.length`).to.equal(0)
      expect(() => new window[name](), `new ${name}()`).to.throw(TypeError)
    }
  })

  it('reads its arguments as Chrome does', function () {
    const { window, calls } = stage()
    window.alert()
    window.alert(undefined)
    window.alert({ toString: () => 'an object' })
    window.confirm()
    window.prompt('Name?')
    window.prompt(null, undefined)
    expect(calls).to.deep.equal([
      ['alert', '', undefined],
      ['alert', 'undefined', undefined],
      ['alert', 'an object', undefined],
      ['confirm', '', undefined],
      ['prompt', 'Name?', ''],
      ['prompt', 'null', '']
    ])
    // A TypeError of the stand-in window's own realm.
    expect(() => window.alert(Symbol('x'))).to.throw().with.property('name', 'TypeError')
  })

  it('sends no more than a dialog shows, so a page cannot push a huge string through', function () {
    const { window, calls } = stage()
    window.prompt('m'.repeat(5000), 'v'.repeat(5000))
    window.alert('a'.repeat(3000))
    expect(calls[0][1]).to.have.length(3001)
    expect(calls[0][1].endsWith('…')).to.equal(true)
    expect(calls[0][2]).to.have.length(2001)
    expect(calls[1][1], 'up to the limit as it is').to.equal('a'.repeat(3000))
  })

  it('gives the page what the person chose', function () {
    const { window } = stage([{ ok: true }, { ok: false }, { ok: true, value: 'Grace' }, { ok: false }, { ok: true }])
    expect(window.confirm('a')).to.equal(true)
    expect(window.confirm('b')).to.equal(false)
    expect(window.prompt('c', 'd')).to.equal('Grace')
    expect(window.prompt('e')).to.equal(null)
    expect(window.alert('f')).to.equal(undefined)
  })

  it("keeps Electron's own where main says so", function () {
    const { window, native } = stage([{ native: true }, { native: true }, { native: true }])
    window.alert('a')
    expect(window.confirm('b')).to.equal(true)
    expect(window.prompt('c', 'd')).to.equal('native')
    expect(native).to.deep.equal([['alert', 'a'], ['confirm', 'b'], ['prompt', 'c', 'd']])
  })

  it('stops asking once the person stopped the page', function () {
    const { window, calls } = stage([{ ok: true, stopped: true }])
    window.alert('a')
    expect(window.confirm('b')).to.equal(false)
    expect(window.prompt('c')).to.equal(null)
    expect(calls).to.have.length(1)
  })

  it('answers at once for a moment after its tab was not on screen', function () {
    const { window, calls, logged, tick } = stage([{ ok: false, background: true }, { ok: true }])
    expect(window.confirm('a')).to.equal(false)
    expect(logged[0][0]).to.equal('warn')
    expect(window.confirm('b')).to.equal(false)
    expect(calls).to.have.length(1)
    tick(600)
    expect(window.confirm('c')).to.equal(true)
    expect(calls).to.have.length(2)
  })

  it('shows none while the page is going away, as in Chrome', function () {
    const { window, calls, listeners, logged, timers } = stage([{ ok: true }])
    expect(Object.keys(listeners).sort(), 'no unload listener, which would keep the page out of the back-forward cache').to.deep.equal(['beforeunload', 'pagehide'])
    listeners.beforeunload()
    expect(window.confirm('Leave?')).to.equal(false)
    expect(calls).to.deep.equal([])
    expect(logged[0]).to.deep.equal(['error', "Blocked confirm('Leave?') during beforeunload."])
    timers.forEach((fn) => fn())
    expect(window.confirm('Stay?')).to.equal(true)
  })
})

describe('page dialogs in the window', function () {
  let page, tabBar, preload, main
  before(async function () {
    page = await source('../src/pages/tab-dialogs.js')
    tabBar = await source('../src/pages/tab-bar.js')
    preload = await source('../src/pages/unified-preload.js')
    main = await source('../src/main.js')
  })

  it('are asked for by the preload, which waits for the answer', function () {
    expect(preload).to.contain('contextBridge.executeInMainWorld({')
    expect(preload).to.contain("return ipcRenderer.sendSync('page-dialog', { type: kind, message, value })")
    expect(main).to.contain('setupPageDialogs()')
  })

  it('have Chrome\'s buttons, and its way to stop a page', function () {
    const dialog = page.slice(page.indexOf('function pageDialog ('))
    expect(dialog).to.contain("const cancel = dialog.kind === 'alert' ? null : button('Cancel')")
    expect(dialog).to.contain("'Prevent this page from creating additional dialogs'")
    expect(dialog).to.contain('if (dialog.offerStop && !dialog.answered)')
    expect(dialog, 'Escape is OK for an alert, Cancel otherwise').to.contain("keys(form, () => answer(dialog.kind === 'alert'))")
    expect(page).to.contain('dialog.focusTarget.select()')
  })

  it('answer a tab not on screen at once, but for an alert, which waits for the tab', function () {
    const add = page.slice(page.indexOf('  function add (dialog) {'), page.indexOf('  // Main took this one down'))
    expect(add).to.contain("if (dialog.kind !== 'alert') return send(dialog, { background: true })")
    expect(add).to.contain('send(dialog, { later: true })')
    expect(add, 'only the latest alert waits').to.contain('.filter((each) => each.waiting)')
  })

  it('give the page its focus back only once no other dialog came up', function () {
    const drop = page.slice(page.indexOf('  function drop (tab, dialog) {'), page.indexOf('  function track ('))
    expect(drop).to.contain('if (tabs.has(webContentsId) || !shown(webview) || (active && active !== document.body)) return')
    expect(drop).to.contain('}, 150)')
  })

  it('give a frame inside the page a way to stop its own', function () {
    const prefs = tabBar.match(/setAttribute\('webpreferences', '([^']+)'\)/)[1].split(',')
    expect(prefs).to.include('safeDialogs=yes')
    expect(prefs).to.include('safeDialogsMessage=Prevent this page from creating additional dialogs')
  })
})
