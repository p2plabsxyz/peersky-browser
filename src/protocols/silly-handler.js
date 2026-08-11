// silly-handler.js — turns any peersky instance into a "silly" relay node:
// the same room/state logic as plan1's production geckos relay
// (multiplayer.js + storage.mjs, vendored verbatim as silly-store.mjs),
// running in this Electron main process instead of a dedicated always-on
// server.
//
// Why HTTP+SSE instead of real geckos.io/WebRTC: geckos.io's data channel
// is negotiated over WebRTC/ICE, which resolves its own peer-to-peer path
// independent of whatever port carried the signaling handshake. Tunneling
// the signaling through Holesail wouldn't make the resulting WebRTC data
// channel ride inside that tunnel — ICE would still try to connect via the
// real network, defeating the point of using Holesail for NAT traversal at
// all. So the transport here stays a single HTTP+SSE connection (the same
// shape already proven to tunnel cleanly through Holesail), while the state
// engine (silly-store.mjs) and its secureEval sandboxing are lifted
// unmodified from production.
//
// Deterministic race-to-host: given the same (elf, id), every peer derives
// the identical HyperDHT keypair via Holesail's secure-mode key hashing —
// confirmed end-to-end with a standalone 2-process probe before this was
// wired in. No directory server, no generated-URL exchange.

import http from 'http'
import fs from 'fs'
import path from 'path'
import Holesail from 'holesail'
import { app } from 'electron'
import { getQuickJS } from 'quickjs-emscripten'
import createStore from './silly-store.mjs'
import { createLogger } from '../logger.js'

const log = createLogger('protocols:silly')

const rooms = new Map() // `${elf}:${id}` -> { role, holesail, docPort, doc? }

let QuickJS = null
const quickJSReady = getQuickJS().then((instance) => { QuickJS = instance })

function secureEval (query, variables = {}) {
  let res
  const vm = QuickJS.newContext()

  for (const [key, value] of Object.entries(variables)) {
    const handle = vm.newString(value)
    vm.setProp(vm.global, key, handle)
    handle.dispose()
  }

  const evaluation = vm.evalCode(query)
  if (evaluation.error) {
    res = { error: vm.dump(evaluation.error), data: null }
    evaluation.error.dispose()
  } else {
    res = { error: null, data: vm.dump(evaluation.value) }
    evaluation.value.dispose()
  }

  vm.dispose()
  return res
}

function roomKey (elf, id) {
  return `${elf}:${id}`
}

function withTimeout (promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms))
  ])
}

// Disk persistence is an addition on top of production's actual behavior —
// multiplayer.js/storage.mjs is pure in-memory, relying on the relay being a
// separate long-lived process nobody restarts casually. Here, "who is the
// relay" is decided ad hoc per room (whichever peer wins the race), so we
// persist to survive that peer's own process restarting.
function roomFilePath (elf, id) {
  const dir = path.join(app.getPath('userData'), 'silly-rooms')
  const safe = `${elf}__${id}`.replace(/[^a-zA-Z0-9_.-]/g, '_')
  return path.join(dir, `${safe}.json`)
}

function loadPersisted (elf, id) {
  try {
    return JSON.parse(fs.readFileSync(roomFilePath(elf, id), 'utf8'))
  } catch (e) {
    return {}
  }
}

async function persist (elf, id, data) {
  try {
    const file = roomFilePath(elf, id)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, JSON.stringify(data))
  } catch (e) {
    log.error(`[silly] failed to persist "${elf}:${id}": ${e.message}`)
  }
}

