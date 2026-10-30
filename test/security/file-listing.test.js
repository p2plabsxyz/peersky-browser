// A folder listing publishes its folder. It reads the list of files and each
// file with a token for that folder, which only the listing has, as the request
// gate lets no other page read a local file. The same token lets it make a
// private drive to publish to.

import { expect } from 'chai'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { pathToFileURL } from 'url'
import { createHandler } from '../../src/protocols/file-handler.js'
import { gateRequest, isListingRead, listingToken, LISTING_HEADER, LISTING_PARAM } from '../../src/protocols/request-gate.js'

describe('file handler: folder listing', () => {
  let dir
  let folderUrl
  let handle

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-listing-'))
    await fs.mkdir(path.join(dir, 'sub dir'))
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    await fs.writeFile(path.join(dir, 'sub dir', 'b c.txt'), 'b')
    await fs.utimes(path.join(dir, 'sub dir', 'b c.txt'), new Date('2020-01-02T12:30:00Z'), new Date('2020-01-02T12:30:00Z'))
    folderUrl = `${pathToFileURL(dir).href}/`
    handle = await createHandler()
  })

  after(() => fs.rm(dir, { recursive: true, force: true }))

  const manifestUrl = (token) => {
    const url = new URL(folderUrl)
    url.searchParams.set('__publishManifest', '1')
    if (token) url.searchParams.set(LISTING_PARAM, token)
    return url.href
  }

  // Runs the listing's own script with a stand-in page, and keeps every
  // request it makes. Local files are answered by the file handler.
  async function publish (protocol, visibility) {
    const html = await (await handle(new Request(folderUrl))).text()
    const elements = {}
    const element = (id) => (elements[id] ||= { id, value: '', hidden: false, textContent: '', appendChild (child) { this.link = child } })
    element('protocolSelect').value = 'hyper'
    element('visibilitySelect').value = 'public'
    const sent = []
    const sandbox = {
      URL,
      URLSearchParams,
      File,
      FormData,
      console: { log () {}, error () {} },
      location: new URL(folderUrl),
      document: { getElementById: element, createElement: () => ({}) },
      fetch: async (url, init = {}) => {
        sent.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body })
        if (String(url).startsWith('file:')) return handle(new Request(url))
        if (String(url).startsWith('hyper://localhost/')) return new Response('hyper://drive/')
        return new Response('', { headers: { Location: 'ipfs://cid/' } })
      }
    }
    sandbox.window = sandbox
    vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], sandbox)
    element('protocolSelect').value = protocol
    element('protocolSelect').onchange()
    element('visibilitySelect').value = visibility
    element('visibilitySelect').onchange()
    await sandbox.publishDirectory()
    return { sent, status: element('status').textContent, link: element('result').link?.href, elements }
  }

  it("puts its folder's token in the listing, which never loads as a script or a stylesheet", async () => {
    const res = await handle(new Request(folderUrl))
    expect(res.headers.get('x-content-type-options')).to.equal('nosniff')
    expect(await res.text()).to.include(`const listingToken = '${listingToken(folderUrl)}'`)
  })

  it('lists the files for the listing alone', async () => {
    expect((await handle(new Request(manifestUrl()))).status).to.equal(403)
    expect((await handle(new Request(manifestUrl('f'.repeat(64))))).status).to.equal(403)
    expect((await handle(new Request(manifestUrl(listingToken(folderUrl))))).status).to.equal(200)
  })

  it('gives each file a URL the gate lets the listing read, its path with / and its date', async () => {
    const { files } = await (await handle(new Request(manifestUrl(listingToken(folderUrl))))).json()
    expect(files.map((file) => file.relativePath).sort()).to.deep.equal(['a.txt', 'sub dir/b c.txt'])
    expect(files.find((file) => file.name === 'b c.txt').lastModified).to.equal(Date.parse('2020-01-02T12:30:00Z'))
    for (const file of files) {
      const verdict = gateRequest({ url: file.fileUrl, method: 'GET', resourceType: 'xhr', initiatorOrigin: 'file://', frameUrl: folderUrl, source: 'tab' })
      expect(verdict.action, file.relativePath).to.equal('allow')
      expect(await (await handle(new Request(file.fileUrl))).text()).to.equal(file.name === 'a.txt' ? 'a' : 'b')
    }
  })

  it('publishes to a public hyper:// drive with each file at its own path', async () => {
    const { sent, status, link } = await publish('hyper', 'public')
    expect(status).to.equal('✅ Published!')
    expect(link).to.equal('hyper://drive/')
    const make = sent.find((request) => request.url.startsWith('hyper://localhost/'))
    expect(new URL(make.url).searchParams.get('visibility')).to.equal('public')
    const puts = sent.filter((request) => request.method === 'PUT')
    expect(puts.map((request) => request.url).sort()).to.deep.equal(['hyper://drive/a.txt', 'hyper://drive/sub%20dir/b%20c.txt'])
    expect(puts.find((request) => request.url.endsWith('b%20c.txt')).headers['Last-Modified']).to.equal('Thu, 02 Jan 2020 12:30:00 GMT')
  })

  it('publishes privately under the folder name, proving with each request that it is the listing', async () => {
    const { sent, status, link } = await publish('hyper', 'private')
    const folder = encodeURIComponent(path.basename(dir))
    expect(status).to.equal('✅ Published!')
    expect(link).to.equal(`hyper://drive/${folder}/`)
    const hyper = sent.filter((request) => request.url.startsWith('hyper://'))
    expect(new URL(hyper[0].url).searchParams.get('visibility')).to.equal('private')
    expect(hyper.slice(1).map((request) => request.url).sort()).to.deep.equal([`hyper://drive/${folder}/a.txt`, `hyper://drive/${folder}/sub%20dir/b%20c.txt`])
    for (const request of hyper) {
      expect(isListingRead(new URL(request.headers[LISTING_HEADER])), request.url).to.equal(true)
    }
  })

  it('publishes to IPFS with each file under the folder name, which the IPFS handler takes off', async () => {
    const { sent, status, link, elements } = await publish('ipfs', 'private')
    expect(elements.visibilitySelect.hidden, 'no private choice for IPFS').to.equal(true)
    expect(status).to.equal('✅ Published!')
    expect(link).to.equal('ipfs://cid/')
    const upload = sent.find((request) => request.url.startsWith('ipfs://'))
    const names = [...upload.body.values()].map((file) => file.name).sort()
    expect(names).to.deep.equal([`${path.basename(dir)}/a.txt`, `${path.basename(dir)}/sub dir/b c.txt`])
  })
})
