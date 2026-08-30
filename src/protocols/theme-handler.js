import path from 'path'
import { createLogger } from '../logger.js'
import { fileURLToPath } from 'url'
import ScopedFS from 'scoped-fs'
import { Readable } from 'stream'
import { resolveFileCached, respondWithFile } from './static-file.js'

const log = createLogger('protocols:theme')

const __dirname = fileURLToPath(new URL('./', import.meta.url))
const themePath = path.join(__dirname, '../pages/theme')
const pagesPath = path.join(__dirname, '../pages')
const themeFS = new ScopedFS(themePath)
const pagesFS = new ScopedFS(pagesPath)

const CHECK_PATHS = [
  (path) => path,
  (path) => path + 'index.html',
  (path) => path + '/index.html',
  (path) => path + '.html'
]

// request path -> resolved theme path; see the note in static-file.js.
const resolveCache = new Map()

function resolveFile (filePath) {
  return resolveFileCached({ scopedFs: themeFS, filePath, candidates: CHECK_PATHS, cache: resolveCache })
}

async function get404Response () {
  try {
    await new Promise((resolve, reject) => {
      pagesFS.stat('error.html', (err, stat) => {
        if (err) reject(err)
        else resolve(stat.isFile())
      })
    })
    const html404Stream = Readable.toWeb(pagesFS.createReadStream('error.html'))
    return new Response(html404Stream, {
      status: 404,
      headers: {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      }
    })
  } catch (e) {
    log.error('Failed to serve error.html:', e)
    return new Response('File not found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
        'Allow-CSP-From': '*',
        'Cache-Control': 'no-cache'
      }
    })
  }
}

export async function createHandler () {
  return async function protocolHandler (request) {
    const { url } = request
    const parsedUrl = new URL(url)

    if (parsedUrl.hostname === 'theme') {
      const fileName = parsedUrl.pathname.slice(1)

      try {
        let resolved

        // Handle dynamic theme loading for vars.css
        if (fileName === 'vars.css') {
          try {
            // Use the unified themes.css file for all theme switching
            resolved = await resolveFile('themes.css')
          } catch (themeError) {
            // Fallback to default vars.css if unified theme file not found
            log.warn('Unified themes.css file not found, falling back to vars.css')
            resolved = await resolveFile(fileName)
          }
        } else {
          // For all other files, use normal resolution
          resolved = await resolveFile(fileName)
        }

        // These used to be served no-store with an ETag stamped from Date.now().
        // That gave every request a brand new validator, so the shell's ~90KB of
        // CSS and its webfont were re-read and re-parsed on every window and
        // every internal page, and each response also churned a fresh cache
        // entry. A validator derived from the file itself keeps edits visible in
        // development while letting repeat loads answer 304.
        return respondWithFile({
          scopedFs: themeFS,
          resolvedPath: resolved.resolvedPath,
          stat: resolved.stat,
          request,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Allow-CSP-From': '*'
          }
        })
      } catch (e) {
        log.info('File not found:', fileName)
        return get404Response()
      }
    } else {
      return get404Response()
    }
  }
}
