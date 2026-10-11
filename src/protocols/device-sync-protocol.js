// How a person's devices find each other and tell each other which private
// drives they write, so a private upload on one shows up on the others.
//
// Every device of one person holds the same private drive key: a desktop made
// it, and Link Device carried it to the phone. That key is the secret here.
// The devices meet under a topic made from it, and on each connection a device
// proves it holds the key, without sending it: an HMAC over the connection's
// handshake hash and its own network key, good on that connection alone. Only
// after the other side's proof checks out does a device say what it is and
// which drives it writes. Someone else's device never computes the topic, and
// a stranger who connects for another reason gets nothing.
//
// Must match backend/hyper/device-sync-protocol.mjs in PeerSky Mobile byte for
// byte: both test the same vector.
import { createHmac } from 'crypto'

export const DEVICE_SYNC_PROTOCOL = 'peersky-private-sync/1'
export const MAX_DEVICE_SYNC_FRAME_BYTES = 64 * 1024
export const MAX_ANNOUNCED_DRIVES = 200
export const DEVICE_TYPES = Object.freeze(['phone', 'desktop'])

const TOPIC_LABEL = 'peersky-private-sync/1 topic'
const PROOF_KEY_LABEL = 'peersky-private-sync/1 proof key'
const PROOF_LABEL = 'peersky-private-sync/1 proof'
const HEX_32 = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})+$/

function bytesOf (key) {
  if (typeof key === 'string' && HEX_32.test(key.toLowerCase())) return Buffer.from(key.toLowerCase(), 'hex')
  if (ArrayBuffer.isView(key) && key.byteLength === 32) return Buffer.from(key.buffer, key.byteOffset, key.byteLength)
  return null
}

function hexOf (value) {
  if (typeof value === 'string') return value.toLowerCase()
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('hex')
  return ''
}

/** The topic a person's devices meet under, or null without a key. */
export function deviceSyncTopic (identityKey) {
  const key = bytesOf(identityKey)
  if (!key) return null
  return createHmac('sha256', key).update(TOPIC_LABEL).digest()
}

/**
 * This device's proof on one connection: keyed with the private drive key,
 * over the handshake hash both ends share and the sender's own network key, so
 * it cannot be replayed on another connection or bounced back at its sender.
 */
export function deviceSyncProof (identityKey, handshakeHash, senderKey) {
  const key = bytesOf(identityKey)
  const handshake = hexOf(handshakeHash)
  const sender = hexOf(senderKey)
  if (!key || !HEX.test(handshake) || !HEX_32.test(sender)) return ''
  const proofKey = createHmac('sha256', key).update(PROOF_KEY_LABEL).digest()
  return createHmac('sha256', proofKey).update(`${PROOF_LABEL}\n${handshake}\n${sender}`).digest('hex')
}

export function checkDeviceSyncProof (identityKey, handshakeHash, senderKey, proof) {
  if (typeof proof !== 'string' || !HEX_32.test(proof)) return false
  const expected = deviceSyncProof(identityKey, handshakeHash, senderKey)
  if (!expected) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i)
  return diff === 0
}

export function proofFrame (proof) {
  return JSON.stringify({ t: 'proof', proof })
}

/**
 * What a device says once the other side has proved itself: whether it is a
 * phone or a desktop, and the private drives it writes. A drive under a key
 * other than the shared one carries its key; only devices that proved they
 * hold the shared key ever see it, over a connection that is encrypted anyway.
 * A phone says when it is on a cellular connection, so a desktop waits for
 * Wi-Fi before copying the phone's files.
 */
export function helloFrame ({ device, drives = [], metered = false }) {
  if (!DEVICE_TYPES.includes(device)) throw new Error('Unknown device type')
  const listed = []
  const seen = new Set()
  for (const drive of drives) {
    const id = typeof drive?.id === 'string' ? drive.id.toLowerCase() : ''
    if (!HEX_32.test(id) || seen.has(id)) continue
    seen.add(id)
    const key = typeof drive.key === 'string' ? drive.key.toLowerCase() : ''
    listed.push(HEX_32.test(key) ? { id, key } : { id })
    if (listed.length >= MAX_ANNOUNCED_DRIVES) break
  }
  return JSON.stringify({ t: 'hello', device, drives: listed, ...(metered ? { metered: true } : {}) })
}

/** A frame from the other side, checked and trimmed, or null. */
export function parseDeviceSyncFrame (text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_DEVICE_SYNC_FRAME_BYTES) return null
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    return null
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null

  if (frame.t === 'proof') {
    return typeof frame.proof === 'string' && HEX_32.test(frame.proof) ? { t: 'proof', proof: frame.proof } : null
  }

  if (frame.t === 'hello') {
    if (!DEVICE_TYPES.includes(frame.device) || !Array.isArray(frame.drives)) return null
    if (frame.drives.length > MAX_ANNOUNCED_DRIVES) return null
    const drives = []
    const seen = new Set()
    for (const drive of frame.drives) {
      const id = typeof drive?.id === 'string' ? drive.id : ''
      if (!HEX_32.test(id)) return null
      if (seen.has(id)) continue
      seen.add(id)
      if (drive.key !== undefined && (typeof drive.key !== 'string' || !HEX_32.test(drive.key))) return null
      drives.push(drive.key ? { id, key: drive.key } : { id })
    }
    return { t: 'hello', device: frame.device, drives, metered: frame.metered === true }
  }

  return null
}
