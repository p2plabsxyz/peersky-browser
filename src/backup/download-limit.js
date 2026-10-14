import { promises as fs } from 'fs'

// A restore from the network is written to disk before anything reads it. A
// link to a drive that sent more than it said, or that never stopped, filled
// the disk. Now a download takes no more than it said it would send, and never
// the last of the free space.
export const KEEP_FREE_BYTES = 512 * 1024 * 1024

export const SENT_TOO_MUCH = 'The other device sent more than it said it would, so the download was stopped.'
export const DISK_FULL = "The download was stopped before it filled this computer's disk. Free up some space and press Download again."

function mb (bytes) {
  const value = bytes / (1024 * 1024)
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

export function tooBigFor (bytes) {
  return `This download is ${mb(bytes)} MB, which would leave this computer with less than ${mb(KEEP_FREE_BYTES)} MB free. Free up some space and press Download again.`
}

async function freeBytes (folder) {
  try {
    const stats = await fs.statfs(folder)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

/**
 * The most a download into folder may write, and what to say when it goes
 * past that: the size it said it would send, or, when it said none, the free
 * space less KEEP_FREE_BYTES. Throws when what it said would not fit.
 * @param {string} folder
 * @param {number} [declared] The Content-Length, or 0 when there was none.
 * @param {(folder: string) => Promise<number|null>} [readFree] Free bytes in folder, null when unknown.
 */
export async function downloadLimit (folder, declared = 0, readFree = freeBytes) {
  const free = await readFree(folder)
  const room = free === null ? Infinity : Math.max(0, free - KEEP_FREE_BYTES)
  if (declared > 0) {
    if (declared > room) throw new Error(tooBigFor(declared))
    return { limit: declared, overLimit: SENT_TOO_MUCH }
  }
  return { limit: room, overLimit: DISK_FULL }
}
