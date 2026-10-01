import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'fs/promises'
import esmock from 'esmock'

/**
 * Importing a folder as a P2P app.
 *
 * A folder goes up as it stands, which is the whole point: an author's site is
 * whatever they put in it. What it must not carry is the repository history,
 * because .git holds the remote's config and that is where an access token
 * lives.
 */
async function loadRegistry () {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-myapps-'))
  const registry = await esmock.strict('../../src/p2p-app-registry.js', {
    electron: {
      app: { getPath: () => userData },
      ipcMain: { handle: () => {} },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
    }
  })
  const module = registry.default ?? registry
  await module.init()
  return { registry: module, userData }
}

const file = (p, body = 'x') => ({ path: p, data: Buffer.from(body) })

const bundledFiles = async (userData, appId) => {
  const walk = async (dir, base) => {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...await walk(full, base))
      else out.push(path.relative(base, full).split(path.sep).join('/'))
    }
    return out
  }
  const appDir = path.join(userData, 'myapps', appId, 'app')
  return (await walk(appDir, appDir)).sort()
}

describe('P2P app folder import', function () {
  it('takes every ordinary file in the folder, whatever it is called', async function () {
    const { registry, userData } = await loadRegistry()

    const app = await registry.importFolder({
      name: 'My Site',
      files: [
        file('index.html', '<h1>hi</h1>'),
        // Each of these used to fail the whole upload.
        file('LICENSE'),
        file('CNAME'),
        file('README.md'),
        file('.github/workflows/deploy-distributed-press.yaml'),
        file('assets/style.css')
      ]
    })

    expect(await bundledFiles(userData, app.id)).to.deep.equal([
      '.github/workflows/deploy-distributed-press.yaml',
      'CNAME',
      'LICENSE',
      'README.md',
      'assets/style.css',
      'index.html'
    ])
  })

  it('leaves the repository and the desktop clutter behind', async function () {
    const { registry, userData } = await loadRegistry()

    const app = await registry.importFolder({
      name: 'My Site',
      files: [
        file('index.html'),
        // A submodule checkout has .git as a file, a clone has it as a folder.
        file('.git', 'gitdir: ../../.git/modules/site'),
        file('.git/config', '[remote "origin"]\n  url = https://token@github.com/me/site.git'),
        file('.DS_Store'),
        file('assets/.DS_Store'),
        file('Thumbs.db')
      ]
    })

    expect(await bundledFiles(userData, app.id)).to.deep.equal(['index.html'])
  })

  it('leaves credentials behind, which the old allowlist kept out by accident', async function () {
    const { registry, userData } = await loadRegistry()

    const app = await registry.importFolder({
      name: 'My Site',
      files: [
        file('index.html'),
        file('.env', 'API_KEY=secret'),
        file('.env.local', 'API_KEY=secret'),
        file('.npmrc', '//registry.npmjs.org/:_authToken=secret'),
        file('server.pem', 'PRIVATE KEY'),
        file('config/app.key', 'PRIVATE KEY'),
        file('.ssh/id_rsa', 'PRIVATE KEY'),
        file('node_modules/left-pad/index.js')
      ]
    })

    expect(await bundledFiles(userData, app.id)).to.deep.equal(['index.html'])
  })

  it('refuses a second app with a name already on the shelf', async function () {
    const { registry, userData } = await loadRegistry()
    await registry.importFolder({ name: 'My Site', files: [file('index.html')] })

    let error
    try {
      await registry.importFolder({ name: 'my site ', files: [file('index.html')] })
    } catch (caught) {
      error = caught
    }

    expect(error?.message).to.match(/already here/)
    expect(error?.message).to.contain('My Site')
    expect(registry.getUserApps()).to.have.length(1)
    // Refused before anything was written, so there is no half-made app left.
    expect(await readdir(path.join(userData, 'myapps'))).to.deep.equal([
      'my-site', 'p2p-app-registry.json'
    ])
  })

  it('still asks for an index.html, and a folder of nothing but clutter is empty', async function () {
    const { registry } = await loadRegistry()

    const refused = async (payload) => {
      try {
        await registry.importFolder(payload)
        return ''
      } catch (error) {
        return error.message
      }
    }

    expect(await refused({ name: 'No Entry', files: [file('README.md')] })).to.match(/index\.html/)
    expect(await refused({ name: 'Junk', files: [file('.DS_Store')] })).to.match(/empty/)
  })

  it('never reads the repository off disk when a folder is picked', async function () {
    const { registry, userData } = await loadRegistry()
    const source = await mkdtemp(path.join(os.tmpdir(), 'peersky-folder-'))
    await writeFile(path.join(source, 'index.html'), '<h1>hi</h1>')
    await writeFile(path.join(source, 'LICENSE'), 'MIT')
    await mkdir(path.join(source, '.git'), { recursive: true })
    await writeFile(path.join(source, '.git', 'config'), 'url = https://token@github.com/me/site.git')

    const app = await registry.importFolderFromPath(source)

    expect(await bundledFiles(userData, app.id)).to.deep.equal(['LICENSE', 'index.html'])
  })

  it('skips the same names in the page as in the registry', async function () {
    const registrySource = await readFile(
      new URL('../../src/p2p-app-registry.js', import.meta.url), 'utf8')
    const pageSource = await readFile(
      new URL('../../src/pages/static/js/p2p-app-manager.js', import.meta.url), 'utf8')

    const listed = (source) => {
      const start = source.indexOf('SKIPPED_BUNDLE_ENTRIES = new Set([')
      const body = source.slice(start, source.indexOf('])', start))
      return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()
    }

    // The page skips them so they are never read; the registry skips them so
    // nothing else can put them in. They have to name the same things.
    const patterns = (source) => {
      const start = source.indexOf('SKIPPED_BUNDLE_PATTERNS = [')
      return source.slice(start, source.indexOf(']', start))
    }

    expect(listed(pageSource)).to.deep.equal(listed(registrySource))
    expect(listed(registrySource)).to.include('.git')
    expect(listed(registrySource)).to.include('.env')
    expect(patterns(pageSource)).to.equal(patterns(registrySource))
  })
})

