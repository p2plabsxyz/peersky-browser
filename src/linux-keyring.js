import { spawnSync } from 'child_process'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import path from 'path'

// On Linux, Electron's safe storage (PeerChat's room keys, the private drive
// key, the names of private files, site cookies) uses the keyring it expects
// from the desktop's name. On a desktop it does not know, such as Raspberry
// Pi OS, i3 or Sway, it falls back to a password built into every copy of
// Chromium, which locks nothing, so PeerSky leaves its own files plain there
// (sealed-file.js). Many of those systems still run GNOME Keyring. Where
// Electron fell back and the keyring's default collection is already
// unlocked, PeerSky chooses the keyring, from the next start on.
//
// Only when it is unlocked: a Raspberry Pi that logs in by itself has its
// keyring locked or missing, and using it would ask for a password at every
// boot, which a Pi left on to be someone's cloud cannot answer. Once chosen it
// is kept, since what the keyring locked opens only with it. What was locked
// with the built-in password still opens after the switch: Chromium marks it
// (v10) and keeps that password for it. A --password-store given at launch is
// the person's own choice, and nothing here goes over it.

export const PASSWORD_STORE_FILE = 'password-store.json'
export const KEYRING_STORE = 'gnome-libsecret'

const DEFAULT_COLLECTION = '/org/freedesktop/secrets/aliases/default'

function storeFile (userDataDir) {
  return path.join(userDataDir, PASSWORD_STORE_FILE)
}

function hasOwnPasswordStore (argv) {
  return argv.some((arg) => arg === '--password-store' || String(arg).startsWith('--password-store='))
}

/** The keyring chosen at an earlier start, or null. */
export function chosenPasswordStore (userDataDir, { readFile = readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFile(storeFile(userDataDir), 'utf8'))
    return parsed && parsed.store === KEYRING_STORE ? KEYRING_STORE : null
  } catch {
    return null
  }
}

/** Before the app is ready: the keyring chosen before, given to Electron. */
export function applyPasswordStore (commandLine, { userDataDir, platform = process.platform, argv = process.argv, readFile } = {}) {
  if (platform !== 'linux' || !userDataDir || hasOwnPasswordStore(argv)) return null
  const store = chosenPasswordStore(userDataDir, { readFile })
  if (store) commandLine.appendSwitch('password-store', store)
  return store
}

/**
 * Whether the keyring's default collection is there and unlocked, asked over
 * D-Bus with busctl (systemd) or else gdbus (GLib). Asking never prompts.
 * busctl is told not to start a keyring that is not running.
 */
export function keyringUnlocked ({ spawn = spawnSync } = {}) {
  const run = (command, args) => {
    let result
    try {
      result = spawn(command, args, { encoding: 'utf8', timeout: 2000 })
    } catch (error) {
      return { missing: error?.code === 'ENOENT', out: null }
    }
    if (result?.error) return { missing: result.error.code === 'ENOENT', out: null }
    return { missing: false, out: result?.status === 0 ? String(result.stdout || '').trim() : null }
  }
  // Only where there is no busctl: gdbus may start a keyring that is not
  // running.
  const busctl = run('busctl', ['--user', '--auto-start=no', 'get-property', 'org.freedesktop.secrets', DEFAULT_COLLECTION, 'org.freedesktop.Secret.Collection', 'Locked'])
  if (!busctl.missing) return busctl.out === 'b false'
  const gdbus = run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', DEFAULT_COLLECTION, '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked'])
  return gdbus.out === '(<false>,)'
}

/**
 * After the app is ready, given the store Electron picked: chooses the
 * keyring for the next start when Electron fell back and the keyring is open
 * now. True when it chose it.
 */
export function choosePasswordStore ({
  userDataDir,
  backend,
  platform = process.platform,
  argv = process.argv,
  isUnlocked = keyringUnlocked,
  readFile,
  writeFile = writeFileSync,
  now = Date.now
} = {}) {
  if (platform !== 'linux' || backend !== 'basic_text' || !userDataDir) return false
  if (hasOwnPasswordStore(argv) || chosenPasswordStore(userDataDir, { readFile })) return false
  if (!isUnlocked()) return false
  const destination = storeFile(userDataDir)
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    mkdirSync(userDataDir, { recursive: true })
    writeFile(temporary, JSON.stringify({ version: 1, store: KEYRING_STORE, chosenAt: new Date(now()).toISOString() }, null, 2), { mode: 0o600 })
    renameSync(temporary, destination)
    return true
  } catch {
    return false
  }
}
