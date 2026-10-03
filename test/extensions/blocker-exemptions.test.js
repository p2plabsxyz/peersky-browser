/**
 * Requests kept away from content blockers because blocking them breaks a site.
 *
 * Figma's sign-up dialog stayed invisible behind a dimmed page: uBlock's
 * EasyPrivacy list blocks figma.com/api/figment-proxy, Figma's sign-in frame
 * then drops all its events, and the page waits for one of them before fading
 * the dialog in. Only the sign-in frame's requests may pass.
 */

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import { isExemptFromBlockers } from '../../src/extensions/blocker-exemptions.js'

const main = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8')

const SIGN_IN_FRAME = 'https://www.figma.com/login_iframe?redirect_url=%2Fcommunity&form_state=sign_up&type=fixedmodal'
const PAGE = 'https://www.figma.com/community/file/1623112888695852806/platano-screenshots'

describe('content blocker exemptions', () => {
  it("lets Figma's sign-in frame reach Figma's analytics", () => {
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/figment-proxy/page', frame: { url: SIGN_IN_FRAME } })).to.equal(true)
  })

  it('goes by the referrer when the frame is gone', () => {
    const gone = { get url () { throw new Error('Render frame was disposed') } }
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/figment-proxy/page', frame: gone, referrer: SIGN_IN_FRAME })).to.equal(true)
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/figment-proxy/page', frame: null, referrer: SIGN_IN_FRAME })).to.equal(true)
  })

  it("leaves Figma's analytics from its other pages to the blocker", () => {
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/figment-proxy/monitor', frame: { url: PAGE } })).to.equal(false)
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/figment-proxy/page', frame: { url: PAGE }, referrer: PAGE })).to.equal(false)
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/figment-proxy/page' })).to.equal(false)
  })

  it('leaves every other request from the sign-in frame to the blocker', () => {
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/web_logger/metrics_batched', frame: { url: SIGN_IN_FRAME } })).to.equal(false)
    expect(isExemptFromBlockers({ url: 'https://browser-intake-datadoghq.com/api/v2/rum', frame: { url: SIGN_IN_FRAME } })).to.equal(false)
  })

  it('is not fooled by lookalike addresses', () => {
    const lookalike = 'https://www.figma.com.example.test/login_iframe'
    expect(isExemptFromBlockers({ url: 'https://www.figma.com.example.test/api/figment-proxy/page', frame: { url: lookalike } })).to.equal(false)
    expect(isExemptFromBlockers({ url: 'http://www.figma.com/api/figment-proxy/page', frame: { url: SIGN_IN_FRAME } })).to.equal(false)
    expect(isExemptFromBlockers({ url: 'https://www.figma.com/api/figment-proxy/page', frame: { url: 'https://www.figma.com/login_iframe_other' } })).to.equal(false)
    expect(isExemptFromBlockers({ url: 'https://evil.example/api/figment-proxy/page', frame: { url: SIGN_IN_FRAME } })).to.equal(false)
  })

  it('handles missing or broken details', () => {
    expect(isExemptFromBlockers()).to.equal(false)
    expect(isExemptFromBlockers({})).to.equal(false)
    expect(isExemptFromBlockers({ url: 'not a url', frame: { url: SIGN_IN_FRAME } })).to.equal(false)
  })

  it('is checked before any request reaches an extension', () => {
    const bridge = main.slice(main.indexOf('function installExtensionWebRequestBridge'), main.indexOf("app.on('window-all-closed'"))
    expect(bridge).to.contain('if (isExemptFromBlockers(details)) return false')
    const calls = bridge.match(/shouldForwardToExtensions\(url, details\)/g) || []
    const all = bridge.match(/shouldForwardToExtensions\(/g) || []
    expect(calls.length).to.equal(all.length)
    expect(calls.length).to.be.at.least(8)
  })
})
