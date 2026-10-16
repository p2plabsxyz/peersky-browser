// Simulated P2PMD editors, one process's share of them. Each joins the note the
// way the editor does, keeps its own Yjs copy of it from what the host sends,
// and the ones typing send edits (and presence, from the desktop editor) the
// way the editor does. run.mjs starts these processes and collects what they
// measured.
//
// desktop: the editor in the p2pmd repo (p2p.js), which PeerSky Desktop uses.
// phone: the editor page in peersky-mobile's backend/p2pmd/server.mjs.
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import * as Y from 'yjs'

const LOCAL = 'local-input'
const REMOTE = 'remote-sse'
// The editor sends an edit 100 ms after a keystroke, and the desktop one sends
// presence 220 ms after. A typist here does both on a steady beat.
const EDIT_EVERY_MS = 100
const PRESENCE_EVERY_MS = 220
// The phone editor applies what the host sends every 80 ms.
const PHONE_APPLY_MS = 80
// Every tenth edit types a token, timed until every other editor has it.
const PROBE_EVERY = 10
const PROBE = /\[(\d+:\d+)\]/g
// What the typists type, a character an edit.
const WORDS = 'we went over the plan for the release and agreed to ship once the last fixes are in '
const COLORS = ['#1FC1A8', '#E0533D', '#3D7BE0', '#B54FD1', '#D19A1F', '#2E9E4F', '#D14F86', '#4FA3D1']
const REQUEST_TIMEOUT_MS = 15000
// How long stopping waits for the typists' requests still out. A host that
// fell behind may never answer them all.
const STOP_WAIT_MS = 30000
// Bytes in, by SSE event and for the replies to the editor's own requests.
const KINDS = ['yjsupdate', 'update', 'peerlist', 'peers', 'activity', 'keepalive', 'other', 'replies']

const now = () => performance.timeOrigin + performance.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sha1 = (text) => createHash('sha1').update(text).digest('hex')

const editors = []
const LOOP_EVERY_MS = 10
const loop = monitorEventLoopDelay({ resolution: LOOP_EVERY_MS })
const stats = {
  edits: { sent: 0, failed: 0, lost: 0, unanswered: 0 },
  presence: { sent: 0, failed: 0 },
  roundTrips: { edit: [], presence: [] },
  applyErrors: 0
}
let measuring = false

const handlers = {
  async join ({ url, mode, gapMs, editors: list }) {
    const results = await Promise.allSettled(list.map(async (spec) => {
      // Spread over time by each person's place in the whole room.
      await sleep(spec.index * gapMs)
      const editor = createEditor({ ...spec, url, mode })
      editors.push(editor)
      await joinNote(editor)
    }))
    const failed = []
    results.forEach((result, n) => {
      if (result.status === 'rejected') failed.push({ index: list[n].index, error: result.reason?.message || String(result.reason) })
    })
    return { failed }
  },

  start () {
    for (const editor of editors) editor.atStart = { ...editor.bytes }
    measuring = true
    loop.reset()
    loop.enable()
    for (const editor of editors) {
      if (editor.typist) startTyping(editor)
    }
    return {}
  },

  async stop () {
    for (const editor of editors) editor.atStop = { ...editor.bytes }
    measuring = false
    loop.disable()
    const deadline = Date.now() + STOP_WAIT_MS
    await Promise.all(editors.filter((editor) => editor.typist).map((editor) => stopTyping(editor, deadline)))
    return {}
  },

  check ({ hash }) {
    const differing = editors.filter((editor) => sha1(editor.text.toString()) !== hash)
    return { differing: differing.map((editor) => editor.index) }
  },

  report () {
    // For each token: how many editors have it, and when the last one got it.
    const seen = {}
    for (const editor of editors) {
      for (const [token, at] of editor.seen) {
        const entry = seen[token] || (seen[token] = [0, 0])
        entry[0] += 1
        entry[1] = Math.max(entry[1], at)
      }
    }
    return {
      editors: editors.map((editor) => ({
        index: editor.index,
        typist: editor.typist,
        joining: editor.atStart,
        window: Object.fromEntries(KINDS.map((kind) => [kind, editor.atStop[kind] - editor.atStart[kind]])),
        dropped: editor.dropped
      })),
      probes: editors.flatMap((editor) => editor.probes),
      seen,
      ...stats,
      // How late the event loop ran: the histogram counts the sampling interval too.
      loop: {
        p99: Math.max(0, loop.percentile(99) / 1e6 - LOOP_EVERY_MS),
        max: Math.max(0, loop.max / 1e6 - LOOP_EVERY_MS)
      }
    }
  },

  close () {
    for (const editor of editors) {
      editor.closing = true
      clearTimeout(editor.waitTimer)
      editor.stream?.destroy()
      editor.agent.destroy()
    }
    return {}
  }
}

