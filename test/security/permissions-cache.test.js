import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, readFile } from 'fs/promises'
import esmock from 'esmock'

async function loadPermissions (dialog = { showMessageBox: async () => ({ response: 1 }) }) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-perms-'))
  let requestHandler = null
  let checkHandler = null

  const mod = await esmock.strict('../../src/permissions.js', {
    electron: {
      app: { getPath: () => userData },
      dialog,
      BrowserWindow: {
        fromWebContents: () => null,
        getAllWindows: () => []
      }
    }
  })

  const session = {
    setPermissionRequestHandler (fn) { requestHandler = fn },
    setPermissionCheckHandler (fn) { checkHandler = fn }
  }
  await mod.setupPermissionHandler(session)

  return { ...mod, userData, requestHandler, checkHandler }
}

describe('permission cache', function () {
  it('accepts http(s) and browser scheme origins, rejects opaque ones', async function () {
    const { setPermission, isValidOrigin, permissionOriginFromUrl } = await loadPermissions()
    expect(isValidOrigin('https://example.com')).to.equal(true)
    expect(isValidOrigin('peersky://backup')).to.equal(true)
    expect(isValidOrigin('ipfs://bafy')).to.equal(true)
    expect(isValidOrigin('file://')).to.equal(true)
    expect(permissionOriginFromUrl('peersky://backup/scan')).to.equal('peersky://backup')
    expect(permissionOriginFromUrl('file:///C:/x')).to.equal('file://')
    expect(isValidOrigin('unknown')).to.equal(false)
    expect(isValidOrigin('null')).to.equal(false)
    expect(setPermission('about:blank', 'geolocation', 'allow')).to.deep.equal({
      ok: false,
      error: 'invalid origin'
    })
    expect(setPermission('data:text/html,hi', 'geolocation', 'allow')).to.deep.equal({
      ok: false,
      error: 'invalid origin'
    })
  })

  it('sets, reads, and resets permanent decisions', async function () {
    const {
      setPermission,
      getPermissionsForOrigin,
      resetPermissionsForOrigin
    } = await loadPermissions()
    const origin = 'https://example.com'

    expect(getPermissionsForOrigin(origin).geolocation).to.equal('ask')
    expect(setPermission(origin, 'geolocation', 'allow')).to.deep.equal({ ok: true })
    expect(getPermissionsForOrigin(origin).geolocation).to.equal('allow')

    expect(setPermission(origin, 'notifications', 'block')).to.deep.equal({ ok: true })
    expect(getPermissionsForOrigin(origin).notifications).to.equal('block')

    expect(setPermission(origin, 'geolocation', 'ask')).to.deep.equal({ ok: true })
    expect(getPermissionsForOrigin(origin).geolocation).to.equal('ask')

    expect(resetPermissionsForOrigin(origin)).to.be.at.least(1)
    expect(getPermissionsForOrigin(origin).notifications).to.equal('ask')
  })

  it('silently grants clipboard-sanitized-write on request and check', async function () {
    const { requestHandler, checkHandler } = await loadPermissions()
    let granted = null
    requestHandler({ getURL: () => 'peersky://settings' }, 'clipboard-sanitized-write', (ok) => {
      granted = ok
    })
    expect(granted).to.equal(true)
    expect(checkHandler(null, 'clipboard-sanitized-write', 'peersky://settings')).to.equal(true)
  })

  // PeerChat's media viewer saved through the save dialog, and the write that
  // followed was refused, so it fell back to a download link that asked where
  // to save a second time. The file the person picked is now writable, by the
  // browser's own pages only.
  it('lets the browser\'s own pages use a file the person picked, and nothing more', async function () {
    const { requestHandler, checkHandler, isOwnPageFileAccess } = await loadPermissions()
    const own = { getURL: () => 'peersky://p2p/peerchat/' }
    const site = { getURL: () => 'https://example.com/' }
    const ask = (webContents, details) => new Promise((resolve) => requestHandler(webContents, 'fileSystem', resolve, details))
    const file = { filePath: '/Users/me/Downloads/photo.png', isDirectory: false, fileAccessType: 'writable' }
    expect(await ask(own, { ...file, requestingUrl: 'peersky://p2p/peerchat/' })).to.equal(true)
    expect(await ask(own, file)).to.equal(true)
    expect(await ask(own, { ...file, isDirectory: true, requestingUrl: 'peersky://p2p/peerchat/' })).to.equal(false)
    expect(await ask(site, { ...file, requestingUrl: 'https://example.com/' })).to.equal(false)
    expect(checkHandler(own, 'fileSystem', 'peersky://p2p', { isDirectory: false })).to.equal(true)
    expect(checkHandler(site, 'fileSystem', 'https://example.com', { isDirectory: false })).to.equal(false)
    expect(isOwnPageFileAccess('media', { requestingUrl: 'peersky://p2p/peerchat/' })).to.equal(false)
    expect(isOwnPageFileAccess('fileSystem', null, 'peersky://p2p/peerchat/')).to.equal(false)
  })

  it('prompts on peersky pages instead of denying', async function () {
    const { requestHandler, getPermissionsForOrigin } = await loadPermissions()
    const wc = { getURL: () => 'peersky://backup' }
    await new Promise((resolve) => {
      requestHandler(wc, 'media', () => resolve())
    })
    expect(getPermissionsForOrigin('peersky://backup').media).to.equal('allow-session')
  })

  it('asks once for P2P publishing, however many writes are waiting', async function () {
    let prompts = 0
    const { requestSitePermission, getPermissionsForOrigin } = await loadPermissions({
      showMessageBox: async () => { prompts++; return { response: 0 } }
    })
    const wc = { getURL: () => 'https://site.example/' }
    const ask = () => requestSitePermission(wc, 'https://site.example', 'p2pPublish')
    expect(await Promise.all([ask(), ask(), ask()])).to.deep.equal([true, true, true])
    expect(await ask()).to.equal(true)
    expect(prompts).to.equal(1)
    expect(getPermissionsForOrigin('https://site.example').p2pPublish).to.equal('allow')
  })

  it('remembers a blocked site without asking again', async function () {
    let prompts = 0
    const { requestSitePermission } = await loadPermissions({
      showMessageBox: async () => { prompts++; return { response: 2 } }
    })
    const ask = () => requestSitePermission(null, 'hyper://abc', 'p2pPublish')
    expect(await ask()).to.equal(false)
    expect(await ask()).to.equal(false)
    expect(prompts).to.equal(1)
  })

  it('keeps Allow this time in memory only', async function () {
    const { requestHandler, getPermissionsForOrigin } = await loadPermissions()
    const wc = { getURL: () => 'https://example.com/page' }
    await new Promise((resolve) => {
      requestHandler(wc, 'geolocation', () => resolve())
    })
    expect(getPermissionsForOrigin('https://example.com').geolocation).to.equal('allow-session')
  })
})

