// What Paste on Link Device and onboarding may take from the clipboard: a
// pairing code or a transfer link. Pages may not read the clipboard, so the
// main process reads it and hands over this, never anything else on it.
const MAX_CODE_LENGTH = 4096

export function linkDeviceCodeFrom (text) {
  const value = String(text || '').trim()
  if (value.length > MAX_CODE_LENGTH) return ''
  return /^(peersky-identity:|hyper:\/\/)\S+$/i.test(value) ? value : ''
}
