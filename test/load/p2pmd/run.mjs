// P2PMD load test: one note served by this checkout's own P2PMD host to many
// simulated editors, some of them typing, all on this machine. Prints what it
// cost. See README.md.
//
//   npm run test:load:p2pmd -- --people 20 --typing 3 --seconds 20
//   npm run test:load:p2pmd -- --lan
//
// run.mjs and editors.mjs are the same in PeerSky Mobile and PeerSky Desktop.
// host.mjs runs the checkout's own host, and lan.mjs its own local network
// tunnels.
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EDITORS_PER_PROCESS = 25
// One person joins every 20 ms, so 100 take two seconds, unless --join-every
// says otherwise.
const JOIN_GAP_MS = 20
// How long the copies get to agree once typing stops.
const SAME_TEXT_WAIT_MS = 30000
const ASK_TIMEOUT_MS = 120000
const KINDS = [
  ['yjsupdate', 'yjsupdate: edits'],
  ['peerlist', 'peerlist: who is in the note'],
  ['update', 'update: the whole note'],
  ['activity', 'activity'],
  ['peers', 'peers: how many'],
  ['keepalive', 'keepalive'],
  ['other', 'other events'],
  ['replies', 'replies to its own requests']
]
const USAGE = `Usage: node test/load/p2pmd/run.mjs [options]

  --people <n>     editors in the note (default 100)
  --typing <n>     how many of them type (default 10)
  --seconds <n>    how long they type (default 60)
  --editor <kind>  desktop or phone: which P2PMD editor they act like (default desktop)
  --lan            each editor a device of its own, reaching the note through a
                   tunnel on the local network, as with no internet
  --join-every <ms>
                   one person joins every <ms> (default ${JOIN_GAP_MS})
  --out <file>     also write the results to a JSON file`

const options = readOptions()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pmd-load-'))
const children = new Set()
let lastId = 0

process.once('SIGINT', () => {
  for (const child of children) child.kill('SIGKILL')
  fs.rmSync(dir, { recursive: true, force: true })
  process.exit(130)
})

let code = 1
try {
  code = await run()
} catch (error) {
  console.error(`The load test stopped: ${error.message}`)
} finally {
  await stopChildren()
  fs.rmSync(dir, { recursive: true, force: true })
}
process.exit(code)

