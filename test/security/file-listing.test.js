// A folder listing publishes its folder. It reads the list of files and each
// file with a token for that folder, which only the listing has, as the request
// gate lets no other page read a local file.

import { expect } from 'chai'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { createHandler } from '../../src/protocols/file-handler.js'
import { gateRequest, listingToken, LISTING_PARAM } from '../../src/protocols/request-gate.js'

describe('file handler: folder listing', () => {
  let dir
  let folderUrl
  let handle

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'peersky-listing-'))
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'a.txt'), 'a')
    await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'b')
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

  it("puts its folder's token in the listing, which never loads as a script or a stylesheet", async () => {
    const res = await handle(new Request(folderUrl))
    expect(res.headers.get('x-content-type-options')).to.equal('nosniff')
    expect(await res.text()).to.include(`'${LISTING_PARAM}', '${listingToken(folderUrl)}'`)
  })

  it('lists the files for the listing alone', async () => {
    expect((await handle(new Request(manifestUrl()))).status).to.equal(403)
    expect((await handle(new Request(manifestUrl('f'.repeat(64))))).status).to.equal(403)
    expect((await handle(new Request(manifestUrl(listingToken(folderUrl))))).status).to.equal(200)
  })

  it('gives each file a URL the gate lets the listing read', async () => {
    const { files } = await (await handle(new Request(manifestUrl(listingToken(folderUrl))))).json()
    expect(files.map((file) => file.relativePath).sort()).to.deep.equal(['a.txt', path.join('sub', 'b.txt')])
    for (const file of files) {
      const verdict = gateRequest({ url: file.fileUrl, method: 'GET', resourceType: 'xhr', initiatorOrigin: 'file://', frameUrl: folderUrl, source: 'tab' })
      expect(verdict.action, file.relativePath).to.equal('allow')
      expect(await (await handle(new Request(file.fileUrl))).text()).to.equal(file.name === 'a.txt' ? 'a' : 'b')
    }
  })
})
