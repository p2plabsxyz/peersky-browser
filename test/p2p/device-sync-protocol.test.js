import { expect } from 'chai'
import {
  checkDeviceSyncProof,
  deviceSyncProof,
  deviceSyncTopic,
  helloFrame,
  MAX_ANNOUNCED_DRIVES,
  parseDeviceSyncFrame,
  proofFrame
} from '../../src/protocols/device-sync-protocol.js'

const KEY = '0f'.repeat(32)
const HANDSHAKE = '0e'.repeat(64)
const SENDER = '0d'.repeat(32)

describe('device sync protocol', function () {
  // PeerSky Mobile pins the same values in test/protocol/device-sync-protocol.test.mjs.
  it('makes the topic and the proof the phone makes, byte for byte', function () {
    expect(deviceSyncTopic(KEY).toString('hex')).to.equal('e702b30ef6aaa58eb3694a8888c6ddeda12383813d5121dec0db65df9b9c3cc8')
    expect(deviceSyncProof(KEY, HANDSHAKE, SENDER)).to.equal('8beb43aaede8fa35e6b0558e88ebeae7c1b3e809c00a68ec98e698fdae438c6c')
  })

  it('takes a proof only for its key, its connection and its sender', function () {
    const proof = deviceSyncProof(KEY, HANDSHAKE, SENDER)
    expect(checkDeviceSyncProof(KEY, HANDSHAKE, SENDER, proof)).to.equal(true)
    expect(checkDeviceSyncProof('01'.repeat(32), HANDSHAKE, SENDER, proof)).to.equal(false)
    expect(checkDeviceSyncProof(KEY, '0b'.repeat(64), SENDER, proof)).to.equal(false)
    expect(checkDeviceSyncProof(KEY, HANDSHAKE, '0c'.repeat(32), proof)).to.equal(false)
  })

  it('reads the frames the phone writes and refuses anything off', function () {
    const proof = deviceSyncProof(KEY, HANDSHAKE, SENDER)
    expect(parseDeviceSyncFrame(proofFrame(proof))).to.deep.equal({ t: 'proof', proof })
    const hello = helloFrame({ device: 'phone', drives: [{ id: 'aa'.repeat(32) }, { id: 'bb'.repeat(32), key: 'cc'.repeat(32) }], metered: true })
    expect(parseDeviceSyncFrame(hello)).to.deep.equal({
      t: 'hello',
      device: 'phone',
      drives: [{ id: 'aa'.repeat(32) }, { id: 'bb'.repeat(32), key: 'cc'.repeat(32) }],
      metered: true
    })
    expect(parseDeviceSyncFrame(JSON.stringify({ t: 'hello', device: 'phone', drives: [{ id: 'bad' }] }))).to.equal(null)
    const many = Array.from({ length: MAX_ANNOUNCED_DRIVES + 1 }, (_, index) => ({ id: index.toString(16).padStart(64, '0') }))
    expect(parseDeviceSyncFrame(JSON.stringify({ t: 'hello', device: 'phone', drives: many }))).to.equal(null)
    expect(parseDeviceSyncFrame('nope')).to.equal(null)
  })
})
