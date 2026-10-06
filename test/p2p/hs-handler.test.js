import { expect } from 'chai'
import { EventEmitter } from 'events'
import esmock from 'esmock'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import * as Y from 'yjs'

let activeConnections = null

async function getAvailablePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref?.()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((closeErr) => {
        if (closeErr) reject(closeErr)
        else resolve(Number(port))
      })
    })
  })
}

class FakeHolesail {
  static rooms = new Map()
  static nextKey = 1
  /** seed hex -> room key, so a seed identifies a room the way it does for real. */
  static seedToKey = new Map()

  static reset () {
    FakeHolesail.rooms.clear()
    FakeHolesail.seedToKey.clear()
    FakeHolesail.nextKey = 1
  }

  static urlParser (key) {
    const entry = FakeHolesail.rooms.get(key)
    return {
      secure: Boolean(entry?.secure),
      udp: Boolean(entry?.udp),
      port: Number(entry?.port || 0)
    }
  }

  constructor (options = {}) {
    this.options = options
    this.info = null
    this.dht = null
    this.seed = null
  }

  async ready () {
    if (this.options.server) {
      const port = Number(this.options.port || await getAvailablePort())
      // Re-hosting a public room with its seed returns to the same room, which
      // is the whole reason the seed is persisted. A private room's address is
      // its key, and like Holesail, a private server given no key makes one
      // up, seed or not.
      const suppliedSeedHex = this.seed ? Buffer.from(this.seed).toString('hex') : null
      const keyFromSeed = suppliedSeedHex && !this.options.secure ? FakeHolesail.seedToKey.get(suppliedSeedHex) : null
      const key =
        keyFromSeed ||
        (typeof this.options.key === 'string' && this.options.key.length > 0
          ? this.options.key
          : `hs://room-${FakeHolesail.nextKey++}`)
      const seedValue = this.seed || Buffer.from(`seed-${key}`.padEnd(32, '0').slice(0, 32))
      FakeHolesail.seedToKey.set(Buffer.from(seedValue).toString('hex'), key)
      this.info = {
        url: key,
        key: `key-${key}`,
        secure: Boolean(this.options.secure),
        udp: Boolean(this.options.udp),
        port
      }
      this.dht = { seed: seedValue }
      FakeHolesail.rooms.set(key, {
        key,
        port,
        secure: this.info.secure,
        udp: this.info.udp,
        seed: seedValue
      })
      return
    }

    if (this.options.client) {
      const entry = FakeHolesail.rooms.get(this.options.key)
      const port = Number(this.options.port || entry?.port || await getAvailablePort())
      this.info = {
        port,
        secure: this.options.secure ?? entry?.secure ?? false,
        udp: this.options.udp ?? entry?.udp ?? false
      }
    }
  }

  async close () {}
}

/**
 * safeStorage as it behaves in production: encryption is available, and what
 * comes back out of encryptString is not the plaintext.
 *
 * The default mock below reports encryption as unavailable, which stores seeds
 * as plaintext hex that round-trips by accident. Real runs encrypt, and the
 * ciphertext then has to survive a restart.
 */
const encryptingSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.concat([Buffer.from('ENC:'), Buffer.from(String(value))]),
  decryptString: (buffer) => {
    const text = Buffer.from(buffer).toString()
    if (!text.startsWith('ENC:')) throw new Error('cannot decrypt')
    return text.slice(4)
  }
}

/** safeStorage that can encrypt but never decrypt, e.g. after a keychain reset. */
const undecryptableSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.concat([Buffer.from('ENC:'), Buffer.from(String(value))]),
  decryptString: () => { throw new Error('keychain unavailable') }
}

/**
 * safeStorage as it actually behaves at startup: unavailable until the app is
 * ready. Import the module first, then flip it, to reproduce the window the
 * handler used to read the ports file in.
 */
function deferredSafeStorage () {
  let ready = false
  return {
    becomeReady () { ready = true },
    isEncryptionAvailable: () => ready,
    encryptString: encryptingSafeStorage.encryptString,
    decryptString: encryptingSafeStorage.decryptString
  }
}

async function importHsHandler (userDataDir, safeStorage, { realHolesail = false } = {}) {
  fs.mkdirSync(userDataDir, { recursive: true })

  return esmock('../../src/protocols/hs-handler.js', {
    ...(!realHolesail && {
      holesail: {
        default: FakeHolesail
      }
    }),
    electron: {
      app: {
        getAppPath: () => process.cwd(),
        // hs-handler uses "userData" in this test path. For simplicity we
        // return the same fixture dir for any path key.
        getPath: (_pathType) => userDataDir
      },
      safeStorage: safeStorage || {
        isEncryptionAvailable: () => false,
        encryptString: (value) => Buffer.from(String(value)),
        decryptString: (buffer) => Buffer.from(buffer).toString()
      }
    }
  })
}