describe('incognito permissions', function () {
  async function loadIncognito (dialog) {
    const mod = await loadPermissions(dialog)
    let requestHandler = null
    let checkHandler = null
    mod.setupIncognitoPermissionHandler({
      setPermissionRequestHandler (fn) { requestHandler = fn },
      setPermissionCheckHandler (fn) { checkHandler = fn }
    })
    return { ...mod, incognitoRequest: requestHandler, incognitoCheck: checkHandler }
  }

  const ask = (handler, url, permission) => new Promise((resolve) => {
    handler({ getURL: () => url }, permission, resolve)
  })

  it('asks with Allow and Block, and never touches the normal answers', async function () {
    const seen = []
    const { incognitoRequest, incognitoCheck, getPermissionsForOrigin, setPermission, userData } = await loadIncognito({
      showMessageBox: async (...args) => { seen.push(args.at(-1).buttons); return { response: 0 } }
    })
    setPermission('https://example.com', 'media', 'block')

    expect(await ask(incognitoRequest, 'https://example.com/call', 'media')).to.equal(true)
    expect(seen).to.deep.equal([['Allow', 'Block']])
    expect(incognitoCheck(null, 'media', 'https://example.com')).to.equal(true)
    expect(getPermissionsForOrigin('https://example.com').media).to.equal('block')
    expect(getPermissionsForOrigin('https://example.com', { incognito: true }).media).to.equal('allow-session')

    // Nothing from incognito reaches the file the normal answers are saved in.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const saved = JSON.parse(await readFile(path.join(userData, 'permissions.json'), 'utf8'))
    expect(saved).to.deep.equal({ 'https://example.com|media': false })
  })

  it('does not use what the normal profile allowed', async function () {
    let prompts = 0
    const { incognitoRequest, setPermission } = await loadIncognito({
      showMessageBox: async () => { prompts++; return { response: 1 } }
    })
    setPermission('https://example.com', 'geolocation', 'allow')
    expect(await ask(incognitoRequest, 'https://example.com/', 'geolocation')).to.equal(false)
    expect(await ask(incognitoRequest, 'https://example.com/', 'geolocation')).to.equal(false)
    expect(prompts).to.equal(1)
  })

  it('forgets every answer once incognito ends', async function () {
    const { incognitoRequest, incognitoCheck, clearIncognitoPermissions } = await loadIncognito({
      showMessageBox: async () => ({ response: 0 })
    })
    await ask(incognitoRequest, 'https://example.com/', 'fullscreen')
    expect(incognitoCheck(null, 'fullscreen', 'https://example.com')).to.equal(true)
    clearIncognitoPermissions()
    expect(incognitoCheck(null, 'fullscreen', 'https://example.com')).to.equal(false)
  })

  it('never offers P2P publishing', async function () {
    let prompts = 0
    const { incognitoRequest } = await loadIncognito({
      showMessageBox: async () => { prompts++; return { response: 0 } }
    })
    expect(await ask(incognitoRequest, 'hyper://abc/', 'p2pPublish')).to.equal(false)
    expect(prompts).to.equal(0)
  })
})

