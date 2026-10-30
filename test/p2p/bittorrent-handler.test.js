import { expect } from 'chai'
import sinon from 'sinon'
import esmock from 'esmock'
import { fork as forkProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import path from 'path'
import { EventEmitter } from 'events'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'

const _testDir = path.dirname(fileURLToPath(import.meta.url))
const TRACKERS_JSON = path.join(_testDir, '../../src/protocols/bt/trackers.json')

const HASH_HEX = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const MAGNET = `magnet:?xt=urn:btih:${HASH_HEX}&dn=Test`

function btihFromMagnet (s) {
  const m = String(s).match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i)
  return m ? m[1].toLowerCase() : HASH_HEX
}

// Pretends to be the forked worker: emits `ready`, then answers send({ id, action, ... })
// the same way src/protocols/bt/worker.js does for sendCommand().
function makeFakeChild (onCommand) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let firedReady = false
  const _on = child.on.bind(child)
  child.on = function (ev, fn) {
    const r = _on(ev, fn)
    if (ev === 'message' && !firedReady) {
      firedReady = true
      queueMicrotask(() => child.emit('message', { type: 'ready' }))
    }
    return r
  }
  const run = onCommand(child)
  child.send = sinon.spy((msg) => queueMicrotask(() => run(msg)))
  return child
}

function defaultWorkerReplies (proc) {
  return (msg) => {
    const { id, action } = msg
    if (!id) return
    if (action === 'start') {
      const ih = btihFromMagnet(msg.magnetUri)
      proc.emit('message', { id, type: 'started', infoHash: ih, magnetURI: msg.magnetUri })
      return
    }
    if (action === 'seed') {
      const ih = btihFromMagnet(msg.magnetUri)
      proc.emit('message', {
        id,
        type: 'started',
        infoHash: ih,
        magnetURI: msg.magnetUri,
        mode: 'seed'
      })
      return
    }
    if (action === 'pause') {
      proc.emit('message', { id, type: 'paused', infoHash: msg.hash || HASH_HEX })
      return
    }
    if (action === 'resume') {
      proc.emit('message', { id, type: 'resumed', infoHash: msg.hash || HASH_HEX })
      return
    }
    if (action === 'remove') {
      proc.emit('message', { id, type: 'removed', infoHash: msg.hash || HASH_HEX })
      return
    }
    if (action === 'stop') {
      proc.emit('message', {
        id,
        type: 'stopped',
        infoHash: msg.hash || HASH_HEX,
        magnetURI: MAGNET,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0
      })
      return
    }
    if (action === 'unseed') {
      proc.emit('message', { id, type: 'unseeded', infoHash: msg.hash || HASH_HEX })
      return
    }
    proc.emit('message', { id, error: `Unknown action: ${action}` })
  }
}

