// The pairing codes this desktop has shown, so a transfer sent to it can be
// checked against one of them. A transfer made for some other code, or for
// one shown long ago, is refused before anything in it is used.
//
// Kept in memory. Every visit to Backup & Restore shows a fresh code, and a
// restart shows another, so there is nothing worth keeping on disk.
const PAIRING_NONCE_TTL_MS = 60 * 60 * 1000
const MAX_LIVE_NONCES = 16
const HEX_NONCE = /^[0-9a-f]{32}$/

const issued = new Map()

export function rememberPairingNonce (nonce, now = Date.now()) {
  const value = String(nonce || '').toLowerCase()
  if (!HEX_NONCE.test(value)) return false
  prune(now)
  issued.set(value, now)
  while (issued.size > MAX_LIVE_NONCES) issued.delete(issued.keys().next().value)
  return true
}

export function isLivePairingNonce (nonce, now = Date.now()) {
  const value = String(nonce || '').toLowerCase()
  prune(now)
  return issued.has(value)
}

// A code answers one transfer. Used once, it is gone.
export function forgetPairingNonce (nonce) {
  issued.delete(String(nonce || '').toLowerCase())
}

export function clearPairingNonces () {
  issued.clear()
}

function prune (now) {
  for (const [nonce, issuedAt] of issued) {
    if (now - issuedAt > PAIRING_NONCE_TTL_MS || issuedAt > now + 60 * 1000) issued.delete(nonce)
  }
}