describe('updating the built-in P2P apps', function () {
  // A packaged PeerSky once unpacked each app's latest GitHub zip over its
  // own app.asar.unpacked. Files an update added were invisible to the app,
  // and PeerSky stopped starting once PeerChat's main-process code imported
  // one. P2P apps now come with PeerSky updates.
  async function loadPackaged (appDir) {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-packaged-'))
    const registry = await esmock.strict('../../src/p2p-app-registry.js', {
      electron: {
        app: { getPath: () => userData, getAppPath: () => appDir, isPackaged: true },
        ipcMain: { handle: () => {} },
        dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
      }
    })
    const module = registry.default ?? registry
    await module.init()
    return module
  }

  it('never downloads or writes a P2P app in a packaged build, and checks for a PeerSky update', async function () {
    const appDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-app-asar-'))
    const originalFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = async () => { fetched = true; throw new Error('no network in this test') }
    try {
      const registry = await loadPackaged(appDir)
      let checks = 0
      registry.setupIpc({ checkForAppUpdate: async () => { checks += 1; return 'up-to-date' } })

      const result = await registry.updateSubmodules()
      expect(result).to.deep.equal({ success: true, message: 'P2P apps update with PeerSky, and this is the latest PeerSky.' })
      expect(checks).to.equal(1)
      expect(fetched).to.equal(false)
      expect(await readdir(appDir)).to.deep.equal([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('says when a PeerSky update is ready, and where to look when it cannot check', async function () {
    const registry = await loadPackaged(await mkdtemp(path.join(os.tmpdir(), 'peersky-app-asar-')))

    registry.setupIpc({ checkForAppUpdate: async () => 'update-available' })
    expect((await registry.updateSubmodules()).message).to.match(/Restart PeerSky to install it/)

    registry.setupIpc({ checkForAppUpdate: async () => 'not-initialized' })
    expect(await registry.updateSubmodules()).to.deep.equal({ success: false, error: 'P2P apps update with PeerSky. Check for updates in Settings.' })

    registry.setupIpc({ checkForAppUpdate: async () => { throw new Error('offline') } })
    expect((await registry.updateSubmodules()).success).to.equal(false)

    registry.setupIpc()
    expect((await registry.updateSubmodules()).success).to.equal(false)
  })
})
