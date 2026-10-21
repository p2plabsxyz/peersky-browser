import path from 'path'
import { fileURLToPath } from 'url'
import electron from 'electron'

let pagesPath = null

// Where peersky:// pages are served from, P2P apps included. In packaged
// builds, serve from app.asar.unpacked so we can read updated P2P apps.
export function getPagesPath () {
  if (pagesPath) return pagesPath
  const { app } = electron
  if (app.isPackaged) {
    const unpackedPath = app.getAppPath().replace(/\.asar$/, '.asar.unpacked')
    pagesPath = path.join(unpackedPath, 'src', 'pages')
  } else {
    pagesPath = fileURLToPath(new URL('../pages', import.meta.url))
  }
  return pagesPath
}