process.on('message', async (message) => {
  let reply
  try {
    reply = { ...(await handlers[message.type](message)), id: message.id }
  } catch (error) {
    reply = { id: message.id, error: error.message }
  }
  process.send(reply)
})
process.on('disconnect', () => process.exit(0))

function createEditor ({ index, name, typist, url, mode }) {
  const doc = new Y.Doc()
  const editor = {
    index,
    name,
    typist,
    url,
    mode,
    // Each editor's own kind of id and colour.
    clientId: mode === 'phone' ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` : randomUUID(),
    color: mode === 'phone' ? `hsl(${(index * 47) % 360} 74% 58%)` : COLORS[index % COLORS.length],
    linePrefix: `- ${name}: `,
    doc,
    text: doc.getText('content'),
    // A browser keeps up to six connections to a host.
    agent: new http.Agent({ keepAlive: true, maxSockets: 6 }),
    stream: null,
    decoder: new StringDecoder('utf8'),
    buffer: '',
    bytes: Object.fromEntries(KINDS.map((kind) => [kind, 0])),
    atStart: null,
    atStop: null,
    // Tokens from other typists, and when this editor got each one.
    seen: new Map(),
    // Phone: what the host sent and is not applied yet.
    waiting: null,
    waitTimer: null,
    // Phone typists: the note's line authors as this editor knows them.
    authors: {},
    peerList: [],
    ownAuthors: undefined,
    outgoing: null,
    // An edit the host did not take, sent again with the next one.
    unsent: null,
    cursor: { line: 1, column: 1, offset: 0 },
    typing: false,
    edits: 0,
    probes: [],
    stops: [],
    inFlight: new Set(),
    editsOut: 0,
    dropped: false,
    closing: false
  }

  doc.on('update', (update, origin) => {
    if (origin === LOCAL) editor.outgoing = update
  })
  editor.text.observe((event, transaction) => {
    if (transaction.origin !== REMOTE) return
    for (const change of event.delta) {
      if (typeof change.insert !== 'string' || !change.insert.includes('[')) continue
      for (const match of change.insert.matchAll(PROBE)) {
        if (!editor.seen.has(match[1])) editor.seen.set(match[1], now())
      }
    }
  })
  return editor
}

// The requests each editor makes to open a note, in its order.
async function joinNote (editor) {
  if (editor.mode === 'phone') {
    // loadDocument, then initializeYjs.
    await request(editor, 'GET', '/doc')
    await loadState(editor)
  } else {
    // connectToRoom: pingServerStatus, the people list, the activity, the note
    // and its Yjs state.
    await request(editor, 'GET', '/status')
    await request(editor, 'GET', '/status')
    await request(editor, 'GET', '/activity')
    await request(editor, 'GET', '/doc')
    await loadState(editor)
  }
  await openStream(editor)
  // Once the stream is open the editor compares its copy with the host's, and
  // the desktop one sends its presence.
  await Promise.all([
    loadState(editor),
    editor.mode === 'desktop' && send(editor, '/presence', presenceBody(editor), 'presence')
  ])
}

async function loadState (editor) {
  const reply = await request(editor, 'GET', '/doc/yjsstate')
  if (reply.status !== 200) throw new Error(`/doc/yjsstate answered ${reply.status}`)
  const { yjsState } = JSON.parse(reply.body.toString())
  if (typeof yjsState === 'string') Y.applyUpdate(editor.doc, Buffer.from(yjsState, 'base64'), REMOTE)
}

function openStream (editor) {
  const query = editor.mode === 'phone'
    ? new URLSearchParams(phonePeer(editor))
    : new URLSearchParams({ role: 'client', clientId: editor.clientId, color: editor.color, name: editor.name })
  return new Promise((resolve, reject) => {
    let timer = null
    const req = http.get(`${editor.url}/events?${query}`, { agent: false }, (res) => {
      clearTimeout(timer)
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`/events answered ${res.statusCode}`))
        return
      }
      editor.stream = req
      res.on('data', (chunk) => readStream(editor, chunk))
      res.on('close', () => {
        if (!editor.closing) editor.dropped = true
      })
      resolve()
    })
    timer = setTimeout(() => req.destroy(new Error('/events did not answer')), REQUEST_TIMEOUT_MS)
    req.on('error', (error) => {
      clearTimeout(timer)
      if (!editor.stream) reject(error)
      else if (!editor.closing) editor.dropped = true
    })
  })
}

function readStream (editor, chunk) {
  editor.buffer += editor.decoder.write(chunk)
  let cut = editor.buffer.indexOf('\n\n')
  while (cut !== -1) {
    const raw = editor.buffer.slice(0, cut)
    editor.buffer = editor.buffer.slice(cut + 2)
    takeEvent(editor, raw)
    cut = editor.buffer.indexOf('\n\n')
  }
}

function takeEvent (editor, raw) {
  const size = Buffer.byteLength(raw) + 2
  if (raw.startsWith(':')) {
    editor.bytes.keepalive += size
    return
  }
  let name = 'other'
  let data = ''
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) name = line.slice(7)
    else if (line.startsWith('data: ')) data = data ? `${data}\n${line.slice(6)}` : line.slice(6)
  }
  editor.bytes[KINDS.includes(name) && name !== 'replies' ? name : 'other'] += size

  if (name === 'yjsupdate') takeUpdate(editor, data)
  // The phone editor keeps the note's line authors, from the whole note and
  // from the people list, and sends them with every edit.
  else if (name === 'update' && editor.typist && editor.mode === 'phone') takeNote(editor, data)
  else if (name === 'peerlist' && editor.typist && editor.mode === 'phone') takePeerList(editor, data)
}

function takeUpdate (editor, data) {
  const update = Buffer.from(data, 'base64')
  if (editor.mode !== 'phone') {
    applyRemote(editor, update)
    return
  }
  editor.waiting = editor.waiting ? Y.mergeUpdates([editor.waiting, update]) : update
  if (editor.waitTimer) return
  editor.waitTimer = setTimeout(() => {
    const waiting = editor.waiting
    editor.waiting = null
    editor.waitTimer = null
    applyRemote(editor, waiting)
  }, PHONE_APPLY_MS)
}

function applyRemote (editor, update) {
  try {
    Y.applyUpdate(editor.doc, update, REMOTE)
  } catch {
    stats.applyErrors += 1
  }
}

function takeNote (editor, data) {
  try {
    const note = JSON.parse(data)
    editor.authors = normalizeAuthors(note.lineAttributions, lineCount(editor.text.toString()))
    mergePeerAuthors(editor)
  } catch {}
}

function takePeerList (editor, data) {
  try {
    const list = JSON.parse(data)
    if (!Array.isArray(list)) return
    editor.peerList = list
    mergePeerAuthors(editor)
  } catch {}
}

function mergePeerAuthors (editor) {
  const count = lineCount(editor.text.toString())
  for (const peer of editor.peerList) {
    if (!peer?.lineAttributions) continue
    for (const [line, author] of Object.entries(normalizeAuthors(peer.lineAttributions, count))) {
      const next = { ...author, clientId: author.clientId || peer.clientId || '' }
      const known = editor.authors[line]
      if (known?.clientId === next.clientId && known?.color === next.color && known?.name === next.name) continue
      editor.authors[line] = next
    }
  }
}

function normalizeAuthors (authors, count) {
  const normalized = {}
  if (!authors || typeof authors !== 'object') return normalized
  for (const [line, value] of Object.entries(authors)) {
    const number = Number(line)
    const color = typeof value?.color === 'string' ? value.color.trim() : ''
    if (!Number.isInteger(number) || number < 1 || number > count || !color) continue
    const author = {
      clientId: typeof value.clientId === 'string' ? value.clientId : '',
      color,
      name: typeof value.name === 'string' ? value.name : ''
    }
    const updatedAt = Number(value.updatedAt)
    if (Number.isFinite(updatedAt) && updatedAt >= 0) author.updatedAt = updatedAt
    normalized[line] = author
  }
  return normalized
}

function startTyping (editor) {
  editor.typing = true
  editor.stops.push(every(EDIT_EVERY_MS, () => typeOnce(editor)))
  if (editor.mode === 'desktop') editor.stops.push(every(PRESENCE_EVERY_MS, () => sendPresence(editor)))
}

async function stopTyping (editor, deadline) {
  for (const stop of editor.stops) stop()
  editor.stops = []
  editor.typing = false
  await within(Promise.all(editor.inFlight), deadline - Date.now())
  if (editor.editsOut > 0) {
    stats.edits.unanswered += editor.editsOut
    return
  }
  // The editor sends an edit the host did not take again, and so does this, once.
  if (editor.unsent) {
    const update = editor.unsent
    editor.unsent = null
    if (!await send(editor, '/doc/update', editBody(editor, update), 'edit')) stats.edits.lost += 1
  }
}

// Runs fn every ms, from a random point in the first beat so typists are not
// in step.
function every (ms, fn) {
  let interval = null
  const first = setTimeout(() => {
    fn()
    interval = setInterval(fn, ms)
  }, Math.random() * ms)
  return () => {
    clearTimeout(first)
    clearInterval(interval)
  }
}

// One keystroke at the end of the typist's own line, sent as the change it made.
function typeOnce (editor) {
  const content = editor.text.toString()
  const start = content.indexOf(editor.linePrefix)
  if (start === -1) throw new Error(`${editor.name} has no line to type on`)
  const lineEnd = content.indexOf('\n', start)
  const at = lineEnd === -1 ? content.length : lineEnd

  editor.edits += 1
  const token = editor.edits % PROBE_EVERY === 0 ? `${editor.index}:${editor.probes.length}` : null
  const piece = token ? `[${token}]` : WORDS[(editor.edits + editor.index * 7) % WORDS.length]
  editor.doc.transact(() => editor.text.insert(at, piece), LOCAL)
  const offset = at + piece.length
  editor.cursor = { line: lineAt(content, start), column: offset - start + 1, offset }
  noteOwnLine(editor)

  const update = editor.unsent ? Y.mergeUpdates([editor.unsent, editor.outgoing]) : editor.outgoing
  editor.unsent = null
  editor.outgoing = null
  if (token) editor.probes.push([token, now()])
  stats.edits.sent += 1
  editor.editsOut += 1
  send(editor, '/doc/update', editBody(editor, update), 'edit').then((ok) => {
    editor.editsOut -= 1
    if (ok) return
    stats.edits.failed += 1
    editor.unsent = editor.unsent ? Y.mergeUpdates([update, editor.unsent]) : update
  })
}

function sendPresence (editor) {
  stats.presence.sent += 1
  send(editor, '/presence', presenceBody(editor), 'presence').then((ok) => {
    if (!ok) stats.presence.failed += 1
  })
}

// The line the typist just edited is theirs, as each editor records it.
function noteOwnLine (editor) {
  const line = String(editor.cursor.line)
  if (editor.mode === 'phone') {
    const own = { clientId: editor.clientId, color: editor.color, name: editor.name, updatedAt: Date.now() }
    editor.authors[line] = own
    editor.ownAuthors = { [line]: own }
  } else {
    editor.ownAuthors = { [line]: { name: editor.name, color: editor.color, clientId: editor.clientId, updatedAt: Date.now() } }
  }
}

// flushYjsUpdate's body in each editor. The phone sends every line author it
// knows of and its own lines apart; the desktop sends only its own lines.
function editBody (editor, update) {
  const encoded = Buffer.from(update).toString('base64')
  if (editor.mode === 'phone') {
    return { update: encoded, ...phonePeer(editor), lineAttributions: editor.authors, peerLineAttributions: editor.ownAuthors }
  }
  return {
    update: encoded,
    clientId: editor.clientId,
    role: 'client',
    name: editor.name,
    color: editor.color,
    latexModeEnabled: false,
    selectionStart: editor.cursor.offset,
    selectionEnd: editor.cursor.offset,
    cursorLine: editor.cursor.line,
    cursorColumn: editor.cursor.column,
    lineAttributions: editor.ownAuthors
  }
}

// The desktop editor's buildPresencePayload. The phone editor sends no presence
// while typing: its cursor goes with each edit.
function presenceBody (editor) {
  return {
    clientId: editor.clientId,
    role: 'client',
    name: editor.name,
    color: editor.color,
    latexModeEnabled: false,
    selectionStart: editor.cursor.offset,
    selectionEnd: editor.cursor.offset,
    cursorLine: editor.cursor.line,
    cursorColumn: editor.cursor.column,
    isTyping: editor.typing,
    lineAttributions: editor.ownAuthors
  }
}

// The phone editor's getPeerPayload.
function phonePeer (editor) {
  return {
    clientId: editor.clientId,
    role: 'client',
    name: editor.name,
    color: editor.color,
    latexModeEnabled: false,
    isTyping: editor.typing,
    cursorLine: editor.cursor.line,
    cursorColumn: editor.cursor.column
  }
}

function send (editor, path, body, kind) {
  const startedAt = now()
  const done = request(editor, 'POST', path, JSON.stringify(body)).then((reply) => {
    if (measuring) stats.roundTrips[kind].push(now() - startedAt)
    return reply.status >= 200 && reply.status < 300
  }, () => false)
  editor.inFlight.add(done)
  done.then(() => editor.inFlight.delete(done))
  return done
}

function request (editor, method, path, payload) {
  return new Promise((resolve, reject) => {
    const headers = payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    const req = http.request(`${editor.url}${path}`, { method, agent: editor.agent, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        editor.bytes.replies += body.length
        resolve({ status: res.statusCode, body })
      })
      res.on('error', reject)
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`${method} ${path} timed out`)))
    req.on('error', reject)
    req.end(payload)
  })
}

// Waits for promise, or ms at most.
function within (promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function lineAt (text, offset) {
  let line = 1
  for (let at = text.indexOf('\n'); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) line += 1
  return line
}

function lineCount (text) {
  return lineAt(text, text.length + 1)
}
