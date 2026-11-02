/**
 * A VPN extension's proxy outlives a restart (services/proxy-settings.js).
 *
 * The extension host kept what an extension set with chrome.proxy in memory
 * only, so after a restart a VPN extension said it was connected while tabs and
 * torrents went out directly. These run the host's own ProxyAPI, taken from its
 * build, with a stand-in session, and check the file it leaves behind.
 */

import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import { EventEmitter } from 'events'
import {
  PROXY_SETTINGS_FILE,
  toSessionProxy,
  readSavedProxy,
  saveProxySettings,
  restoreSavedProxy,
  keepExtensionProxy,
  pauseExtensionProxy,
  resumeExtensionProxy,
  forgetExtensionProxy,
  settleExtensionProxy,
  logInToProxy
} from '../../src/extensions/services/proxy-settings.js'

const VEEPN = 'majdfhpaihoncoakbjgbdhglocklcgno'
const OTHER = 'abcdefghijklmnopabcdefghijklmnop'
const PAC = 'function FindProxyForURL(url, host) { return "HTTPS maasdam-1-nl.nexorcdn.com:16858"; }'
const VPN_ON = { mode: 'pac_script', pacScript: { data: PAC } }

const hostBuild = await readFile(
  new URL('../../node_modules/@p2plabs/peersky-chrome-extensions/dist/esm/index.mjs', import.meta.url),
  'utf8'
)
const managerSource = await readFile(new URL('../../src/extensions/index.js', import.meta.url), 'utf8')
const mainSource = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8')

// The extension host's ProxyAPI class, as it ships.
function loadProxyApiClass () {
  const start = hostBuild.indexOf('// src/browser/api/proxy.ts')
  const end = hostBuild.indexOf('\n// src/browser/api/', start + 1)
  expect(start, 'ProxyAPI in the extension host build').to.be.greaterThan(-1)
  const silent = { log () {}, warn () {}, error () {} }
  // eslint-disable-next-line no-new-func
  return new Function('Buffer', 'console', `${hostBuild.slice(start, end)}\nreturn ProxyAPI`)(Buffer, silent)
}
const ProxyAPI = loadProxyApiClass()

function makeHost () {
  const setProxy = []
  const events = []
  const handlers = new Map()
  const ctx = {
    session: { setProxy: async (config) => { setProxy.push(config) } },
    router: {
      apiHandler: () => (name, fn) => handlers.set(name, fn),
      sendEventForEachListener: (name, build) => events.push({ name, args: build(VEEPN) })
    }
  }
  const proxy = new ProxyAPI(ctx)
  return { proxy, setProxy, events, handlers }
}