async function jsonBody (res) {
  const t = await res.text()
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

// Tokens live in the module instance, so mint from the handler loaded last.
let mintLatest = null
function mintToken () {
  return mintLatest(`bt://${HASH_HEX}/`)
}

function apiQuery (parts) {
  return `bt://api?${new URLSearchParams({ action: 'api', ...parts }).toString()}`
}

describe('BitTorrent protocol handler', function () {
  this.timeout(20000)

  const realSetInterval = global.setInterval
  const intervalHandles = []
  before(function () {
    global.setInterval = function (fn, ms, ...rest) {
      const handle = realSetInterval(fn, ms, ...rest)
      // bittorrent-handler.js schedules a 30s crash-safety save interval.
      if (ms === 30000) {
        intervalHandles.push(handle)
        if (handle && typeof handle.unref === 'function') handle.unref()
      }
      return handle
    }
  })
  after(function () {
    global.setInterval = realSetInterval
  })

  /** Dirs created by loadHandler when caller does not pass userDataDir / downloadsDir */
  const tmpDirs = []

  afterEach(function () {
    sinon.restore()
    while (intervalHandles.length) {
      try {
        clearInterval(intervalHandles.pop())
      } catch {
        /* ignore */
      }
    }
    while (tmpDirs.length) {
      const d = tmpDirs.pop()
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  async function loadHandler (opts = {}) {
    const { userDataDir, downloadsDir, replyAs, fetch } = opts
    let ud = userDataDir
    let dd = downloadsDir
    if (!ud) {
      ud = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-ud-'))
      tmpDirs.push(ud)
    }
    if (!dd) {
      dd = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-dl-'))
      tmpDirs.push(dd)
    }
    const fork = sinon.stub()
    const ipcMain = { handle: sinon.stub() }

    // strict so ../settings-manager.js is not merged with the real module (pulls permissions → electron).
    const mod = await esmock.strict('../../src/protocols/bittorrent-handler.js', {
      child_process: { fork },
      electron: {
        app: {
          getPath (t) {
            if (t === 'userData') return ud
            if (t === 'downloads') return dd
            return path.join(ud, t)
          }
        },
        ipcMain,
        net: { fetch: fetch || (async () => { throw new Error('No network in this test') }) }
      },
      '../../src/logger.js': {
        createLogger: () => ({ debug () {}, info () {}, warn () {}, error () {} })
      },
      '../../src/settings-manager.js': {
        default: { settings: { theme: 'dark' } }
      }
    })

    const child = makeFakeChild((proc) => (replyAs ? replyAs(proc) : defaultWorkerReplies(proc)))
    fork.returns(child)

    const handler = await mod.createHandler()
    const loaded = { handler, child, ud, dd, mod, ipcMain, fork }
    mintLatest = tokenIpc(loaded)
    return loaded
  }

  function tokenIpc ({ mod, ipcMain }) {
    mod.setupBittorrentIpc()
    const call = ipcMain.handle.getCalls().find((c) => c.args[0] === 'bt-api-token')
    return (senderUrl) => call.args[1]({ senderFrame: { url: senderUrl } })
  }

  it('serves torrent UI on bt:// without an API token in the page', async () => {
    const { handler } = await loadHandler()
    const res = await handler(new Request(`bt://${HASH_HEX}/`))
    expect(res.status).to.equal(200)
    expect(res.headers.get('Content-Type')).to.match(/text\/html/)
    const html = await res.text()
    expect(html).to.include('BitTorrent')
    expect(html).to.include("var apiToken = '';")
  })

  it('serves torrent UI for magnet: URLs', async () => {
    const { handler } = await loadHandler()
    const res = await handler(new Request(MAGNET))
    expect(res.status).to.equal(200)
    expect(await res.text()).to.include("var apiToken = '';")
  })

  it('rejects API calls when request.url is not bt/bittorrent/magnet', async () => {
    const { handler, child } = await loadHandler()
    const n = child.send.callCount
    const res = await handler(
      new Request(`https://evil.example/x?action=api&api=status&hash=${HASH_HEX}`)
    )
    expect(res.status).to.equal(403)
    expect((await jsonBody(res)).error).to.equal('Forbidden: API only accessible from BitTorrent protocol')
    expect(child.send.callCount).to.equal(n)
  })

  it('mutations without POST get 405 and no CORS wildcard', async () => {
    const { handler, child } = await loadHandler()
    const n = child.send.callCount
    const url = apiQuery({ api: 'start', magnet: encodeURIComponent(MAGNET) })
    const res = await handler(new Request(url, { method: 'GET' }))
    expect(res.status).to.equal(405)
    expect(res.headers.get('Access-Control-Allow-Origin')).to.equal(null)
    expect(child.send.callCount).to.equal(n)
  })

  it('mutations need a valid token; pause works with token from the UI page', async () => {
    const { handler, child } = await loadHandler()
    const token = mintToken()
    expect(token).to.be.a('string')

    const start = apiQuery({ api: 'start', magnet: encodeURIComponent(MAGNET) })
    expect((await handler(new Request(start, { method: 'POST', headers: { 'X-BT-Token': 'invalid' } }))).status).to.equal(403)
    expect(child.send.callCount).to.equal(0)

    const bad = `${start}&token=${'0'.repeat(48)}`
    expect((await handler(new Request(bad, { method: 'POST', headers: { 'X-BT-Token': '0'.repeat(48) } }))).status).to.equal(403)

    const pause = apiQuery({ api: 'pause', hash: HASH_HEX })
    const res = await handler(new Request(pause, { method: 'POST', headers: { 'X-BT-Token': token } }))
    expect(res.status).to.equal(200)
    const body = await jsonBody(res)
    expect(body).to.include({ success: true, paused: true })
    const ipc = child.send.getCalls().map((c) => c.args[0])
    expect(ipc.some((m) => m.action === 'pause' && m.hash === HASH_HEX)).to.equal(true)
  })

  it('accepts X-BT-Token header for mutations', async () => {
    const { handler, child } = await loadHandler()
    const token = mintToken()
    const url = apiQuery({ api: 'pause', hash: HASH_HEX })
    const res = await handler(new Request(url, { method: 'POST', headers: { 'X-BT-Token': token } }))
    expect(res.status).to.equal(200)
    const ipc = child.send.getCalls().map((c) => c.args[0])
    expect(ipc.some((m) => m.action === 'pause' && m.hash === HASH_HEX)).to.equal(true)
  })

  it('status is 404 until worker pushes a status-update, then reads from cache', async () => {
    const { handler, child } = await loadHandler()
    const st = apiQuery({ api: 'status', hash: HASH_HEX })
    expect((await handler(new Request(st))).status).to.equal(404)

    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      name: 'Fixture',
      progress: 0.5,
      downloaded: 100,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      done: false,
      paused: false,
      files: [],
      magnetURI: MAGNET,
      downloadPath: '/tmp'
    })

    const res = await handler(new Request(st))
    expect(res.status).to.equal(200)
    const data = await jsonBody(res)
    expect(data.name).to.equal('Fixture')
    expect(data.infoHash).to.equal(HASH_HEX)
    expect(data).to.not.have.property('type')
  })

  it('list returns cached torrents sorted by name then infoHash', async () => {
    const { handler, child } = await loadHandler()
    child.emit('message', { type: 'status-update', infoHash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'zeta', files: [] })
    child.emit('message', { type: 'status-update', infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'alpha', files: [] })
    child.emit('message', { type: 'status-update', infoHash: '9999999999999999999999999999999999999999', name: 'alpha', files: [] })

    const denied = await handler(new Request(apiQuery({ api: 'list' })))
    expect(denied.status).to.equal(403)

    const token = mintToken()
    const res = await handler(new Request(apiQuery({ api: 'list' }), { headers: { 'X-BT-Token': token } }))
    expect(res.status).to.equal(200)
    const body = await jsonBody(res)
    expect(body.torrents.map((t) => t.infoHash)).to.deep.equal([
      '9999999999999999999999999999999999999999',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    ])
  })

  it('token is not served over bt://, so other origins cannot read it', async () => {
    const { handler } = await loadHandler()
    const res = await handler(new Request(apiQuery({ api: 'token' })))
    expect(res.status).to.equal(400)
    expect((await jsonBody(res)).token).to.equal(undefined)
  })

  it('token IPC mints a usable token only for torrent UI pages', async () => {
    const loaded = await loadHandler()
    const mint = tokenIpc(loaded)
    for (const url of ['https://evil.example/', 'hyper://abc/', 'peersky://settings/', undefined]) {
      expect(() => mint(url), String(url)).to.throw('Forbidden')
    }
    expect(mint('peersky://bt-manager/')).to.be.a('string').with.lengthOf(48)
    const token = mint(`bt://${HASH_HEX}/`)

    const start = apiQuery({ api: 'start', magnet: encodeURIComponent(MAGNET) })
    const startRes = await loaded.handler(new Request(start, { method: 'POST', headers: { 'X-BT-Token': token } }))
    expect(startRes.status).to.equal(200)
  })

  it('a file inside a torrent gets no token, though it shares the torrent page\'s origin', async () => {
    const mint = tokenIpc(await loadHandler())
    for (const url of [`bt://${HASH_HEX}/Name/index.html`, `bittorrent://${HASH_HEX}/page.html`, `bt://${HASH_HEX}/Name/`]) {
      expect(() => mint(url), url).to.throw('Forbidden')
    }
    expect(mint(`bt://${HASH_HEX}/?dn=Name`)).to.be.a('string')
    expect(mint(`bittorrent://${HASH_HEX}`)).to.be.a('string')
  })

  it('start merges custom tr= with defaults and returns success', async () => {
    const { handler, child } = await loadHandler()
    const token = mintToken()
    const magnet = `${MAGNET}&tr=${encodeURIComponent('udp://tracker.example.com:6969/announce')}`
    const url = apiQuery({ api: 'start', magnet: encodeURIComponent(magnet) })
    const res = await handler(new Request(url, { method: 'POST', headers: { 'X-BT-Token': token } }))
    expect(res.status).to.equal(200)
    const body = await jsonBody(res)
    expect(body.success).to.equal(true)
    expect(body.infoHash).to.equal(HASH_HEX)

    const start = child.send.getCalls().map((c) => c.args[0]).find((m) => m.action === 'start')
    expect(start.announce.length).to.be.greaterThan(0)
    expect(start.announce.join(',')).to.include('tracker.example.com')
    const defaults = JSON.parse(fs.readFileSync(TRACKERS_JSON, 'utf8'))
    for (const tr of defaults) {
      expect(start.announce).to.include(tr)
    }
  })

  it('seed hits the worker with action seed', async () => {
    const { handler, child } = await loadHandler()
    const token = mintToken()
    const url = apiQuery({ api: 'seed', magnet: encodeURIComponent(MAGNET), hash: HASH_HEX })
    const res = await handler(new Request(url, { method: 'POST', headers: { 'X-BT-Token': token } }))
    expect(res.status).to.equal(200)
    expect((await jsonBody(res)).mode).to.equal('seed')
    const seed = child.send.getCalls().map((c) => c.args[0]).find((m) => m.action === 'seed')
    expect(seed.magnetUri).to.include('urn:btih')
  })

  it('stop and unseed dispatch their worker actions', async () => {
    const { handler, child } = await loadHandler()
    const token = mintToken()

    const stopRes = await handler(new Request(apiQuery({ api: 'stop', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } }))
    expect(stopRes.status).to.equal(200)
    expect((await jsonBody(stopRes)).stopped).to.equal(true)

    const unseedRes = await handler(new Request(apiQuery({ api: 'unseed', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } }))
    expect(unseedRes.status).to.equal(200)
    expect((await jsonBody(unseedRes)).mode).to.equal('download')

    const actions = child.send.getCalls().map((c) => c.args[0].action)
    expect(actions).to.include('stop')
    expect(actions).to.include('unseed')
  })

  it('bt://hash/path streams a file when cache lists it and bytes exist on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-serve-'))
    const rel = 'readme.txt'
    fs.writeFileSync(path.join(dir, rel), 'hello-bt-file', 'utf8')

    try {
      const { handler, child } = await loadHandler({ downloadsDir: dir })
      child.emit('message', {
        type: 'status-update',
        infoHash: HASH_HEX,
        name: 'T',
        downloadPath: dir,
        progress: 1,
        downloaded: 10,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        done: true,
        paused: false,
        files: [{ index: 0, name: rel, path: rel, length: 14, downloaded: 14, progress: 1 }],
        magnetURI: MAGNET
      })

      const res = await handler(new Request(`bt://${HASH_HEX}/${rel}`))
      expect(res.status).to.equal(200)
      expect(await res.text()).to.equal('hello-bt-file')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('files a torrent holds', function () {
    async function serving (files) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-files-'))
      tmpDirs.push(dir)
      for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
        fs.writeFileSync(path.join(dir, rel), body)
      }
      const { handler, child } = await loadHandler({ downloadsDir: dir })
      child.emit('message', {
        type: 'status-update',
        infoHash: HASH_HEX,
        name: 'T',
        downloadPath: dir,
        done: true,
        magnetURI: MAGNET,
        files: Object.entries(files).map(([rel, body], index) => ({ index, name: path.basename(rel), path: rel, length: body.length }))
      })
      return (rel, headers) => handler(new Request(`bt://${HASH_HEX}/${rel}`, { headers }))
    }

    it('runs a page from a torrent sandboxed in an origin of its own, never sniffed', async () => {
      const get = await serving({ 'T/index.html': '<script>top.peerskyBT</script>', 'T/notes.txt': 'hi' })
      const page = await get('T/index.html')
      expect(page.status).to.equal(200)
      expect(page.headers.get('Content-Type')).to.equal('text/html; charset=utf-8')
      expect(page.headers.get('Content-Security-Policy')).to.match(/^sandbox allow-scripts/)
      expect(page.headers.get('Content-Security-Policy')).to.not.include('allow-same-origin')
      expect(page.headers.get('X-Content-Type-Options')).to.equal('nosniff')
      const text = await get('T/notes.txt')
      expect(text.headers.get('Content-Type')).to.equal('text/plain; charset=utf-8')
      expect(text.headers.get('Content-Security-Policy')).to.match(/^sandbox /)
    })

    it('leaves a PDF unsandboxed, where the PDF viewer would not run', async () => {
      const get = await serving({ 'T/book.pdf': '%PDF-1.4' })
      const res = await get('T/book.pdf')
      expect(res.headers.get('Content-Type')).to.equal('application/pdf')
      expect(res.headers.get('Content-Security-Policy')).to.equal(null)
    })

    it('answers byte ranges, so a video can seek, and plays an MKV as WebM', async () => {
      const get = await serving({ 'T/clip.mkv': '0123456789' })
      const part = await get('T/clip.mkv', { Range: 'bytes=2-5' })
      expect(part.status).to.equal(206)
      expect(part.headers.get('Content-Range')).to.equal('bytes 2-5/10')
      expect(part.headers.get('Content-Length')).to.equal('4')
      expect(part.headers.get('Content-Type')).to.equal('video/webm')
      expect(await part.text()).to.equal('2345')
      expect(await (await get('T/clip.mkv', { Range: 'bytes=-3' })).text()).to.equal('789')
      expect(await (await get('T/clip.mkv', { Range: 'bytes=7-' })).text()).to.equal('789')
      const whole = await get('T/clip.mkv')
      expect(whole.status).to.equal(200)
      expect(whole.headers.get('Accept-Ranges')).to.equal('bytes')
      expect(whole.headers.get('Content-Length')).to.equal('10')
      const past = await get('T/clip.mkv', { Range: 'bytes=10-' })
      expect(past.status).to.equal(416)
      expect(past.headers.get('Content-Range')).to.equal('bytes */10')
    })

    it('reads only the ranges it can serve', async () => {
      const { mod } = await loadHandler()
      expect(mod.parseByteRange('bytes=0-0', 10)).to.deep.equal({ start: 0, end: 0 })
      expect(mod.parseByteRange('bytes=4-99', 10)).to.deep.equal({ start: 4, end: 9 })
      expect(mod.parseByteRange('bytes=-20', 10)).to.deep.equal({ start: 0, end: 9 })
      for (const header of [undefined, '', 'items=1-2', 'bytes=0-1,4-5', 'bytes=-']) {
        expect(mod.parseByteRange(header, 10), String(header)).to.equal(null)
      }
      for (const [header, size] of [['bytes=5-2', 10], ['bytes=-0', 10], ['bytes=0-', 0]]) {
        expect(mod.parseByteRange(header, size), header).to.equal(false)
      }
    })
  })

  it('rejects path segments that escape the torrent root (../ after normalize)', async () => {
    const { handler, child } = await loadHandler()
    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      downloadPath: '/tmp',
      files: [{ index: 0, name: 'x', path: 'x', length: 1, downloaded: 0, progress: 0 }],
      magnetURI: MAGNET
    })
    const res = await handler(new Request(`bt://${HASH_HEX}/%2E%2E%2Fsecret`))
    expect(res.status).to.equal(400)
    expect(await res.text()).to.include('Invalid torrent file path')
  })

  it('resume + worker miss re-adds a download via start from cached magnet', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-resume-dl-'))
    try {
      let resumes = 0
      const { handler, child } = await loadHandler({
        replyAs (proc) {
          return (msg) => {
            const { id, action } = msg
            if (!id) return
            if (action === 'resume') {
              resumes += 1
              proc.emit('message', { id, error: 'Torrent not found' })
              return
            }
            if (action === 'start') {
              proc.emit('message', {
                id,
                type: 'started',
                infoHash: HASH_HEX,
                magnetURI: decodeURIComponent(msg.magnetUri)
              })
              return
            }
            defaultWorkerReplies(proc)(msg)
          }
        }
      })

      child.emit('message', {
        type: 'status-update',
        infoHash: HASH_HEX,
        mode: 'download',
        magnetURI: MAGNET,
        downloadPath: dir,
        done: false,
        paused: true,
        files: [],
        progress: 0,
        downloaded: 0,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0
      })

      const token = mintToken()
      const res = await handler(new Request(apiQuery({ api: 'resume', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } }))
      expect(res.status).to.equal(200)
      expect((await jsonBody(res)).success).to.equal(true)
      expect(resumes).to.equal(1)
      const actions = child.send.getCalls().map((c) => c.args[0].action)
      expect(actions).to.include.members(['resume', 'start'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resume + worker miss re-adds seeding via seed from cached magnet when mode was seed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-resume-seed-'))
    try {
      let resumes = 0
      const { handler, child } = await loadHandler({
        replyAs (proc) {
          return (msg) => {
            const { id, action } = msg
            if (!id) return
            if (action === 'resume') {
              resumes += 1
              proc.emit('message', { id, error: 'Torrent not found' })
              return
            }
            if (action === 'seed') {
              proc.emit('message', {
                id,
                type: 'started',
                infoHash: HASH_HEX,
                magnetURI: decodeURIComponent(msg.magnetUri),
                mode: 'seed'
              })
              return
            }
            defaultWorkerReplies(proc)(msg)
          }
        }
      })

      child.emit('message', {
        type: 'status-update',
        infoHash: HASH_HEX,
        mode: 'seed',
        magnetURI: MAGNET,
        downloadPath: dir,
        done: true,
        paused: true,
        files: [],
        progress: 1,
        downloaded: 100,
        uploaded: 10,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0
      })

      const token = mintToken()
      const res = await handler(new Request(apiQuery({ api: 'resume', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } }))
      expect(res.status).to.equal(200)
      expect(resumes).to.equal(1)
      const actions = child.send.getCalls().map((c) => c.args[0].action)
      expect(actions).to.include.members(['resume', 'seed'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resume calls worker resume only when torrent exists (no start)', async () => {
    const { handler, child } = await loadHandler()
    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: '/tmp',
      paused: true,
      done: false,
      progress: 0.4,
      downloaded: 100,
      uploaded: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      files: []
    })
    const token = mintToken()
    const res = await handler(
      new Request(apiQuery({ api: 'resume', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } })
    )
    expect(res.status).to.equal(200)
    expect(await jsonBody(res)).to.deep.include({ success: true, paused: false })
    const actions = child.send.getCalls().map((c) => c.args[0].action)
    expect(actions.filter((a) => a === 'resume').length).to.equal(1)
    expect(actions).to.not.include('start')

    // The handler doesn't flip cache.paused on resume; it reflects the next worker status update.
    const cachedBeforeUpdate = await jsonBody(await handler(new Request(apiQuery({ api: 'status', hash: HASH_HEX }))))
    expect(cachedBeforeUpdate.paused).to.equal(true)

    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: '/tmp',
      paused: false,
      done: false,
      progress: 0.4,
      downloaded: 100,
      uploaded: 0,
      downloadSpeed: 1024,
      uploadSpeed: 0,
      numPeers: 2,
      files: []
    })
    const st = await jsonBody(await handler(new Request(apiQuery({ api: 'status', hash: HASH_HEX }))))
    expect(st.paused).to.equal(false)
  })

  it('worker done bumps cache to done with speeds cleared', async () => {
    const { handler, child } = await loadHandler()
    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      name: 'DoneSoon',
      magnetURI: MAGNET,
      downloadPath: '/tmp',
      paused: false,
      done: false,
      progress: 0.99,
      downloaded: 999,
      uploaded: 0,
      downloadSpeed: 5000,
      uploadSpeed: 0,
      numPeers: 3,
      files: []
    })
    child.emit('message', { type: 'done', infoHash: HASH_HEX })
    const st = await jsonBody(await handler(new Request(apiQuery({ api: 'status', hash: HASH_HEX }))))
    expect(st.done).to.equal(true)
    expect(st.downloadSpeed).to.equal(0)
    expect(st.uploadSpeed).to.equal(0)
  })

  it('status passes through seeding fields from worker updates', async () => {
    const { handler, child } = await loadHandler()
    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      name: 'SeedBox',
      magnetURI: MAGNET,
      downloadPath: '/tmp',
      mode: 'seed',
      isSeeding: true,
      paused: false,
      done: true,
      progress: 1,
      downloaded: 1000,
      uploaded: 400,
      downloadSpeed: 0,
      uploadSpeed: 8192,
      numPeers: 5,
      seedingSince: Date.now() - 5000,
      files: []
    })
    const st = await jsonBody(await handler(new Request(apiQuery({ api: 'status', hash: HASH_HEX }))))
    expect(st.mode).to.equal('seed')
    expect(st.isSeeding).to.equal(true)
    expect(st.uploadSpeed).to.be.above(0)
  })

  it('stop clears speeds and flags in cached status', async () => {
    const { handler, child } = await loadHandler()
    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: '/tmp',
      paused: false,
      stopped: false,
      done: false,
      progress: 0.5,
      downloaded: 50,
      uploaded: 0,
      downloadSpeed: 3000,
      uploadSpeed: 0,
      numPeers: 4,
      files: []
    })
    const token = mintToken()
    const stopRes = await handler(
      new Request(apiQuery({ api: 'stop', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } })
    )
    expect(stopRes.status).to.equal(200)

    const st = await jsonBody(await handler(new Request(apiQuery({ api: 'status', hash: HASH_HEX }))))
    expect(st.stopped).to.equal(true)
    expect(st.paused).to.equal(true)
    expect(st.isSeeding).to.equal(false)
    expect(st.downloadSpeed).to.equal(0)
    expect(st.uploadSpeed).to.equal(0)
    expect(st.numPeers).to.equal(0)
  })

  it('unseed zeros upload and marks cache as download + paused', async () => {
    const { handler, child } = await loadHandler()
    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      magnetURI: MAGNET,
      downloadPath: '/tmp',
      mode: 'seed',
      isSeeding: true,
      paused: false,
      done: true,
      progress: 1,
      downloaded: 100,
      uploaded: 50,
      downloadSpeed: 0,
      uploadSpeed: 16000,
      numPeers: 8,
      files: []
    })
    const token = mintToken()
    const unseedRes = await handler(
      new Request(apiQuery({ api: 'unseed', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } })
    )
    expect(unseedRes.status).to.equal(200)

    const st = await jsonBody(await handler(new Request(apiQuery({ api: 'status', hash: HASH_HEX }))))
    expect(st.mode).to.equal('download')
    expect(st.isSeeding).to.equal(false)
    expect(st.paused).to.equal(true)
    expect(st.uploadSpeed).to.equal(0)
    expect(st.numPeers).to.equal(0)
  })

  it('remove drops torrent data from disk when cache has a named folder', async () => {
    const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-rm-'))
    const tname = 'RmTorFolder'
    fs.mkdirSync(path.join(dd, tname), { recursive: true })
    fs.writeFileSync(path.join(dd, tname, 'keep-me.txt'), 'data', 'utf8')

    try {
      const { handler, child } = await loadHandler({ downloadsDir: dd })
      child.emit('message', {
        type: 'status-update',
        infoHash: HASH_HEX,
        name: tname,
        magnetURI: MAGNET,
        downloadPath: dd,
        paused: true,
        done: true,
        progress: 1,
        downloaded: 4,
        uploaded: 0,
        downloadSpeed: 0,
        uploadSpeed: 0,
        numPeers: 0,
        files: [{ index: 0, name: 'keep-me.txt', path: 'keep-me.txt', length: 4, downloaded: 4, progress: 1 }]
      })

      const token = mintToken()
      const rmRes = await handler(
        new Request(apiQuery({ api: 'remove', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } })
      )
      expect(rmRes.status).to.equal(200)
      expect((await jsonBody(rmRes)).removed).to.equal(true)

      expect(fs.existsSync(path.join(dd, tname))).to.equal(false)
      expect((await handler(new Request(apiQuery({ api: 'status', hash: HASH_HEX })))).status).to.equal(404)
    } finally {
      fs.rmSync(dd, { recursive: true, force: true })
    }
  })

  it('saves an unfinished torrent for the next start paused, with no peers or speeds', async () => {
    const { child, ud, mod } = await loadHandler()
    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      name: 'T',
      progress: 0.4,
      numPeers: 6,
      downloadSpeed: 5000,
      uploadSpeed: 20,
      timeRemaining: 9000,
      done: false,
      paused: false,
      files: [],
      magnetURI: MAGNET
    })
    mod.shutdownBittorrent()
    const saved = JSON.parse(fs.readFileSync(path.join(ud, 'bt-state.json'), 'utf8'))[HASH_HEX]
    expect(saved).to.include({ paused: true, numPeers: 0, downloadSpeed: 0, uploadSpeed: 0, timeRemaining: null, progress: 0.4 })
  })

  it('keeps .torrent files in the profile, and remove forgets one with its torrent', async () => {
    const { handler, ud, fork } = await loadHandler()
    const kept = path.join(ud, 'bt-torrents', `${HASH_HEX}.torrent`)
    expect(fork.firstCall.args[1][1]).to.equal(path.dirname(kept))
    fs.mkdirSync(path.dirname(kept), { recursive: true })
    fs.writeFileSync(kept, 'd4:infod4:name1:xee')
    const res = await handler(
      new Request(apiQuery({ api: 'remove', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': mintToken() } })
    )
    expect(res.status).to.equal(200)
    expect(fs.existsSync(kept)).to.equal(false)
  })

  it('resume from cache returns 409 when another torrent is actively seeding', async () => {
    const { handler, child } = await loadHandler({
      replyAs (proc) {
        return (msg) => {
          if (msg.id && msg.action === 'resume') {
            proc.emit('message', { id: msg.id, error: 'Torrent not found' })
            return
          }
          defaultWorkerReplies(proc)(msg)
        }
      }
    })

    child.emit('message', {
      type: 'status-update',
      infoHash: HASH_HEX,
      mode: 'download',
      magnetURI: MAGNET,
      paused: true,
      files: []
    })
    child.emit('message', {
      type: 'status-update',
      infoHash: '1111111111111111111111111111111111111111',
      mode: 'seed',
      isSeeding: true,
      paused: false,
      files: []
    })

    const token = mintToken()
    const res = await handler(
      new Request(apiQuery({ api: 'resume', hash: HASH_HEX }), { method: 'POST', headers: { 'X-BT-Token': token } })
    )
    expect(res.status).to.equal(409)
    expect((await jsonBody(res)).error).to.include('Cannot resume while another torrent is actively seeding')
  })

  it('base32 btih in hostname still renders a magnet link in the UI', async () => {
    const b32 = 'YNKEUYQYHGNZBULYSH6QUYSTMFPUVV52'
    const { handler } = await loadHandler()
    const html = await (await handler(new Request(`bt://${b32}/`))).text()
    expect(html).to.include('magnet:?xt=urn:btih:')
  })

  // The Internet Archive links its torrents as webtorrent:<address of the
  // .torrent file>. Its torrents are mostly web seeds.
  describe('webtorrent: links', function () {
    const SOURCE = 'https://archive.example/items/mose/mose_archive.torrent'
    let torrentFile

    before(async function () {
      torrentFile = await new Promise((resolve, reject) => {
        const file = Buffer.from('Mysterious Mose, 1930')
        file.name = 'mose.txt'
        createTorrent(file, {
          name: 'mysterious-mose_1930',
          announceList: [['https://tracker.example/announce']],
          urlList: ['https://archive.example/download/']
        }, (error, torrent) => (error ? reject(error) : resolve(torrent)))
      })
    })

    function serving (body, init = {}) {
      const calls = []
      const fetch = async (url) => {
        calls.push(url)
        return new Response(body, init)
      }
      return { fetch, calls }
    }

    it('fetches the .torrent file and opens its torrent with trackers, web seeds and the file address', async () => {
      const { fetch, calls } = serving(torrentFile)
      const { handler } = await loadHandler({ fetch })
      const res = await handler(new Request(`webtorrent:${SOURCE}`))
      expect(res.status).to.equal(200)
      expect(calls).to.deep.equal([SOURCE])

      const parsed = await parseTorrent(torrentFile)
      const html = await res.text()
      expect(html).to.include(parsed.infoHash)
      expect(html).to.include('mysterious-mose_1930')
      expect(html).to.include(`tr=${encodeURIComponent('https://tracker.example/announce')}`)
      expect(html).to.include(`ws=${encodeURIComponent('https://archive.example/download/')}`)
      expect(html).to.include(`xs=${encodeURIComponent(SOURCE)}`)
    })

    it('refuses an address that is not http or https, and anything that is not a torrent file', async () => {
      const { fetch, calls } = serving('<html>not a torrent</html>')
      const { handler } = await loadHandler({ fetch })
      for (const url of ['webtorrent:', 'webtorrent:file:///etc/passwd', 'webtorrent:hyper://abc/x.torrent']) {
        const res = await handler(new Request(url))
        expect(res.status, url).to.equal(500)
        expect(await res.text(), url).to.include('http or https address')
      }
      expect(calls).to.deep.equal([])

      const html = await handler(new Request(`webtorrent:${SOURCE}`))
      expect(await html.text()).to.include('did not give a .torrent file')
    })

    it('stops reading a file far bigger than any torrent file', async () => {
      const huge = new ReadableStream({
        pull (controller) { controller.enqueue(new Uint8Array(1024 * 1024)) }
      })
      const { fetch } = serving(huge)
      const { handler } = await loadHandler({ fetch })
      const res = await handler(new Request(`webtorrent:${SOURCE}`))
      expect(await res.text()).to.include('too big')
    })

    it('a webtorrent: page may ask for the API token', async () => {
      const loaded = await loadHandler()
      expect(tokenIpc(loaded)(`webtorrent:${SOURCE}`)).to.be.a('string').with.lengthOf(48)
    })
  })
})

describe('BitTorrent worker lifecycle', function () {
  this.timeout(20000)

  function fakeWebTorrentModuleSource () {
    return `
import { EventEmitter } from "events";

function btihFromMagnet(uri) {
  const m = String(uri).match(/btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
}

class FakeTorrent extends EventEmitter {
  constructor(magnetURI, client) {
    super();
    this.client = client;
    this.magnetURI = magnetURI;
    this.infoHash = btihFromMagnet(magnetURI);
    this.name = "FakeTorrent";
    this.length = 1024 * 1024;
    this.files = [{ name: "file.txt", path: "file.txt", length: 3, downloaded: 0, progress: 0 }];
    this.wires = [];
    this.pieces = [0];
    this.progress = 0.5;
    this.downloaded = 1;
    this.uploaded = 0;
    this.downloadSpeed = 1234;
    this.uploadSpeed = 0;
    this.ratio = 0;
    this.numPeers = 0;
    this.timeRemaining = 0;
    this.done = false;
    this.paused = false;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  deselect() {}

  destroy(_opts, cb) {
    if (this.client) this.client.torrents = this.client.torrents.filter((t) => t !== this);
    if (process.send) process.send({ type: "fake-destroy", infoHash: this.infoHash });
    if (typeof cb === "function") cb();
  }
}

export default class FakeWebTorrent extends EventEmitter {
  constructor() {
    super();
    this.torrents = [];
  }

  async get(hash) {
    return this.torrents.find((t) => t.infoHash === hash) || null;
  }

  add(source) {
    // A kept .torrent file reads "fake torrent file <hash>" here.
    const fromFile = typeof source !== "string";
    const magnetURI = fromFile ? "magnet:?xt=urn:btih:" + Buffer.from(source).toString().split(" ").pop() : source;
    if (process.send) process.send({ type: "fake-add", from: fromFile ? "file" : "magnet", infoHash: btihFromMagnet(magnetURI) });
    if (magnetURI.includes("dn=Boom")) {
      setTimeout(() => { throw new Error("boom"); });
      Promise.reject(new Error("boom, rejected"));
    }
    const t = new FakeTorrent(magnetURI, this);
    t.torrentFile = Buffer.from("fake torrent file " + t.infoHash);
    this.torrents.push(t);

    queueMicrotask(() => {
      // Complete after worker attaches listeners.
      t.emit("metadata");
      t.done = true;
      t.progress = 1;
      t.downloadSpeed = 0;
      t.emit("done");
    });

    return t;
  }

  destroy(cb) {
    this.torrents = [];
    if (typeof cb === "function") cb();
  }
}
`
  }

  async function withTempWorker (run) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-worker-test-'))
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-worker-dl-'))
    const torrentFiles = path.join(tmp, 'bt-torrents')

    const workerSrcPath = path.join(_testDir, '../../src/protocols/bt/worker.js')
    const workerOutPath = path.join(tmp, 'worker.js')
    fs.writeFileSync(workerOutPath, fs.readFileSync(workerSrcPath, 'utf8'), 'utf8')

    const nm = path.join(tmp, 'node_modules', 'webtorrent')
    fs.mkdirSync(nm, { recursive: true })
    fs.writeFileSync(
      path.join(nm, 'package.json'),
      JSON.stringify({ name: 'webtorrent', version: '0.0.0', type: 'module', exports: './index.js' }, null, 2),
      'utf8'
    )
    fs.writeFileSync(path.join(nm, 'index.js'), fakeWebTorrentModuleSource(), 'utf8')

    const child = forkProcess(workerOutPath, [dl, torrentFiles], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      silent: true
    })
    let stderr = ''
    child.stderr.on('data', (data) => { stderr += data })

    try {
      await run(child, { torrentFiles, stderr: () => stderr })
    } finally {
      // Gone before its folders are, as it may still be writing a .torrent file.
      const exited = child.exitCode === null ? new Promise((resolve) => child.once('exit', resolve)) : null
      try { child.disconnect() } catch {}
      try { child.kill('SIGTERM') } catch {}
      await exited
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.rmSync(dl, { recursive: true, force: true })
    }
  }

  function waitForMessage (child, predicate, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for worker message'))
      }, timeoutMs)
      function onMsg (msg) {
        if (predicate(msg)) {
          cleanup()
          resolve(msg)
        }
      }
      function cleanup () {
        clearTimeout(timer)
        child.off('message', onMsg)
      }
      child.on('message', onMsg)
    })
  }

  it('download completion emits done and destroys torrent (no seeding)', async () => {
    await withTempWorker(async (child) => {
      await waitForMessage(child, (m) => m && m.type === 'ready')

      child.send({ id: 1, action: 'start', magnetUri: MAGNET, announce: [] })

      const done = await waitForMessage(child, (m) => m && m.type === 'done' && m.infoHash === HASH_HEX)
      expect(done.infoHash).to.equal(HASH_HEX)

      const destroyed = await waitForMessage(child, (m) => m && m.type === 'fake-destroy' && m.infoHash === HASH_HEX)
      expect(destroyed.infoHash).to.equal(HASH_HEX)
    })
  })

  it('keeps a torrent\'s .torrent file, and seeds from it later with no peer to ask', async () => {
    await withTempWorker(async (child, { torrentFiles }) => {
      await waitForMessage(child, (m) => m && m.type === 'ready')
      const added = waitForMessage(child, (m) => m && m.type === 'fake-add')
      const destroyed = waitForMessage(child, (m) => m && m.type === 'fake-destroy')
      child.send({ id: 1, action: 'start', magnetUri: MAGNET, announce: [] })
      expect((await added).from).to.equal('magnet')
      await destroyed

      const kept = path.join(torrentFiles, `${HASH_HEX}.torrent`)
      for (let i = 0; i < 50 && !fs.existsSync(kept); i++) await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fs.readFileSync(kept, 'utf8')).to.equal(`fake torrent file ${HASH_HEX}`)
      expect(fs.readdirSync(torrentFiles)).to.deep.equal([`${HASH_HEX}.torrent`])

      const seeded = waitForMessage(child, (m) => m && m.type === 'fake-add')
      child.send({ id: 2, action: 'seed', magnetUri: MAGNET, announce: [] })
      expect(await seeded).to.include({ from: 'file', infoHash: HASH_HEX })
    })
  })

  it('finds the kept file from an old base32 magnet link too', async () => {
    await withTempWorker(async (child, { torrentFiles }) => {
      await waitForMessage(child, (m) => m && m.type === 'ready')
      fs.mkdirSync(torrentFiles, { recursive: true })
      fs.writeFileSync(path.join(torrentFiles, `${HASH_HEX}.torrent`), `fake torrent file ${HASH_HEX}`)
      const added = waitForMessage(child, (m) => m && m.type === 'fake-add')
      // deadbeef… in base32
      child.send({ id: 1, action: 'seed', magnetUri: 'magnet:?xt=urn:btih:32w35366vw7o7xvnx3x55ln657pk3pxp', announce: [] })
      expect((await added).from).to.equal('file')
    })
  })

  it('one torrent\'s error does not stop the worker and every other torrent with it', async () => {
    await withTempWorker(async (child, { stderr }) => {
      await waitForMessage(child, (m) => m && m.type === 'ready')
      const boom = waitForMessage(child, (m) => m && m.type === 'fake-add')
      child.send({ id: 1, action: 'start', magnetUri: `magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=Boom`, announce: [] })
      await boom
      await new Promise((resolve) => setTimeout(resolve, 100))

      const done = waitForMessage(child, (m) => m && m.type === 'done' && m.infoHash === HASH_HEX)
      child.send({ id: 2, action: 'start', magnetUri: MAGNET, announce: [] })
      expect((await done).infoHash).to.equal(HASH_HEX)
      expect(child.exitCode).to.equal(null)
      expect(stderr()).to.include('[BT-Worker] Uncaught error: Error: boom')
      expect(stderr()).to.include('[BT-Worker] Unhandled rejection: Error: boom, rejected')
    })
  })

  it('seed completion keeps seeding and does not emit done', async () => {
    await withTempWorker(async (child) => {
      await waitForMessage(child, (m) => m && m.type === 'ready')

      child.send({ id: 1, action: 'seed', magnetUri: MAGNET, announce: [] })

      const status = await waitForMessage(child, (m) => m && m.type === 'status-update' && m.infoHash === HASH_HEX)
      expect(status.mode).to.equal('seed')
      expect(status.isSeeding).to.equal(true)

      let sawDone = false
      let sawDestroy = false
      const onMsg = (m) => {
        if (m && m.type === 'done') sawDone = true
        if (m && m.type === 'fake-destroy') sawDestroy = true
      }
      child.on('message', onMsg)
      await new Promise((resolve) => setTimeout(resolve, 200))
      child.off('message', onMsg)

      expect(sawDone).to.equal(false)
      expect(sawDestroy).to.equal(false)
    })
  })
})

