import { expect } from 'chai'
import { resolveHyperdriveUploadTarget } from '../../src/protocols/hyper-drive-visibility.js'

describe('Hyperdrive upload visibility', function () {
  it('maps supported visibility to per-upload drives', function () {
    expect(resolveHyperdriveUploadTarget('public', 'public-file')).to.deep.equal({
      driveName: 'public-file',
      autoJoin: true
    })
    expect(resolveHyperdriveUploadTarget('private', 'private-file')).to.deep.equal({
      driveName: 'private-file',
      autoJoin: false
    })
    expect(resolveHyperdriveUploadTarget('shared', 'file')).to.equal(null)
  })
})