describe('a VPN extension\'s proxy across restarts', () => {
  let dir
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'peersky-proxy-settings-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  const savedFile = () => path.join(dir, PROXY_SETTINGS_FILE)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

  it('saves what a VPN extension sets, and removes it when the VPN turns off', async () => {
    const host = makeHost()
    await keepExtensionProxy(host.proxy, dir)
    await host.handlers.get('proxy.settings.set')({ extension: { id: VEEPN } }, { value: VPN_ON })
    await settle()
    expect(JSON.parse(await readFile(savedFile(), 'utf8'))).to.deep.equal({ extensionId: VEEPN, value: VPN_ON, off: false })
    // The extension still hears about its own change.
    expect(host.events.map((e) => e.name)).to.include('proxy.settings.onChange')

    await host.handlers.get('proxy.settings.clear')({ extension: { id: VEEPN } })
    await settle()
    expect(await readSavedProxy(dir)).to.equal(null)
    await readFile(savedFile()).then(() => { throw new Error('file still there') }, (err) => expect(err.code).to.equal('ENOENT'))
  })

  it('hands the saved proxy back to its extension before it runs, as Chrome does', async () => {
    await saveProxySettings(dir, VEEPN, VPN_ON)
    const host = makeHost()
    const saved = await keepExtensionProxy(host.proxy, dir)
    expect(saved).to.deep.equal({ extensionId: VEEPN, value: VPN_ON, off: false })
    // The session goes through the VPN again, and chrome.proxy.settings.get says it is the VPN's.
    expect(host.setProxy.at(-1).mode).to.equal('pac_script')
    expect(Buffer.from(host.setProxy.at(-1).pacScript.split(',')[1], 'base64').toString()).to.equal(PAC)
    const got = await host.handlers.get('proxy.settings.get')({ extension: { id: VEEPN } })
    expect(got).to.deep.include({ value: VPN_ON, levelOfControl: 'controlled_by_this_extension' })
    const other = await host.handlers.get('proxy.settings.get')({ extension: { id: OTHER } })
    expect(other.levelOfControl).to.equal('controlled_by_other_extensions')
  })

  it('puts the proxy back on the session before any window opens', async () => {
    await saveProxySettings(dir, VEEPN, VPN_ON)
    const calls = []
    const restored = await restoreSavedProxy({ setProxy: async (config) => calls.push(config) }, dir)
    expect(restored.extensionId).to.equal(VEEPN)
    expect(calls).to.deep.equal([toSessionProxy(VPN_ON)])

    await rm(savedFile())
    expect(await restoreSavedProxy({ setProxy: async () => { throw new Error('nothing to restore') } }, dir)).to.equal(null)
  })

  async function hostWithVpnOn () {
    const host = makeHost()
    await keepExtensionProxy(host.proxy, dir)
    await host.handlers.get('proxy.settings.set')({ extension: { id: VEEPN } }, { value: VPN_ON })
    await settle()
    return host
  }

  it('takes the proxy off while its extension is turned off, and puts it back when it is turned on', async () => {
    const host = await hostWithVpnOn()
    expect(await pauseExtensionProxy(host.proxy, dir, OTHER)).to.equal(false)
    expect(host.proxy.controllingExtensionId).to.equal(VEEPN)

    expect(await pauseExtensionProxy(host.proxy, dir, VEEPN)).to.equal(true)
    expect(host.setProxy.at(-1)).to.deep.equal({ mode: 'system' })
    expect(host.proxy.controllingExtensionId).to.equal(undefined)
    expect(await readSavedProxy(dir)).to.deep.equal({ extensionId: VEEPN, value: VPN_ON, off: true })
    // Turned off, it is not put back at the next start either.
    expect(await restoreSavedProxy({ setProxy: async () => { throw new Error('off') } }, dir)).to.equal(null)
    expect(await keepExtensionProxy(makeHost().proxy, dir)).to.equal(null)

    expect(await resumeExtensionProxy(host.proxy, dir, OTHER)).to.equal(false)
    expect(await resumeExtensionProxy(host.proxy, dir, VEEPN)).to.equal(true)
    expect(host.setProxy.at(-1).mode).to.equal('pac_script')
    expect(host.proxy.controllingExtensionId).to.equal(VEEPN)
    await settle()
    expect(await readSavedProxy(dir)).to.deep.equal({ extensionId: VEEPN, value: VPN_ON, off: false })
  })

  it('forgets the proxy when its extension is removed, whether it was on or off', async () => {
    const host = await hostWithVpnOn()
    expect(await forgetExtensionProxy(host.proxy, dir, OTHER)).to.equal(false)
    expect(await readSavedProxy(dir)).to.not.equal(null)
    expect(await forgetExtensionProxy(host.proxy, dir, VEEPN)).to.equal(true)
    expect(host.setProxy.at(-1)).to.deep.equal({ mode: 'system' })
    await settle()
    expect(await readSavedProxy(dir)).to.equal(null)

    const paused = await hostWithVpnOn()
    await pauseExtensionProxy(paused.proxy, dir, VEEPN)
    await forgetExtensionProxy(paused.proxy, dir, VEEPN)
    expect(await readSavedProxy(dir)).to.equal(null)
  })

  it('after extensions load, forgets a proxy whose extension is gone and takes off one whose extension is off', async () => {
    const gone = await hostWithVpnOn()
    expect(await settleExtensionProxy(gone.proxy, dir, { installed: () => false, enabled: () => false })).to.equal('forgotten')
    expect(gone.setProxy.at(-1)).to.deep.equal({ mode: 'system' })
    await settle()
    expect(await readSavedProxy(dir)).to.equal(null)

    const off = await hostWithVpnOn()
    expect(await settleExtensionProxy(off.proxy, dir, { installed: () => true, enabled: () => false })).to.equal('off')
    expect(off.setProxy.at(-1)).to.deep.equal({ mode: 'system' })
    expect((await readSavedProxy(dir)).off).to.equal(true)

    const on = await hostWithVpnOn()
    expect(await settleExtensionProxy(on.proxy, dir, { installed: () => true, enabled: () => true })).to.equal('kept')
    expect(on.proxy.controllingExtensionId).to.equal(VEEPN)
  })

  it('reads nothing from a file it did not write', async () => {
    for (const bad of ['not json', '{}', JSON.stringify({ extensionId: 'x', value: VPN_ON }),
      JSON.stringify({ extensionId: VEEPN, value: { mode: 'system' } }),
      JSON.stringify({ extensionId: VEEPN, value: { mode: 'pac_script', pacScript: {} } })]) {
      await writeFile(savedFile(), bad)
      expect(await readSavedProxy(dir), bad).to.equal(null)
    }
  })

  it('writes the last change when changes come quickly', async () => {
    const other = { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'socks5', host: '10.8.0.1', port: 1080 } } }
    saveProxySettings(dir, VEEPN, VPN_ON)
    saveProxySettings(dir, VEEPN, { mode: 'system' })
    await saveProxySettings(dir, VEEPN, other)
    expect(await readSavedProxy(dir)).to.deep.equal({ extensionId: VEEPN, value: other, off: false })
  })

  it('does nothing, and says so, when the host has no proxy API', async () => {
    const warnings = []
    expect(await keepExtensionProxy(undefined, dir, { log: { warn: (...a) => warnings.push(a.join(' ')) } })).to.equal(null)
    expect(warnings).to.have.length(1)
  })

  // A stand-in for net.request: the proxy asks for a login, and lets the
  // request through only with the right one.
  function proxyAsking ({ authInfo = { isProxy: true, host: 'nl.vpn.example', port: 16858, realm: 'Redox Proxy', scheme: 'basic' }, then } = {}) {
    const made = []
    const request = (options) => {
      const req = new EventEmitter()
      req.options = options
      req.abort = () => { req.aborted = true }
      req.end = () => queueMicrotask(() => {
        if (then) return then(req)
        req.emit('login', authInfo, (username, password) => {
          req.answer = [username, password]
          req.emit('response', { statusCode: username === 'u' && password === 'p' ? 200 : 407 })
        })
      })
      made.push(req)
      return req
    }
    return { request, made }
  }

  it('logs the browser\'s own requests in to the VPN\'s proxy with the extension\'s login', async () => {
    const { request, made } = proxyAsking()
    const asked = []
    const loggedIn = await logInToProxy({ request, credentialsFor: async (info) => { asked.push(info); return { username: 'u', password: 'p' } } })
    expect(loggedIn).to.equal(true)
    expect(made[0].options).to.include({ method: 'HEAD', url: 'https://github.com/' })
    expect(made[0].answer).to.deep.equal(['u', 'p'])
    expect(asked[0]).to.include({ host: 'nl.vpn.example', port: 16858, realm: 'Redox Proxy' })

    // The extension gives no login, or a wrong one: the proxy still says no.
    expect(await logInToProxy({ request, credentialsFor: async () => null })).to.equal(false)
    expect(made[1].answer).to.deep.equal([undefined, undefined])
    expect(await logInToProxy({ request, credentialsFor: async () => ({ username: 'u', password: 'old' }) })).to.equal(false)
    expect(await logInToProxy({ request, credentialsFor: async () => { throw new Error('extension gone') } })).to.equal(false)
  })

  it('answers no site\'s login, and gives up on an error or when nothing answers', async () => {
    const site = proxyAsking({ authInfo: { isProxy: false, host: 'github.com', port: 443, realm: 'site' } })
    let asked = 0
    expect(await logInToProxy({ request: site.request, credentialsFor: async () => { asked++; return { username: 'u', password: 'p' } } })).to.equal(false)
    expect(asked).to.equal(0)
    expect(site.made[0].answer).to.deep.equal([undefined, undefined])

    const failing = proxyAsking({ then: (req) => req.emit('error', new Error('net::ERR_TUNNEL_CONNECTION_FAILED')) })
    expect(await logInToProxy({ request: failing.request, credentialsFor: async () => null })).to.equal(false)

    const silent = proxyAsking({ then: () => {} })
    expect(await logInToProxy({ request: silent.request, credentialsFor: async () => null, timeoutMs: 30 })).to.equal(false)
    expect(silent.made[0].aborted).to.equal(true)

    // Already logged in: the proxy lets it through without asking.
    const open = proxyAsking({ then: (req) => req.emit('response', { statusCode: 200 }) })
    expect(await logInToProxy({ request: open.request, credentialsFor: async () => null })).to.equal(true)
  })

  it('turns chrome.proxy settings into the session\'s', () => {
    expect(toSessionProxy({ mode: 'pac_script', pacScript: { url: 'https://vpn.example/proxy.pac' } }))
      .to.deep.equal({ mode: 'pac_script', pacScript: 'https://vpn.example/proxy.pac' })
    expect(toSessionProxy({ mode: 'fixed_servers', rules: { singleProxy: { scheme: 'https', host: 'nl.vpn.example', port: 443 }, bypassList: ['<local>', '10.0.0.0/8'] } }))
      .to.deep.equal({ mode: 'fixed_servers', proxyRules: 'https://nl.vpn.example:443', proxyBypassRules: '<local>,10.0.0.0/8' })
    expect(toSessionProxy({ mode: 'fixed_servers', rules: { singleProxy: { host: '2001:db8::1', port: 8080 } } }))
      .to.deep.equal({ mode: 'fixed_servers', proxyRules: 'http://[2001:db8::1]:8080' })
    expect(toSessionProxy({ mode: 'fixed_servers', rules: { proxyForHttp: { host: 'a.example', port: 80 }, proxyForHttps: { scheme: 'https', host: 'b.example', port: 443 }, fallbackProxy: { scheme: 'socks5', host: 'c.example', port: 1080 } } }))
      .to.deep.equal({ mode: 'fixed_servers', proxyRules: 'http=http://a.example:80;https=https://b.example:443;socks=socks5://c.example:1080' })
    for (const nothing of [{ mode: 'system' }, { mode: 'direct' }, { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'quic', host: 'q.example' } } }, { mode: 'fixed_servers', rules: {} }, null]) {
      expect(toSessionProxy(nothing), JSON.stringify(nothing)).to.equal(null)
    }
  })

  // A VPN extension that names its servers itself, and what Chrome hands the
  // network for each. Without the scheme an HTTPS proxy was taken for a plain
  // HTTP one, and SOCKS5 for SOCKS4, so none of them connected.
  const FIXED_SERVERS = [
    [{ singleProxy: { scheme: 'https', host: 'nl.vpn.example', port: 443 } }, 'https://nl.vpn.example:443'],
    [{ singleProxy: { scheme: 'socks5', host: '10.8.0.1', port: 1080 } }, 'socks5://10.8.0.1:1080'],
    [{ singleProxy: { scheme: 'socks4', host: '10.8.0.1', port: 1080 } }, 'socks4://10.8.0.1:1080'],
    [{ singleProxy: { host: 'proxy.example', port: 8080 } }, 'http://proxy.example:8080'],
    [{ singleProxy: { scheme: 'https', host: '2001:db8::1', port: 443 } }, 'https://[2001:db8::1]:443'],
    [{ proxyForHttp: { host: 'a.example', port: 80 }, proxyForHttps: { scheme: 'https', host: 'b.example', port: 443 }, fallbackProxy: { scheme: 'socks5', host: 'c.example', port: 1080 } },
      'http=http://a.example:80;https=https://b.example:443;socks=socks5://c.example:1080'],
    [{ proxyForHttps: { scheme: 'socks5', host: 'b.example', port: 1080 } }, 'https=socks5://b.example:1080'],
    // "socks=" is Chromium's "for everything else", whatever the scheme.
    [{ fallbackProxy: { scheme: 'https', host: 'c.example', port: 443 } }, 'socks=https://c.example:443']
  ]
  // Rules a host could add to, and a scheme Chromium has no proxy for here.
  const BAD_SERVERS = [
    { singleProxy: { scheme: 'https', host: 'vpn.example;socks=other.example', port: 443 } },
    { singleProxy: { host: 'vpn.example,other.example' } },
    { proxyForHttp: { host: 'a b.example', port: 80 } },
    { singleProxy: { scheme: 'quic', host: 'q.example', port: 443 } },
    {}
  ]

  it('gives fixed proxy servers to the session with their own scheme, as Chrome does', async () => {
    for (const [rules, expected] of FIXED_SERVERS) {
      const host = makeHost()
      await host.handlers.get('proxy.settings.set')({ extension: { id: VEEPN } }, { value: { mode: 'fixed_servers', rules } })
      expect(host.setProxy.at(-1).mode).to.equal('fixed_servers')
      expect(host.setProxy.at(-1).proxyRules, JSON.stringify(rules)).to.equal(expected)
      // And the same again after a restart.
      expect(toSessionProxy({ mode: 'fixed_servers', rules }).proxyRules, JSON.stringify(rules)).to.equal(expected)
    }
  })

  it('refuses fixed servers it cannot hand on, and keeps the proxy it had, where it went out directly', async () => {
    const host = await hostWithVpnOn()
    const before = host.setProxy.length
    for (const rules of BAD_SERVERS) {
      let refused = null
      await host.handlers.get('proxy.settings.set')({ extension: { id: VEEPN } }, { value: { mode: 'fixed_servers', rules } })
        .catch((error) => { refused = error })
      expect(refused, JSON.stringify(rules)).to.be.an('error')
      expect(toSessionProxy({ mode: 'fixed_servers', rules }), JSON.stringify(rules)).to.equal(null)
    }
    expect(host.setProxy.length).to.equal(before)
    const got = await host.handlers.get('proxy.settings.get')({ extension: { id: VEEPN } })
    expect(got.value).to.deep.equal(VPN_ON)
  })

  it('is wired in: kept before extensions load, settled after, and following the extension', () => {
    const keep = managerSource.indexOf('await keepExtensionProxy(')
    const load = managerSource.indexOf('await this._loadExtensionsIntoElectron()')
    const settle = managerSource.indexOf('await settleExtensionProxy(')
    expect(keep).to.be.greaterThan(-1)
    expect(keep).to.be.lessThan(load)
    expect(settle).to.be.greaterThan(load)
    const follows = (change) => (managerSource.match(new RegExp(`await this\\._proxyFollows\\('${change}', (extension\\.electronId|electronExtension\\.id)\\)`, 'g')) || []).length
    expect(follows('pause'), 'turned off').to.equal(1)
    expect(follows('resume'), 'turned on').to.equal(1)
    expect(follows('forget'), 'removed').to.equal(1)
    // Before the first window opens.
    const restore = mainSource.indexOf('await restoreSavedProxy(userSession')
    expect(restore).to.be.greaterThan(-1)
    expect(restore).to.be.lessThan(mainSource.indexOf('await windowManager.openSavedWindows()'))
  })
})
