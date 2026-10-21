import { expect } from 'chai'
import { linkDeviceCodeFrom } from '../../src/backup/link-device-code.js'

// Paste on Link Device reads the clipboard in the main process, since pages
// may not. Only a pairing code or a transfer link comes back to the page.
describe('what Paste on Link Device takes from the clipboard', function () {
  const code = `peersky-identity:${'ab'.repeat(32)}?deviceType=desktop&nonce=${'cd'.repeat(16)}&chat=1`
  const link = `hyper://${'k'.repeat(52)}/backup.zip`

  it('takes a pairing code or a transfer link, trimmed', function () {
    expect(linkDeviceCodeFrom(`  ${code}\n`)).to.equal(code)
    expect(linkDeviceCodeFrom(link)).to.equal(link)
    expect(linkDeviceCodeFrom(link.replace('hyper', 'HYPER'))).to.equal(link.replace('hyper', 'HYPER'))
  })

  it('hands over nothing else that is on the clipboard', function () {
    for (const text of ['', 'my password is hunter2', 'https://example.com', `note: ${link}`, `${link} and more text`, 'peersky-identity:', 'hyper://', null, undefined]) {
      expect(linkDeviceCodeFrom(text)).to.equal('')
    }
  })

  it('refuses anything far longer than a code', function () {
    expect(linkDeviceCodeFrom(`hyper://${'a'.repeat(5000)}`)).to.equal('')
  })
})
