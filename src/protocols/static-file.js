/**
 * Serving bundled files over the internal peersky:// and browser:// schemes.
 *
 * Every internal page pulls a dozen of these — stylesheets, scripts, icons,
 * fonts — and they were served with `Cache-Control: no-cache` and no validator,
 * so each page load re-resolved and re-streamed all of them off disk. Attaching
 * a real validator lets Chromium keep the bytes and revalidate instead, which
 * turns a repeat load into one stat per asset. `no-cache` is kept rather than a
 * max-age so an edited file still shows up on the next load in development.
 *
 * Kept free of Electron imports so the caching rules can be tested directly.
 */

import mime from 'mime-types'
import { Readable } from 'stream'

/** Positive path resolutions only: a miss must stay a miss so new files appear. */
const MAX_RESOLVE_CACHE_ENTRIES = 512

/**
 * Promisified ScopedFS.stat.
 *
 * @param {{ stat: Function }} scopedFs
 * @param {string} filePath
 * @returns {Promise<import('fs').Stats|null>} null when the path is not a file
 */
export function statFile (scopedFs, filePath) {
  return new Promise((resolve, reject) => {
    scopedFs.stat(filePath, (err, stat) => {
      if (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') resolve(null)
        else reject(err)
      } else {
        resolve(stat.isFile() ? stat : null)
      }
    })
  })
}

/**
 * Resolve a request path against a list of candidate shapes (bare, /index.html,
 * .html), remembering which shape won.
 *
 * The resolution is a property of the bundle layout, not of file contents, so
 * caching it is safe: a hit still stats the resolved file before serving, and a
 * resolved path that later disappears is evicted on the next miss.
 *
 * @param {object} options
 * @param {{ stat: Function }} options.scopedFs
 * @param {string} options.filePath
 * @param {Array<(p: string) => string>} options.candidates
 * @param {Map<string, string>} options.cache
 * @returns {Promise<{ resolvedPath: string, stat: import('fs').Stats }>}
 */
export async function resolveFileCached ({ scopedFs, filePath, candidates, cache }) {
  const cached = cache.get(filePath)
  if (cached !== undefined) {
    const stat = await statFile(scopedFs, cached)
    if (stat) return { resolvedPath: cached, stat }
    cache.delete(filePath)
  }

  for (const toTry of candidates) {
    const tryPath = toTry(filePath)
    const stat = await statFile(scopedFs, tryPath)
    if (stat) {
      if (cache.size >= MAX_RESOLVE_CACHE_ENTRIES) cache.clear()
      cache.set(filePath, tryPath)
      return { resolvedPath: tryPath, stat }
    }
  }

  throw Object.assign(new Error('File not found'), { code: 'ENOENT' })
}

/**
 * Strong validator for a bundled file: it changes whenever the bytes could
 * have.
 *
 * @param {import('fs').Stats} stat
 * @returns {string}
 */
export function fileETag (stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
}

/**
 * True when the client already holds this exact version.
 *
 * @param {Request|{ headers?: any }} request
 * @param {string} etag
 * @returns {boolean}
 */
export function isFresh (request, etag) {
  const header = readHeader(request, 'if-none-match')
  if (!header) return false
  // A conditional request may list several tags, and a proxy may weaken them.
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .includes(etag)
}

function readHeader (request, name) {
  const headers = request?.headers
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  // Plain-object headers (tests, non-fetch callers) are case-insensitive too.
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name)
  return match ? headers[match] : null
}

/**
 * Build the response for a resolved bundled file: 304 when the client's copy is
 * current, otherwise the bytes plus the validator it should send next time.
 *
 * @param {object} options
 * @param {{ createReadStream: Function }} options.scopedFs
 * @param {string} options.resolvedPath
 * @param {import('fs').Stats} options.stat
 * @param {Request|{ headers?: any }} options.request
 * @param {Record<string, string>} [options.headers] - Merged over the defaults.
 * @returns {Response}
 */
export function respondWithFile ({ scopedFs, resolvedPath, stat, request, headers = {} }) {
  const etag = fileETag(stat)
  const validators = {
    ETag: etag,
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    'Cache-Control': 'no-cache'
  }

  if (isFresh(request, etag)) {
    return new Response(null, { status: 304, headers: { ...validators, ...headers } })
  }

  return new Response(Readable.toWeb(scopedFs.createReadStream(resolvedPath)), {
    status: 200,
    headers: {
      'Content-Type': mime.lookup(resolvedPath) || 'text/plain',
      ...validators,
      ...headers
    }
  })
}
