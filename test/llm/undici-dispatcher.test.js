import { expect } from 'chai'
import { readFile } from 'fs/promises'
import http from 'http'
import { Agent, fetch as undiciFetch } from 'undici'

function startServer (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve))
      })
    })
  })
}

describe('LLM undici dispatcher compatibility', function () {
  let ctx

  beforeEach(async function () {
    ctx = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })

  afterEach(async function () {
    if (ctx) await ctx.close()
    ctx = null
  })

  it("accepts an undici Agent when paired with undici's own fetch", async function () {
    const res = await undiciFetch(ctx.origin, {
      dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0 })
    })

    expect(res.status).to.equal(200)
    expect(await res.json()).to.deep.equal({ ok: true })
  })

  it('rejects an undici Agent passed to the global fetch when majors differ', async function () {
    const installed = JSON.parse(
      await readFile('node_modules/undici/package.json', 'utf8')
    ).version
    const internal = process.versions.undici
    if (!internal || internal.split('.')[0] === installed.split('.')[0]) this.skip()

    try {
      await fetch(ctx.origin, { dispatcher: new Agent({ headersTimeout: 0 }) })
      throw new Error('expected the mismatched dispatcher to be rejected')
    } catch (error) {
      expect(error.message).to.equal('fetch failed')
      expect(error.cause?.code).to.equal('UND_ERR_INVALID_ARG')
    }
  })

  it('never hands a dispatcher to the global fetch in src/llm.js', async function () {
    const src = await readFile('src/llm.js', 'utf8')
    const calls = [...src.matchAll(/([\w$]*[Ff]etch)\s*\(/g)]
    const hits = [...src.matchAll(/dispatcher\s*:/g)]
    expect(hits.length).to.be.greaterThan(0)

    for (const hit of hits) {
      const enclosing = calls.filter((call) => call.index < hit.index).pop()
      expect(enclosing, `no fetch call precedes dispatcher at ${hit.index}`).to.not.equal(undefined)
      expect(enclosing[1]).to.equal('undiciFetch')
    }
  })

  it('declares undici as a direct dependency', async function () {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'))
    expect(pkg.dependencies).to.have.property('undici')
  })
})
