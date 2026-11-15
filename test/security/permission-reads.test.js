// A site that looks before it asks, with navigator.permissions.query() or
// Notification.permission, read "denied" for every permission nobody had
// answered yet, because Electron's permission check can only say yes or no.
// It never asked. The preload shows the page the answer PeerSky has saved
// instead (src/pages/unified-preload.js, savedAnswerFor in src/permissions.js).

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import vm from 'vm'

const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

describe('what a page reads before it asks for a permission', function () {
  let install

  before(async function () {
    const preload = await source('../../src/pages/unified-preload.js')
    const start = preload.indexOf('func: (savedAnswer) => {') + 'func: '.length
    const end = preload.indexOf("\n    },\n    args: [(name) => {\n      try {\n        return ipcRenderer.sendSync('page-permission-answer'", start)
    expect(start).to.be.above(5)
    expect(end).to.be.above(start)
    install = preload.slice(start, end + '\n    }'.length)
  })

  // A page with Chromium's own PermissionStatus and Notification, whose
  // getters answer from `chromium`, as Electron's check does.
  function stage ({ secure = true, policyOff = [], saved = {}, chromium = {} } = {}) {
    const asked = []
    const statuses = new WeakMap()
    function PermissionStatus () { throw new TypeError('Illegal constructor') }
    const own = {
      get state () {
        if (!statuses.has(this)) throw new TypeError('Illegal invocation')
        const name = statuses.get(this)
        return Object.hasOwn(chromium, name) ? chromium[name] : 'denied'
      },
      get name () {
        if (!statuses.has(this)) throw new TypeError('Illegal invocation')
        return statuses.get(this)
      }
    }
    for (const key of ['state', 'name']) {
      Object.defineProperty(PermissionStatus.prototype, key, { ...Object.getOwnPropertyDescriptor(own, key), enumerable: true, configurable: true })
    }
    function Notification () {}
    Object.defineProperty(Notification, 'permission', {
      ...Object.getOwnPropertyDescriptor({ get permission () { return chromium.Notification ?? 'denied' } }, 'permission'),
      enumerable: true,
      configurable: true
    })
    const sandbox = {
      PermissionStatus,
      Notification,
      isSecureContext: secure,
      document: { featurePolicy: { allowsFeature: (feature) => !policyOff.includes(feature) } }
    }
    vm.runInNewContext(`(${install})`, sandbox)((name) => {
      asked.push(name)
      return Object.hasOwn(saved, name) ? saved[name] : 'ask'
    })
    const status = (name) => {
      const s = Object.create(PermissionStatus.prototype)
      statuses.set(s, name)
      return s
    }
    return { sandbox, asked, status, statuses }
  }

  it('reads as not asked yet where the site has no answer saved', function () {
    const { sandbox, status, asked } = stage()
    for (const name of ['geolocation', 'notifications', 'midi', 'video_capture', 'audio_capture']) {
      expect(status(name).state, name).to.equal('prompt')
    }
    expect(sandbox.Notification.permission).to.equal('default')
    expect(asked).to.deep.equal(['geolocation', 'notifications', 'midi', 'video_capture', 'audio_capture', 'notifications'])
  })

  it('reads the saved answer once there is one, in a status held from before as well', function () {
    const saved = {}
    const { sandbox, status } = stage({ saved })
    const held = status('geolocation')
    const notifications = status('notifications')
    expect(held.state).to.equal('prompt')
    saved.geolocation = 'block'
    saved.notifications = 'allow'
    expect(held.state).to.equal('denied')
    expect(notifications.state).to.equal('granted')
    expect(sandbox.Notification.permission).to.equal('granted')
  })

  it("leaves Chromium's answer alone where it is not denied, and asks nothing", function () {
    const { sandbox, status, asked } = stage({ chromium: { geolocation: 'granted', midi: 'prompt', Notification: 'granted' } })
    expect(status('geolocation').state).to.equal('granted')
    expect(status('midi').state).to.equal('prompt')
    expect(sandbox.Notification.permission).to.equal('granted')
    expect(asked).to.deep.equal([])
  })

  it('keeps denied for what PeerSky never asks for, or when the answer cannot be had', function () {
    const { status, asked } = stage({ saved: { geolocation: null } })
    for (const name of ['clipboard-read', 'persistent-storage', 'storage-access', 'screen-wake-lock', '__proto__']) {
      expect(status(name).state, name).to.equal('denied')
    }
    expect(asked).to.deep.equal([])
    expect(status('geolocation').state).to.equal('denied')
  })

  it('keeps denied on a page that is not secure, which could not have them at all', function () {
    const { sandbox, status, asked } = stage({ secure: false })
    expect(status('geolocation').state).to.equal('denied')
    expect(status('notifications').state).to.equal('denied')
    expect(sandbox.Notification.permission).to.equal('denied')
    expect(asked).to.deep.equal([])
  })

  it("keeps denied for a feature the page's Permissions-Policy turns off", function () {
    const { status } = stage({ policyOff: ['geolocation', 'camera'] })
    expect(status('geolocation').state).to.equal('denied')
    expect(status('video_capture').state).to.equal('denied')
    expect(status('audio_capture').state).to.equal('prompt')
    // Notifications are under no policy feature.
    expect(status('notifications').state).to.equal('prompt')
  })

  it('keeps the getters shaped like the browser\'s own', function () {
    const { sandbox } = stage()
    const state = Object.getOwnPropertyDescriptor(sandbox.PermissionStatus.prototype, 'state')
    expect(state).to.include({ enumerable: true, configurable: true })
    expect(state.get.name).to.equal('get state')
    expect(state.get.length).to.equal(0)
    expect(() => state.get.call({})).to.throw(TypeError, 'Illegal invocation')
    const permission = Object.getOwnPropertyDescriptor(sandbox.Notification, 'permission')
    expect(permission.get.name).to.equal('get permission')
  })

  it('does nothing where the page has neither one', function () {
    expect(() => vm.runInNewContext(`(${install})`, { isSecureContext: true })(() => 'ask')).not.to.throw()
  })
})

describe('the answer a page reads, in the main process', function () {
  it('comes from the top frame of the page that asks, in its own window\'s profile', async function () {
    const main = await source('../../src/main.js')
    const at = main.indexOf("ipcMain.on('page-permission-answer'")
    expect(at).to.be.above(0)
    const handler = main.slice(at, main.indexOf('\n})\n', at))
    expect(handler).to.contain('const frame = event.senderFrame')
    expect(handler).to.contain('!frame.parent')
    expect(handler).to.contain('savedAnswerFor(frame.url, name, { incognito: event.sender.session === getIncognitoSession() })')
    expect(handler).to.contain('event.returnValue = answer')
  })
})
