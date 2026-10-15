import { expect } from 'chai'
import esmock from 'esmock'
import os from 'os'
import path from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { readFile } from 'fs/promises'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import makeHyperFetch from 'hypercore-fetch'
import z32 from 'z32'
import {
  bumpCacheEpoch,
  driveFolderOf,
  hyperFileUrl,
  isFolderListing,
  isFolderReadme,
  knownDriveName,
  listDriveFiles,
  listFailure,
  MAX_LISTED_FILES,
  readCacheEpoch,
  viewerAddressFor,
  viewerRedirect,
  VIEWS_FILE
} from '../../src/protocols/hyperdrive-views.js'

const KEY = z32.encode(Buffer.alloc(32, 7))
const HEX = 'ab'.repeat(32)
// What a tab sends, and what a page's fetch sends.
const TAB = { headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } }

function listing (folderUrl) {
  return new Response('<h1>Index of /</h1>', {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', Link: `<${folderUrl}>; rel="canonical"` }
  })
}

describe('Hyperdrive views', function () {
  this.timeout(30000)

  describe('the views\' address for a folder', function () {
    it('keeps the host as given, lower-cased, and encodes each name on its own', function () {
      expect(viewerAddressFor(`hyper://${KEY}/`)).to.equal(`peersky://p2p/hyperdrive/files/${KEY}/?auto`)
      expect(viewerAddressFor(`hyper://${HEX}/2024/`)).to.equal(`peersky://p2p/hyperdrive/files/${HEX}/2024/?auto`)
      expect(viewerAddressFor('hyper://Photos.Example.ORG/Trip/')).to.equal('peersky://p2p/hyperdrive/files/photos.example.org/Trip/?auto')
      expect(viewerAddressFor(`hyper://${KEY}/My%20Photos/Goa%2C%20India/`)).to.equal(`peersky://p2p/hyperdrive/files/${KEY}/My%20Photos/Goa%2C%20India/?auto`)
      expect(viewerAddressFor(`hyper://${KEY}/Caf%C3%A9/100%25/a&b/`)).to.equal(`peersky://p2p/hyperdrive/files/${KEY}/Caf%C3%A9/100%25/a%26b/?auto`)
      // A folder asked for without its slash, and doubled slashes.
      expect(viewerAddressFor(`hyper://${KEY}/Trip`)).to.equal(`peersky://p2p/hyperdrive/files/${KEY}/Trip/?auto`)
      expect(viewerAddressFor(`hyper://${KEY}//a//b/?x=1`)).to.equal(`peersky://p2p/hyperdrive/files/${KEY}/a/b/?auto`)
    })

    it('names no address for what the views cannot open', function () {
      for (const url of [
        'hyper://localhost/',
        'hyper://under_score/',
        'https://example.com/',
        `hyper://${KEY}/bad%E0%A4%A/`,
        `hyper://${KEY}/a%2Fb/`,
        `hyper://${KEY}/a%5Cb/`,
        'not a url',
        undefined
      ]) {
        expect(viewerAddressFor(url), String(url)).to.equal(null)
      }
    })

    it('reads the drive and the folder a list is asked for', function () {
      expect(driveFolderOf(`hyper://${KEY}/`)).to.deep.equal({ host: KEY, folder: '/' })
      expect(driveFolderOf(`hyper://${KEY}/My%20Photos/2024/?recursive=1`)).to.deep.equal({ host: KEY, folder: '/My Photos/2024/' })
      expect(driveFolderOf(`hyper://${KEY}/a%2Cb%3Bc`)).to.deep.equal({ host: KEY, folder: '/a,b;c/' })
      expect(driveFolderOf('hyper://localhost/')).to.equal(null)
    })

    it('downloads files only', function () {
      expect(hyperFileUrl(`hyper://${KEY}/Trip/a%20b.jpg`)).to.equal(`hyper://${KEY}/Trip/a%20b.jpg`)
      for (const url of [`hyper://${KEY}/`, `hyper://${KEY}/Trip/`, 'https://example.com/a.jpg', 'hyper://localhost/a.jpg', `hyper://${KEY}/a%2Fb`, 42]) {
        expect(hyperFileUrl(url), String(url)).to.equal(null)
      }
    })
  })

  describe('what a tab opening a folder is answered', function () {
    let root, store, drive, hyperFetch

    before(async function () {
      root = mkdtempSync(path.join(os.tmpdir(), 'peersky-drive-views-'))
      store = new Corestore(path.join(root, 'store'))
      drive = new Hyperdrive(store)
      await drive.ready()
      // hyper-sdk gives drives their address, once it is loaded.
      if (!drive.url) Object.defineProperty(drive, 'url', { value: `hyper://${z32.encode(drive.key)}/` })
      await drive.put('/Trip 2024/a.jpg', Buffer.from('a'))
      await drive.put('/site/index.html', Buffer.from('<h1>site</h1>'))
      await drive.put('/notes/README.md', Buffer.from('# notes'))
      // Every other index file hypercore-fetch serves for a folder.
      for (const name of ['README.org', 'index.md', 'index.gmi', 'index.gemini', 'index.org']) {
        await drive.put(`/${name.replace('.', '-')}/${name}`, Buffer.from(name))
      }
      // A website with a readme too: the website wins.
      await drive.put('/both/index.html', Buffer.from('<h1>both</h1>'))
      await drive.put('/both/README.md', Buffer.from('# both'))
      // The real hypercore-fetch, so its answers are what the redirect reads.
      hyperFetch = await makeHyperFetch({ sdk: { getDrive: async () => drive }, writable: false })
    })

    after(async function () {
      await drive?.close().catch(() => {})
      await store?.close().catch(() => {})
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })

    const urlOf = (pathname) => `hyper://${z32.encode(drive.key)}${pathname}`

    async function answer (pathname, { navigation = true, method = 'GET', init = TAB } = {}) {
      const url = urlOf(pathname)
      const response = await hyperFetch(url, { method, ...init })
      return { response, redirect: viewerRedirect({ url, method, navigation, response }) }
    }

    it('sends a folder that holds no website to the Files view, which picks the view itself', async function () {
      const { response, redirect } = await answer('/Trip%202024/')
      expect(isFolderListing(response)).to.equal(true)
      expect(redirect.status).to.equal(302)
      expect(redirect.headers.get('Location')).to.equal(`peersky://p2p/hyperdrive/files/${z32.encode(drive.key)}/Trip%202024/?auto`)

      const top = await answer('/')
      expect(top.redirect.headers.get('Location')).to.equal(`peersky://p2p/hyperdrive/files/${z32.encode(drive.key)}/?auto`)
    })

    it('sends a folder hypercore-fetch answers with a readme there too, which shows it under the list', async function () {
      for (const [folder, file] of [
        ['/notes/', 'README.md'],
        ['/README-org/', 'README.org'],
        ['/index-md/', 'index.md'],
        ['/index-gmi/', 'index.gmi'],
        ['/index-gemini/', 'index.gemini'],
        ['/index-org/', 'index.org']
      ]) {
        const { response, redirect } = await answer(folder)
        expect(response.headers.get('Link'), folder).to.match(new RegExp(`/${file.replace('.', '\\.')}>`))
        expect(redirect?.headers.get('Location'), folder).to.equal(`peersky://p2p/hyperdrive/files/${z32.encode(drive.key)}${folder}?auto`)
      }
    })

    it('leaves a website, a readme\'s own address and a missing folder alone', async function () {
      const site = await answer('/site/')
      expect(await site.response.text()).to.equal('<h1>site</h1>')
      expect(site.redirect).to.equal(null)
      const both = await answer('/both/')
      expect(await both.response.text()).to.equal('<h1>both</h1>')
      expect(both.redirect).to.equal(null)
      const readme = await answer('/notes/README.md')
      expect(await readme.response.text()).to.equal('# notes')
      expect(readme.redirect).to.equal(null)
      const missing = await answer('/nothing/')
      expect(missing.response.status).to.equal(404)
      expect(missing.redirect).to.equal(null)
    })

    it('never sends a page\'s own fetch, a HEAD or a raw list there', async function () {
      expect((await answer('/Trip%202024/', { navigation: false })).redirect).to.equal(null)
      // A page's fetch asks for JSON unless it says otherwise.
      const json = await answer('/Trip%202024/', { init: {} })
      expect(json.response.headers.get('Content-Type')).to.match(/application\/json/)
      expect(json.redirect).to.equal(null)
      expect((await answer('/Trip%202024/', { method: 'HEAD' })).redirect).to.equal(null)
      for (const query of ['?raw', '?raw=1', '?noResolve']) {
        const raw = await answer(`/Trip%202024/${query}`)
        expect(isFolderListing(raw.response), query).to.equal(true)
        expect(raw.redirect, query).to.equal(null)
      }
      // A readme folder, with the readme served for ?raw and the list for ?noResolve.
      expect((await answer('/notes/', { navigation: false })).redirect).to.equal(null)
      expect((await answer('/notes/', { method: 'HEAD' })).redirect).to.equal(null)
      for (const query of ['?raw', '?noResolve']) {
        expect((await answer(`/notes/${query}`)).redirect, query).to.equal(null)
      }
    })

    it('reads only a folder\'s own list as one', function () {
      expect(isFolderListing(listing(`hyper://${KEY}/a/`))).to.equal(true)
      expect(isFolderListing(listing(`hyper://${KEY}/a/index.html`))).to.equal(false)
      expect(isFolderListing(new Response('<p>x</p>', { headers: { 'Content-Type': 'text/html' } }))).to.equal(false)
      expect(isFolderListing(new Response('[]', { status: 404, headers: { 'Content-Type': 'application/json', Link: `<hyper://${KEY}/a/>; rel="canonical"` } }))).to.equal(false)
      expect(isFolderListing(null)).to.equal(false)
    })

    it('takes a readme of any case, and never index.html or index.htm', function () {
      const served = (file, status = 200) => new Response('x', { status, headers: { 'Content-Type': 'text/plain', Link: `<hyper://${KEY}/a/${file}>; rel="canonical"` } })
      const redirectFor = (file, requested = `hyper://${KEY}/a/`, status) => viewerRedirect({ url: requested, navigation: true, response: served(file, status) })
      for (const file of ['Readme.MD', 'readme.org', 'INDEX.ORG', 'Index.Gemini', 'index.GMI']) {
        expect(isFolderReadme(served(file)), file).to.equal(true)
        expect(redirectFor(file)?.headers.get('Location'), file).to.equal(`peersky://p2p/hyperdrive/files/${KEY}/a/?auto`)
      }
      for (const file of ['index.html', 'INDEX.HTM', 'index.htm', 'readme.txt', 'README.markdown', 'notes.md']) {
        expect(isFolderReadme(served(file)), file).to.equal(false)
        expect(redirectFor(file), file).to.equal(null)
      }
      // The readme asked for by its own address, or not served.
      expect(redirectFor('README.md', `hyper://${KEY}/a/README.md`)).to.equal(null)
      expect(redirectFor('README.md', `hyper://${KEY}/a`)).to.equal(null)
      expect(redirectFor('README.md', undefined, 404)).to.equal(null)
    })
  })

  describe('listing a drive\'s files', function () {
    let root, store, drive

    before(async function () {
      root = mkdtempSync(path.join(os.tmpdir(), 'peersky-drive-list-'))
      store = new Corestore(path.join(root, 'store'))
      drive = new Hyperdrive(store)
      await drive.ready()
      await drive.put('/Trip/a.jpg', Buffer.from('aaa'), { metadata: { mtime: 1700000000000 } })
      await drive.put('/Trip/2024/b.mp4', Buffer.from('bbbbb'))
      await drive.put('/Trip/c.srt', Buffer.alloc(0))
      await drive.put('/top.txt', Buffer.from('t'), { metadata: { mtime: 'yesterday' } })
      await drive.symlink('/Trip/link.jpg', '/Trip/a.jpg')
      await drive.putEntry('/Trip/empty-folder-marker')
    })

    after(async function () {
      await drive?.close().catch(() => {})
      await store?.close().catch(() => {})
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })

    it('gives every file under a folder with its size and time, and no folders or links', async function () {
      const listed = await listDriveFiles(drive, '/Trip/')
      expect(listed).to.deep.equal({
        entries: [
          { path: '/Trip/2024/b.mp4', size: 5, mtime: null },
          { path: '/Trip/a.jpg', size: 3, mtime: 1700000000000 },
          { path: '/Trip/c.srt', size: 0, mtime: null }
        ],
        truncated: false,
        empty: false
      })
      const all = await listDriveFiles(drive, '/')
      expect(all.entries.map((entry) => entry.path)).to.deep.equal(['/Trip/2024/b.mp4', '/Trip/a.jpg', '/Trip/c.srt', '/top.txt'])
      // A time that is not a number is no time.
      expect(all.entries[3].mtime).to.equal(null)
    })

    it('keeps to the folder itself when not recursive', async function () {
      const listed = await listDriveFiles(drive, '/Trip/', { recursive: false })
      expect(listed.entries.map((entry) => entry.path)).to.deep.equal(['/Trip/a.jpg', '/Trip/c.srt'])
      expect((await listDriveFiles(drive, '/', { recursive: false })).entries.map((entry) => entry.path)).to.deep.equal(['/top.txt'])
    })

    it('stops at the most it lists, and says so', async function () {
      expect(MAX_LISTED_FILES).to.equal(50000)
      const cut = await listDriveFiles(drive, '/', { maxFiles: 2 })
      expect(cut.entries).to.have.length(2)
      expect(cut.truncated).to.equal(true)
      const exact = await listDriveFiles(drive, '/', { maxFiles: 4 })
      expect(exact.entries).to.have.length(4)
      expect(exact.truncated).to.equal(false)
    })

    it('tells an empty folder from one with nothing in it at all', async function () {
      expect(await listDriveFiles(drive, '/nothing/')).to.deep.equal({ entries: [], truncated: false, empty: true })
    })

    it('gives up on a drive that stops sending, as timeout', async function () {
      let returned = false
      const stuck = {
        list: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise(() => {}),
            return: async () => { returned = true; return { done: true } }
          })
        })
      }
      const error = await listDriveFiles(stuck, '/', { idleMs: 50 }).catch((caught) => caught)
      expect(error.code).to.equal('timeout')
      expect(returned).to.equal(true)
    })

    it('names a drive only as this computer made it', function () {
      const id = 'ab'.repeat(32)
      const other = 'cd'.repeat(32)
      const records = [
        { name: 'Someone else\'s', id: other },
        { name: '  Goa trip 2024  ', id }
      ]
      expect(knownDriveName(records, id)).to.equal('Goa trip 2024')
      expect(knownDriveName(records, 'ef'.repeat(32))).to.equal(null)
      expect(knownDriveName(records, null)).to.equal(null)
      // What PeerSky calls an upload given no name, and names no drive could be made with.
      for (const name of ['Drive', '', '   ', 'line\nbreak', 'x'.repeat(256), 42, null, undefined]) {
        expect(knownDriveName([{ name, id }], id), String(name)).to.equal(null)
      }
      expect(knownDriveName([{ name: 'Private files from your phone', id }], id)).to.equal('Private files from your phone')
    })

    it('words each failure with a code the views know', function () {
      expect(listFailure(Object.assign(new Error('nobody'), { code: 'no-peers' }))).to.deep.equal({ code: 'no-peers', message: 'nobody' })
      expect(listFailure(Object.assign(new Error('slow'), { code: 'REQUEST_TIMEOUT' })).code).to.equal('timeout')
      expect(listFailure(new Error('DNS-Link Record not found for TXT _dnslink.example.org')).code).to.equal('not-found')
      expect(listFailure(Object.assign(new Error('gone'), { code: 'ENOENT' }))).to.deep.equal({ code: 'unknown', message: 'gone' })
      expect(listFailure(undefined).code).to.equal('unknown')
    })
  })

  describe('the number the views\' stored pictures go with', function () {
    let profile

    beforeEach(function () {
      profile = mkdtempSync(path.join(os.tmpdir(), 'peersky-views-epoch-'))
    })

    afterEach(function () {
      rmSync(profile, { recursive: true, force: true })
    })

    it('is 0 until a reset, then higher after each one', async function () {
      expect(await readCacheEpoch(profile)).to.equal(0)
      const first = await bumpCacheEpoch(profile)
      expect(first).to.be.above(0)
      expect(await readCacheEpoch(profile)).to.equal(first)
      expect(JSON.parse(readFileSync(path.join(profile, VIEWS_FILE), 'utf8'))).to.deep.equal({ epoch: first })
      const [second, third] = await Promise.all([bumpCacheEpoch(profile), bumpCacheEpoch(profile)])
      expect(second).to.be.above(first)
      expect(third).to.be.above(second)
      expect(await readCacheEpoch(profile)).to.equal(third)
    })

    it('reads a broken file as 0 and still moves on from it', async function () {
      writeFileSync(path.join(profile, VIEWS_FILE), '{not json')
      expect(await readCacheEpoch(profile)).to.equal(0)
      expect(await bumpCacheEpoch(profile)).to.be.above(0)
      writeFileSync(path.join(profile, VIEWS_FILE), JSON.stringify({ epoch: -4 }))
      expect(await readCacheEpoch(profile)).to.equal(0)
    })
  })

  describe('the views\' addresses on peersky://', function () {
    let pages, handler

    before(async function () {
      pages = mkdtempSync(path.join(os.tmpdir(), 'peersky-views-pages-'))
      const app = path.join(pages, 'p2p', 'hyperdrive')
      mkdirSync(path.join(app, 'viewer', 'lib'), { recursive: true })
      writeFileSync(path.join(app, 'index.html'), 'the upload app')
      writeFileSync(path.join(app, 'viewer', 'index.html'), 'the views')
      writeFileSync(path.join(app, 'viewer', 'app.js'), 'export {}')
      writeFileSync(path.join(app, 'viewer', 'lib', 'kinds.js'), 'export const kinds = 1')
      const { createHandler } = await esmock.strict('../../src/protocols/peersky-protocol.js', {
        electron: { app: { isPackaged: false, getPath: () => pages } },
        '../../src/protocols/pages-path.js': { getPagesPath: () => pages },
        '../../src/extensions/index.js': { default: { loadedExtensions: new Map() } }
      })
      handler = await createHandler()
    })

    after(function () {
      rmSync(pages, { recursive: true, force: true })
    })

    const get = (url) => handler(new Request(url))

    it('serves the one viewer page for Files, Photos and Videos, alone or with a folder', async function () {
      for (const url of [
        `peersky://p2p/hyperdrive/files/${KEY}/?auto`,
        `peersky://p2p/hyperdrive/photos/${KEY}/2024/Goa%20Trip/#album=/2024/`,
        'peersky://p2p/hyperdrive/videos/example.org/Shows/',
        'peersky://p2p/hyperdrive/videos',
        'peersky://p2p/hyperdrive/files/'
      ]) {
        const response = await get(url)
        expect(response.status, url).to.equal(200)
        expect(response.headers.get('Content-Type'), url).to.match(/text\/html/)
        expect(await response.text(), url).to.equal('the views')
      }
    })

    it('serves the viewer\'s own files and the rest of the app as before', async function () {
      const script = await get('peersky://p2p/hyperdrive/viewer/app.js')
      expect(script.headers.get('Content-Type')).to.match(/javascript/)
      expect(await script.text()).to.equal('export {}')
      expect(await (await get('peersky://p2p/hyperdrive/viewer/lib/kinds.js')).text()).to.equal('export const kinds = 1')
      expect(await (await get('peersky://p2p/hyperdrive/')).text()).to.equal('the upload app')
      // Only those three names are views.
      expect((await get('peersky://p2p/hyperdrive/filesx/')).type).to.equal('error')
      expect((await get('peersky://p2p/hyperdrive/viewer/missing.js')).type).to.equal('error')
    })
  })

  describe('what the views may ask the main process', function () {
    let handlers, listed, downloads, profile

    beforeEach(async function () {
      handlers = new Map()
      listed = []
      downloads = []
      profile = mkdtempSync(path.join(os.tmpdir(), 'peersky-views-ipc-'))
      const { setupHyperdriveViewsIpc } = await esmock.strict('../../src/protocols/hyperdrive-views-ipc.js', {
        '../../src/protocols/hyper-handler.js': {
          listHyperdrive: async (url, options) => {
            listed.push([url, options])
            return { entries: [], truncated: false, private: false, writable: false }
          }
        }
      }, {
        electron: {
          ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
          app: { getPath: () => profile }
        }
      })
      setupHyperdriveViewsIpc()
    })

    afterEach(function () {
      rmSync(profile, { recursive: true, force: true })
    })

    const from = (url) => ({
      senderFrame: { url },
      sender: { downloadURL: (file) => downloads.push(file) }
    })

    it('answers the Hyperdrive app and its views', async function () {
      const views = from(`peersky://p2p/hyperdrive/photos/${KEY}/2024/?auto#album=/2024/`)
      expect(await handlers.get('hyperdrive-list')(views, `hyper://${KEY}/2024/`, { recursive: true })).to.have.property('entries')
      await handlers.get('hyperdrive-list')(from('peersky://p2p/hyperdrive/'), `hyper://${KEY}/`, { recursive: false })
      await handlers.get('hyperdrive-list')(views, `hyper://${KEY}/`)
      expect(listed).to.deep.equal([
        [`hyper://${KEY}/2024/`, { recursive: true }],
        [`hyper://${KEY}/`, { recursive: false }],
        [`hyper://${KEY}/`, { recursive: true }]
      ])

      expect(await handlers.get('hyperdrive-cache-epoch')(views)).to.equal(0)
      const epoch = await bumpCacheEpoch(profile)
      expect(await handlers.get('hyperdrive-cache-epoch')(views)).to.equal(epoch)

      expect(await handlers.get('hyperdrive-download')(views, `hyper://${KEY}/2024/IMG%201.jpg`)).to.equal(true)
      expect(downloads).to.deep.equal([`hyper://${KEY}/2024/IMG%201.jpg`])
    })

    it('downloads files of hyper:// drives and nothing else', async function () {
      const views = from(`peersky://p2p/hyperdrive/files/${KEY}/`)
      for (const url of [`hyper://${KEY}/2024/`, 'https://example.com/a.jpg', 'file:///etc/passwd', 'hyper://localhost/a.jpg', undefined]) {
        let error = null
        await Promise.resolve().then(() => handlers.get('hyperdrive-download')(views, url)).catch((caught) => { error = caught })
        expect(error?.message, String(url)).to.match(/Only a file in a hyper:\/\/ drive/)
      }
      expect(downloads).to.deep.equal([])
    })

    it('answers no other page, another P2P app on the same host included', async function () {
      for (const url of [
        'peersky://p2p/peerchat/',
        'peersky://p2p/hyperdrive-evil/files/',
        'peersky://p2p/',
        'hyper://p2p/hyperdrive/files/',
        'peersky://settings/',
        'peersky://myapps/hyperdrive/',
        'https://example.com/hyperdrive/',
        undefined
      ]) {
        for (const [channel, args] of [
          ['hyperdrive-list', [`hyper://${KEY}/`, { recursive: true }]],
          ['hyperdrive-cache-epoch', []],
          ['hyperdrive-download', [`hyper://${KEY}/a.jpg`]]
        ]) {
          let error = null
          await Promise.resolve().then(() => handlers.get(channel)(from(url), ...args)).catch((caught) => { error = caught })
          expect(error?.message, `${channel} from ${url}`).to.equal('Forbidden')
        }
      }
      expect(listed).to.deep.equal([])
      expect(downloads).to.deep.equal([])
    })

    it('is set up by main', async function () {
      const main = await readFile(new URL('../../src/main.js', import.meta.url), 'utf8')
      expect(main).to.match(/\n {2}setupHyperdriveViewsIpc\(\)\n/)
    })
  })

  // The preload as a tab runs it, with Electron and the page stood in for.
  describe('the preload on the views\' pages', function () {
    async function runPreload (href) {
      const source = await readFile(new URL('../../src/pages/unified-preload.js', import.meta.url), 'utf8')
      const exposed = {}
      const invoked = []
      const added = []
      const classList = { add () {}, remove () {} }
      const document = {
        readyState: 'complete',
        head: { appendChild: (node) => added.push(node), insertBefore: (node) => added.push(node), firstChild: null },
        body: { classList, style: {}, appendChild: (node) => added.push(node) },
        documentElement: { setAttribute () {}, dataset: {} },
        styleSheets: [],
        createElement: (tag) => ({ tagName: tag.toUpperCase(), textContent: '', style: {}, classList }),
        addEventListener () {},
        querySelector: () => null,
        getElementById: () => null,
        getElementsByTagName: () => [document.head]
      }
      const electron = {
        contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api } },
        ipcRenderer: {
          invoke: async (...args) => { invoked.push(args); return null },
          send () {},
          sendSync: () => null,
          on () {},
          removeListener () {}
        },
        webUtils: { getPathForFile: () => '' }
      }
      const require = (name) => {
        if (name === 'electron') return electron
        throw new Error(`the preload asked for ${name}`)
      }
      const quiet = { log () {}, warn () {}, error () {} }
      const window = { location: new URL(href), addEventListener () {} }
      const run = new Function('require', 'window', 'document', 'process', 'navigator', 'console', source) // eslint-disable-line no-new-func
      run(require, window, document, { versions: { electron: '43' }, platform: 'darwin', env: {} }, { userAgent: 'test' }, quiet)
      // The page's styles come in after a few answers from the main process.
      await new Promise((resolve) => setTimeout(resolve, 10))
      return { exposed, invoked, scripts: added.filter((node) => node.tagName === 'SCRIPT') }
    }

    it('hands the views their channels, and adds no script their CSP would refuse', async function () {
      for (const href of [
        `peersky://p2p/hyperdrive/photos/${KEY}/2024/?auto#album=/2024/`,
        `peersky://p2p/hyperdrive/files/${KEY}/`,
        'peersky://p2p/hyperdrive/videos',
        'peersky://p2p/hyperdrive/viewer/index.html'
      ]) {
        const { exposed, invoked, scripts } = await runPreload(href)
        expect(scripts, href).to.have.length(0)
        // The rest of the LLM bridge is there as before.
        expect(exposed._llmBridge, href).to.be.an('object')
        const { hyperdrive } = exposed.electronAPI
        await hyperdrive.list(`hyper://${KEY}/2024/`, { recursive: true })
        await hyperdrive.cacheEpoch()
        await hyperdrive.download(`hyper://${KEY}/2024/a.jpg`)
        expect(invoked.filter(([channel]) => channel.startsWith('hyperdrive-')), href).to.deep.equal([
          ['hyperdrive-list', `hyper://${KEY}/2024/`, { recursive: true }],
          ['hyperdrive-cache-epoch'],
          ['hyperdrive-download', `hyper://${KEY}/2024/a.jpg`]
        ])
      }
    })

    it('still adds window.llm everywhere else, the Hyperdrive app itself included', async function () {
      for (const href of [
        'peersky://p2p/hyperdrive/',
        'peersky://p2p/hyperdrive/index.html',
        'peersky://p2p/p2pmd/',
        'peersky://settings/',
        `hyper://${KEY}/hyperdrive/files/`
      ]) {
        const { scripts } = await runPreload(href)
        expect(scripts, href).to.have.length(1)
        expect(scripts[0].textContent, href).to.contain('window.llm = {')
      }
    })
  })
})