async function run () {
  const { people, typing, seconds, editor: mode, lan } = options
  const startedAt = new Date()
  const loadAverage = os.loadavg()[0]
  const typists = pickTypists(typing, people)
  const nameOf = (index) => `Person ${index + 1}`

  // Anything the host saves goes in the temp folder, removed at the end.
  const host = start('host.mjs', 'the host', { P2PMD_LOAD_DIR: dir, PEERSKY_LOG_LEVEL: 'warn', P2PMD_LOAD_LAN: lan ? '1' : '' })
  const ready = await firstMessage(host, 'ready')
  // The host's own address for the note, which is how its own editor reaches
  // it. With --lan everyone else goes through a tunnel to it (lan.mjs).
  const { url } = ready
  if (lan && !ready.lan) throw new Error('The host did not put the note on the local network')
  status(`P2PMD load test: ${ready.host} host, ${mode} editors, ${people} people, ${typing} typing, ${seconds} s${lan ? ', over the local network' : ''}`)

  await post(url, '/doc', buildNote([...typists].map(nameOf)))
  const noteAtStart = await measureNote(url)
  const beforeJoining = await ask(host, { type: 'sample', reset: true })

  status(`Joining ${people} people`)
  const groups = []
  for (let first = 0; first < people; first += EDITORS_PER_PROCESS) {
    const indexes = range(first, Math.min(people, first + EDITORS_PER_PROCESS))
    groups.push({ child: start('editors.mjs', `editor process ${groups.length + 1}`), indexes })
  }
  const joinStartedAt = Date.now()
  const joins = await Promise.all(groups.map(({ child, indexes }) => ask(child, {
    type: 'join',
    url,
    lan: lan ? ready.lan : null,
    mode,
    gapMs: options.joinEvery,
    editors: indexes.map((index) => ({ index, name: nameOf(index), typist: typists.has(index) }))
  })))
  const joinMs = Date.now() - joinStartedAt
  const failed = joins.flatMap((reply) => reply.failed)
  if (failed.length > 0) throw new Error(`${failed.length} of ${people} editors could not join. The first: ${failed[0].error}`)
  // Each join sends everyone the people list, which is paced to once a second
  // at 100 people. That goes out before typing starts.
  await sleep(Math.max(2000, people * 20 + 500))
  const { peers } = await get(url, '/status')

  status(`Typing for ${seconds} s`)
  const [atStart] = await Promise.all([
    ask(host, { type: 'sample', reset: true }),
    ...groups.map(({ child }) => ask(child, { type: 'start' }))
  ])
  // A look at the host every second, to see whether its load grows.
  const startedTypingAt = Date.now()
  const ticks = []
  for (let second = 1; second < seconds; second += 1) {
    await sleep(startedTypingAt + second * 1000 - Date.now())
    ticks.push(await ask(host, { type: 'sample' }))
  }
  await sleep(startedTypingAt + seconds * 1000 - Date.now())
  const [atEnd] = await Promise.all([
    ask(host, { type: 'sample', reset: true }),
    ...groups.map(({ child }) => ask(child, { type: 'stop' }))
  ])

  status('Comparing every editor\'s copy with the host\'s')
  const sameText = await waitForSameText(url, groups)
  const noteAtEnd = await measureNote(url)
  const reports = await Promise.all(groups.map(({ child }) => ask(child, { type: 'report' })))

  const results = summarize({
    ready, mode, lan, people, typing, startedAt, loadAverage, peers, joinMs, beforeJoining, atStart, ticks, atEnd, sameText, noteAtStart, noteAtEnd, reports
  })
  console.log(formatResults(results))
  if (options.out) {
    fs.writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`)
    status(`Results written to ${options.out}`)
  }

  await Promise.all([host, ...groups.map(({ child }) => child)].map((child) => ask(child, { type: 'close' })))
  return results.ok ? 0 : 1
}

function summarize ({ ready, mode, lan, people, typing, startedAt, loadAverage, peers, joinMs, beforeJoining, atStart, ticks, atEnd, sameText, noteAtStart, noteAtEnd, reports }) {
  const seconds = (atEnd.at - atStart.at) / 1000
  const cpuPercent = (from, to) => round((to.cpuMicros - from.cpuMicros) / ((to.at - from.at) * 1000) * 100, 1)
  const marks = [atStart, ...ticks, atEnd]
  const timeline = marks.slice(1).map((mark, n) => ({
    second: round((mark.at - atStart.at) / 1000, 1),
    cpuPercent: cpuPercent(marks[n], mark),
    outMBps: round((mark.written - marks[n].written) / ((mark.at - marks[n].at) / 1000) / 1e6, 3),
    rssMB: round(mark.rss / 1e6, 1)
  }))
  const editors = reports.flatMap((report) => report.editors)
  const typists = editors.filter((editor) => editor.typist)
  const watchers = editors.filter((editor) => !editor.typist)
  const total = (list, pick) => list.reduce((sum, item) => sum + pick(item), 0)
  const bytesIn = (counts) => total(KINDS, ([kind]) => counts[kind])
  const perEditor = (list, pick) => list.length > 0 ? round(total(list, pick) / list.length / seconds / 1000, 3) : null

  // An edit's delay: from its typist sending it until the last of the other
  // editors had it.
  const seen = {}
  for (const report of reports) {
    for (const [token, [count, last]] of Object.entries(report.seen)) {
      const entry = seen[token] || (seen[token] = [0, 0])
      entry[0] += count
      entry[1] = Math.max(entry[1], last)
    }
  }
  const delays = []
  let missing = 0
  for (const [token, sentAt] of reports.flatMap((report) => report.probes)) {
    const entry = seen[token]
    if (entry && entry[0] >= people - 1) delays.push(entry[1] - sentAt)
    else missing += 1
  }

  const edits = {
    sent: total(reports, (report) => report.edits.sent),
    failed: total(reports, (report) => report.edits.failed),
    lost: total(reports, (report) => report.edits.lost),
    unanswered: total(reports, (report) => report.edits.unanswered)
  }
  const dropped = editors.filter((editor) => editor.dropped).length
  const results = {
    host: ready.host,
    editor: mode,
    // Whether the editors came in through tunnels on the local network.
    lan,
    people,
    typing,
    seconds: round(seconds, 2),
    startedAt: startedAt.toISOString(),
    machine: {
      node: process.version,
      os: `${os.platform()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model || '',
      cores: os.availableParallelism(),
      loadAverageAtStart: round(loadAverage, 2)
    },
    peopleConnected: peers,
    edits: { ...edits, perSecond: round(edits.sent / seconds, 1) },
    presence: {
      sent: total(reports, (report) => report.presence.sent),
      failed: total(reports, (report) => report.presence.failed)
    },
    sameText: { same: sameText.differing.length === 0, differing: sameText.differing.length, checkedAfterMs: sameText.afterMs },
    everyEditorSawEditMs: { timed: delays.length, missing, ...dist(delays) },
    dataInPerEditorKBps: {
      all: perEditor(editors, (editor) => bytesIn(editor.window)),
      typing: perEditor(typists, (editor) => bytesIn(editor.window)),
      watching: perEditor(watchers, (editor) => bytesIn(editor.window)),
      byKind: Object.fromEntries(KINDS.map(([kind]) => [kind, perEditor(editors, (editor) => editor.window[kind])]))
    },
    hostOutMBps: round((atEnd.written - atStart.written) / seconds / 1e6, 3),
    hostInMBps: round((atEnd.read - atStart.read) / seconds / 1e6, 3),
    hostCpuPercent: cpuPercent(atStart, atEnd),
    hostCpuPercentFirst5s: cpuPercent(atStart, marks[Math.min(5, marks.length - 1)]),
    hostCpuPercentLast5s: cpuPercent(marks[Math.max(0, marks.length - 6)], atEnd),
    hostMemoryMB: {
      peakRss: round(atEnd.peakRss / 1e6, 1),
      rssBeforeJoining: round(beforeJoining.rss / 1e6, 1),
      heapUsedAtEnd: round(atEnd.heapUsed / 1e6, 1)
    },
    hostEventLoopDelayMs: { p99: round(atEnd.loopP99, 1), max: round(atEnd.loopMax, 1) },
    hostTimeline: timeline,
    roundTripMs: {
      edit: dist(reports.flatMap((report) => report.roundTrips.edit)),
      presence: dist(reports.flatMap((report) => report.roundTrips.presence))
    },
    note: { atStart: noteAtStart, atEnd: noteAtEnd },
    joining: {
      everyMs: options.joinEvery,
      seconds: round(joinMs / 1000, 1),
      hostOutMB: round((atStart.written - beforeJoining.written) / 1e6, 2),
      hostCpuSeconds: round((atStart.cpuMicros - beforeJoining.cpuMicros) / 1e6, 2),
      inPerEditorKB: round(total(editors, (editor) => bytesIn(editor.joining)) / editors.length / 1000, 1),
      // People whose first press of Join failed, and who pressed it again.
      triedAgain: editors.filter((editor) => editor.joinTries > 1).length
    },
    editorProcesses: {
      count: reports.length,
      eventLoopDelayP99Ms: round(Math.max(...reports.map((report) => report.loop.p99)), 1)
    },
    streamsDropped: dropped,
    updatesNotApplied: total(reports, (report) => report.applyErrors)
  }
  results.ok = results.sameText.same && missing === 0 && dropped === 0 && edits.lost === 0 && edits.unanswered === 0 && peers === people
  return results
}

