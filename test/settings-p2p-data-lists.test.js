import { expect } from 'chai'
import { readFile } from 'fs/promises'
import { parseListRemoval, removeFromP2pDataList } from '../src/p2p-data-lists.js'

// Windows checks the repo out with CRLF line endings.
const source = async (file) => (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

// The lists in Settings, P2P data could only be cleared by time. Each row now
// has its own remove button, which takes that entry off its list and leaves
// the data where it is, as Clear All does.
describe('removing one row from the P2P data lists', function () {
  const lists = () => ({
    hyperCache: [
      { name: 'p2pmd', key: 'k-app', timestamp: 1 },
      { name: 'p2pmd', key: 'k-app', timestamp: 2 },
      { name: 'trip.jpg', key: 'k-trip', timestamp: 3 },
      { name: 'notes', key: 'k-notes', timestamp: 4 }
    ],
    ipfsCache: [
      { name: 'a.txt', cid: 'cid-a', url: 'ipfs://cid-a/a.txt', timestamp: 1 },
      { name: 'b.txt', cid: 'cid-b', url: 'ipfs://cid-b/b.txt', timestamp: 2 }
    ],
    ensCache: new Map([['vitalik.eth', { hash: 'ipfs://x', timestamp: 1 }], ['nick.eth', 'ipfs://y']])
  })

  it('takes a Hyper drive off by its key, every entry for it, and keeps the rest in the same array', function () {
    const data = lists()
    const before = data.hyperCache
    expect(removeFromP2pDataList(data, { list: 'hyper', ids: ['k-app'] })).to.deep.equal({ list: 'hyper', removed: 2 })
    expect(data.hyperCache).to.equal(before)
    expect(data.hyperCache.map((entry) => entry.key)).to.deep.equal(['k-trip', 'k-notes'])
    expect(data.ipfsCache).to.have.length(2)
    expect(data.ensCache.size).to.equal(2)
  })

  it('takes an IPFS upload off by its CID and an ENS name off by its name', function () {
    const data = lists()
    expect(removeFromP2pDataList(data, { list: 'ipfs', ids: ['cid-b'] }).removed).to.equal(1)
    expect(data.ipfsCache.map((entry) => entry.cid)).to.deep.equal(['cid-a'])
    expect(removeFromP2pDataList(data, { list: 'ens', ids: ['nick.eth'] }).removed).to.equal(1)
    expect([...data.ensCache.keys()]).to.deep.equal(['vitalik.eth'])
    expect(data.hyperCache).to.have.length(4)
  })

  it('says nothing went when the entry is already gone', function () {
    const data = lists()
    expect(removeFromP2pDataList(data, { list: 'hyper', ids: ['k-missing'] }).removed).to.equal(0)
    expect(data.hyperCache).to.have.length(4)
  })

  it('refuses a list it does not know, or nothing to remove', function () {
    for (const request of [
      undefined,
      { list: 'bookmarks', ids: ['x'] },
      { list: 'hyper' },
      { list: 'hyper', ids: [] },
      { list: 'hyper', ids: [''] },
      { list: 'hyper', ids: [42] },
      { list: 'ipfs', ids: ['x'.repeat(1025)] },
      { list: 'ens', ids: Array.from({ length: 501 }, (_, i) => `n${i}.eth`) }
    ]) {
      expect(() => parseListRemoval(request), JSON.stringify(request)?.slice(0, 60)).to.throw()
    }
  })

  it('is asked for only by Settings, and saves the list that changed', async function () {
    const manager = await source('../src/settings-manager.js')
    const handler = manager.slice(manager.indexOf("'settings-remove-archive-entries'"), manager.indexOf('async loadSettings ()'))
    expect(handler.indexOf("isPeerskyPage(event?.senderFrame?.url, 'settings')")).to.be.above(-1)
    expect(handler.indexOf("isPeerskyPage(event?.senderFrame?.url, 'settings')")).to.be.below(handler.indexOf('removeFromP2pDataList('))
    expect(handler).to.contain("if (list === 'hyper') saveHyperCache()")
    expect(handler).to.contain("else if (list === 'ipfs') saveIpfsCache()")
    expect(handler).to.contain('else saveEnsCache()')

    for (const file of ['../src/pages/unified-preload.js', '../src/pages/static/js/settings.js']) {
      expect(await source(file), file).to.contain("('settings-remove-archive-entries', { list, ids })")
    }
  })

  it('puts a remove button on every row of the four lists, and stays on the page after one goes', async function () {
    const archive = await source('../src/pages/static/js/archive.js')
    for (const call of ["removeButton('hyper-app', safeName, safeName)", "removeButton('hyper', safeKey, safeName)", "removeButton('ipfs', safeCid, safeName)", "removeButton('ens', safeName, safeName)"]) {
      expect(archive).to.contain(call)
    }
    expect(archive.match(/onRendered: attachRowListeners,\n\s+keepPage/g)).to.have.length(4)
    expect(archive).to.contain('await loadArchiveData({ keepPage: true })')
    // A row of P2P app drives is every entry under that app's name.
    expect(archive).to.contain('shownHyperEntries.filter(item => item.name === removeId).map(item => item.key)')

    const pagination = await source('../src/pages/static/js/pagination.js')
    expect(pagination).to.contain('if (!keepPage) this.currentPage = 1')
  })
})
