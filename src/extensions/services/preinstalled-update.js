// A new bundled version of a preinstalled extension goes where the old one is.
//
// Electron names an extension with no manifest key after the folder it loads
// from, and keeps its storage, chrome.storage and IndexedDB, under that name.
// Each version used to be imported into a folder of its own, so a new bundled
// version came up as another extension, and uBlock Origin's own filters,
// trusted sites and settings stayed behind with the old name. Chrome keeps an
// extension's ID and data through an update, and so does this: the new files
// take the old ones' folder, under the same record.

import path from 'path'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { ensureDir } from '../util.js'

/**
 * Moves a freshly prepared version into the installed one's folder.
 * @param {object} existing - the installed record
 * @param {object} fresh - the new version, as the archive or directory installer placed it
 * @returns {Promise<object>} the installed record with the new version's details
 */
export async function moveIntoPlace (existing, fresh) {
  if (!existing?.installedPath || !fresh?.installedPath) throw new Error('Nothing to update in place')
  if (path.resolve(existing.installedPath) === path.resolve(fresh.installedPath)) throw new Error('The new version is already in place')
  await swapDir(fresh.installedPath, existing.installedPath)
  // The new version's own folder, now empty.
  await fs.rm(path.dirname(fresh.installedPath), { recursive: true, force: true }).catch(() => {})

  const updated = {
    ...existing,
    name: fresh.name,
    displayName: fresh.displayName,
    version: fresh.version,
    description: fresh.description,
    displayDescription: fresh.displayDescription,
    manifest: fresh.manifest,
    updateDate: new Date().toISOString()
  }
  if (typeof fresh.iconPath === 'string') {
    updated.iconPath = fresh.iconPath.replace(`/extension-icon/${fresh.id}/`, `/extension-icon/${existing.id}/`)
  }
  if (fresh.warnings?.length) updated.warnings = fresh.warnings
  else delete updated.warnings
  return updated
}

// The old folder is set aside until the new one is in its place, and put back
// if that fails, so a failed update leaves the old version as it was.
async function swapDir (fromDir, toDir) {
  await ensureDir(path.dirname(toDir))
  const aside = `${toDir}.old-${randomBytes(4).toString('hex')}`
  let setAside = false
  try {
    await fs.rename(toDir, aside)
    setAside = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    await fs.rename(fromDir, toDir)
  } catch (error) {
    if (setAside) await fs.rename(aside, toDir).catch(() => {})
    throw error
  }
  if (setAside) await fs.rm(aside, { recursive: true, force: true }).catch(() => {})
}
