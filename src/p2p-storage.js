import { promises as fs } from 'fs'
import path from 'path'

// What PeerSky keeps in the profile folder for Hyper, IPFS and the P2P apps,
// by part, for Settings, P2P data. Torrent downloads are saved in the
// Downloads folder, outside the profile, and are not counted.
export const P2P_STORAGE_PARTS = [
  // Drives shared in public or opened here, PeerChat's rooms and their files,
  // and the notes P2PMD publishes in public.
  { id: 'hyper', paths: ['hyper'] },
  // Private uploads, and the copies of the person's other devices' private
  // files.
  { id: 'hyperPrivate', paths: ['hyper-private'] },
  { id: 'ipfs', paths: ['ipfs'] },
  // The person's own P2P apps, PeerChat's room list, the lists in P2P data,
  // and the keys and records that go with the stores.
  {
    id: 'other',
    paths: [
      'myapps',
      'peersky-chat-rooms.json',
      'hyperCache.json',
      'ipfsCache.json',
      'ensCache.json',
      'privateHyperdrives.json',
      'private-drive-owners.json',
      'private-drive-key.json',
      'peersky-network-keys.json',
      'device-sync.json',
      'bt-state.json',
      'peersky-ports.json'
    ]
  }
]

// File system calls in flight at once. A store can hold thousands of files,
// and every call waits on the same threads the rest of the app reads and
// writes files with.
const MAX_PENDING = 16

function limit (max) {
  let active = 0
  const waiting = []
  return async function run (task) {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve))
    active++
    try {
      return await task()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

// The space a file takes on disk, counted the way du counts it: the blocks it
// has, and a file with several names once. Windows gives no block count.
function usedBytes (info, seen) {
  if (!info.isDirectory() && info.nlink > 1) {
    const id = `${info.dev}:${info.ino}`
    if (seen.has(id)) return 0
    seen.add(id)
  }
  return process.platform !== 'win32' && typeof info.blocks === 'number'
    ? info.blocks * 512
    : info.size
}

// A link is counted as a link, never followed.
async function sizeOf (target, seen, run) {
  let info
  try {
    info = await run(() => fs.lstat(target))
  } catch {
    // Gone since its folder was read, as during a reset, or not readable.
    return 0
  }
  let bytes = usedBytes(info, seen)
  if (!info.isDirectory()) return bytes
  let names
  try {
    names = await run(() => fs.readdir(target))
  } catch {
    return bytes
  }
  const sizes = await Promise.all(names.map((name) => sizeOf(path.join(target, name), seen, run)))
  for (const size of sizes) bytes += size
  return bytes
}

/**
 * How much space P2P data takes in a profile, in bytes, in total and by part.
 * Every file is read about through the thread pool, so a big store takes
 * longer to add up and blocks nothing while it does.
 *
 * @param {string} userDataDir
 * @returns {Promise<{ total: number, parts: Record<string, number> }>}
 */
export async function measureP2PStorage (userDataDir, { parts = P2P_STORAGE_PARTS } = {}) {
  const seen = new Set()
  const run = limit(MAX_PENDING)
  const sizes = {}
  let total = 0
  for (const part of parts) {
    let bytes = 0
    for (const name of part.paths) bytes += await sizeOf(path.join(userDataDir, name), seen, run)
    sizes[part.id] = bytes
    total += bytes
  }
  return { total, parts: sizes }
}

/**
 * One measurement at a time: asked again while one runs, the caller gets that
 * one's answer, so opening the section a few times in a row walks the folders
 * once. After the folders change, as after Reset P2P data, forget() makes the
 * next request walk them again, since the walk under way may have counted
 * what is gone.
 */
export function oneAtATime (measure) {
  let running = null
  function measureNow () {
    if (!running) {
      const walk = Promise.resolve().then(measure).finally(() => {
        if (running === walk) running = null
      })
      running = walk
    }
    return running
  }
  measureNow.forget = () => { running = null }
  return measureNow
}