describe('BitTorrent pages', function () {
  const pages = path.join(_testDir, '../../src/pages')
  const read = (file) => fs.readFileSync(path.join(pages, file), 'utf8')

  // Nothing in the browser pointed at the manager, so only someone who typed
  // peersky://bt-manager ever found it.
  it('Settings lists BitTorrent right under P2P data', () => {
    const settings = read('settings.html')
    const p2pData = settings.indexOf('data-section="p2p-data"')
    const bittorrent = settings.indexOf('href="peersky://bt-manager"')
    expect(p2pData).to.be.greaterThan(-1)
    expect(bittorrent).to.be.greaterThan(p2pData)
    expect(bittorrent).to.be.lessThan(settings.indexOf('id="history-nav-link"'))
    expect(settings).to.match(/<a href="peersky:\/\/bt-manager" class="nav-item">\s*<img src="peersky:\/\/static\/assets\/svg\/bittorrent\.svg"/)
    expect(fs.existsSync(path.join(pages, 'static/assets/svg/bittorrent.svg'))).to.equal(true)
  })

  it('the manager says how to start a torrent, with the privacy notice the torrent page shows', () => {
    const manager = read('bt-manager.html')
    for (const text of ['magnet:', 'bt://', 'bittorrent://', 'Start Torrent', 'Downloads/PeerskyTorrents']) {
      expect(manager).to.include(text)
    }
    const torrentPage = fs.readFileSync(path.join(_testDir, '../../src/protocols/bt/torrentPage.js'), 'utf8')
    const notice = torrentPage.match(/<div class="privacy-warning">\s*([\s\S]*?)\s*<\/div>/)[1]
    expect(notice).to.include('Your IP address is visible to peers')
    expect(manager).to.include(notice)
  })

  // A function of a page's inline script, by its name.
  function pageFunction (script, name) {
    const start = script.indexOf(`function ${name}(`)
    return script.slice(start, script.indexOf('\n    }\n', start) + 6)
  }

  it('the torrent page puts file names in as text, and opens a file from the torrent, not as a file:// page', async () => {
    const { generateTorrentUI } = await import('../../src/protocols/bt/torrentPage.js')
    const html = generateTorrentUI(`magnet:?xt=urn:btih:${HASH_HEX}&dn=</script><b>x</b>`, HASH_HEX, 'magnet', null, 'dark')
    expect(html.match(/<\/script>/g), 'a link ended the script block').to.have.lengthOf(1)
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    expect(script).to.not.include("'file://'")

    const element = () => ({ children: [], style: {}, listeners: {}, appendChild (child) { this.children.push(child) }, addEventListener (type, fn) { this.listeners[type] = fn } })
    const tbody = element()
    const document = { getElementById: (id) => (id === 'filesList' ? tbody : element()), createElement: element }
    const opened = []
    const renderFiles = new Function('document', 'window', 'currentInfoHash', 'formatBytes', // eslint-disable-line no-new-func
      `${pageFunction(script, 'renderFiles')}\n${pageFunction(script, 'openFile')}\nreturn renderFiles`
    )(document, { open: (...args) => opened.push(args) }, HASH_HEX, (n) => `${n} B`)

    const name = '&#39;);alert(1);<img src=x onerror=alert(2)>.html'
    renderFiles([{ index: 0, name, path: `Folder\\Sub/${name}`, length: 3 }])
    const cells = tbody.children[0].children
    expect(cells[1].textContent).to.equal(name)
    cells[2].children[0].listeners.click()
    expect(opened).to.deep.equal([[`bt://${HASH_HEX}/Folder/Sub/${encodeURIComponent(name)}`, '_blank', 'noopener']])
  })

  it('the manager shows a downloaded torrent as done, with nothing to resume or stop', () => {
    const script = read('bt-manager.html').match(/<script>([\s\S]*?)<\/script>/)[1]
    const formatState = new Function( // eslint-disable-line no-new-func
      `${['isActivelySeeding', 'isFinished', 'formatState'].map((name) => pageFunction(script, name)).join('\n')}\nreturn formatState`
    )()
    const states = {
      downloading: {},
      paused: { paused: true },
      stopped: { paused: true, stopped: true },
      seeding: { done: true, mode: 'seed', isSeeding: true },
      'paused seeding': { done: true, mode: 'seed', paused: true },
      'seeding stopped': { done: true, mode: 'download', paused: true },
      'seeding stopped with Stop': { done: true, mode: 'download', paused: true, stopped: true }
    }
    expect(Object.fromEntries(Object.entries(states).map(([key, t]) => [key, formatState(t)]))).to.deep.equal({
      downloading: 'downloading',
      paused: 'paused',
      stopped: 'stopped',
      seeding: 'seeding',
      'paused seeding': 'paused',
      'seeding stopped': 'done',
      'seeding stopped with Stop': 'done'
    })
  })
})

