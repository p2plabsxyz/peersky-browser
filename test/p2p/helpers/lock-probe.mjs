// Run in a child process by torrent-network-lock.test.js: locks this process's
// network to the proxy in argv, tries every way out, and prints what happened
// as JSON. argv: proxy JSON, echo port, http port, https port, login JSON|null.

import net from 'node:net'
import http from 'node:http'
import dgram from 'node:dgram'
import dns from 'node:dns'
import { installNetworkLock } from '../../../src/protocols/bt/network-lock.js'

const [proxyJson, echoPort, httpPort, httpsPort, loginJson] = process.argv.slice(2)
const login = JSON.parse(loginJson || 'null')
const asked = []
const lock = installNetworkLock({
  proxies: [JSON.parse(proxyJson)],
  requestCredentials: async (proxy, info) => { asked.push({ realm: info.realm, stale: info.stale }); return login },
  timeout: 5000
})

const results = { locked: !!lock, clientOptions: lock && lock.clientOptions }

function settle (promise, ms = 6000) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), ms))])
}

results.netConnect = await settle(new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: Number(echoPort) })
  s.once('connect', () => s.write('via net.connect'))
  s.once('data', (d) => { resolve({ reply: d.toString() }); s.destroy() })
  s.once('error', (e) => resolve({ error: e.code || e.message }))
}))

results.rawSocket = await settle(new Promise((resolve) => {
  const s = new net.Socket()
  s.once('connect', () => resolve({ connected: true }))
  s.once('error', (e) => resolve({ error: e.code }))
  s.connect(Number(echoPort), '127.0.0.1')
}))

// WebTorrent's peer listener, and an HTTP server listening the other way.
results.listen = await new Promise((resolve) => {
  const server = net.createServer()
  server.listen(0, () => { const { address } = server.address(); server.close(); resolve({ address }) })
})
results.listenOptions = await new Promise((resolve) => {
  const server = http.createServer()
  server.listen({ port: 0, host: '0.0.0.0' }, () => { const { address } = server.address(); server.close(); resolve({ address }) })
})

try {
  dgram.createSocket('udp4')
  results.udp = { created: true }
} catch (e) {
  results.udp = { error: e.code }
}

results.lookupName = await new Promise((resolve) => dns.lookup('example.com', (err, address) => resolve(err ? { error: err.code } : { address })))
results.lookupPromise = await dns.promises.lookup('example.com').then((a) => ({ address: a.address }), (e) => ({ error: e.code }))
results.resolver = await new dns.promises.Resolver().resolve4('example.com').then(() => ({ resolved: true }), (e) => ({ error: e.code }))
results.lookupLocalhost = await new Promise((resolve) => dns.lookup('localhost', (err) => resolve(err ? { error: err.code } : { ok: true })))

results.fetchHttp = await settle(fetch(`http://127.0.0.1:${httpPort}/plain`).then((r) => r.text()).then((t) => ({ body: t }), (e) => ({ error: e.cause?.code || e.message })))
results.fetchHttps = await settle(fetch(`https://localhost:${httpsPort}/secure`).then((r) => r.text()).then((t) => ({ body: t }), (e) => ({ error: e.cause?.code || e.message })))
results.httpGet = await settle(new Promise((resolve) => {
  http.get(`http://127.0.0.1:${httpPort}/module`, (res) => {
    let body = ''
    res.on('data', (d) => { body += d })
    res.on('end', () => resolve({ body }))
  }).on('error', (e) => resolve({ error: e.code || e.message }))
}))

results.asked = asked
console.log(JSON.stringify(results))
process.exit(0)
