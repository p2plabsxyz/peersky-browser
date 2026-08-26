/**
 * LAN discovery must never fail a hyper:// request.
 *
 * hyperdht-mdns advertises every joined topic in one mDNS TXT record and throws
 * when that record overflows. hyper-sdk's join() wrapper reacts by tearing down
 * the public-DHT session it just created and rethrowing, so the error came out
 * of getDrive() and failed the page:
 *
 *   RangeError: LAN mDNS TXT record exceeds 900 bytes; reduce joined topics
 *
 * Measured against the installed module, that happens on the 19th topic — so a
 * session stopped being able to open hyper:// drives after about eighteen.
 */

import { expect } from 'chai'
import sinon from 'sinon'
import crypto from 'crypto'
import { createRequire } from 'module'

import { guardLANTopicLimit, isTopicCapacityError } from '../../src/protocols/lan-discovery-guard.js'

const require = createRequire(import.meta.url)
const { topicToken, MAX_ADVERTISED_TOPICS } = require('@p2plabs/hyperdht-mdns')

/** The byte budget named in the module's own error message. */
const MAX_TXT_BYTES = 900

const topic = () => crypto.randomBytes(32)

/** Stand-in for HyperDHTmDNS that overflows its record like the real one. */
function fakeLan (limit) {
  const joined = []
  return {
    joined,
    join (t) {
      if (joined.length >= limit) {
        throw new RangeError('LAN mDNS TXT record exceeds 900 bytes; reduce joined topics')
      }
      joined.push(t)
      return { refresh: async () => true, flushed: async () => {}, destroy: async () => {} }
    }
  }
}

describe('LAN discovery topic limit', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('overflows its record long before reaching its own topic cap', function () {
    // Only the public surface: one base64url token per topic, and the cap the
    // module advertises. The tokens alone blow the budget, so the cap is
    // unreachable and the overflow is the limit that is actually hit.
    const tokenBytes = Buffer.byteLength(topicToken(topic()))

    expect(
      tokenBytes * MAX_ADVERTISED_TOPICS,
      'the advertisement no longer overflows before the cap; this guard may be unnecessary'
    ).to.be.greaterThan(MAX_TXT_BYTES)
  })

  it('keeps joining once the advertisement is full instead of throwing', function () {
    const lan = fakeLan(3)
    const onSkip = sinon.stub()
    guardLANTopicLimit(lan, { onSkip })

    for (let i = 0; i < 3; i++) lan.join(topic())

    // The join that used to fail the whole hyper:// request.
    let session
    expect(() => { session = lan.join(topic()) }).to.not.throw()
    expect(session).to.be.an('object')
    expect(onSkip.calledOnce, 'the skipped advertisement was not reported').to.equal(true)
  })

  it('hands back a session the sdk wrapper can drive', async function () {
    const lan = fakeLan(0)
    guardLANTopicLimit(lan)

    const session = lan.join(topic())

    // These are the three members hyper-sdk's CombinedDiscovery calls.
    expect(await session.refresh(), 'a skipped topic must not claim it refreshed').to.equal(false)
    await session.flushed()
    await session.destroy()
  })

  it('still advertises while there is room', function () {
    const lan = fakeLan(5)
    const onSkip = sinon.stub()
    guardLANTopicLimit(lan, { onSkip })

    for (let i = 0; i < 5; i++) lan.join(topic())

    expect(lan.joined).to.have.lengthOf(5)
    expect(onSkip.called).to.equal(false)
  })

  it('lets a real failure through', function () {
    const lan = {
      join () { throw new TypeError('topic must be a 32-byte Buffer') }
    }
    guardLANTopicLimit(lan)

    expect(() => lan.join('nope')).to.throw(TypeError, 'topic must be a 32-byte Buffer')
  })

  it('is applied once, however many times discovery re-attaches', function () {
    const lan = fakeLan(1)
    const original = lan.join
    guardLANTopicLimit(lan)
    const guarded = lan.join
    guardLANTopicLimit(lan)

    expect(lan.join).to.equal(guarded)
    expect(guarded).to.not.equal(original)
  })

  it('recognises both ways the module reports a full advertisement', function () {
    expect(isTopicCapacityError(new RangeError('LAN mDNS TXT record exceeds 900 bytes; reduce joined topics'))).to.equal(true)
    expect(isTopicCapacityError(new RangeError('Cannot join more than 32 LAN topics'))).to.equal(true)
    expect(isTopicCapacityError(new RangeError('Cannot advertise more than 32 topics'))).to.equal(true)
    expect(isTopicCapacityError(new RangeError('port must be an integer between 1 and 65535'))).to.equal(false)
    expect(isTopicCapacityError(new TypeError('topic must be a 32-byte Buffer'))).to.equal(false)
    expect(isTopicCapacityError(null)).to.equal(false)
  })
})
