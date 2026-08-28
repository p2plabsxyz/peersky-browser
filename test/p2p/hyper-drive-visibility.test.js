import { expect } from 'chai'
import sinon from 'sinon'

import {
  getExistingNamedDrive,
  resolveHyperdriveUploadTarget
} from '../../src/protocols/hyper-drive-visibility.js'

describe('Hyperdrive upload visibility', function () {
  it('maps supported visibility to stable named drives', function () {
    expect(resolveHyperdriveUploadTarget('public')).to.deep.equal({
      driveName: 'hyperdrive-public',
      autoJoin: true
    })
    expect(resolveHyperdriveUploadTarget('private')).to.deep.equal({
      driveName: 'hyperdrive-private',
      autoJoin: false
    })
    expect(resolveHyperdriveUploadTarget('shared')).to.equal(null)
  })

  it('does not create a missing private drive during startup', async function () {
    const getDrive = sinon.stub()
    const runtime = createRuntime({ getDrive, discoveryKey: null })

    expect(await getExistingNamedDrive(runtime, {
      driveName: 'hyperdrive-private',
      autoJoin: false
    })).to.equal(null)
    expect(getDrive.called).to.equal(false)
  })

  it('restores an existing private drive without announcing it', async function () {
    const drive = { id: 'private-drive' }
    const getDrive = sinon.stub().resolves(drive)
    const runtime = createRuntime({ getDrive, discoveryKey: Buffer.from('key') })

    expect(await getExistingNamedDrive(runtime, {
      driveName: 'hyperdrive-private',
      autoJoin: false
    })).to.equal(drive)
    expect(getDrive.calledOnceWithExactly('hyperdrive-private', {
      autoJoin: false
    })).to.equal(true)
  })
})

function createRuntime ({ getDrive, discoveryKey }) {
  return {
    getDrive,
    namespace: sinon.stub().returns({
      ns: Buffer.from('private'),
      storage: {
        getAlias: sinon.stub().resolves(discoveryKey),
        hasCore: sinon.stub().resolves(Boolean(discoveryKey))
      }
    })
  }
}