async function loadHsHandler (userDataDir, safeStorage) {
  const module = await importHsHandler(userDataDir, safeStorage)
  const handler = await module.createHandler()
  return { handler }
}

async function protocolPost (handler, action, payload) {
  const response = await handler(
    new Request(`hs://p2pmd?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    })
  )
  const data = await response.json()
  return { response, data }
}

async function getDoc (localUrl) {
  const res = await fetch(`${localUrl}/doc`)
  expect(res.status).to.equal(200)
  return res.json()
}

async function getStatus (localUrl) {
  const res = await fetch(`${localUrl}/status`)
  expect(res.status).to.equal(200)
  return res.json()
}

async function getYjsState (localUrl) {
  const res = await fetch(`${localUrl}/doc/yjsstate`)
  expect(res.status).to.equal(200)
  return res.json()
}

async function getYjsStateWithRetry (localUrl, attempts = 8) {
  let lastError = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await getYjsState(localUrl)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)))
    }
  }
  throw lastError || new Error('Unable to read /doc/yjsstate after retries')
}

async function getActivity (localUrl) {
  const res = await fetch(`${localUrl}/activity`)
  expect(res.status).to.equal(200)
  return res.json()
}

async function postPresence (localUrl, payload) {
  const res = await fetch(`${localUrl}/presence`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  expect(res.status).to.equal(200)
  const body = await res.json()
  expect(body.ok).to.equal(true)
}

function findPeer (status, clientId) {
  const list = Array.isArray(status?.peerList) ? status.peerList : []
  return list.find((peer) => peer && peer.clientId === clientId) || null
}

async function waitForEditActivity (localUrl, clientIds, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const payload = await getActivity(localUrl)
    const activity = Array.isArray(payload?.activity) ? payload.activity : []
    const matched = new Set()
    for (const entry of activity) {
      if (entry?.type === 'edit' && clientIds.includes(entry.clientId)) {
        matched.add(entry.clientId)
      }
    }
    if (matched.size === clientIds.length) {
      return activity
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for edit activity for: ${clientIds.join(', ')}`)
}

async function setDoc (localUrl, payload) {
  const res = await fetch(`${localUrl}/doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  expect(res.status).to.equal(200)
  const body = await res.json()
  expect(body.ok).to.equal(true)
}

async function setDocUpdate (localUrl, payload) {
  const res = await fetch(`${localUrl}/doc/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  expect(res.status).to.equal(200)
  const body = await res.json()
  expect(body.ok).to.equal(true)
}

async function appendLine (localUrl, clientId, name, line) {
  const current = await getDoc(localUrl)
  const next = current.content ? `${current.content}\n${line}` : line
  await setDoc(localUrl, { content: next, clientId, name })
}

async function connectPeer (localUrl, clientId, role) {
  const controller = new AbortController()
  let timer = null
  const connectPromise = fetch(
    `${localUrl}/events?clientId=${encodeURIComponent(clientId)}&role=${encodeURIComponent(role)}`,
    { signal: controller.signal }
  )
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error('SSE connect timeout'))
    }, 5000)
    timer.unref?.()
  })
  const response = await Promise.race([connectPromise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
  expect(response.status).to.equal(200)
  const connection = { controller, response }
  if (activeConnections) activeConnections.add(connection)
  return connection
}

async function connectPeerWithRetry (localUrl, clientId, role, attempts = 5) {
  let lastError = null
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await connectPeer(localUrl, clientId, role)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 120 * (i + 1)))
    }
  }
  throw lastError || new Error('SSE reconnect failed')
}

function disconnectPeer (peerConn) {
  if (!peerConn) return
  try {
    peerConn.controller.abort()
  } catch {}
  try {
    peerConn.response.body?.cancel()
  } catch {}
  if (activeConnections) activeConnections.delete(peerConn)
}

function buildLineReplaceUpdate (base64State, target, replacement) {
  // Each update is built from its own Y.Doc seeded from the same base state
  // to model independent peer edits that must merge on the server.
  const doc = new Y.Doc()
  const ytext = doc.getText('content')
  const decodedState = Buffer.from(base64State, 'base64')
  Y.applyUpdate(doc, new Uint8Array(decodedState), 'seed')

  const before = ytext.toString()
  const start = before.indexOf(target)
  if (start === -1) {
    throw new Error(`Missing target text "${target}"`)
  }

  doc.transact(() => {
    ytext.delete(start, target.length)
    ytext.insert(start, replacement)
  }, 'edit')

  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
}

