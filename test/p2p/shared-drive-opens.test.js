import { expect } from 'chai'
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { mkdtempSync, rmSync } from 'fs'
import z32 from 'z32'
import { create } from 'hyper-sdk'
import Hyperdrive from 'hyperdrive'
import { driveOpenId, shareDriveOpens } from '../../src/protocols/shared-drive-opens.js'

describe('opens of one drive at the same time', () => {
  it('names one drive the same way by address, hostname, key or bytes', () => {
    const key = crypto.randomBytes(32)
    const hex = key.toString('hex')
    expect(driveOpenId(`hyper://${z32.encode(key)}/`)).to.equal(hex)
    expect(driveOpenId(`hyper://${hex}/app-icon.png`)).to.equal(hex)
    expect(driveOpenId(z32.encode(key))).to.equal(hex)
    expect(driveOpenId(hex.toUpperCase())).to.equal(hex)
    expect(driveOpenId(key)).to.equal(hex)
    // A drive's name keeps its case: two names are two drives. And a drive
    // named like a domain is not the drive that domain points to.
    expect(driveOpenId('Notes')).to.equal('name:Notes')
    expect(driveOpenId('notes')).to.equal('name:notes')
    expect(driveOpenId('hyper://example.com/')).to.equal('host:example.com')
    expect(driveOpenId('example.com')).to.equal('name:example.com')
    expect(driveOpenId('https://example.com/')).to.equal(null)
    expect(driveOpenId('')).to.equal(null)
  })

  // Three reads of a drive not opened yet, as a page's files arrive. Without
  // this the second and third each opened the drive again, and waited for the
  // first open to close, which it never does.
  it('shares one open between reads that arrive together', async function () {
    const root = mkdtempSync(path.join(os.tmpdir(), 'peersky-opens-'))
    const swarmOpts = { bootstrap: [], port: 0 }
    const phone = await create({ storage: path.join(root, 'phone'), swarmOpts, autoJoin: false })
    const desktop = shareDriveOpens(await create({ storage: path.join(root, 'desktop'), swarmOpts, autoJoin: false }))
    const left = phone.corestore.replicate(true)
    const right = desktop.corestore.replicate(false)
    left.pipe(right).pipe(left)
    try {
      const made = new Hyperdrive(phone.corestore.namespace('site'))
      await made.ready()
      await made.put('/index.html', Buffer.from('<h1>hello</h1>'))

      const address = `hyper://${z32.encode(made.key)}/`
      let timer = null
      const drives = await Promise.race([
        Promise.all([
          desktop.getDrive(address),
          desktop.getDrive(made.key.toString('hex')),
          desktop.getDrive(address)
        ]),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 5000) })
      ])
      clearTimeout(timer)
      expect(drives, 'every read got its drive').to.not.equal(null)
      expect(drives[1]).to.equal(drives[0])
      expect(drives[2]).to.equal(drives[0])
      // And once open, it is the one kept for later reads.
      expect(await desktop.getDrive(address)).to.equal(drives[0])
    } finally {
      left.destroy()
      right.destroy()
      await Promise.allSettled([phone.close(), desktop.close()])
      // Windows can hold a closed store's files a moment longer.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  // Someone's private drive, read without its key. Its first block is here
  // and does not decode, so opening it fails, and the drive that failed keeps
  // its core: every later open of it used to wait forever.
  it('fails a later open of a drive that did not decode at once, rather than never', async function () {
    const root = mkdtempSync(path.join(os.tmpdir(), 'peersky-opens-'))
    const swarmOpts = { bootstrap: [], port: 0 }
    const phone = await create({ storage: path.join(root, 'phone'), swarmOpts, autoJoin: false })
    const desktop = shareDriveOpens(await create({ storage: path.join(root, 'desktop'), swarmOpts, autoJoin: false }))
    const left = phone.corestore.replicate(true)
    const right = desktop.corestore.replicate(false)
    left.pipe(right).pipe(left)
    try {
      // To a device without its key, such a drive starts with a block that is
      // not a drive's header. A real encrypted block is random bytes, which
      // now and then read as a header after all, so this one never can.
      const made = phone.corestore.get({ name: 'private-drive' })
      await made.ready()
      await made.append(Buffer.from([0x07, 0x07]))
      // Held open, so the block it fetched is the one the drive opens with, and
      // brought up to date first, so the store knows how long the drive is.
      const core = desktop.corestore.get({ key: made.key })
      await core.update({ wait: true })
      await core.get(0, { timeout: 5000 })

      const address = `hyper://${z32.encode(made.key)}/`
      const open = () => Promise.race([
        desktop.getDrive(address).then(() => 'opened', (error) => error.code),
        new Promise((resolve) => setTimeout(() => resolve('waited'), 3000))
      ])
      expect(await open()).to.equal('DECODING_ERROR')
      expect(await open()).to.equal('DECODING_ERROR')
    } finally {
      left.destroy()
      right.destroy()
      await Promise.allSettled([phone.close(), desktop.close()])
      // Windows can hold a closed store's files a moment longer.
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })
})
