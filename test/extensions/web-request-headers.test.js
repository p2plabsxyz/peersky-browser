/**
 * Extensions get webRequest headers the way Chrome gives them (patches/
 * @p2plabs+peersky-chrome-extensions+1.3.2.patch).
 *
 * Chrome hands listeners requestHeaders and responseHeaders as [{ name, value }]
 * and takes changes back the same way. The extension host passed Electron's
 * { name: value | [values] } instead, so a listener that looked a header up
 * threw (Browsec's details.responseHeaders.find), and Browsec never turned its
 * VPN on. These run the host's own code, taken from its build as patched.
 */

import { expect } from 'chai'
import { readFile } from 'fs/promises'

const builds = {
  esm: await readFile(new URL('../../node_modules/@p2plabs/peersky-chrome-extensions/dist/esm/index.mjs', import.meta.url), 'utf8'),
  cjs: await readFile(new URL('../../node_modules/@p2plabs/peersky-chrome-extensions/dist/cjs/index.js', import.meta.url), 'utf8')
}

function slice (source, start, end) {
  const from = source.indexOf(start)
  expect(from, start).to.be.greaterThan(-1)
  const to = source.indexOf(end, from)
  expect(to, end).to.be.greaterThan(from)
  return source.slice(from, to)
}

// The two helpers, and the host's own merge methods turned into functions.
function load (source) {
  const helpers = slice(source, 'function toChromeHeaders(', '// src/browser/api/proxy.ts')
  const method = (name) => 'function ' + slice(source, `  ${name}(original, results) {`, '\n  }\n').trim() + '\n}'
  // eslint-disable-next-line no-new-func
  return new Function('Buffer', `${helpers}\n${method('mergeRequestHeaders')}\n${method('mergeResponseHeaders')}\nreturn { toChromeHeaders, fromChromeHeaders, mergeRequestHeaders, mergeResponseHeaders }`)(Buffer)
}

for (const [name, source] of Object.entries(builds)) {
  describe(`webRequest headers for extensions (${name} build)`, () => {
    const host = load(source)

    it('hands listeners headers as Chrome does', () => {
      expect(host.toChromeHeaders({ 'Content-Type': ['text/html'], 'Set-Cookie': ['a=1', 'b=2'] })).to.deep.equal([
        { name: 'Content-Type', value: 'text/html' },
        { name: 'Set-Cookie', value: 'a=1' },
        { name: 'Set-Cookie', value: 'b=2' }
      ])
      expect(host.toChromeHeaders({ 'User-Agent': 'PeerSky', 'X-Count': 2 })).to.deep.equal([
        { name: 'User-Agent', value: 'PeerSky' },
        { name: 'X-Count', value: '2' }
      ])
      const list = [{ name: 'A', value: '1' }]
      expect(host.toChromeHeaders(list)).to.equal(list)
      expect(host.toChromeHeaders(undefined)).to.equal(undefined)
      // What Browsec does with them.
      expect(host.toChromeHeaders({ server: ['nginx'] }).find((h) => h.name === 'server').value).to.equal('nginx')
    })

    it('takes a listener\'s changed headers back, replacing them all as Chrome does', () => {
      const original = { 'Content-Type': ['text/html'], 'X-Frame-Options': ['DENY'] }
      const changed = new Map([['ext', { responseHeaders: [{ name: 'Content-Type', value: 'text/html' }, { name: 'X-Added', value: 'yes' }] }]])
      expect(host.mergeResponseHeaders(original, changed)).to.deep.equal({
        responseHeaders: { 'Content-Type': ['text/html'], 'X-Added': ['yes'] }
      })
      const requests = new Map([['ext', { requestHeaders: [{ name: 'Accept', value: 'a' }, { name: 'Accept', value: 'b' }, { name: 'X-Bin', binaryValue: [104, 105] }] }]])
      expect(host.mergeRequestHeaders({ Accept: '*/*', Cookie: 'c' }, requests)).to.deep.equal({
        requestHeaders: { Accept: 'a, b', 'X-Bin': 'hi' }
      })
    })

    it('still merges a listener that answers with Electron\'s form, and leaves headers alone when none answer', () => {
      expect(host.mergeResponseHeaders({ A: ['1'] }, new Map([['ext', { responseHeaders: { B: ['2'] } }]]))).to.deep.equal({ responseHeaders: { A: ['1'], B: ['2'] } })
      expect(host.mergeRequestHeaders({ A: '1' }, new Map([['ext', {}]]))).to.deep.equal({ requestHeaders: { A: '1' } })
    })

    it('gives every listener Chrome\'s form, never Electron\'s', () => {
      expect(source).to.not.include('responseHeaders: details.responseHeaders')
      expect(source).to.not.include('requestHeaders: details.requestHeaders')
      expect((source.match(/responseHeaders: toChromeHeaders\(details\.responseHeaders\)/g) || []).length).to.equal(5)
      expect((source.match(/requestHeaders: toChromeHeaders\(details\.requestHeaders\)/g) || []).length).to.equal(3)
    })
  })
}
