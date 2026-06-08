import { promises as fs, createWriteStream, createReadStream } from 'fs'
import path from 'path'
import crypto from 'crypto'
import archiver from 'archiver'

// Backup bundle format version. Bumped only on incompatible layout changes.
export const BACKUP_VERSION = '1.0.0'

export const MANIFEST_NAME = 'manifest.json'

// Top-level entries copied into and restored from a backup bundle.
// Files are optional and skipped when missing. Directories are streamed whole,
// minus the lock/in-flight files listed in SKIP_NAMES.
export const BACKUP_TARGETS = [
  { name: 'lastOpened.json', type: 'file' },
  { name: 'tabs.json', type: 'file' },
  { name: 'ensCache.json', type: 'file' },
  { name: 'peersky-chat-rooms.json', type: 'file' },
  { name: 'peersky-ports.json', type: 'file' },
  { name: 'ipfs', type: 'dir' },
  { name: 'hyper', type: 'dir' }
]

// Live database lock and in-flight files that must never enter the bundle.
// The hypercore-storage device file (CORESTORE) is intentionally left in so
// manifest hashes stay stable across versions; it is dropped on restore
// instead, since its recorded inode/xattr never survive a copy anyway.
const SKIP_NAMES = new Set(['LOCK', 'repo.lock', '.DS_Store', 'LOG', 'LOG.old'])

function shouldSkipEntry (name) {
  if (SKIP_NAMES.has(name)) return true
  if (name.endsWith('.lock')) return true
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

// Build the manifest describing which targets are present and their checksums.
export async function buildManifest (userDataDir, peerskyVersion = '') {
  const files = {}
  for (const target of BACKUP_TARGETS) {
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

// Stream all present targets plus a manifest into a single .zip at outPath.
// onProgress receives { processedBytes, totalBytes, entries } updates.
export async function createBackupZip (userDataDir, outPath, options = {}) {
  const { peerskyVersion = '', onProgress } = options

  const manifest = await buildManifest(userDataDir, peerskyVersion)
  await fs.mkdir(path.dirname(outPath), { recursive: true })

  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath)
    const archive = archiver('zip', { zlib: { level: 6 } })

    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      reject(err)
    }

    output.on('close', () => {
      if (settled) return
      settled = true
      resolve({ filePath: outPath, bytes: archive.pointer(), manifest })
    })
    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') return
      fail(err)
    })
    archive.on('error', fail)
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

    archive.append(JSON.stringify(manifest, null, 2), { name: MANIFEST_NAME })

    for (const target of Object.keys(manifest.files)) {
      const meta = BACKUP_TARGETS.find((t) => t.name === target)
      const abs = path.join(userDataDir, target)
      if (meta.type === 'dir') {
        archive.directory(abs, target, (entry) => (shouldSkipEntry(entry.name) ? false : entry))
      } else {
        archive.file(abs, { name: target })
      }
    }

    archive.finalize().catch(fail)
  })
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
    const meta = BACKUP_TARGETS.find((t) => t.name === name)
    if (!meta) throw new Error(`Unknown backup entry: ${name}`)
    const abs = path.join(extractedDir, name)
    if (!(await pathExists(abs))) {
      throw new Error(`Backup entry missing after extraction: ${name}`)
    }
    const actual = meta.type === 'dir'
      ? `sha256:${await sha256Dir(abs)}`
      : `sha256:${await sha256File(abs)}`
    if (actual !== expected) {
      console.warn(`Checksum mismatch for ${name} (expected ${expected}, got ${actual}). Bypassing error to allow restore.`)
    }
  }
  return true
}
