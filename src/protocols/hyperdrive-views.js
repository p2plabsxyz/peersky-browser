import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { getPagesPath } from './pages-path.js'

// The Hyperdrive app's Files, Photos and Videos views. A tab opening a
// hyper:// folder that holds no website gets them instead of the plain list
// of its files, at peersky://p2p/hyperdrive/<view>/<host><folder>. The views
// are one page in the Hyperdrive app, which reads the view, the drive and the
// folder from its own address and asks the main process for the files.

// The page every view's address is served, under the pages peersky:// serves.
export const VIEWER_PAGE = 'p2p/hyperdrive/viewer/index.html'

// The most files one listing holds. A folder with more says it was cut short.
export const MAX_LISTED_FILES = 50000

// What a listing that fails says it was. The views word each one for people.
export const LIST_ERROR_CODES = ['not-found', 'no-peers', 'private', 'timeout', 'too-large', 'unknown']

// The number the views compare with the one their stored pictures and
// details were kept under. Reset P2P data changes it, and they drop them.
export const VIEWS_FILE = 'hyperdrive-views.json'

// A drive's key, z-base-32 or hex, or a DNS name, as the views take it. A hex
// key is one character longer than a DNS label may be.
const DRIVE_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const HEX_KEY = /^[0-9a-f]{64}$/

function parseUrl (value) {
  try {
    return new URL(String(value))
  } catch {
    return null
  }
}

// hyper://localhost/ is hypercore-fetch's own drive for pages that write,
// never one a person opens.
function driveHostOf (url) {
  if (!url || url.protocol !== 'hyper:') return null
  const host = url.hostname.toLowerCase()
  return host !== 'localhost' && (DRIVE_HOST.test(host) || HEX_KEY.test(host)) ? host : null
}

// The names along a path, decoded. Null when one cannot be read, or would
// step out of its folder once decoded, as the views refuse those as well.
function pathNames (pathname) {
  const names = []
  for (const part of String(pathname || '/').split('/')) {
    if (!part) continue
    let name
    try {
      name = decodeURIComponent(part)
    } catch {
      return null
    }
    if (name === '.' || name === '..' || /[/\\\0]/.test(name)) return null
    names.push(name)
  }
  return names
}

/**
 * The drive and the folder in it a hyper:// address names, the folder
 * decoded with a slash at each end, or null when it names no drive.
 * @param {string} url
 * @returns {{ host: string, folder: string } | null}
 */
export function driveFolderOf (url) {
  const parsed = parseUrl(url)
  const host = driveHostOf(parsed)
  const names = host ? pathNames(parsed.pathname) : null
  if (!names) return null
  return { host, folder: names.length ? `/${names.join('/')}/` : '/' }
}

/**
 * Where a tab opening this folder goes: its Files view, which picks Photos or
 * Videos itself (?auto). Each name in the folder is encoded on its own.
 * @param {string} url
 * @returns {string | null}
 */
export function viewerAddressFor (url) {
  const target = driveFolderOf(url)
  if (!target) return null
  const folder = target.folder === '/'
    ? '/'
    : `/${target.folder.slice(1, -1).split('/').map(encodeURIComponent).join('/')}/`
  return `peersky://p2p/hyperdrive/files/${target.host}${folder}?auto`
}

/**
 * A hyper:// address that names a file the views may download, or null.
 * @param {string} url
 * @returns {string | null}
 */
export function hyperFileUrl (url) {
  const parsed = parseUrl(url)
  if (!driveHostOf(parsed) || parsed.pathname.endsWith('/')) return null
  return pathNames(parsed.pathname)?.length ? parsed.href : null
}

function canonicalOf (link) {
  const match = /<([^>]*)>\s*;\s*rel="?canonical"?/i.exec(String(link || ''))
  return match ? parseUrl(match[1]) : null
}

/**
 * Whether a response is a folder's list of files. hypercore-fetch lists a
 * folder that has no index file as HTML when a tab asks, and names the
 * folder, with its trailing slash, as the canonical address. An index file
 * served in its place names the file. The private store names its lists the
 * same way.
 * @param {Response} response
 */
export function isFolderListing (response) {
  if (!response || response.status !== 200) return false
  if (!/^text\/html\b/i.test(response.headers.get('Content-Type') || '')) return false
  const canonical = canonicalOf(response.headers.get('Link'))
  return Boolean(canonical) && canonical.pathname.endsWith('/')
}

// The index files hypercore-fetch serves for a folder that are no website.
// The views show them under the folder's list. Only index.html, which it also
// serves, and index.htm make a folder a website.
const README_INDEX = /\/(readme\.md|readme\.org|index\.md|index\.gmi|index\.gemini|index\.org)$/i

/**
 * Whether a response is a readme hypercore-fetch served in place of a
 * folder's list, by the file it names as the canonical address.
 * @param {Response} response
 */
export function isFolderReadme (response) {
  if (!response || response.status !== 200) return false
  const canonical = canonicalOf(response.headers.get('Link'))
  return Boolean(canonical) && README_INDEX.test(canonical.pathname)
}

/**
 * The answer to a tab opening a folder that holds no website: a redirect to
 * the views. Null when the folder or file stays as it is: a page's own fetch,
 * ?raw (and hypercore-fetch's own ?noResolve), a website's index file, a
 * readme's own address, anything else.
 * @param {{ url: string, method?: string, navigation?: boolean, response: Response }} request
 * @returns {Response | null}
 */