function formatResults (r) {
  const kb = (bytes) => (bytes / 1000).toFixed(1)
  const fixed = (value, digits) => value === null ? '-' : value.toFixed(digits)
  const delays = r.everyEditorSawEditMs
  const data = r.dataInPerEditorKBps
  const memory = r.hostMemoryMB

  let editsText = `${r.edits.sent.toLocaleString('en-US')} (${r.edits.perSecond} a second), `
  editsText += r.edits.failed === 0 ? 'none failed' : `${r.edits.failed} failed and went again with the next one`
  if (r.edits.lost > 0) editsText += `, ${r.edits.lost} never got through`
  if (r.edits.unanswered > 0) editsText += `, ${r.edits.unanswered} still unanswered 30 s after typing stopped`
  let delayText = delays.timed > 0 ? `p50 ${delays.p50} ms, p95 ${delays.p95} ms, max ${delays.max} ms` : 'none timed'
  if (delays.missing > 0) delayText += `, and ${delays.missing} of ${delays.timed + delays.missing} never reached everyone`
  const split = r.typing < r.people ? ` (typing ${fixed(data.typing, 1)}, watching ${fixed(data.watching, 1)})` : ''

  const rows = [
    ['People connected', r.peopleConnected === r.people ? String(r.people) : `${r.peopleConnected} of ${r.people}`],
    ['Typing', String(r.typing)],
    ...(r.joining.triedAgain > 0 ? [['Joins that needed another try', `${r.joining.triedAgain} of ${r.people}`]] : []),
    ['Edits sent', editsText],
    ['Every editor ended with the host\'s text', r.sameText.same ? 'yes' : `no, ${r.sameText.differing} of ${r.people} differ`],
    ['Time until every editor saw an edit', delayText],
    ['Data in per editor', `${fixed(data.all, 1)} KB/s${split}`],
    ['Out from the host', `${fixed(r.hostOutMBps, 2)} MB/s`],
    ['Host CPU and memory', `${Math.round(r.hostCpuPercent)}% of one core, up to ${Math.round(memory.peakRss)} MB RSS while typing (${Math.round(memory.rssBeforeJoining)} MB before anyone joined)`],
    ['Note on the host', `${kb(r.note.atEnd.textBytes)} KB of text, ${kb(r.note.atEnd.stateBytes)} KB of Yjs state (${kb(r.note.atStart.textBytes)} and ${kb(r.note.atStart.stateBytes)} KB at the start)`]
  ]
  const kinds = KINDS
    .filter(([kind]) => data.byKind[kind] > 0)
    .sort(([a], [b]) => data.byKind[b] - data.byKind[a])
    .map(([kind, label]) => [label, fixed(data.byKind[kind], 2)])

  const lines = [
    `P2PMD load test: ${r.host} host, ${r.editor} editors, ${r.seconds} s of typing${r.lan ? ', over the local network' : ''}`,
    '',
    '| Measure | Result |',
    '|---|---|',
    ...rows.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    '| Data in per editor, by kind | KB/s |',
    '|---|---|',
    ...kinds.map(([label, value]) => `| ${label} | ${value} |`)
  ]
  const notes = []
  const first = r.hostCpuPercentFirst5s
  const last = r.hostCpuPercentLast5s
  if (r.seconds >= 10 && last > first * 1.5 && last - first >= 5) {
    notes.push(`The host's CPU grew while people typed: ${Math.round(first)}% of one core in the first 5 s, ${Math.round(last)}% in the last 5 s.`)
  }
  if (r.editorProcesses.eventLoopDelayP99Ms > 50) notes.push(`The editor processes ran up to ${r.editorProcesses.eventLoopDelayP99Ms} ms late (p99), and the times above include that.`)
  if (r.hostEventLoopDelayMs.p99 > 100) notes.push(`The host's event loop ran ${r.hostEventLoopDelayMs.p99} ms late (p99): it was falling behind.`)
  if (r.streamsDropped > 0) notes.push(`${r.streamsDropped} editors lost their event stream from the host.`)
  if (r.updatesNotApplied > 0) notes.push(`${r.updatesNotApplied} updates from the host could not be applied.`)
  if (notes.length > 0) lines.push('', ...notes)
  return lines.join('\n')
}