describe('HS protocol handler', function () {
  this.timeout(30000)

  let handler
  let userDataDir

  beforeEach(async function () {
    FakeHolesail.reset()
    activeConnections = new Set()
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-hs-test-'));
    ({ handler } = await loadHsHandler(userDataDir))
  })

  afterEach(async function () {
    if (activeConnections && activeConnections.size > 0) {
      for (const conn of Array.from(activeConnections)) {
        disconnectPeer(conn)
      }
      activeConnections.clear()
    }
    activeConnections = null
    try {
      await protocolPost(handler, 'close', {})
    } catch {}
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })

  describe('rehosting a room after a restart', function () {
    /**
     * Seeds are encrypted with safeStorage, and safeStorage is unavailable until
     * the app is ready. Reading the ports file at import time therefore skipped
     * decryption and stored ciphertext where a seed belonged; the next rehost fed
     * that to holesail as hex, which asserted, took the request down with it, and
     * surfaced in the page as an opaque "Failed to fetch".
     */
    it('recovers an encrypted seed written by the previous run', async function () {
      const { handler: first } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { data: room } = await protocolPost(first, 'create', { secure: false, udp: false })
      expect(room.key, 'room was not created').to.be.a('string')
      await protocolPost(first, 'close', {})

      // What is on disk must be ciphertext, or this test proves nothing.
      const ports = JSON.parse(fs.readFileSync(path.join(userDataDir, 'peersky-ports.json'), 'utf8'))
      const stored = ports[room.key]
      expect(stored, 'the room was not persisted').to.be.an('object')
      expect(stored.seed, 'the seed was stored unencrypted').to.match(/^RU5D/)

      // A second load is a restart: the file is re-read from scratch.
      const { handler: restarted } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { response, data } = await protocolPost(restarted, 'rehost', { key: room.key })

      expect(response.status, `rehost failed: ${data.error}`).to.equal(200)
      expect(data.key, 'the room URL changed across the restart').to.equal(room.key)
      await protocolPost(restarted, 'close', {})
    })

    it('does not read the ports file before safeStorage can decrypt', async function () {
      const { handler: first } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { data: room } = await protocolPost(first, 'create', { secure: false, udp: false })
      await protocolPost(first, 'close', {})

      // The restart, in the order it really happens: the module is imported while
      // encryption is still unavailable, and only then does the app become ready.
      const storage = deferredSafeStorage()
      const restarted = await importHsHandler(userDataDir, storage)
      storage.becomeReady()
      const handler = await restarted.createHandler()

      const { response, data } = await protocolPost(handler, 'rehost', { key: room.key })
      expect(response.status, `rehost failed: ${data.error}`).to.equal(200)
      expect(data.key, 'the seed was read before it could be decrypted').to.equal(room.key)
      await protocolPost(handler, 'close', {})
    })

    it('still rehosts when the stored seed cannot be decrypted', async function () {
      const { handler: first } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { data: room } = await protocolPost(first, 'create', { secure: false, udp: false })
      await protocolPost(first, 'close', {})

      // Keychain reset, different machine, corrupted entry: the seed is gone, but
      // the room key is not, and hosting from the key keeps the same URL.
      const { handler: restarted } = await loadHsHandler(userDataDir, undecryptableSafeStorage)
      const { response, data } = await protocolPost(restarted, 'rehost', { key: room.key })

      expect(response.status, `rehost failed: ${data.error}`).to.equal(200)
      expect(data.key).to.equal(room.key)
      await protocolPost(restarted, 'close', {})
    })
  })

  describe('a private note hosted again', function () {
    // Its address is its key. Hosting it from the saved seed with no key left
    // Holesail to make one up, and the page saved the note's edits and line
    // authors under that made-up address, so the next open lost them.
    it('keeps its address after a restart, even when the page lost the private flag', async function () {
      const { handler: first } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { data: room } = await protocolPost(first, 'create', { secure: true, udp: false })
      expect(room.key, 'room was not created').to.be.a('string')
      await protocolPost(first, 'close', {})
      const ports = JSON.parse(fs.readFileSync(path.join(userDataDir, 'peersky-ports.json'), 'utf8'))
      expect(ports[room.key]?.seed, 'no seed was saved, so this proves nothing').to.be.a('string')

      const { handler: restarted } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { response, data } = await protocolPost(restarted, 'rehost', { key: room.key, secure: false })
      expect(response.status, `rehost failed: ${data.error}`).to.equal(200)
      expect(data.key).to.equal(room.key)
      // A private key is never hosted in the open.
      expect(data.secure).to.equal(true)
      await protocolPost(restarted, 'close', {})
    })

    it('keeps its address when opening it hosts it again', async function () {
      const { handler: first } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { data: room } = await protocolPost(first, 'create', { secure: true, udp: false })
      await protocolPost(first, 'close', {})

      const { handler: restarted } = await loadHsHandler(userDataDir, encryptingSafeStorage)
      const { response, data } = await protocolPost(restarted, 'join', { key: room.key })
      expect(response.status, `join failed: ${data.error}`).to.equal(200)
      expect(data.hosted).to.equal(true)
      expect(data.key).to.equal(room.key)
      await protocolPost(restarted, 'close', {})
    })

    // The real library, without starting a network: what it makes of each plan.
    it('comes back at the same address and keypair with the real Holesail', async function () {
      const { default: Holesail } = await import('holesail')
      const { rehostPlan } = await importHsHandler(userDataDir, null, { realHolesail: true })
      const base = { server: true, host: '127.0.0.1', port: 9 }
      const made = new Holesail({ ...base, secure: true })
      const key = `hs://s000${made.key}`
      const savedSeed = Buffer.from(made.seed, 'hex')

      // What re-hosting did before: no key, the seed put back.
      const before = new Holesail({ ...base, secure: true })
      before.seed = made.seed
      expect(before.key, 'Holesail kept the key, so this proves nothing').to.not.equal(made.key)

      const plan = rehostPlan(key, { secure: false, savedSeed })
      expect(plan).to.deep.equal({ secure: true, key, seed: null })
      const again = new Holesail({ ...base, secure: plan.secure, key: plan.key })
      expect(again.key).to.equal(made.key)
      expect(again.seed).to.equal(made.seed)

      // A public note's address is its public key, which gives no seed.
      const publicKey = `hs://0000${'y'.repeat(52)}`
      expect(rehostPlan(publicKey, { secure: false, savedSeed })).to.deep.equal({ secure: false, key: null, seed: savedSeed })
      expect(rehostPlan(publicKey, { secure: false })).to.deep.equal({ secure: false, key: publicKey, seed: null })
    })
  })

  // A note is for a team, up to about 100 people. Every edit went out to
  // everyone as the whole note, and every edit or cursor move as the whole
  // people list with every line author in it: 100 people, 10 of them typing,
  // was 334 MB a second out of the host.
  describe('a note with many people in it', function () {
    async function listen (localUrl, clientId, role = 'client') {
      const conn = await connectPeerWithRetry(localUrl, clientId, role)
      const events = []
      const reader = conn.response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      ;(async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let cut
            while ((cut = buffer.indexOf('\n\n')) !== -1) {
              const lines = buffer.slice(0, cut).split('\n')
              buffer = buffer.slice(cut + 2)
              const event = lines.find((line) => line.startsWith('event: '))?.slice(7)
              const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('')
              if (event) events.push({ event, data })
            }
          }
        } catch {}
      })()
      return events
    }

    async function until (check, timeoutMs = 3000) {
      const stop = Date.now() + timeoutMs
      while (!check() && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 20))
      return check()
    }

    const named = (events, name) => events.filter((entry) => entry.event === name)

    it('sends each edit as what it changed, not the whole note', async function () {
      const { data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
      const note = Array.from({ length: 400 }, (_, i) => `- line ${i} of a long note`).join('\n')
      await setDoc(room.localUrl, { content: note, clientId: 'device-a', name: 'Mac' })
      const events = await listen(room.localUrl, 'device-b')
      expect(await until(() => named(events, 'yjsupdate').length === 1)).to.equal(true)
      // Whoever joins gets the whole note once.
      const watcher = new Y.Doc()
      const whole = named(events, 'yjsupdate')[0].data
      Y.applyUpdate(watcher, Buffer.from(whole, 'base64'))
      expect(watcher.getText('content').toString()).to.equal(note)

      // Someone else adds a word at the end.
      const typist = new Y.Doc()
      Y.applyUpdate(typist, Buffer.from((await getYjsState(room.localUrl)).yjsState, 'base64'))
      const before = Y.encodeStateVector(typist)
      typist.getText('content').insert(typist.getText('content').length, ' done')
      await setDocUpdate(room.localUrl, {
        update: Buffer.from(Y.encodeStateAsUpdate(typist, before)).toString('base64'),
        clientId: 'device-c',
        name: 'Phone'
      })

      expect(await until(() => named(events, 'yjsupdate').length === 2)).to.equal(true)
      const change = named(events, 'yjsupdate')[1].data
      expect(change.length).to.be.below(whole.length / 20)
      Y.applyUpdate(watcher, Buffer.from(change, 'base64'))
      expect(watcher.getText('content').toString()).to.equal(`${note} done`)
    })

    it('sends the people list a few times a second, not on every cursor move', async function () {
      const { data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
      await setDoc(room.localUrl, { content: 'Line 1', clientId: 'device-a', name: 'Mac' })
      const events = await listen(room.localUrl, 'device-b')
      await listen(room.localUrl, 'device-c')
      expect(await until(() => named(events, 'peerlist').length >= 2)).to.equal(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      const listsBefore = named(events, 'peerlist').length

      for (let column = 1; column <= 20; column += 1) {
        await postPresence(room.localUrl, { clientId: 'device-c', role: 'client', name: 'Phone', cursorLine: 1, cursorColumn: column, isTyping: true })
      }
      expect(await until(() => named(events, 'peerlist').length > listsBefore)).to.equal(true)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const lists = named(events, 'peerlist').slice(listsBefore)
      expect(lists.length).to.be.at.most(3)
      // The last one says where the cursor is now.
      const phone = JSON.parse(lists.at(-1).data).find((peer) => peer.clientId === 'device-c')
      expect(phone.cursorColumn).to.equal(20)
    })

    // The phone's editor sends the whole note's authors as lineAttributions,
    // which its own host keeps for the note, and its own lines as
    // peerLineAttributions. Taken as the phone's own, everyone's lines were
    // filed under the phone, and the phone showed Alice's lines as its own.
    it('files only a phone\'s own lines under the phone', async function () {
      const { data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
      await setDoc(room.localUrl, { content: 'Line 1\nLine 2\nLine 3', clientId: 'device-a', name: 'Alice' })
      await listen(room.localUrl, 'device-a', 'host')
      await listen(room.localUrl, 'phone')
      const alice = { name: 'Alice', color: '#1FC1A8' }
      const sam = { name: 'Sam', color: '#59a6ff' }
      await postPresence(room.localUrl, { clientId: 'device-a', role: 'host', name: 'Alice', cursorLine: 1, lineAttributions: { 1: alice, 2: alice } })

      const typist = new Y.Doc()
      Y.applyUpdate(typist, Buffer.from((await getYjsState(room.localUrl)).yjsState, 'base64'))
      const before = Y.encodeStateVector(typist)
      typist.getText('content').insert(typist.getText('content').length, '!')
      await setDocUpdate(room.localUrl, {
        update: Buffer.from(Y.encodeStateAsUpdate(typist, before)).toString('base64'),
        clientId: 'phone',
        role: 'client',
        name: 'Sam',
        cursorLine: 3,
        lineAttributions: { 1: alice, 2: alice, 3: sam },
        peerLineAttributions: { 3: sam }
      })
      const status = await getStatus(room.localUrl)
      expect(Object.keys(findPeer(status, 'phone').lineAttributions)).to.deep.equal(['3'])
      expect(Object.keys(findPeer(status, 'device-a').lineAttributions)).to.deep.equal(['1', '2'])
    })

    it('sends someone\'s line authors again only when they change, and in full to whoever joins', async function () {
      const { data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
      await setDoc(room.localUrl, { content: 'Line 1\nLine 2\nLine 3', clientId: 'device-a', name: 'Mac' })
      const events = await listen(room.localUrl, 'device-b')
      await listen(room.localUrl, 'device-c')
      const authors = { 1: { name: 'Phone', color: '#229922' }, 2: { name: 'Phone', color: '#229922' } }
      const phoneIn = (entry) => JSON.parse(entry.data).find((peer) => peer.clientId === 'device-c')
      const latestPhone = () => {
        const lists = named(events, 'peerlist')
        return lists.length ? phoneIn(lists.at(-1)) : null
      }

      await postPresence(room.localUrl, { clientId: 'device-c', role: 'client', name: 'Phone', cursorLine: 1, cursorColumn: 1, lineAttributions: authors })
      expect(await until(() => latestPhone()?.lineAttributions?.['2'] !== undefined)).to.equal(true)

      // The same authors with a new cursor: the list says where, not who wrote what.
      const listsBefore = named(events, 'peerlist').length
      await postPresence(room.localUrl, { clientId: 'device-c', role: 'client', name: 'Phone', cursorLine: 2, cursorColumn: 3, lineAttributions: authors })
      expect(await until(() => named(events, 'peerlist').length > listsBefore)).to.equal(true)
      expect(latestPhone().cursorLine).to.equal(2)
      expect(latestPhone().lineAttributions).to.equal(null)

      // A new line of theirs goes out.
      await postPresence(room.localUrl, { clientId: 'device-c', role: 'client', name: 'Phone', cursorLine: 3, cursorColumn: 1, lineAttributions: { ...authors, 3: { name: 'Phone', color: '#229922' } } })
      expect(await until(() => latestPhone()?.lineAttributions?.['3'] !== undefined)).to.equal(true)

      // Someone joining now gets them all.
      const late = await listen(room.localUrl, 'device-d')
      expect(await until(() => named(late, 'peerlist').length > 0)).to.equal(true)
      expect(Object.keys(phoneIn(named(late, 'peerlist')[0]).lineAttributions)).to.deep.equal(['1', '2', '3'])
    })
  })

  describe('a note on another of the person\'s devices', function () {
    // Opening one looks for it on the other device first. Hosting it here from
    // the saved seed as part of that look would answer the look itself, and
    // the two devices would each host their own copy.
    it('only joins when asked to look, even with a seed saved here', async function () {
      const { data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
      await protocolPost(handler, 'close', {})

      const { handler: restarted } = await loadHsHandler(userDataDir)
      const look = await protocolPost(restarted, 'join', { key: room.key, joinOnly: true })
      expect(look.response.status, `join failed: ${look.data.error}`).to.equal(200)
      expect(look.data.hosted, 'the look hosted the room from the saved seed').to.not.equal(true)
      await protocolPost(restarted, 'close', {})

      // A plain join of a room this device made still hosts it again.
      const plain = await protocolPost(restarted, 'join', { key: room.key })
      expect(plain.data.hosted).to.equal(true)
      expect(plain.data.key).to.equal(room.key)
      await protocolPost(restarted, 'close', {})
    })

    // A join binds the port the room's host advertised once ready() is done.
    // A port already taken here used to throw in the main process.
    it('answers with the port when the one to join on is busy, instead of throwing', async function () {
      const { waitForClientProxy } = await importHsHandler(userDataDir)
      const proxy = new EventEmitter()
      const waiting = waitForClientProxy({ dht: { proxy, args: { port: 59677 }, state: 'waiting' } })
      const busy = Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' })
      expect(() => proxy.emit('error', busy)).to.not.throw()
      expect(await waiting).to.deep.include({ ok: false, port: 59677 })
      // And nothing later gets through either.
      expect(() => proxy.emit('error', new Error('reset'))).to.not.throw()

      const fine = new EventEmitter()
      const listening = waitForClientProxy({ dht: { proxy: fine, args: { port: 1 }, state: 'waiting' } })
      fine.emit('listening')
      expect(await listening).to.deep.equal({ ok: true })
    })

    it('says so when the room it joins is one this device is hosting', async function () {
      const { data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
      const { data } = await protocolPost(handler, 'join', { key: room.key, joinOnly: true })
      expect(data.hosted).to.equal(true)
      expect(data.localUrl).to.be.a('string')
    })
  })

  it('answers with the reason when a request fails instead of dropping the connection', async function () {
    // An unhandled rejection here reaches the page as "Failed to fetch", with the
    // cause visible only in the main process log.
    const response = await handler(new Request('hs://p2pmd?action=rehost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json'
    }))

    expect(response.status).to.equal(500)
    const data = await response.json()
    expect(data.error, 'the failure carried no reason').to.be.a('string')
    expect(data.error.length).to.be.greaterThan(0)
  })

  it('keeps peer edits when host disconnects and reconnects', async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
    expect(createResponse.status).to.equal(200)

    const baseLines = ['Mac: Line 1', 'Mac: Line 2']
    await setDoc(room.localUrl, { content: baseLines.join('\n'), clientId: 'device-a', name: 'Mac' })

    const hostConn = await connectPeer(room.localUrl, 'device-a', 'host')
    const peerConn = await connectPeer(room.localUrl, 'device-b', 'client')

    await postPresence(room.localUrl, {
      clientId: 'device-b',
      role: 'client',
      name: 'Phone',
      color: '#00AAFF',
      cursorLine: 3,
      cursorColumn: 5,
      lineAttributions: {
        3: { name: 'Phone', color: '#00AAFF' }
      },
      isTyping: true
    })
    const preDisconnectStatus = await getStatus(room.localUrl)
    const preDisconnectPeer = findPeer(preDisconnectStatus, 'device-b')
    expect(preDisconnectPeer).to.not.equal(null)
    expect(preDisconnectPeer.cursorLine).to.equal(3)
    expect(preDisconnectPeer.cursorColumn).to.equal(5)
    expect(preDisconnectPeer.lineAttributions).to.have.property('3')

    disconnectPeer(hostConn)

    await appendLine(room.localUrl, 'device-b', 'Phone', 'Phone: Host is gone')
    await appendLine(room.localUrl, 'device-b', 'Phone', 'Phone: Still editing')
    await waitForEditActivity(room.localUrl, ['device-b'])

    const { response: rehostResponse, data: rehostData } = await protocolPost(handler, 'rehost', {
      key: room.key,
      secure: false,
      udp: false,
      initialContent: ''
    })
    expect(rehostResponse.status).to.equal(200)
    expect(rehostData.localUrl).to.be.a('string')
    const yjsSnapshot = await getYjsStateWithRetry(rehostData.localUrl)
    expect(yjsSnapshot.yjsState).to.be.a('string')
    expect(yjsSnapshot.yjsState.length).to.be.greaterThan(0)

    const hostReconnect = await connectPeerWithRetry(rehostData.localUrl, 'device-a', 'host')
    const peerReconnect = await connectPeerWithRetry(rehostData.localUrl, 'device-b', 'client')
    const statusAfterRehost = await getStatus(rehostData.localUrl)
    const phoneAfterRehost = findPeer(statusAfterRehost, 'device-b')
    expect(phoneAfterRehost).to.not.equal(null)
    // Cursor is a live-presence field and should not keep the stale pre-rehost
    // value until the peer posts presence again.
    expect(phoneAfterRehost.cursorLine).to.not.equal(3)
    expect(phoneAfterRehost.lineAttributions).to.have.property('3')
    const doc = await getDoc(rehostData.localUrl)
    const lines = doc.content.split('\n')

    expect(lines).to.deep.equal([
      'Mac: Line 1',
      'Mac: Line 2',
      'Phone: Host is gone',
      'Phone: Still editing'
    ])

    disconnectPeer(peerConn)
    disconnectPeer(peerReconnect)
    disconnectPeer(hostReconnect)
  })

  it('keeps host edits when peer disconnects and reconnects', async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
    expect(createResponse.status).to.equal(200)

    await setDoc(room.localUrl, { content: 'Shared: Start', clientId: 'device-a', name: 'Mac' })

    const hostConn = await connectPeer(room.localUrl, 'device-a', 'host')
    const peerConn = await connectPeer(room.localUrl, 'device-b', 'client')
    await postPresence(room.localUrl, {
      clientId: 'device-a',
      role: 'host',
      name: 'Mac',
      color: '#AA5500',
      cursorLine: 2,
      cursorColumn: 1,
      lineAttributions: {
        2: { name: 'Mac', color: '#AA5500' }
      },
      isTyping: true
    })
    const preDisconnectStatus = await getStatus(room.localUrl)
    const preDisconnectHost = findPeer(preDisconnectStatus, 'device-a')
    expect(preDisconnectHost).to.not.equal(null)
    expect(preDisconnectHost.cursorLine).to.equal(2)
    expect(preDisconnectHost.lineAttributions).to.have.property('2')

    disconnectPeer(peerConn)

    await appendLine(room.localUrl, 'device-a', 'Mac', 'Mac: Peer left, editing alone')
    await appendLine(room.localUrl, 'device-a', 'Mac', 'Mac: More changes')

    const peerReconnect = await connectPeer(room.localUrl, 'device-b', 'client')
    const doc = await getDoc(room.localUrl)
    const lines = doc.content.split('\n')

    expect(lines).to.deep.equal([
      'Shared: Start',
      'Mac: Peer left, editing alone',
      'Mac: More changes'
    ])

    disconnectPeer(hostConn)
    disconnectPeer(peerReconnect)
  })

  it('syncs host edits to a laptop peer connected via action=join', async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
    expect(createResponse.status).to.equal(200)

    await setDoc(room.localUrl, { content: 'Shared: Start', clientId: 'device-a', name: 'Mac' })
    const hostConn = await connectPeer(room.localUrl, 'device-a', 'host')

    const laptopUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-hs-join-'))
    const { handler: laptopHandler } = await loadHsHandler(laptopUserDataDir)

    let laptopConn = null
    try {
      // Use a separate handler instance so join exercises the client path.
      const { response: joinResponse, data: joinData } = await protocolPost(laptopHandler, 'join', {
        key: room.key,
        secure: false,
        udp: false
      })
      expect(joinResponse.status).to.equal(200)
      expect(joinData.localUrl).to.be.a('string')

      laptopConn = await connectPeer(joinData.localUrl, 'device-laptop', 'client')
      await postPresence(joinData.localUrl, {
        clientId: 'device-laptop',
        role: 'client',
        name: 'Laptop',
        color: '#229922',
        cursorLine: 1,
        cursorColumn: 4,
        lineAttributions: {
          1: { name: 'Laptop', color: '#229922' }
        },
        isTyping: true
      })
      const joinStatus = await getStatus(joinData.localUrl)
      const laptopPeer = findPeer(joinStatus, 'device-laptop')
      expect(laptopPeer).to.not.equal(null)
      expect(laptopPeer.cursorLine).to.equal(1)
      expect(laptopPeer.lineAttributions).to.have.property('1')

      await appendLine(room.localUrl, 'device-a', 'Mac', 'Mac: host edit after laptop join')
      await waitForEditActivity(room.localUrl, ['device-a'])
      const doc = await getDoc(joinData.localUrl)
      const lines = doc.content.split('\n')

      expect(lines).to.deep.equal([
        'Shared: Start',
        'Mac: host edit after laptop join'
      ])
    } finally {
      disconnectPeer(laptopConn)
      try {
        await protocolPost(laptopHandler, 'close', {})
      } catch {}
      fs.rmSync(laptopUserDataDir, { recursive: true, force: true })
      disconnectPeer(hostConn)
    }
  })

  it('returns active room details via action=resume', async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
    expect(createResponse.status).to.equal(200)

    const { response: resumeResponse, data: resumeData } = await protocolPost(handler, 'resume', { key: room.key })
    expect(resumeResponse.status).to.equal(200)
    expect(resumeData.key).to.equal(room.key)
    expect(resumeData.localUrl).to.equal(room.localUrl)
    expect(resumeData.localPort).to.equal(room.localPort)
  })

  it('preserves edits from two peers when host reconnects in a three-peer room', async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
    expect(createResponse.status).to.equal(200)

    await setDoc(room.localUrl, { content: 'Shared: Start', clientId: 'device-a', name: 'Mac' })

    const hostConn = await connectPeer(room.localUrl, 'device-a', 'host')
    const peerBConn = await connectPeer(room.localUrl, 'device-b', 'client')
    const peerCConn = await connectPeer(room.localUrl, 'device-c', 'client')
    await postPresence(room.localUrl, {
      clientId: 'device-b',
      role: 'client',
      name: 'B',
      color: '#3366CC',
      cursorLine: 2,
      cursorColumn: 2,
      lineAttributions: { 2: { name: 'B', color: '#3366CC' } },
      isTyping: true
    })
    await postPresence(room.localUrl, {
      clientId: 'device-c',
      role: 'client',
      name: 'C',
      color: '#CC6633',
      cursorLine: 3,
      cursorColumn: 2,
      lineAttributions: { 3: { name: 'C', color: '#CC6633' } },
      isTyping: true
    })
    const threePeerStatus = await getStatus(room.localUrl)
    expect(findPeer(threePeerStatus, 'device-b')?.lineAttributions).to.have.property('2')
    expect(findPeer(threePeerStatus, 'device-c')?.lineAttributions).to.have.property('3')

    disconnectPeer(hostConn)

    await appendLine(room.localUrl, 'device-b', 'B', 'B: editing')
    await appendLine(room.localUrl, 'device-c', 'C', 'C: also editing')

    const hostReconnect = await connectPeer(room.localUrl, 'device-a', 'host')
    const doc = await getDoc(room.localUrl)
    const lines = doc.content.split('\n')

    expect(lines).to.deep.equal([
      'Shared: Start',
      'B: editing',
      'C: also editing'
    ])

    disconnectPeer(peerBConn)
    disconnectPeer(peerCConn)
    disconnectPeer(hostReconnect)
  })

  it('merges concurrent line edits from two peers via CRDT updates', async function () {
    const { response: createResponse, data: room } = await protocolPost(handler, 'create', { secure: false, udp: false })
    expect(createResponse.status).to.equal(200)

    const initial = ['Line 1: base', 'Line 2: base', 'Line 3: base', 'Line 4: base'].join('\n')
    await setDoc(room.localUrl, { content: initial, clientId: 'device-a', name: 'Mac' })
    const hostConn = await connectPeer(room.localUrl, 'device-a', 'host')
    const peerConn = await connectPeer(room.localUrl, 'device-b', 'client')
    await postPresence(room.localUrl, {
      clientId: 'device-a',
      role: 'host',
      name: 'Mac',
      color: '#AA0000',
      cursorLine: 1,
      cursorColumn: 4,
      lineAttributions: {
        1: { name: 'Mac', color: '#AA0000' }
      },
      isTyping: true
    })
    await postPresence(room.localUrl, {
      clientId: 'device-b',
      role: 'client',
      name: 'Phone',
      color: '#0000AA',
      cursorLine: 1,
      cursorColumn: 6,
      lineAttributions: {
        1: { name: 'Phone', color: '#0000AA' }
      },
      isTyping: true
    })

    const yjsRes = await fetch(`${room.localUrl}/doc/yjsstate`)
    expect(yjsRes.status).to.equal(200)
    const yjsPayload = await yjsRes.json()
    expect(yjsPayload.yjsState).to.be.a('string')

    const updateA = buildLineReplaceUpdate(yjsPayload.yjsState, 'Line 1: base', 'Mac: edited line 1')
    const updateB = buildLineReplaceUpdate(yjsPayload.yjsState, 'Line 3: base', 'Phone: edited line 3')

    await Promise.all([
      setDocUpdate(room.localUrl, {
        clientId: 'device-a',
        name: 'Mac',
        color: '#AA0000',
        cursorLine: 1,
        cursorColumn: 8,
        lineAttributions: {
          1: { name: 'Mac', color: '#AA0000' }
        },
        update: updateA
      }),
      setDocUpdate(room.localUrl, {
        clientId: 'device-b',
        name: 'Phone',
        color: '#0000AA',
        cursorLine: 3,
        cursorColumn: 8,
        lineAttributions: {
          3: { name: 'Phone', color: '#0000AA' }
        },
        update: updateB
      })
    ])

    const doc = await getDoc(room.localUrl)
    expect(doc.content).to.contain('Mac: edited line 1')
    expect(doc.content).to.contain('Phone: edited line 3')
    expect(doc.content).to.contain('Line 2: base')
    expect(doc.content).to.contain('Line 4: base')
    const status = await getStatus(room.localUrl)
    const hostPeer = findPeer(status, 'device-a')
    const phonePeer = findPeer(status, 'device-b')
    expect(hostPeer).to.not.equal(null)
    expect(phonePeer).to.not.equal(null)
    expect(hostPeer.cursorLine).to.equal(1)
    expect(phonePeer.cursorLine).to.equal(3)
    expect(hostPeer.lineAttributions).to.have.property('1')
    expect(phonePeer.lineAttributions).to.have.property('3')
    // Host editing line 1 should evict line-1 ownership from other peers.
    expect(phonePeer.lineAttributions).to.not.have.property('1')
    await waitForEditActivity(room.localUrl, ['device-a', 'device-b'])

    disconnectPeer(hostConn)
    disconnectPeer(peerConn)
  })
})
