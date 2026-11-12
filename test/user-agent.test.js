import { expect } from 'chai'
import { readFile } from 'fs/promises'
import { chromeLikeUserAgent } from '../src/user-agent.js'

const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8')

describe('the user agent', () => {
  const electron = (platform) => `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) peersky-browser/1.0.2 Chrome/150.0.7871.250 Electron/43.8.5 Safari/537.36`

  it('is Chrome\'s, with PeerSky inside the platform part where P2P pages find it', () => {
    expect(chromeLikeUserAgent(electron('Macintosh; Intel Mac OS X 10_15_7'), '1.0.2')).to.equal(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; PeerSky/1.0.2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    )
    expect(chromeLikeUserAgent(electron('Windows NT 10.0; Win64; x64'), '1.0.2')).to.equal(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; PeerSky/1.0.2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    )
    expect(chromeLikeUserAgent(electron('X11; Linux x86_64'), '1.0.2')).to.equal(
      'Mozilla/5.0 (X11; Linux x86_64; PeerSky/1.0.2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    )
  })

  it('has nothing after Chrome\'s own tokens, which sites read as another browser', () => {
    const ua = chromeLikeUserAgent(electron('Macintosh; Intel Mac OS X 10_15_7'), '1.0.2')
    expect(ua).to.not.match(/Electron|peersky-browser/)
    expect(ua).to.match(/\) Chrome\/150\.0\.0\.0 Safari\/537\.36$/)
    expect(ua.toLowerCase()).to.include('peersky')
  })

  it('leaves a user agent it does not know alone', () => {
    expect(chromeLikeUserAgent('Something else', '1.0.2')).to.equal('Something else')
    expect(chromeLikeUserAgent(electron('Macintosh; Intel Mac OS X 10_15_7'), 'bad version!')).to.include('; PeerSky)')
  })

  it('is set before any window opens', () => {
    const set = mainSource.indexOf('app.userAgentFallback = chromeLikeUserAgent(app.userAgentFallback, app.getVersion())')
    expect(set).to.be.greaterThan(-1)
    expect(set).to.be.lessThan(mainSource.indexOf('await windowManager.openSavedWindows()'))
  })
})
