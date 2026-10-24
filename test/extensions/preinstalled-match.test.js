// History and uBlock were removed and imported again on every start, because
// preinstalled.json names them differently from their manifests, and a History
// tab left open then crashed the next start.

import { expect } from 'chai'
import { readFile } from 'fs/promises'

import { matchesPreinstalledEntry, preinstalledEntryKey } from '../../src/extensions/utils/preinstalled.js'

const bundled = JSON.parse(await readFile(new URL('../../src/extensions/preinstalled-extensions/preinstalled.json', import.meta.url), 'utf8')).extensions
const manager = await readFile(new URL('../../src/extensions/index.js', import.meta.url), 'utf8')

describe('preinstalled extensions', function () {
  it('finds what each bundled entry installed, though the names differ, so nothing is taken for removed', function () {
    // As a profile from before recorded them.
    const installed = [
      { id: 'gbefmodhlophhakmoecijeppjblibmie', name: '__MSG_ext_name__', displayName: 'Linguist - web page translator' },
      { id: 'afed918b9e670e12116909186ff4765c', name: 'peersky-history', displayName: 'peersky-history' },
      { id: 'ab9887a9becdfb5f55b1d922fd813e07', name: 'Consent Autodeny', displayName: 'Consent Autodeny' },
      { id: '9d9d3b3a7a3ec9611887957d5467bf76', name: 'uBlock Origin development build', displayName: 'uBlock Origin development build' },
      { id: '8418b924f5ae64890d9ca47b47ded964', name: 'Wayback Machine', displayName: 'Wayback Machine' }
    ]
    for (const ext of installed) {
      expect(bundled.filter((entry) => matchesPreinstalledEntry(ext, entry)), ext.name).to.have.length(1)
    }
  })

  it('goes by the entry an import recorded, so an entry that left the list is still removed', function () {
    const history = { id: 'afed918b9e670e12116909186ff4765c', name: 'peersky-history', preinstalledEntry: 'PeerSky History' }
    expect(matchesPreinstalledEntry(history, { name: 'PeerSky History' })).to.equal(true)
    expect(matchesPreinstalledEntry(history, { name: 'Consent Autodeny' })).to.equal(false)
    expect(matchesPreinstalledEntry({ id: 'old', name: 'PeerSky History Beta', preinstalledEntry: 'PeerSky History Beta' }, { name: 'PeerSky History' })).to.equal(false)
    expect(preinstalledEntryKey({ id: 'gbefmodhlophhakmoecijeppjblibmie', name: 'Linguist' })).to.equal('gbefmodhlophhakmoecijeppjblibmie')
    expect(preinstalledEntryKey({ name: 'Wayback Machine', archive: 'wayback.zip' })).to.equal('Wayback Machine')
  })

  it('records the entry on every import, and on a record from before when it matches', function () {
    expect(manager).to.contain('extData.preinstalledEntry = preinstalledEntryKey(entry)')
    expect(manager).to.match(/if \(existing\.preinstalledEntry !== preinstalledEntryKey\(entry\)\) \{\s+existing\.preinstalledEntry = preinstalledEntryKey\(entry\)\s+await this\._writeRegistry\(\)/)
  })
})
