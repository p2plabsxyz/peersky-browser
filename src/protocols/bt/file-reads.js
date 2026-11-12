// A file of a torrent still downloading, read through WebTorrent. Its bytes on
// disk may not have arrived yet, where a video seeking past what has downloaded
// read zeros or the end of the file. WebTorrent's file stream fetches the
// pieces asked for first and waits for them.
//
// The main process asks for one chunk at a time, so nothing is read ahead of
// what the page takes. A read nobody asks on for a while is closed, which lets
// go of its pieces, and opens again where it was if asked again.

const IDLE_MS = 30 * 1000
const MAX_CHUNK = 1024 * 1024

export function createFileReads ({ getTorrent, idleMs = IDLE_MS }) {
  const reads = new Map()

  function close (key) {
    const read = reads.get(key)
    if (!read) return
    reads.delete(key)
    clearTimeout(read.timer)
    read.torrent.off('close', read.onTorrentClose)
    read.stream.destroy()
    // A file stream waiting on a piece of a torrent that is gone never
    // answers, so a pending read is let go here.
    read.onClose({ done: true })
  }

  async function open (key, { hash, path, start, end }) {
    const torrent = await getTorrent(hash)
    if (!torrent || torrent.destroyed) return null
    const file = (torrent.files || []).find((f) => f.path === path)
    if (!file || end >= file.length) return null
    const stream = file.createReadStream({ start, end })
    const read = { torrent, stream, position: start, end, rest: null, timer: null }
    read.iterator = stream[Symbol.asyncIterator]()
    read.closed = new Promise((resolve) => { read.onClose = resolve })
    read.onTorrentClose = () => close(key)
    torrent.once('close', read.onTorrentClose)
    reads.set(key, read)
    return read
  }

  /**
   * The next chunk of a file from `start`, up to `end`. { data } with the
   * bytes, or { inactive: true } when the torrent or the file is not in the
   * worker or stopped before the range was read, so the caller reads disk.
   */
  async function read ({ stream: key, hash, path, start, end }) {
    let current = reads.get(key)
    if (current && (current.position !== start || current.end !== end)) {
      close(key)
      current = null
    }
    current = current || await open(key, { hash, path, start, end })
    if (!current) return { inactive: true }
    clearTimeout(current.timer)

    let chunk = current.rest
    current.rest = null
    if (!chunk) {
      const next = await Promise.race([current.iterator.next(), current.closed]).catch(() => ({ done: true }))
      if (next.done || reads.get(key) !== current) {
        close(key)
        return { inactive: true }
      }
      chunk = next.value
    }
    // A stream from byte 0 to byte 0 reads the whole file in WebTorrent.
    chunk = chunk.subarray(0, current.end - current.position + 1)
    if (chunk.length > MAX_CHUNK) {
      current.rest = chunk.subarray(MAX_CHUNK)
      chunk = chunk.subarray(0, MAX_CHUNK)
    }
    current.position += chunk.length
    if (current.position > current.end) close(key)
    else {
      current.timer = setTimeout(() => close(key), idleMs)
      current.timer.unref?.()
    }
    return { data: chunk }
  }

  function closeAll () {
    for (const key of [...reads.keys()]) close(key)
  }

  return { read, close, closeAll, get size () { return reads.size } }
}
