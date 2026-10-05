import { expect } from 'chai'
import { readFile } from 'fs/promises'
import { toHyperFetchUrl } from '../../src/protocols/hyper-fetch-url.js'

const drive = `hyper://${'a'.repeat(52)}`
// What hypercore-fetch does with the path before it looks the file up.
const lookedUp = (url) => decodeURI(new URL(url).pathname)

describe('hyper:// addresses given to hypercore-fetch', function () {
  // PeerTunes uploaded "Safe & Sound.mp3" as "Safe %26 Sound.mp3", and the
  // phone, asking for the real name, could not play it.
  it('reads and writes the name a page escaped with encodeURIComponent', function () {
    expect(lookedUp(toHyperFetchUrl(`${drive}/music/05%20-%20Safe%20%26%20Sound.mp3`))).to.equal('/music/05 - Safe & Sound.mp3')
    expect(lookedUp(toHyperFetchUrl(`${drive}/a%2Cb%3Bc%3Dd%2Be%24f%40g%3Ah.png`))).to.equal('/a,b;c=d+e$f@g:h.png')
    expect(lookedUp(toHyperFetchUrl(`${drive}/100%25%20done.txt`))).to.equal('/100% done.txt')
  })

  it('leaves what is already right, and what it cannot read, as it was', function () {
    expect(toHyperFetchUrl(`${drive}/a%20b/c.mp3`)).to.equal(`${drive}/a%20b/c.mp3`)
    expect(toHyperFetchUrl(`${drive}/x%2Fy.txt`)).to.equal(`${drive}/x%2Fy.txt`)
    expect(toHyperFetchUrl(`${drive}/what%3F%23.mp3`)).to.equal(`${drive}/what%3F%23.mp3`)
    expect(toHyperFetchUrl(`${drive}/bad%E0%A4%A.mp3`)).to.equal(`${drive}/bad%E0%A4%A.mp3`)
    expect(toHyperFetchUrl(drive)).to.equal(drive)
    expect(toHyperFetchUrl('https://example.com/a%26b')).to.equal('https://example.com/a%26b')
  })

  it('keeps the query, which names the drive to create', function () {
    expect(toHyperFetchUrl('hyper://localhost/?key=my%26app&visibility=public')).to.equal('hyper://localhost/?key=my%26app&visibility=public')
    expect(toHyperFetchUrl(`${drive}/a%26b.mp3?noResolve`)).to.equal(`${drive}/a&b.mp3?noResolve`)
  })

  it('is used for page reads, uploads and saving a file to disk', async function () {
    const handler = await readFile(new URL('../../src/protocols/hyper-handler.js', import.meta.url), 'utf8')
    expect(handler).to.match(/const resp = await fetchFn\(toHyperFetchUrl\(url\), \{/)
    expect(handler).to.match(/_hyperFetchToFile\(context\.fetch, prepare, toHyperFetchUrl\(address\), destPath, onStatus\)/)
  })
})
