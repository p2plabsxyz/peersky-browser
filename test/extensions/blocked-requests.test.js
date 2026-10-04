/**
 * A content blocker's cancel becomes an empty answer for a page's own calls.
 *
 * Figma's sign-up dialog stayed invisible behind a dimmed page: EasyPrivacy
 * blocks Figma's analytics, and the dialog waits for its sign-in frame to log
 * an event before fading in. Any site can wait on a blocked call like that, so
 * every blocked fetch, XHR and beacon is answered with an empty 204 on the
 * device, and nothing is sent. test/integration/blocked-calls.e2e.test.js runs
 * it through Electron.
 */

import { expect } from 'chai'
import { readFile } from 'fs/promises'
import {
  BLOCKED_SCHEME,
  BLOCKED_SCHEME_PRIVILEGES,
  answerBlockedCall,
  blockedCallHandler
} from '../../src/extensions/blocked-requests.js'

const main = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8')
const ANSWER = { redirectURL: `${BLOCKED_SCHEME}://blocked/` }

describe('blocked calls', () => {
  it("answers a page's blocked fetch, XHR and beacon calls on the device", () => {
    expect(answerBlockedCall({ resourceType: 'xhr' }, { cancel: true })).to.deep.equal(ANSWER)
    expect(answerBlockedCall({ resourceType: 'ping' }, { cancel: true })).to.deep.equal(ANSWER)
  })

  it('leaves everything else blocked', () => {
    for (const resourceType of ['mainFrame', 'subFrame', 'script', 'stylesheet', 'image', 'font', 'media', 'object', 'webSocket', 'other', undefined]) {
      expect(answerBlockedCall({ resourceType }, { cancel: true }), resourceType).to.deep.equal({ cancel: true })
    }
  })

  it('passes on whatever else the extensions decided', () => {
    const redirect = { redirectURL: 'chrome-extension://abc/web_accessible_resources/noop.js' }
    expect(answerBlockedCall({ resourceType: 'xhr' }, redirect)).to.equal(redirect)
    expect(answerBlockedCall({ resourceType: 'xhr' }, {})).to.deep.equal({})
    expect(answerBlockedCall({ resourceType: 'xhr' }, { cancel: false })).to.deep.equal({ cancel: false })
    expect(answerBlockedCall(undefined, undefined)).to.equal(undefined)
  })

  it('answers with an empty 204 that no cache keeps', async () => {
    const response = blockedCallHandler()
    expect(response.status).to.equal(204)
    expect(await response.text()).to.equal('')
    expect(response.headers.get('cache-control')).to.equal('no-store')
  })

  it("is reachable from any page, whatever the page's Content-Security-Policy", () => {
    expect(BLOCKED_SCHEME_PRIVILEGES).to.include({ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true })
  })

  it('is wired into the extension bridge, for every page in the normal session', () => {
    expect(main).to.contain('{ scheme: BLOCKED_SCHEME, privileges: BLOCKED_SCHEME_PRIVILEGES }')
    const start = main.indexOf('function installExtensionWebRequestBridge')
    const bridge = main.slice(start, main.indexOf('session.webRequest.onBeforeSendHeaders', start))
    expect(bridge).to.contain('session.protocol.handle(BLOCKED_SCHEME, blockedCallHandler)')
    expect(bridge).to.contain('callback(answerBlockedCall(details, result))')
    // No site is let past the blocker any more.
    expect(main).to.not.match(/isExemptFromBlockers|blocker-exemptions/)
  })
})
