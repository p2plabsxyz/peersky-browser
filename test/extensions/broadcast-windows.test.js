import { expect } from 'chai'
import sinon from 'sinon'

import { isWindowSendable, sendToWindows } from '../../src/extensions/services/broadcast.js'

/**
 * A window whose WebContents outlives its render frame: isDestroyed() reports
 * false while touching mainFrame throws. This is what Electron leaves behind
 * after a window closes and its renderer is reclaimed, and it is the state that
 * produced the "Render frame was disposed" log storm.
 */
function makeWindow ({ destroyed = false, wcDestroyed = false, frame = 'live' } = {}) {
  const send = sinon.stub()
  const wc = {
    isDestroyed: () => wcDestroyed,
    send,
    get mainFrame () {
      if (frame === 'throws') {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
      if (frame === 'destroyed') return { isDestroyed: () => true }
      if (frame === 'null') return null
      return { isDestroyed: () => false }
    }
  }
  return { isDestroyed: () => destroyed, webContents: wc, __send: send }
}

describe('Broadcasting to browser windows', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('treats a window with a disposed render frame as unsendable', function () {
    expect(isWindowSendable(makeWindow({ frame: 'throws' }))).to.equal(false)
    expect(isWindowSendable(makeWindow())).to.equal(true)
  })

  it('rejects destroyed windows, destroyed contents, and missing frames', function () {
    expect(isWindowSendable(makeWindow({ destroyed: true }))).to.equal(false)
    expect(isWindowSendable(makeWindow({ wcDestroyed: true }))).to.equal(false)
    expect(isWindowSendable(makeWindow({ frame: 'destroyed' }))).to.equal(false)
    expect(isWindowSendable(makeWindow({ frame: 'null' }))).to.equal(false)
    expect(isWindowSendable(null)).to.equal(false)
  })

  it('does not send to a window whose frame was disposed', function () {
    const disposed = makeWindow({ frame: 'throws' })

    const sent = sendToWindows([disposed], 'browser-action-updated', { t: 1 })

    expect(sent).to.equal(0)
    expect(disposed.__send.called).to.equal(false)
  })

  it('still reaches live windows when another has a disposed frame', function () {
    const disposed = makeWindow({ frame: 'throws' })
    const live = makeWindow()

    const sent = sendToWindows([disposed, live], 'browser-action-updated', { t: 1 })

    expect(sent).to.equal(1)
    expect(disposed.__send.called).to.equal(false)
    expect(live.__send.calledOnceWithExactly('browser-action-updated', { t: 1 })).to.equal(true)
  })

  it('omits the payload argument when none is given', function () {
    const live = makeWindow()

    sendToWindows([live], 'refresh-browser-actions')

    expect(live.__send.calledOnceWithExactly('refresh-browser-actions')).to.equal(true)
  })

  it('keeps going when send itself throws', function () {
    const throwing = makeWindow()
    throwing.__send.throws(new Error('Object has been destroyed'))
    const live = makeWindow()

    const sent = sendToWindows([throwing, live], 'browser-action-updated')

    expect(sent).to.equal(1)
    expect(live.__send.calledOnce).to.equal(true)
  })

  it('handles a missing window list without throwing', function () {
    expect(sendToWindows(undefined, 'x')).to.equal(0)
    expect(sendToWindows([], 'x')).to.equal(0)
    expect(sendToWindows([makeWindow()], '')).to.equal(0)
  })
})
