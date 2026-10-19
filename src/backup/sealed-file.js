import crypto from 'crypto'
import { createRequire } from 'module'
import { promises as fs, readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'fs'
import path from 'path'

// Files that hold private things, the key to the private drives and the names
// of private files, are locked with the system's safe storage: the Keychain on
// macOS, DPAPI on Windows, the keyring on Linux. A copy of such a file taken
// off the disk shows nothing; only PeerSky, run by the same user on the same
// computer, can open it, and nobody is asked for anything. Where the system
// has no safe storage (Linux with no keyring), the file stays as it was:
// Electron's fallback there locks with a key built into every copy.
//
// A file written before this is read as it was, and locked the next time it
// is written. A locked file that cannot be opened is an error, never a reason
// to start over: for the key, starting over would lose every private drive.

const MARK = 'peersky-sealed'

const require = createRequire(import.meta.url)
let sealer = null
let sealerLoaded = false

function systemSealer () {
  if (!sealerLoaded) {
    sealerLoaded = true
    try {
      // In Electron's main process this is the API; under plain Node, where
      // the tests run, it is a path, and nothing is locked.
      const electron = require('electron')
      sealer = electron && typeof electron === 'object' && electron.safeStorage ? electron.safeStorage : null
    } catch {
      sealer = null
    }
  }
  return sealer
}

let override
/** For tests: an object with isEncryptionAvailable, encryptString, decryptString, or null for none. */
export function setSealerForTests (value) {
  override = value
}

function currentSealer () {
  return override !== undefined ? override : systemSealer()
}

export class SealedFileError extends Error {
  constructor (filePath, cause) {
    super(`${path.basename(filePath)} is locked with this computer's safe storage and could not be opened`)
    this.name = 'SealedFileError'
    this.code = 'SEALED_FILE_LOCKED'
    this.cause = cause
  }
}

export function canSeal () {
  const s = currentSealer()
  if (!s) return false
  try {
    if (!s.isEncryptionAvailable()) return false
    if (typeof s.getSelectedStorageBackend === 'function' && s.getSelectedStorageBackend() === 'basic_text') return false
    return true
  } catch {
    return false
  }
}

export function isSealedText (text) {
  try {
    const parsed = JSON.parse(text)
    return Boolean(parsed && parsed[MARK] === 1 && typeof parsed.data === 'string')
  } catch {
    return false
  }
}

/** The text to write for value: locked where the system can, plain JSON where it cannot. */
export function sealJson (value) {
  const plain = JSON.stringify(value, null, 2)
  if (!canSeal()) return plain
  const data = currentSealer().encryptString(JSON.stringify(value)).toString('base64')
  return JSON.stringify({ [MARK]: 1, data })
}

/** The value in text read from filePath, and whether it was locked. */
export function openJson (text, filePath = 'file') {
  const parsed = JSON.parse(text)
  if (!(parsed && parsed[MARK] === 1 && typeof parsed.data === 'string')) {
    return { value: parsed, sealed: false }
  }
  const s = currentSealer()
  try {
    if (!s) throw new Error('No safe storage here')
    return { value: JSON.parse(s.decryptString(Buffer.from(parsed.data, 'base64'))), sealed: true }
  } catch (error) {
    throw new SealedFileError(filePath, error)
  }
}

/** null when the file is not there. */
export async function readSealedJson (filePath) {
  let text
  try {
    text = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return openJson(text, filePath)
}

export function readSealedJsonSync (filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  return openJson(text, filePath)
}

export async function writeSealedJson (filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.writeFile(temporary, sealJson(value), { mode: 0o600 })
    await fs.rename(temporary, filePath)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
  }
}

export function writeSealedJsonSync (filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    writeFileSync(temporary, sealJson(value), { mode: 0o600 })
    renameSync(temporary, filePath)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Locks the files named here that are still plain, once at startup, so files
 * written before locking came in do not wait for their next write. Each is
 * left as it was if anything goes wrong.
 */
export async function sealFilesAtRest (directory, names) {
  if (!canSeal()) return []
  const sealed = []
  for (const name of names) {
    const filePath = path.join(directory, name)
    try {
      const read = await readSealedJson(filePath)
      if (read && !read.sealed) {
        await writeSealedJson(filePath, read.value)
        sealed.push(name)
      }
    } catch {}
  }
  return sealed
}
