import { expect } from 'chai'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

import {
  _hyperFetchToFile,
  describeDownload,
  NOBODY_SHARING,
  NOT_ANSWERING,
  STOPPED_SENDING
} from '../../src/backup/hyper-backup.js'
import { _ipfsFetchToFile } from '../../src/backup/ipfs-backup.js'
import { DISK_FULL, KEEP_FREE_BYTES, SENT_TOO_MUCH, tooBigFor } from '../../src/backup/download-limit.js'

// Downloading a backup or a transfer from another device. The other device
// can go quiet part way, as a phone does when its screen locks, and the
// download has to say so and look for it again instead of sitting still.
describe('downloading from another device', function () {
  let dir
  beforeEach(function () { dir = mkdtempSync(path.join(tmpdir(), 'peersky-hyper-download-')) })
  afterEach(function () { rmSync(dir, { recursive: true, force: true }) })

  const ready = async () => {}

  // A response whose body sends the chunks it is given, then waits until
  // released, the way a stream from a device that went quiet does.
  function quietResponse (chunks, total) {
    let release
    const released = new Promise((resolve) => { release = resolve })
    const body = new ReadableStream({
      async pull (controller) {
        const next = chunks.shift()
        if (next) {
          controller.enqueue(next)
          return
        }
        await released
        controller.close()
      }
    })
    const response = new Response(body, { headers: total ? { 'content-length': String(total) } : {} })
    return { response, release }
  }

  it('saves the file and says how much has come', async function () {
    const messages = []
    const dest = path.join(dir, 'out.zip')
    const data = new Uint8Array(3 * 1024 * 1024).fill(7)
    await _hyperFetchToFile(
      async () => new Response(data, { headers: { 'content-length': String(data.length) } }),
      ready,
      'hyper://abc/backup.zip',
      dest,
      (message) => messages.push(message)
    )
    expect(readFileSync(dest).length).to.equal(data.length)
    expect(messages[0]).to.equal('Downloading: 0.0 of 3.0 MB')
  })

  it('looks for the other device again when the download goes quiet, and carries on when it comes back', async function () {
    const messages = []
    let lookedAgain = 0
    const { response, release } = quietResponse([new Uint8Array(1024)], 2048)
    const done = _hyperFetchToFile(async () => response, ready, 'hyper://abc/backup.zip', path.join(dir, 'out.zip'),
      (message) => messages.push(message),
      { lookAgain: async () => { lookedAgain++ }, stallMs: 40, giveUpMs: 5000, tickMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(lookedAgain).to.be.greaterThan(0)
    expect(messages).to.include('Waiting for the other device. Keep PeerSky open on it, with its screen on.')
    release()
    await done
  })

  it('gives up with a plain message when the other device stays quiet', async function () {
    const { response } = quietResponse([new Uint8Array(1024)], 4096)
    let failure = null
    await _hyperFetchToFile(async () => response, ready, 'hyper://abc/backup.zip', path.join(dir, 'out.zip'), null,
      { stallMs: 20, giveUpMs: 80, tickMs: 10 }).catch((error) => { failure = error })
    expect(failure?.message).to.equal(STOPPED_SENDING)
  })

  it('looks again for a device that was found but does not answer, and gives up in the end', async function () {
    let lookedAgain = 0
    let failure = null
    await _hyperFetchToFile(() => new Promise(() => {}), ready, 'hyper://abc/backup.zip', path.join(dir, 'out.zip'), null,
      { lookAgain: async () => { lookedAgain++ }, stallMs: 20, giveUpMs: 100, tickMs: 10 }).catch((error) => { failure = error })
    expect(lookedAgain).to.be.greaterThan(0)
    expect(failure?.message).to.equal(NOT_ANSWERING)
  })

  it('carries on when a device that did not answer comes back', async function () {
    const dest = path.join(dir, 'out.zip')
    let answer
    const answered = new Promise((resolve) => { answer = resolve })
    const done = _hyperFetchToFile(() => answered, ready, 'hyper://abc/backup.zip', dest, null,
      { lookAgain: async () => answer(new Response(new Uint8Array(10).fill(1))), stallMs: 20, giveUpMs: 5000, tickMs: 10 })
    await done
    expect(readFileSync(dest).length).to.equal(10)
  })

  it('says nobody is sharing it when no device has the file', async function () {
    const messages = []
    let failure = null
    await _hyperFetchToFile(async () => new Response('Not Found', { status: 404 }), ready, 'hyper://abc/backup.zip',
      path.join(dir, 'out.zip'), (message) => messages.push(message), { retryDelayMs: 1 }).catch((error) => { failure = error })
    expect(failure?.message).to.equal(NOBODY_SHARING)
    expect(messages[0]).to.equal('Looking for the device that sent it (try 2 of 5)...')
  })

  // A link pasted into Link Device can lead anywhere.
  describe('from a device that will not stop', function () {
    const fails = (promise) => promise.then(() => null, (error) => error)

    it('stops a download that sends more than it said, and leaves no file behind', async function () {
      const dest = path.join(dir, 'out.zip')
      const failure = await fails(_hyperFetchToFile(
        async () => new Response(new Uint8Array(256 * 1024), { headers: { 'content-length': '10' } }),
        ready, 'hyper://abc/backup.zip', dest, null))
      expect(failure?.message).to.equal(SENT_TOO_MUCH)
      expect(existsSync(dest)).to.equal(false)
    })

    it('refuses one bigger than the free space before writing any of it', async function () {
      const dest = path.join(dir, 'out.zip')
      let fetched = false
      const failure = await fails(_hyperFetchToFile(
        async () => { fetched = true; return new Response(new Uint8Array(1000), { headers: { 'content-length': '1000' } }) },
        ready, 'hyper://abc/backup.zip', dest, null, { freeBytes: async () => KEEP_FREE_BYTES + 100 }))
      expect(fetched).to.equal(true)
      expect(failure?.message).to.equal(tooBigFor(1000))
      expect(existsSync(dest)).to.equal(false)
    })

    it('stops one that says no size before it fills the disk', async function () {
      const dest = path.join(dir, 'out.zip')
      const failure = await fails(_hyperFetchToFile(
        async () => new Response(new Uint8Array(256 * 1024)),
        ready, 'hyper://abc/backup.zip', dest, null, { freeBytes: async () => KEEP_FREE_BYTES + 1000 }))
      expect(failure?.message).to.equal(DISK_FULL)
      expect(existsSync(dest)).to.equal(false)
    })

    it('gives up on one that sends a byte now and then, as if it had stopped', async function () {
      let sent = 0
      const body = new ReadableStream({
        async pull (controller) {
          await new Promise((resolve) => setTimeout(resolve, 5))
          if (sent++ < 400) controller.enqueue(new Uint8Array(1))
          else controller.close()
        }
      })
      const dest = path.join(dir, 'out.zip')
      const failure = await fails(_hyperFetchToFile(async () => new Response(body), ready, 'hyper://abc/backup.zip', dest, null,
        { stallMs: 40, giveUpMs: 150, tickMs: 10 }))
      expect(failure?.message).to.equal(STOPPED_SENDING)
      expect(existsSync(dest)).to.equal(false)
    })

    it('gives an IPFS address no more than the free space either', async function () {
      const cid = CID.create(1, 0x55, await sha256.digest(new Uint8Array([1]))).toString()
      const unixFs = { async * cat () { for (let i = 0; i < 8; i++) yield new Uint8Array(64 * 1024) } }
      const dest = path.join(dir, 'out.zip')
      const failure = await fails(_ipfsFetchToFile(unixFs, cid, dest, null, { freeBytes: async () => KEEP_FREE_BYTES + 1000 }))
      expect(failure?.message).to.equal(DISK_FULL)
      expect(existsSync(dest)).to.equal(false)
    })
  })

  it('writes sizes a person can read', function () {
    expect(describeDownload(0, 0)).to.equal('Downloading...')
    expect(describeDownload(1.5 * 1024 * 1024, 0)).to.equal('Downloading: 1.5 MB')
    expect(describeDownload(12 * 1024 * 1024, 400 * 1024 * 1024)).to.equal('Downloading: 12 of 400 MB')
  })
})
