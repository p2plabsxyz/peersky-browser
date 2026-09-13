import { readFile } from 'node:fs/promises'
import { expect } from 'chai'
import { urlFromArgv, queueLaunchUrl, startDeliveringLaunchUrls, LAUNCH_SCHEMES } from '../src/launch-url.js'

describe('launch URLs handed over by the OS', () => {
  it('accepts every scheme the installer registers', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const declared = pkg.build.protocols.flatMap((p) => p.schemes)
    expect(declared.length).to.be.greaterThan(0)
    for (const scheme of declared) {
      expect(LAUNCH_SCHEMES.has(`${scheme}:`), `build.protocols declares ${scheme} but launch-url.js drops it`).to.equal(true)
    }
  })

  it('finds the link in a packaged Windows/Linux argv', () => {
    expect(urlFromArgv(['C:\\Peersky\\Peersky Browser.exe', 'https://example.com/a?b=1'])).to.equal('https://example.com/a?b=1')
  })

  it('finds p2p links too', () => {
    expect(urlFromArgv(['/usr/bin/peersky', 'hyper://abc123/'])).to.equal('hyper://abc123/')
    expect(urlFromArgv(['peersky', 'peersky://settings'])).to.match(/^peersky:\/\/settings/)
  })

  it('ignores the dev app path, flags and Windows paths', () => {
    expect(urlFromArgv(['electron', '.'])).to.equal(null)
    expect(urlFromArgv(['electron', '.', '--new-window'])).to.equal(null)
    expect(urlFromArgv(['electron', '--user-data-dir=/tmp/x'])).to.equal(null)
    expect(urlFromArgv(['Peersky.exe', 'C:\\Users\\me\\file.html'])).to.equal(null)
  })

  it('never launches a scheme that could run code or read disk', () => {
    expect(urlFromArgv(['x', 'javascript:alert(1)'])).to.equal(null)
    expect(urlFromArgv(['x', 'data:text/html,hi'])).to.equal(null)
    expect(urlFromArgv(['x', 'file:///etc/passwd'])).to.equal(null)
    expect(LAUNCH_SCHEMES.has('file:')).to.equal(false)
  })

  it('skips the executable itself even when it parses as a URL', () => {
    expect(urlFromArgv(['https://evil.example/', '--flag'])).to.equal(null)
  })

  it('holds links until a window can take them, then flushes in order', () => {
    const delivered = []
    queueLaunchUrl('https://one.example/')
    queueLaunchUrl(null)
    queueLaunchUrl('https://two.example/')
    expect(delivered).to.deep.equal([])
    startDeliveringLaunchUrls((u) => delivered.push(u))
    expect(delivered).to.deep.equal(['https://one.example/', 'https://two.example/'])
    queueLaunchUrl('https://three.example/')
    expect(delivered).to.deep.equal(['https://one.example/', 'https://two.example/', 'https://three.example/'])
  })
})
