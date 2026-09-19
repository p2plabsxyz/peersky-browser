import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp } from 'fs/promises'
import esmock from 'esmock'

async function loadPermissions () {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-perms-'))
  let requestHandler = null
  let checkHandler = null

  const mod = await esmock.strict('../../src/permissions.js', {
    electron: {
      app: { getPath: () => userData },
      dialog: {
        showMessageBox: async () => ({ response: 1 })
      },
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

  it('prompts on peersky pages instead of denying', async function () {
    const { requestHandler, getPermissionsForOrigin } = await loadPermissions()
    const wc = { getURL: () => 'peersky://backup' }
    await new Promise((resolve) => {
      requestHandler(wc, 'media', () => resolve())
    })
    expect(getPermissionsForOrigin('peersky://backup').media).to.equal('allow-session')
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
