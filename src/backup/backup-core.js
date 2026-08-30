import { promises as fs, createWriteStream, createReadStream } from 'fs'
import path from 'path'
import crypto from 'crypto'
import archiver from 'archiver'
import { Transform } from 'stream'
import { finished } from 'stream/promises'

// Backup bundle format version. Bumped only on incompatible layout changes.
export const BACKUP_VERSION = '1.0.0'

export const MANIFEST_NAME = 'manifest.json'

export const STANDARD_BACKUP_TARGETS = [
  { name: 'lastOpened.json', type: 'file' },
  { name: 'tabs.json', type: 'file' },
  { name: 'ensCache.json', type: 'file' },
  { name: 'ipfsCache.json', type: 'file' },
  { name: 'hyperCache.json', type: 'file' },
  { name: 'hyper', type: 'dir' },
  { name: 'peersky-chat-rooms.json', type: 'file' },
  { name: 'peersky-ports.json', type: 'file' },
  { name: 'peersky-identity.json', type: 'file' }
]

export const IDENTITY_BACKUP_TARGETS = STANDARD_BACKUP_TARGETS

export const MOBILE_IDENTITY_BACKUP_TARGETS = [
  { name: 'lastOpened.json', type: 'file' },
  { name: 'tabs.json', type: 'file' },
  { name: 'hyper', type: 'dir' },
  { name: 'peersky-chat-rooms.json', type: 'file' },
  { name: 'peersky-ports.json', type: 'file' },
  { name: 'peersky-identity.json', type: 'file' }
]

export const PRIVATE_HYPER_BACKUP_TARGETS = [
  { name: 'privateHyperdrives.json', type: 'file' },
  { name: 'hyper-private', type: 'dir' }
]

const RESTORABLE_BACKUP_TARGETS = [
  ...IDENTITY_BACKUP_TARGETS,
  ...PRIVATE_HYPER_BACKUP_TARGETS
]

// Skip live DB lock/log files. CORESTORE is left in to stabilize manifest
// hashes, but is explicitly dropped during restore in backup-manager.js.
const SKIP_NAMES = new Set(['LOCK', 'repo.lock', '.DS_Store', 'LOG', 'LOG.old'])

function shouldSkipEntry (name) {
  const base = name.split('/').pop().split('\\').pop()
  if (SKIP_NAMES.has(base)) return true
  if (base.endsWith('.lock')) return true
  return false
}

async function pathExists (p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function ensureInside (base, target) {
  const rel = path.relative(base, target)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

async function sha256File (filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// Recursively walk a directory, returning POSIX-relative file paths (skips locks).
async function listDirFiles (dir, baseDir = dir) {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (shouldSkipEntry(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await listDirFiles(abs, baseDir))
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, abs).split(path.sep).join('/'))
    }
  }
  return out
}

// Compute a stable sha256 over a directory's files (sorted by relative path).
async function sha256Dir (dir) {
  const files = (await listDirFiles(dir)).sort()
  const hash = crypto.createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update(await sha256File(path.join(dir, rel)))
  }
  return hash.digest('hex')
}

function selectTargets (isIdentityTransfer, targetDeviceType, includePrivate) {
  const targets = !isIdentityTransfer
    ? STANDARD_BACKUP_TARGETS
    : targetDeviceType === 'mobile'
      ? MOBILE_IDENTITY_BACKUP_TARGETS
      : IDENTITY_BACKUP_TARGETS
  return includePrivate
    ? [...targets, ...PRIVATE_HYPER_BACKUP_TARGETS]
    : targets
}

// Legacy compatibility for backups created before LOG and LOG.old were added to SKIP_NAMES.
// Safe to remove after version 2.0 when all users have re-created backups.
async function listDirFilesOld (dir, baseDir = dir) {
  const out = []
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const name = entry.name
    const base = name.split('/').pop().split('\\').pop()
    const OLD_SKIP_NAMES = new Set(['LOCK', 'repo.lock', '.DS_Store', 'CORESTORE'])
    if (OLD_SKIP_NAMES.has(base)) continue
    if (name.endsWith('.lock')) continue

    const abs = path.join(dir, name)
    if (entry.isDirectory()) {
      out.push(...await listDirFilesOld(abs, baseDir))
    } else if (entry.isFile()) {
      out.push(path.relative(baseDir, abs).split(path.sep).join('/'))
    }
  }
  return out
}

async function sha256DirOld (dir) {
  const files = (await listDirFilesOld(dir)).sort()
  const hash = crypto.createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update(await sha256File(path.join(dir, rel)))
  }
  return hash.digest('hex')
}

// Build the manifest describing which targets are present and their checksums.
export async function buildManifest (userDataDir, peerskyVersion = '', isIdentityTransfer = false, targetDeviceType = 'desktop', includePrivate = false) {
  const files = {}
  const targets = selectTargets(isIdentityTransfer, targetDeviceType, includePrivate)
  for (const target of targets) {
    const abs = path.join(userDataDir, target.name)
    if (!(await pathExists(abs))) continue
    files[target.name] = target.type === 'dir'
      ? `sha256:${await sha256Dir(abs)}`
      : `sha256:${await sha256File(abs)}`
  }
  return {
    version: BACKUP_VERSION,
    peerskyVersion,
    createdAt: new Date().toISOString(),
    files
  }
}