async function waitForSameText (url, groups) {
  const stoppedAt = Date.now()
  for (;;) {
    const { content } = await get(url, '/doc')
    const hash = sha1(content)
    const replies = await Promise.all(groups.map(({ child }) => ask(child, { type: 'check', hash })))
    const differing = replies.flatMap((reply) => reply.differing)
    const afterMs = Date.now() - stoppedAt
    if (differing.length === 0 || afterMs > SAME_TEXT_WAIT_MS) return { differing, afterMs }
    await sleep(200)
  }
}

async function measureNote (url) {
  const { content } = await get(url, '/doc')
  const { yjsState } = await get(url, '/doc/yjsstate')
  return { textBytes: Buffer.byteLength(content), stateBytes: Buffer.from(yjsState || '', 'base64').length }
}

// A team's running notes, with a line for each typist to type on. Three people
// wrote the rest of it earlier, and like any note written in P2PMD it records
// who wrote each line. The phone host keeps those authors in the note, and the
// phone editor sends every author it knows of with each edit.
function buildNote (typistNames) {
  const writers = [
    { clientId: 'earlier-writer-1', color: '#3D7BE0', name: 'Alex' },
    { clientId: 'earlier-writer-2', color: '#E0533D', name: 'Sam' },
    { clientId: 'earlier-writer-3', color: '#2E9E4F', name: 'Kim' }
  ]
  const writtenAt = Date.now() - 3600 * 1000
  const lines = []
  const lineAttributions = {}
  const write = (writer, ...text) => {
    for (const line of text) {
      lines.push(line)
      if (writer) lineAttributions[lines.length] = { ...writer, updatedAt: writtenAt }
    }
  }

  write(writers[0], '# Team notes', '', 'Notes from the weekly call, written by whoever is in it.', '')
  for (let topic = 1; topic <= 6; topic += 1) {
    const writer = writers[Math.floor((topic - 1) / 2)]
    write(writer, `## Topic ${topic}`, '')
    for (let point = 1; point <= 6; point += 1) {
      write(writer, `- point ${topic}.${point}: what was said, who follows it up and by when`)
    }
    write(writer, '')
  }
  write(writers[0], '## Live notes', '')
  for (const name of typistNames) write(null, `- ${name}: `)
  write(writers[0], '', '## Next call', '', '- same time next week')
  return { content: lines.join('\n'), lineAttributions }
}