// A peer connecting to a paused torrent made WebTorrent throw, which ended the
// worker and every torrent in it (patches/webtorrent+3.0.21.patch).
describe('WebTorrent with a paused torrent', function () {
  this.timeout(30000)

  it('turns an encrypted peer away and keeps going, then serves it once resumed', async () => {
    const { default: WebTorrent } = await import('webtorrent')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-bt-paused-'))
    const file = path.join(dir, 'hello.txt')
    fs.writeFileSync(file, 'hello from a paused seeder\n'.repeat(1000))
    const opts = { dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false }
    const seeder = new WebTorrent(opts)
    const peer = new WebTorrent(opts)
    // Mocha swallows a rejection no test awaits, which is how this one ends.
    const thrown = []
    const record = (err) => thrown.push(err)
    process.on('unhandledRejection', record)
    try {
      await new Promise((resolve) => seeder.once('listening', resolve))
      const address = `127.0.0.1:${seeder.address().port}`
      const seeded = await new Promise((resolve) => seeder.seed(file, { path: dir }, resolve))
      seeded.pause()

      const leech = peer.add(seeded.magnetURI, { path: fs.mkdtempSync(path.join(dir, 'leech-')) })
      await new Promise((resolve) => leech.once('infoHash', resolve))
      for (let i = 0; i < 3; i++) {
        leech.addPeer(address)
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
      expect(seeded.destroyed).to.equal(false)
      expect(thrown.map((err) => err?.stack || String(err))).to.deep.equal([])

      seeded.resume()
      leech.addPeer(address)
      if (!leech.done) await new Promise((resolve) => leech.once('done', resolve))
      expect(leech.progress).to.equal(1)
    } finally {
      process.off('unhandledRejection', record)
      await Promise.all([seeder, peer].map((client) => new Promise((resolve) => client.destroy(resolve))))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
