/**
 * Cost of serving the browser's own pages.
 *
 * Every internal page pulls a dozen bundled assets over peersky:// and
 * browser://. Each request used to walk up to four candidate paths to resolve
 * the file, then stream the whole thing back with `no-store` and an ETag
 * stamped from Date.now() — a validator that can never match, so nothing was
 * ever reused and every window and every internal page re-read the shell's
 * ~90KB of CSS and its webfont from disk.
 *
 * Resolutions are now remembered and responses carry a validator derived from
 * the file, so a repeat load answers 304.
 */

import { expect } from 'chai'
import sinon from 'sinon'
import os from 'os'
import path from 'path'
import { mkdtemp, writeFile, rm, utimes } from 'fs/promises'
import ScopedFS from 'scoped-fs'

import {
  resolveFileCached,
  respondWithFile,
  fileETag,
  isFresh,
  statFile
} from '../../src/protocols/static-file.js'
import { createHandler as createThemeHandler } from '../../src/protocols/theme-handler.js'

const CHECK_PATHS = [
  (p) => p,
  (p) => p + '/index.html',
  (p) => p + '.html'
]

/** Wraps a ScopedFS so stat calls can be counted. */
function countingFs (scopedFs, counter) {
  return {
    stat (filePath, cb) {
      counter.stats++
      return scopedFs.stat(filePath, cb)
    },
    createReadStream (filePath) {
      counter.reads++
      return scopedFs.createReadStream(filePath)
    }
  }
}

describe('Internal assets are resolved once and revalidated', function () {
  let dir
  let scopedFs

  beforeEach(async function () {
    dir = await mkdtemp(path.join(os.tmpdir(), 'peersky-perf-assets-'))
    await writeFile(path.join(dir, 'style.css'), 'body { color: red }')
    await writeFile(path.join(dir, 'page.html'), '<h1>page</h1>')
    scopedFs = new ScopedFS(dir)
  })

  afterEach(async function () {
    sinon.restore()
    await rm(dir, { recursive: true, force: true })
  })

  it('stats candidate paths once per asset, not once per request', async function () {
    const counter = { stats: 0, reads: 0 }
    const fs = countingFs(scopedFs, counter)
    const cache = new Map()

    // 'page' only resolves on the third candidate, so a cold miss costs three stats.
    await resolveFileCached({ scopedFs: fs, filePath: 'page', candidates: CHECK_PATHS, cache })
    const coldStats = counter.stats
    expect(coldStats).to.equal(3)

    for (let i = 0; i < 20; i++) {
      await resolveFileCached({ scopedFs: fs, filePath: 'page', candidates: CHECK_PATHS, cache })
    }

    // One stat each to confirm the remembered path still exists.
    expect(counter.stats - coldStats, '20 repeat loads re-walked the candidate list').to.equal(20)
  })

  it('forgets a resolution when the file goes away, so a rename is not cached forever', async function () {
    const cache = new Map()
    await resolveFileCached({ scopedFs, filePath: 'style.css', candidates: CHECK_PATHS, cache })
    expect(cache.get('style.css')).to.equal('style.css')

    await rm(path.join(dir, 'style.css'))

    let threw = false
    try {
      await resolveFileCached({ scopedFs, filePath: 'style.css', candidates: CHECK_PATHS, cache })
    } catch (error) {
      threw = true
      expect(error.code).to.equal('ENOENT')
    }
    expect(threw).to.equal(true)
    expect(cache.has('style.css'), 'a stale resolution stayed in the cache').to.equal(false)
  })

  it('gives the same asset the same validator across requests', async function () {
    const stat = await statFile(scopedFs, 'style.css')
    expect(fileETag(stat)).to.equal(fileETag(await statFile(scopedFs, 'style.css')))
  })

  it('changes the validator when the file changes', async function () {
    const before = fileETag(await statFile(scopedFs, 'style.css'))

    await writeFile(path.join(dir, 'style.css'), 'body { color: blue; font-size: 2em }')
    const afterEdit = fileETag(await statFile(scopedFs, 'style.css'))
    expect(afterEdit, 'an edit must invalidate the cached copy').to.not.equal(before)

    // Same length, different mtime: the validator must still move.
    const sameLength = 'body { color: teal; font-size: 2em }'
    await writeFile(path.join(dir, 'style.css'), sameLength)
    const future = new Date(Date.now() + 60_000)
    await utimes(path.join(dir, 'style.css'), future, future)
    expect(fileETag(await statFile(scopedFs, 'style.css'))).to.not.equal(afterEdit)
  })

  it('answers a conditional request with 304 and no file read', async function () {
    const counter = { stats: 0, reads: 0 }
    const fs = countingFs(scopedFs, counter)
    const stat = await statFile(scopedFs, 'style.css')
    const etag = fileETag(stat)

    const fresh = respondWithFile({
      scopedFs: fs,
      resolvedPath: 'style.css',
      stat,
      request: new Request('http://x/style.css', { headers: { 'If-None-Match': etag } })
    })

    expect(fresh.status).to.equal(304)
    expect(await fresh.text()).to.equal('')
    expect(counter.reads, 'a 304 still read the file off disk').to.equal(0)
  })

  it('sends the body when the client holds a different version', async function () {
    const stat = await statFile(scopedFs, 'style.css')

    const response = respondWithFile({
      scopedFs,
      resolvedPath: 'style.css',
      stat,
      request: new Request('http://x/style.css', { headers: { 'If-None-Match': '"stale"' } })
    })

    expect(response.status).to.equal(200)
    expect(await response.text()).to.equal('body { color: red }')
    expect(response.headers.get('etag')).to.equal(fileETag(stat))
  })

  it('matches a weakened validator and a multi-tag list', function () {
    const etag = '"abc-123"'
    expect(isFresh({ headers: { 'if-none-match': `W/${etag}` } }, etag)).to.equal(true)
    expect(isFresh({ headers: { 'If-None-Match': `"other", ${etag}` } }, etag)).to.equal(true)
    expect(isFresh({ headers: { 'if-none-match': '"other"' } }, etag)).to.equal(false)
    expect(isFresh({ headers: {} }, etag)).to.equal(false)
    expect(isFresh({}, etag)).to.equal(false)
  })
})