// Spread through the room, so every editor process has some.
function pickTypists (typing, people) {
  return new Set(range(0, typing).map((n) => Math.floor(n * people / typing)))
}

function start (file, label, env = {}) {
  // Their output goes to stderr, leaving stdout to the results.
  const child = fork(path.join(HERE, file), [], { env: { ...process.env, ...env }, stdio: ['ignore', 2, 2, 'ipc'] })
  child.label = label
  children.add(child)
  child.once('exit', () => children.delete(child))
  return child
}

function firstMessage (child, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return
      done()
      resolve(message)
    }
    const onExit = (code, signal) => {
      done()
      reject(new Error(`${child.label} stopped before it was ready (${signal || `exit ${code}`})`))
    }
    function done () {
      child.off('message', onMessage)
      child.off('exit', onExit)
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
}

function ask (child, message) {
  const id = ++lastId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`${child.label} did not answer "${message.type}"`)), ASK_TIMEOUT_MS)
    const onMessage = (reply) => {
      if (reply?.id === id) finish(reply.error ? new Error(`${child.label}: ${reply.error}`) : null, reply)
    }
    const onExit = (code, signal) => finish(new Error(`${child.label} stopped (${signal || `exit ${code}`})`))
    function finish (error, reply) {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(reply)
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
    child.send({ ...message, id })
  })
}

// Children exit when their channel closes. Any that do not are killed.
async function stopChildren () {
  const running = [...children]
  const exited = running.map((child) => new Promise((resolve) => child.once('exit', resolve)))
  for (const child of running) {
    if (child.connected) child.disconnect()
  }
  const timer = setTimeout(() => {
    for (const child of running) child.kill('SIGKILL')
  }, 5000)
  await Promise.all(exited)
  clearTimeout(timer)
}

async function get (url, route) {
  const response = await fetch(`${url}${route}`)
  if (!response.ok) throw new Error(`GET ${route} answered ${response.status}`)
  return response.json()
}

async function post (url, route, body) {
  const response = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`POST ${route} answered ${response.status}`)
  return response.json()
}

function readOptions () {
  let values
  try {
    ({ values } = parseArgs({
      options: {
        people: { type: 'string', default: '100' },
        typing: { type: 'string', default: '10' },
        seconds: { type: 'string', default: '60' },
        editor: { type: 'string', default: 'desktop' },
        lan: { type: 'boolean', default: false },
        'join-every': { type: 'string', default: String(JOIN_GAP_MS) },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    }))
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`)
    process.exit(2)
  }
  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }
  const people = Number(values.people)
  const typing = Number(values.typing)
  const seconds = Number(values.seconds)
  const joinEvery = Number(values['join-every'])
  const problems = []
  if (!Number.isInteger(people) || people < 2) problems.push('--people must be a whole number, 2 or more.')
  if (!Number.isInteger(typing) || typing < 1 || typing > people) problems.push('--typing must be a whole number from 1 to --people.')
  if (!(seconds > 0)) problems.push('--seconds must be more than 0.')
  if (!Number.isInteger(joinEvery) || joinEvery < 0) problems.push('--join-every must be a whole number of milliseconds.')
  if (!['desktop', 'phone'].includes(values.editor)) problems.push('--editor must be desktop or phone.')
  if (problems.length > 0) {
    console.error(`${problems.join('\n')}\n\n${USAGE}`)
    process.exit(2)
  }
  return { people, typing, seconds, editor: values.editor, lan: values.lan, joinEvery, out: values.out ? path.resolve(values.out) : null }
}

function dist (values) {
  if (values.length === 0) return { p50: null, p95: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]
  return { p50: round(at(50), 1), p95: round(at(95), 1), max: round(sorted[sorted.length - 1], 1) }
}

function round (value, digits) {
  if (value === null || !Number.isFinite(value)) return null
  return Math.round(value * 10 ** digits) / 10 ** digits
}

function range (from, to) {
  return Array.from({ length: to - from }, (_, n) => from + n)
}

function sha1 (text) {
  return createHash('sha1').update(text).digest('hex')
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function status (message) {
  console.error(message)
}
