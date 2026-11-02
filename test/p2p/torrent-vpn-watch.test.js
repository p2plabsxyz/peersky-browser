// Torrents follow the proxy a VPN extension sets for the browser
// (src/protocols/bt/vpn-watch.js), and get its login from the extension the
// way the browser does.

import { expect } from 'chai'
import { watchExtensionProxy, extensionProxyCredentials } from '../../src/protocols/bt/vpn-watch.js'

const PAC_ON = { mode: 'pac_script', pacScript: 'data:application/x-ns-proxy-autoconfig;base64,AA==' }

function fakeSession (answers) {
  const calls = []
  const session = {
    calls,
    answers,
    async setProxy (config) { calls.push(config) },
    async resolveProxy (url) { return session.answers[url] ?? 'DIRECT' }
  }
  return session
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('torrents follow the VPN extension\'s proxy', () => {
  it('reports the VPN\'s proxies once it has settled', async () => {
    const session = fakeSession({ 'http://1.1.1.1/': 'HTTPS nl.vpn.example:16858; DIRECT' })
    const seen = []
    const watch = watchExtensionProxy(session, (p) => seen.push(p), { settleMs: 20 })
    await session.setProxy(PAC_ON)
    await session.setProxy(PAC_ON)
    await session.setProxy(PAC_ON)
    await wait(60)
    expect(seen).to.deep.equal([[{ scheme: 'https', host: 'nl.vpn.example', port: 16858 }]])
    // The session still got every call.
    expect(session.calls).to.have.length(3)
    watch.stop()
  })

  it('asks a site when the PAC script sends bare addresses direct', async () => {
    const session = fakeSession({ 'http://1.1.1.1/': 'DIRECT', 'https://archive.org/': 'PROXY 10.8.0.1:3128' })
    const seen = []
    const watch = watchExtensionProxy(session, (p) => seen.push(p), { settleMs: 5 })
    await session.setProxy(PAC_ON)
    await wait(30)
    expect(seen).to.deep.equal([[{ scheme: 'http', host: '10.8.0.1', port: 3128 }]])
    watch.stop()
  })

  it('reports no VPN when the extension turns it off, and nothing for the same proxy again', async () => {
    const session = fakeSession({ 'http://1.1.1.1/': 'HTTPS nl.vpn.example:443' })
    const seen = []
    const watch = watchExtensionProxy(session, (p) => seen.push(p), { settleMs: 5 })
    await session.setProxy(PAC_ON)
    await wait(20)
    await session.setProxy(PAC_ON)
    await wait(20)
    await session.setProxy({ mode: 'system' })
    await wait(20)
    expect(seen).to.deep.equal([[{ scheme: 'https', host: 'nl.vpn.example', port: 443 }], []])
    watch.stop()
  })

  it('counts only an extension\'s proxy, not system or direct settings', async () => {
    const session = fakeSession({ 'http://1.1.1.1/': 'PROXY corp.example:8080' })
    const seen = []
    const watch = watchExtensionProxy(session, (p) => seen.push(p), { settleMs: 5 })
    await session.setProxy({ mode: 'system' })
    await session.setProxy({ mode: 'direct' })
    await wait(20)
    expect(seen).to.deep.equal([])
    expect(await watch.current()).to.deep.equal([])
    watch.stop()
  })

  it('can look at once, for a start that must not wait', async () => {
    const session = fakeSession({ 'http://1.1.1.1/': 'SOCKS5 127.0.0.1:1080' })
    const seen = []
    const watch = watchExtensionProxy(session, (p) => seen.push(p), { settleMs: 10000 })
    await session.setProxy(PAC_ON)
    expect(await watch.check()).to.deep.equal([{ scheme: 'socks5', host: '127.0.0.1', port: 1080 }])
    expect(seen).to.have.length(1)
    watch.stop()
  })

  it('puts setProxy back when stopped', async () => {
    const session = fakeSession({})
    const original = session.setProxy
    const watch = watchExtensionProxy(session, () => {})
    expect(session.setProxy).to.not.equal(original)
    watch.stop()
    expect(session.setProxy).to.equal(original)
  })

  it('asks the extension for the proxy\'s login as the browser does', async () => {
    const asked = []
    const webRequest = { notifyOnAuthRequired: async (details) => { asked.push(details); return { authCredentials: { username: 'u', password: 'p' } } } }
    const proxy = { scheme: 'https', host: 'nl.vpn.example', port: 16858 }
    expect(await extensionProxyCredentials(webRequest, proxy, { realm: 'Redox Proxy', target: { host: '2001:db8::7', port: 6881 } }))
      .to.deep.equal({ username: 'u', password: 'p' })
    expect(asked[0]).to.deep.include({ url: 'https://[2001:db8::7]:6881/', isProxy: true, scheme: 'basic', realm: 'Redox Proxy', challenger: { host: 'nl.vpn.example', port: 16858 } })

    const silent = { notifyOnAuthRequired: async () => ({}) }
    expect(await extensionProxyCredentials(silent, proxy, { realm: 'x', target: { host: '1.2.3.4', port: 1 } })).to.equal(null)
    expect(await extensionProxyCredentials(undefined, proxy, { realm: 'x', target: { host: '1.2.3.4', port: 1 } })).to.equal(null)
  })
})