describe('browser://theme responses are cacheable', function () {
  let handler

  before(async function () {
    handler = await createThemeHandler()
  })

  it('serves the shell stylesheet with a stable validator', async function () {
    const first = await handler(new Request('browser://theme/index.css'))
    const second = await handler(new Request('browser://theme/index.css'))

    expect(first.status).to.equal(200)
    const etag = first.headers.get('etag')
    expect(etag, 'no validator to revalidate against').to.be.a('string')
    expect(second.headers.get('etag'), 'the validator changed between two identical requests')
      .to.equal(etag)
    expect(etag).to.not.match(/theme-\d{13}/)
  })

  it('does not tell the client to throw the response away', async function () {
    const response = await handler(new Request('browser://theme/index.css'))
    const cacheControl = response.headers.get('cache-control') || ''

    expect(cacheControl, 'no-store means the stylesheet is re-read on every page')
      .to.not.match(/no-store/)
  })

  it('answers 304 for a stylesheet the window already has', async function () {
    const first = await handler(new Request('browser://theme/index.css'))
    const etag = first.headers.get('etag')

    const second = await handler(
      new Request('browser://theme/index.css', { headers: { 'If-None-Match': etag } })
    )

    expect(second.status).to.equal(304)
    expect(await second.text()).to.equal('')
  })

  it('keeps serving themes.css for vars.css', async function () {
    const response = await handler(new Request('browser://theme/vars.css'))
    expect(response.status).to.equal(200)
    const body = await response.text()
    expect(body).to.include('[data-theme="light"]')
  })

  it('still 404s an unknown theme file', async function () {
    const response = await handler(new Request('browser://theme/nope.css'))
    expect(response.status).to.equal(404)
  })
})
