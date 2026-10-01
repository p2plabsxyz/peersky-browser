import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import hypercoreCrypto from 'hypercore-crypto'

// A desktop restored from another desktop starts with a copy of its stores,
// and the keys its network connections are made with come from those stores.
// Two desktops on one key are one peer to everyone else: they push each other
// off the network, and in PeerChat they are one member. The restored desktop
// gets keys of its own here, one for the main store and one for the private
// store. They stay on this device: no backup or transfer carries this file,
// and no restore replaces it.
export const NETWORK_KEYS_FILE = 'peersky-network-keys.json'

const HEX_PUBLIC = /^[0-9a-f]{64}$/
const HEX_SECRET = /^[0-9a-f]{128}$/

function readPair (raw) {
  if (!raw || !HEX_PUBLIC.test(raw.publicKey) || !HEX_SECRET.test(raw.secretKey)) return null
  return { publicKey: Buffer.from(raw.publicKey, 'hex'), secretKey: Buffer.from(raw.secretKey, 'hex') }
}

function writePair (pair) {
  return { publicKey: pair.publicKey.toString('hex'), secretKey: pair.secretKey.toString('hex') }
}

// { main, private } keypairs, or null on a desktop that uses its stores' own.
export async function readNetworkKeys (userDataDir) {
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(path.join(userDataDir, NETWORK_KEYS_FILE), 'utf8'))
  } catch {
    return null
  }
  const main = readPair(parsed?.main)
  const privateStore = readPair(parsed?.private)
  return main && privateStore ? { main, private: privateStore } : null
}

// Made once. A desktop that already has its own keys keeps them, so being
// restored again does not make it a new member again.
export async function ensureOwnNetworkKeys (userDataDir) {
  if (await readNetworkKeys(userDataDir)) return false
  const destination = path.join(userDataDir, NETWORK_KEYS_FILE)
  const body = JSON.stringify({
    version: 1,
    main: writePair(hypercoreCrypto.keyPair()),
    private: writePair(hypercoreCrypto.keyPair())
  }, null, 2)
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await fs.mkdir(userDataDir, { recursive: true })
    await fs.writeFile(temporary, body, { mode: 0o600 })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
  return true
}

// SDK options that connect with keyPair instead of the store's own key.
export function withNetworkKey (options, keyPair) {
  if (!keyPair) return options
  return { ...options, swarmOpts: { ...(options?.swarmOpts || {}), keyPair } }
}
