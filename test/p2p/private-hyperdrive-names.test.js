// A private upload named with spaces or brackets was saved under its
// percent-encoded name, and the drive's list encoded that again, so the movie
// opened from the uploading desktop's own drive said "File not found".
import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { create } from 'hyper-sdk'
import { makePrivateDriveFetcher } from '../../src/protocols/private-hyperdrive.js'
import { rememberPrivateHyperdrive } from '../../src/protocols/private-hyperdrive-registry.js'

const NAME = 'Insidious.Out.Of.The.Further.2026.1080p.WEBRip.x264.AAC5.1-[YTS.GG - YTS.BZ].mp4'
// What the Hyperdrive app builds for an upload.
const linkFor = (drive, name) => drive.url + name.split('/').map(encodeURIComponent).join('/')

describe('private file names with spaces and brackets', function () {
  this.timeout(20000)
  let userData, sdk, fetcher, drive

  before(async () => {
    userData = mkdtempSync(path.join(os.tmpdir(), 'peersky-private-names-'))
    sdk = await create({ storage: path.join(userData, 'hyper-private'), swarmOpts: { bootstrap: [], port: 0 }, autoJoin: false })
    fetcher = makePrivateDriveFetcher(sdk, userData)
    drive = await fetcher.openByName(NAME)
    await rememberPrivateHyperdrive(userData, { name: NAME, url: drive.url, timestamp: Date.now(), encrypted: true })
  })

  after(async () => {
    await sdk?.close()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('saves the file under its name, and opens it every way it is reached', async () => {
    const put = await fetcher(linkFor(drive, NAME), { method: 'PUT', body: Buffer.from('movie bytes') })
    expect(put.status).to.equal(200)
    const names = []
    for await (const name of drive.readdir('/')) names.push(name)
    expect(names).to.deep.equal([NAME])

    // The link the upload gave.
    expect(await (await fetcher(linkFor(drive, NAME))).text()).to.equal('movie bytes')
    // The link in the drive's own list.
    const listing = await (await fetcher(drive.url)).text()
    const listed = listing.match(/href="([^"]+)"/)[1]
    const fromList = await fetcher(listed)
    expect(fromList.status).to.equal(200)
    expect(await fromList.text()).to.equal('movie bytes')
  })

  it('still opens a file saved before, under its encoded name', async () => {
    const old = 'Old%20Movie%20%5B2026%5D.mp4'
    await drive.put(`/${old}`, Buffer.from('old bytes'))
    // The link its upload gave, which encoded the name once.
    const link = `${drive.url}${old}`
    const response = await fetcher(link)
    expect(response.status).to.equal(200)
    expect(await response.text()).to.equal('old bytes')
    // And from the list, which encodes the stored name again.
    const listing = await (await fetcher(drive.url)).text()
    const listed = [...listing.matchAll(/href="([^"]+)"/g)].map((match) => match[1]).find((href) => href.includes('Old'))
    expect((await fetcher(listed)).status).to.equal(200)
  })

  it('says what is missing is missing, and refuses a path that cannot be read', async () => {
    expect((await fetcher(`${drive.url}nothing%20here.mp4`)).status).to.equal(404)
    expect((await fetcher(`${drive.url}bad%E0%A4%A.mp4`)).status).to.equal(400)
  })
})
