// The desktop's P2PMD host for the load test: the real src/protocols/hs-handler.js
// under plain Node, the way test/p2p/hs-handler.test.js runs it. hooks.mjs swaps
// electron and holesail for stubs, so nothing starts Electron or Holesail, and
// every app data path is the run's temp folder. The note is made with
// hs://p2pmd?action=create, as the P2PMD page does, and its server binds
// 127.0.0.1. run.mjs starts this process and asks it for measurements.
import dc from 'node:diagnostics_channel'
import { register } from 'node:module'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const LOOP_EVERY_MS = 10

register('./hooks.mjs', import.meta.url)
const { createHandler } = await import('../../../src/protocols/hs-handler.js')

const meter = createMeter()
const handler = await createHandler()
const room = await protocol('create', { secure: false, udp: false })
if (!room.localUrl) throw new Error(`hs://p2pmd?action=create answered ${JSON.stringify(room)}`)

answer({
  sample: ({ reset }) => meter.sample(reset),
  async close () {
    await protocol('close', {})
    return {}
  }
})
process.send({ type: 'ready', url: room.localUrl, host: 'desktop' })

// A request to the hs://p2pmd protocol, as the P2PMD page makes it.
async function protocol (action, body) {
  const response = await handler(new Request(`hs://p2pmd?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }))
  return response.json()
}

// What the host process does: bytes on every connection it accepts, CPU time,
// memory, and how late its event loop runs.
function createMeter () {
  const open = new Set()
  const closed = { read: 0, written: 0 }
  dc.subscribe('net.server.socket', ({ socket }) => {
    open.add(socket)
    socket.once('close', () => {
      open.delete(socket)
      closed.read += socket.bytesRead
      closed.written += socket.bytesWritten
    })
  })
  const loop = monitorEventLoopDelay({ resolution: LOOP_EVERY_MS })
  loop.enable()
  let peakRss = 0
  const watchMemory = () => { peakRss = Math.max(peakRss, process.memoryUsage.rss()) }
  setInterval(watchMemory, 250).unref()

  // Totals so far, and the peaks since the last reset.
  return {
    sample (reset) {
      watchMemory()
      let read = closed.read
      let written = closed.written
      for (const socket of open) {
        read += socket.bytesRead
        written += socket.bytesWritten
      }
      const cpu = process.cpuUsage()
      const memory = process.memoryUsage()
      const result = {
        at: performance.timeOrigin + performance.now(),
        cpuMicros: cpu.user + cpu.system,
        read,
        written,
        rss: memory.rss,
        peakRss,
        heapUsed: memory.heapUsed,
        loopP99: lateness(loop.percentile(99)),
        loopMax: lateness(loop.max)
      }
      if (reset) {
        peakRss = memory.rss
        loop.reset()
      }
      return result
    }
  }
}

// How late the event loop ran: the histogram counts the sampling interval too.
function lateness (nanoseconds) {
  return Math.max(0, nanoseconds / 1e6 - LOOP_EVERY_MS)
}

function answer (handlers) {
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
}