export function viewerRedirect ({ url, method = 'GET', navigation = false, response }) {
  if (!navigation || String(method).toUpperCase() !== 'GET') return null
  const parsed = parseUrl(url)
  if (!parsed || parsed.searchParams.has('raw') || parsed.searchParams.has('noResolve')) return null
  // A folder's list, or the readme served for the folder's address.
  if (!isFolderListing(response) && !(parsed.pathname.endsWith('/') && isFolderReadme(response))) return null
  const location = viewerAddressFor(url)
  if (!location) return null
  return new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store' } })
}

// What PeerSky calls an upload that was given no name. No name at all.
const UNNAMED_DRIVE = 'Drive'

/**
 * The name this computer made a drive under, from its records of the drives
 * it made, matched by the drive's id (its key in hex). Null when it has none:
 * a name is never made up from an address or from what the drive holds.
 * @param {{ name?: unknown, id?: string | null }[]} records
 * @param {string | null} id
 * @returns {string | null}
 */
export function knownDriveName (records, id) {
  if (!id) return null
  const record = records.find((entry) => entry?.id === id)
  const name = typeof record?.name === 'string' ? record.name.trim() : ''
  if (!name || name === UNNAMED_DRIVE) return null
  // As a drive's name may be when one is made.
  const characters = Array.from(name)
  const control = characters.some((character) => {
    const code = character.codePointAt(0)
    return code <= 31 || (code >= 127 && code <= 159)
  })
  return characters.length <= 255 && !control ? name : null
}

let viewerFound = false

/**
 * Whether the views are here. They come with the Hyperdrive app, which
 * installs move to its own latest main, and that may not have them yet:
 * until it does, a folder keeps its plain list.
 */
export async function hasViewer () {
  if (viewerFound) return true
  try {
    await fs.access(path.join(getPagesPath(), ...VIEWER_PAGE.split('/')))
    viewerFound = true
  } catch {}
  return viewerFound
}

/** An error a listing answers with, as { code, message }. */
export function listError (code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * What the views are told when a listing fails.
 * @returns {{ code: string, message: string }}
 */
export function listFailure (error) {
  let code = LIST_ERROR_CODES.includes(error?.code) ? error.code : 'unknown'
  const message = String(error?.message || error || 'This folder could not be listed')
  if (code === 'unknown') {
    if (error?.code === 'REQUEST_TIMEOUT') code = 'timeout'
    else if (/DNS-?Link|DoH|encoded key or a valid DNSlink/i.test(message)) code = 'not-found'
  }
  return { code, message }
}

/**
 * The files under a folder of an open drive, as the views take them: the
 * path in the drive, the size and the time it was last written, when the
 * drive says. Folders hold no entry of their own and a symlink no file, so
 * neither is listed. At most `maxFiles`; `truncated` says there were more.
 * `empty` says nothing at all is under the folder. A drive that sends
 * nothing for `idleMs` fails as `timeout`, so a peer that went away does not
 * hold the views for good.
 *
 * @param {object} drive - a Hyperdrive
 * @param {string} folder - with a slash at each end
 */
export async function listDriveFiles (drive, folder = '/', {
  recursive = true,
  maxFiles = MAX_LISTED_FILES,
  idleMs = 30000
} = {}) {
  const entries = []
  let truncated = false
  let empty = true
  const iterator = drive.list(folder, { recursive })[Symbol.asyncIterator]()
  try {
    while (true) {
      let timer = null
      const result = await Promise.race([
        iterator.next(),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(listError('timeout', 'The drive stopped sending its list of files')), idleMs)
        })
      ]).finally(() => clearTimeout(timer))
      if (result.done) break
      const node = result.value
      if (typeof node?.key !== 'string') continue
      empty = false
      const filePath = node.key.startsWith('/') ? node.key : `/${node.key}`
      // Not recursive, a folder shows up as the first file in it.
      if (!recursive && filePath.slice(folder.length).includes('/')) continue
      const blob = node.value?.blob
      if (!blob) continue
      if (entries.length >= maxFiles) {
        truncated = true
        break
      }
      const size = blob.byteLength
      const mtime = node.value.metadata?.mtime
      entries.push({
        path: filePath,
        size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
        mtime: Number.isFinite(mtime) ? mtime : null
      })
    }
  } finally {
    if (typeof iterator.return === 'function') await iterator.return().catch(() => {})
  }
  return { entries, truncated, empty }
}

/**
 * The number the views' stored pictures and details go with. 0 before any
 * reset, and when the file cannot be read.
 * @param {string} userDataDir
 */
export async function readCacheEpoch (userDataDir) {
  try {
    const { epoch } = JSON.parse(await fs.readFile(path.join(userDataDir, VIEWS_FILE), 'utf8'))
    return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0
  } catch {
    return 0
  }
}

// One write at a time, so two resets together still end on a new number.
let epochWrite = Promise.resolve()

/**
 * A new number for the views, higher than the last one. Taken from the
 * clock as well, so a file that went missing never brings an old one back.
 * @param {string} userDataDir
 * @returns {Promise<number>}
 */
export function bumpCacheEpoch (userDataDir) {
  const update = epochWrite
    .catch(() => {})
    .then(async () => {
      const epoch = Math.max((await readCacheEpoch(userDataDir)) + 1, Date.now())
      await fs.mkdir(userDataDir, { recursive: true })
      const destination = path.join(userDataDir, VIEWS_FILE)
      const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify({ epoch }), { mode: 0o600 })
        await fs.rename(temporary, destination)
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {})
      }
      return epoch
    })
  epochWrite = update
  return update
}
