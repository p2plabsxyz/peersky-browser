import path from 'path'
import { promises as fs } from 'fs'
import { readSealedJson, writeSealedJson } from '../backup/sealed-file.js'

export const PRIVATE_HYPERDRIVE_REGISTRY_FILE = 'privateHyperdrives.json'

const MAX_PRIVATE_HYPERDRIVES = 1000
const MAX_NAME_LENGTH = 255
const MAX_REGISTRY_BYTES = 1024 * 1024
let registryWrite = Promise.resolve()

function isSafeName (value) {
  if (typeof value !== 'string') return false
  const characters = Array.from(value)
  return characters.length > 0 &&
    characters.length <= MAX_NAME_LENGTH &&
    !characters.some((character) => {
      const code = character.codePointAt(0)
      return code <= 31 || (code >= 127 && code <= 159)
    })
}

function normalizePrivateHyperdrive (entry) {
  if (!entry || typeof entry !== 'object' || !isSafeName(entry.name)) return null

  try {
    const url = new URL(entry.url)
    if (url.protocol !== 'hyper:' || url.pathname !== '/' || url.search || url.hash) return null
    if (!/^(?:[a-z0-9]{52}|[a-f0-9]{64})$/i.test(url.hostname)) return null

    const timestamp = Number(entry.timestamp)
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return null

    return {
      name: entry.name,
      url: `hyper://${url.hostname}/`,
      timestamp,
      encrypted: entry.encrypted === true
    }
  } catch {
    return null
  }
}

function registryPath (userDataDir) {
  return path.join(userDataDir, PRIVATE_HYPERDRIVE_REGISTRY_FILE)
}

export async function listPrivateHyperdrives (userDataDir) {
  let parsed
  try {
    const filePath = registryPath(userDataDir)
    const info = await fs.stat(filePath)
    if (info.size > MAX_REGISTRY_BYTES) throw new Error('Private Hyperdrive registry is too large')
    // The names of private drives, so locked like the key (sealed-file.js).
    parsed = (await readSealedJson(filePath))?.value
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  if (parsed === undefined) return []

  if (!Array.isArray(parsed)) throw new Error('Private Hyperdrive registry is invalid')

  const normalized = parsed.map(normalizePrivateHyperdrive)
  if (normalized.some((entry) => entry === null)) {
    throw new Error('Private Hyperdrive registry contains invalid entries')
  }

  return normalized
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, MAX_PRIVATE_HYPERDRIVES)
}

async function writePrivateHyperdrives (userDataDir, entries) {
  await writeSealedJson(registryPath(userDataDir), entries)
}

export function rememberPrivateHyperdrive (userDataDir, entry) {
  const normalized = normalizePrivateHyperdrive(entry)
  if (!normalized) return Promise.reject(new Error('Private Hyperdrive metadata is invalid'))

  const update = registryWrite
    .catch(() => {})
    .then(async () => {
      const existing = await listPrivateHyperdrives(userDataDir)
      const entries = [
        normalized,
        ...existing.filter((item) => item.url !== normalized.url)
      ].slice(0, MAX_PRIVATE_HYPERDRIVES)
      await writePrivateHyperdrives(userDataDir, entries)
      return normalized
    })

  registryWrite = update
  return update
}
