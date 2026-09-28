import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { decodePairingString } from './identity-transfer.js'

export const MOBILE_PAIRING_FILE = 'paired-mobile.json'

const HEX_KEY = /^[0-9a-f]{64}$/

// An identity is one profile, and a profile lives on one phone. Hypercore is
// single writer: two devices holding the same identity write the same chat
// feed and fork it, and the swarm only routes to one of them because they
// share a public key. Desktops are the same story, but a second phone is the
// one people reach for by accident, so this is where the guard goes.
//
// Enforced on the desktop alone, deliberately. The usual reason to move to a
// new phone is that the old one is broken, sold or already wiped, so waiting
// to hear back from it would fail exactly when it is needed. This is a guard
// against the accidental second phone, not a security boundary: anyone can
// still restore a backup by hand.
function pairingPath (userDataDir) {
  return path.join(userDataDir, MOBILE_PAIRING_FILE)
}

export async function readPairedMobile (userDataDir) {
  if (!userDataDir) return null
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(pairingPath(userDataDir), 'utf8'))
  } catch {
    // Missing, unreadable or corrupt all mean the same thing here: we do not
    // know of a paired phone. Throwing would strand someone behind a file
    // they cannot fix, for a guard that is only meant to catch an accident.
    return null
  }

  const key = String(parsed?.encryptionPublicKey || '').toLowerCase()
  if (!HEX_KEY.test(key)) return null
  const pairedAt = Number.isSafeInteger(parsed?.pairedAt) ? parsed.pairedAt : 0
  return { encryptionPublicKey: key, pairedAt }
}

export async function setPairedMobile (userDataDir, encryptionPublicKey) {
  const key = String(encryptionPublicKey || '').toLowerCase()
  if (!HEX_KEY.test(key)) return false
  await fs.mkdir(userDataDir, { recursive: true })

  const destination = pairingPath(userDataDir)
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.writeFile(
      temporary,
      JSON.stringify({ encryptionPublicKey: key, pairedAt: Date.now() }, null, 2),
      { mode: 0o600 }
    )
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  return true
}

export async function clearPairedMobile (userDataDir) {
  await fs.rm(pairingPath(userDataDir), { force: true })
  return true
}

/**
 * Throws when a different phone already holds this identity. Returns the
 * mobile key to record on success, or null when the target is not a phone.
 */
export async function assertMobilePairingAllowed (userDataDir, targetPairingPayload) {
  let pairing
  try {
    pairing = decodePairingString(targetPairingPayload)
  } catch {
    return null
  }

  if (pairing.deviceType !== 'mobile') return null

  const key = String(pairing.encryptionPublicKey || '').toLowerCase()
  if (!HEX_KEY.test(key)) return null

  const paired = await readPairedMobile(userDataDir)
  // Re-pairing the same phone is a retry, not a second device.
  if (paired && paired.encryptionPublicKey !== key) {
    const error = new Error(
      'This identity is already on a phone. Use "Move to a new phone" first, then pair again.'
    )
    error.code = 'MOBILE_ALREADY_PAIRED'
    error.pairedAt = paired.pairedAt
    throw error
  }

  return key
}