async function appendHashedFile (archive, sourcePath, archivePath) {
  const hash = crypto.createHash('sha256')
  let bytes = 0
  const hashingStream = new Transform({
    transform (chunk, encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback(null, chunk)
    }
  })
  const source = createReadStream(sourcePath)
  source.on('error', (error) => hashingStream.destroy(error))
  source.pipe(hashingStream)
  archive.append(hashingStream, { name: archivePath })
  await finished(hashingStream)
  return { bytes, digest: hash.digest('hex') }
}

// Stream all present targets plus a manifest into a single .zip at outPath.
// onProgress receives { processedBytes, totalBytes, entries } updates.
export async function createBackupZip (userDataDir, outPath, options = {}) {
  const { peerskyVersion = '', isIdentityTransfer = false, targetDeviceType = 'desktop', includePrivate = false, onProgress } = options
  const targets = selectTargets(isIdentityTransfer, targetDeviceType, includePrivate)
  const manifest = {
    version: BACKUP_VERSION,
    peerskyVersion,
    createdAt: new Date().toISOString(),
    files: {}
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  const tempPath = outPath + '.tmp'
  const output = createWriteStream(tempPath)
  const archive = archiver('zip', { zlib: { level: 6 } })
  const completed = new Promise((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('warning', (error) => {
      if (error.code !== 'ENOENT') reject(error)
    })
    archive.on('error', reject)
  })

  if (typeof onProgress === 'function') {
    archive.on('progress', (data) => {
      onProgress({
        processedBytes: data.fs.processedBytes,
        totalBytes: data.fs.totalBytes,
        entries: data.entries
      })
    })
  }

  archive.pipe(output)

  try {
    let uncompressedBytes = 0
    for (const target of targets) {
      const abs = path.join(userDataDir, target.name)
      if (!(await pathExists(abs))) continue

      if (target.type === 'file') {
        const { bytes, digest } = await appendHashedFile(archive, abs, target.name)
        uncompressedBytes += bytes
        manifest.files[target.name] = `sha256:${digest}`
        continue
      }

      const dirHash = crypto.createHash('sha256')
      const files = (await listDirFiles(abs)).sort()
      if (files.length === 0) archive.append('', { name: `${target.name}/` })
      for (const rel of files) {
        const { bytes, digest } = await appendHashedFile(
          archive,
          path.join(abs, rel),
          `${target.name}/${rel}`
        )
        uncompressedBytes += bytes
        dirHash.update(rel)
        dirHash.update(digest)
      }
      manifest.files[target.name] = `sha256:${dirHash.digest('hex')}`
    }

    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2))
    uncompressedBytes += manifestBytes.length
    archive.append(manifestBytes, { name: MANIFEST_NAME })
    await archive.finalize()
    await completed
    await fs.rename(tempPath, outPath)
    return { filePath: outPath, bytes: archive.pointer(), uncompressedBytes, manifest }
  } catch (error) {
    archive.abort()
    output.destroy()
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

// Read and parse the manifest from a backup .zip without extracting everything.
export async function readManifest (zipPath) {
  const unzipper = await import('unzipper')
  const directory = await unzipper.Open.file(zipPath)
  const entry = directory.files.find((f) => f.path === MANIFEST_NAME)
  if (!entry) throw new Error('Backup is missing manifest.json')
  const buffer = await entry.buffer()
  return JSON.parse(buffer.toString('utf-8'))
}

// Extract a backup .zip into destDir with zip-slip protection.
export async function extractBackupZip (zipPath, destDir) {
  const unzipper = await import('unzipper')
  await fs.mkdir(destDir, { recursive: true })

  const directory = await unzipper.Open.file(zipPath)
  for (const entry of directory.files) {
    const filePath = path.join(destDir, entry.path)
    if (!ensureInside(destDir, filePath)) {
      throw new Error('Backup contains illegal path traversal entries')
    }
    if (entry.type === 'Directory') {
      await fs.mkdir(filePath, { recursive: true })
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await new Promise((resolve, reject) => {
        entry.stream()
          .pipe(createWriteStream(filePath))
          .on('finish', resolve)
          .on('error', reject)
      })
    }
  }
}

// Verify that extracted contents match the manifest checksums.
export async function verifyManifest (extractedDir, manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.files) {
    throw new Error('Invalid backup manifest')
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    const meta = RESTORABLE_BACKUP_TARGETS.find((t) => t.name === name)
    if (!meta) throw new Error(`Unknown backup entry: ${name}`)
    const abs = path.join(extractedDir, name)
    if (!(await pathExists(abs))) {
      throw new Error(`Backup entry missing after extraction: ${name}`)
    }
    const actual = meta.type === 'dir'
      ? `sha256:${await sha256Dir(abs)}`
      : `sha256:${await sha256File(abs)}`
    if (actual !== expected) {
      if (meta.type === 'dir') {
        const actualOld = `sha256:${await sha256DirOld(abs)}`
        if (actualOld === expected) {
          continue
        }
      }
      throw new Error(`Checksum mismatch for ${name} (expected ${expected}, got ${actual})`)
    }
  }
  return true
}