function createDocServer (elf, id) {
  const clients = new Set()
  const store = createStore(loadPersisted(elf, id), () => null, secureEval)

  const server = http.createServer((req, res) => {
    // The renderer fetches this from a peersky:// origin — a genuine
    // cross-origin request against this plain http://127.0.0.1 server, so
    // without CORS headers the browser blocks it outright (and a JSON POST
    // triggers a preflight OPTIONS this server never answered, surfacing as
    // 404s). This was silently breaking every /upload, /state, and /events
    // call regardless of anything else being correct.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.url === '/state' && req.method === 'GET') {
      const current = store.get(elf) || {}
      log.info(`[silly] GET /state for "${elf}:${id}" -> ${Object.keys(current).length} top-level keys`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(current))
      return
    }

    if (req.url === '/upload' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let payload
        try {
          payload = JSON.parse(body)
        } catch (e) {
          log.error(`[silly] /upload for "${elf}:${id}" got invalid JSON`)
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid JSON' }))
          return
        }
        // Same event, same handling as multiplayer.js's stateUpload: apply
        // the sender's merge function through the sandboxed store, then
        // fan the raw payload back out to every connected peer (including
        // the sender — elf.js dedupes by senderId).
        store.set(elf, payload.knowledge, payload.nuance)
        log.info(`[silly] POST /upload for "${elf}:${id}" from ${payload.senderId} -> state now has ${JSON.stringify(store.get(elf)).length} bytes`)
        const message = `event: update\ndata: ${JSON.stringify(payload)}\n\n`
        clients.forEach((client) => client.write(message))
        persist(elf, id, store.get(elf) || {}).finally(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        })
      })
      return
    }

    if (req.url === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(': connected\n\n')
      clients.add(res)
      const keepalive = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        clients.delete(res)
        clearInterval(keepalive)
      })
      return
    }

    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found')
  })

  return { server, clients }
}

async function ensureRoom (elf, id) {
  const key = roomKey(elf, id)
  const existing = rooms.get(key)
  if (existing) return existing

  await quickJSReady

  const holesailKey = `silly-room:${elf}:${id}`
  const doc = createDocServer(elf, id)
  const docPort = await new Promise((resolve) => {
    doc.server.listen(0, '127.0.0.1', () => resolve(doc.server.address().port))
  })

  // Pin an explicit, distinct local tunnel port for the client-join attempt —
  // Holesail's auto-port selection isn't reliably collision-free (confirmed
  // during the standalone probe), so never leave it undefined.
  const clientTunnelPort = 20000 + Math.floor(Math.random() * 20000)

  try {
    const client = new Holesail({ client: true, secure: true, key: holesailKey, host: '127.0.0.1', port: clientTunnelPort, log: 0 })
    await client.ready()
    // client.ready() only confirms the local tunnel is listening, not that a
    // peer answered — probe with a real request to detect an actual host.
    await withTimeout(fetch(`http://127.0.0.1:${clientTunnelPort}/state`), 4000, 'no host found')
    doc.server.close()
    const room = { role: 'client', holesail: client, docPort: clientTunnelPort, key: holesailKey }
    rooms.set(key, room)
    log.info(`[silly] joined "${key}" as client`)
    return room
  } catch (e) {
    try { await new Holesail({ client: true, secure: true, key: holesailKey, host: '127.0.0.1', port: clientTunnelPort, log: 0 }).close() } catch {}
    const server = new Holesail({ server: true, secure: true, key: holesailKey, host: '127.0.0.1', port: docPort, log: 0 })
    await server.ready()
    const room = { role: 'server', holesail: server, docPort, doc, key: holesailKey }
    rooms.set(key, room)
    log.info(`[silly] hosting "${key}" as server`)
    return room
  }
}

export async function createHandler () {
  return async function protocolHandler (req) {
    const url = new URL(req.url)
    if (url.hostname !== 'relay') {
      return new Response('Unknown silly target', { status: 404, headers: { 'content-type': 'text/plain' } })
    }

    const elf = url.searchParams.get('elf')
    const id = url.searchParams.get('id')
    const action = url.searchParams.get('action')

    if (!elf || !id) {
      return new Response(JSON.stringify({ error: 'Missing elf/id' }), { status: 400, headers: { 'content-type': 'application/json' } })
    }

    if (action === 'linkState' && req.method === 'POST') {
      try {
        const room = await ensureRoom(elf, id)
        return new Response(JSON.stringify({ ok: true, role: room.role, docUrl: `http://127.0.0.1:${room.docPort}` }), { headers: { 'content-type': 'application/json' } })
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err.message || err) }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
    }

    return new Response('Unknown action', { status: 400, headers: { 'content-type': 'application/json' } })
  }
}