describe('the AI permission', function () {
  it('asks only on the pages that get window.llm', async function () {
    const { llmAccessFor } = await loadPermissions()
    const expected = {
      'peersky://p2p/ai-chat/': 'own',
      'peersky://settings': 'own',
      'peersky://myapps/app1/': 'ask',
      'hyper://abc/': 'ask',
      'ipfs://bafy/': 'ask',
      'ipns://example.org/': 'ask',
      'hs://abc/': 'ask',
      'file:///tmp/page.html': 'ask',
      'http://localhost:8080/': 'ask',
      'https://agregore.mauve.moe/': 'ask',
      'https://example.com/': 'none',
      'http://localhost.example.com/': 'none',
      'about:blank': 'none',
      'not a url': 'none'
    }
    for (const [url, access] of Object.entries(expected)) {
      expect(llmAccessFor(url), url).to.equal(access)
    }
  })

  it('shows AI in the site panel only where a page can ask for it', async function () {
    const { permissionsShownFor, MANAGED_PERMISSIONS } = await loadPermissions()
    const rows = (url) => permissionsShownFor(url).map(p => p.id)
    const others = MANAGED_PERMISSIONS.map(p => p.id).filter(id => id !== 'llm')
    expect(rows('hyper://abc/')).to.include('llm')
    expect(rows('ipfs://bafy/')).to.include('llm')
    expect(rows('peersky://p2p/ai-chat/')).to.deep.equal(others)
    expect(rows('https://example.com/')).to.deep.equal(others)
  })

  it('remembers an AI answer like any other permission', async function () {
    const { setPermission, getPermissionsForOrigin } = await loadPermissions()
    expect(getPermissionsForOrigin('hyper://abc').llm).to.equal('ask')
    expect(setPermission('hyper://abc', 'llm', 'block')).to.deep.equal({ ok: true })
    expect(getPermissionsForOrigin('hyper://abc').llm).to.equal('block')
  })
})
