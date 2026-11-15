/**
 * A content blocker's cancel becomes an empty answer for a page's own calls.
 *
 * Figma's sign-up dialog stayed invisible behind a dimmed page: EasyPrivacy
 * blocks Figma's analytics, and the dialog waits for its sign-in frame to log
 * an event before fading in. Any site can wait on a blocked call like that, so
 * every blocked fetch, XHR and beacon is answered with an empty 204 on the
 * device, and nothing is sent. A blocker's data: answer, which uBlock Origin
 * gives every fetch and XHR it redirects and Electron will not follow, is
 * served on the device too. test/integration/blocked-calls.e2e.test.js runs
 * both through Electron.
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
const DATA_ADDRESS = /^peersky-blocked:\/\/data\/[0-9a-f]{32}$/

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

  describe("a blocker's data: answer", () => {
    const xhr = { resourceType: 'xhr' }
    const served = async (result) => {
      expect(result.redirectURL).to.match(DATA_ADDRESS)
      return blockedCallHandler({ url: result.redirectURL })
    }

    it('serves its content, at an address made for that request', async () => {
      const first = answerBlockedCall(xhr, { redirectURL: 'data:text/plain;base64,c3R1Yg==' })
      const second = answerBlockedCall(xhr, { redirectURL: 'data:text/plain;base64,c3R1Yg==' })
      expect(first.redirectURL).to.not.equal(second.redirectURL)
      const response = await served(first)
      expect(response.status).to.equal(200)
      expect(await response.text()).to.equal('stub')
      expect(response.headers.get('content-type')).to.equal('text/plain')
      expect(response.headers.get('access-control-allow-origin')).to.equal('*')
      expect(response.headers.get('cache-control')).to.equal('no-store')
    })

    it('reads text, base64, empty and typed content as Chrome does', async () => {
      const read = async (dataUrl, type = 'xhr') => {
        const response = await served(answerBlockedCall({ resourceType: type }, { redirectURL: dataUrl }))
        return [response.headers.get('content-type'), await response.text()]
      }
      expect(await read('data:application/json,%7B%7D')).to.deep.equal(['application/json', '{}'])
      expect(await read('data:text/plain,')).to.deep.equal(['text/plain', ''])
      expect(await read('data:text/plain;base64,')).to.deep.equal(['text/plain', ''])
      expect(await read('data:,')).to.deep.equal(['text/plain;charset=US-ASCII', ''])
      expect(await read('data:text/javascript;base64,KGZ1bmN0aW9uKCl7fSkoKTs=', 'script')).to.deep.equal(['text/javascript', '(function(){})();'])
      const [gif] = await read('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'image')
      expect(gif).to.equal('image/gif')
    })

    it('answers beacons, scripts, images, styles and media the same way', () => {
      for (const resourceType of ['ping', 'script', 'image', 'stylesheet', 'media', 'font', 'object', 'other']) {
        expect(answerBlockedCall({ resourceType }, { redirectURL: 'data:text/plain,' }).redirectURL, resourceType).to.match(DATA_ADDRESS)
      }
    })

    it('leaves frames, WebSockets and large content as the extension gave them', () => {
      for (const resourceType of ['mainFrame', 'subFrame', 'webSocket', undefined]) {
        const sent = { redirectURL: 'data:text/plain,' }
        expect(answerBlockedCall({ resourceType }, sent), resourceType).to.equal(sent)
      }
      const large = { redirectURL: 'data:text/plain,' + 'a'.repeat(64 * 1024) }
      expect(answerBlockedCall(xhr, large)).to.equal(large)
    })

    it('finds nothing at an address no request was given', async () => {
      const response = await blockedCallHandler({ url: `peersky-blocked://data/${'0'.repeat(32)}` })
      expect(response.status).to.equal(404)
      expect(await response.text()).to.equal('')
      expect((await blockedCallHandler({ url: 'peersky-blocked://data/' })).status).to.equal(404)
    })
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
