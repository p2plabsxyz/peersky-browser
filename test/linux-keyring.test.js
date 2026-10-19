import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  applyPasswordStore,
  choosePasswordStore,
  chosenPasswordStore,
  keyringUnlocked,
  KEYRING_STORE,
  PASSWORD_STORE_FILE
} from '../src/linux-keyring.js'

// On a Linux desktop Electron does not know, safe storage fell back to a
// password built into Chromium, and the private drive key stayed plain. The
// keyring is chosen when it is open, and only then: a Pi that logs in by
// itself would be asked for a password at every boot.
describe('the keyring on Linux', function () {
  let dir

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peersky-keyring-'))
  })

  function commandLine () {
    const switches = []
    return { switches, appendSwitch: (name, value) => switches.push([name, value]) }
  }

  const open = () => true
  const locked = () => false

  it('chooses the keyring where Electron fell back and the keyring is open, for the next start', function () {
    expect(choosePasswordStore({ userDataDir: dir, backend: 'basic_text', platform: 'linux', argv: [], isUnlocked: open })).to.equal(true)
    const saved = JSON.parse(fs.readFileSync(path.join(dir, PASSWORD_STORE_FILE), 'utf8'))
    expect(saved.store).to.equal(KEYRING_STORE)
    const line = commandLine()
    expect(applyPasswordStore(line, { userDataDir: dir, platform: 'linux', argv: [] })).to.equal(KEYRING_STORE)
    expect(line.switches).to.deep.equal([['password-store', KEYRING_STORE]])
  })

  it('leaves a locked or missing keyring alone, so nobody is asked for a password', function () {
    expect(choosePasswordStore({ userDataDir: dir, backend: 'basic_text', platform: 'linux', argv: [], isUnlocked: locked })).to.equal(false)
    expect(chosenPasswordStore(dir)).to.equal(null)
    const line = commandLine()
    applyPasswordStore(line, { userDataDir: dir, platform: 'linux', argv: [] })
    expect(line.switches).to.deep.equal([])
  })

  it('changes nothing where Electron already uses a keyring, and nothing off Linux', function () {
    for (const backend of ['gnome_libsecret', 'kwallet5', 'kwallet6', null]) {
      expect(choosePasswordStore({ userDataDir: dir, backend, platform: 'linux', argv: [], isUnlocked: open })).to.equal(false)
    }
    expect(choosePasswordStore({ userDataDir: dir, backend: 'basic_text', platform: 'darwin', argv: [], isUnlocked: open })).to.equal(false)
    fs.writeFileSync(path.join(dir, PASSWORD_STORE_FILE), JSON.stringify({ store: KEYRING_STORE }))
    const line = commandLine()
    expect(applyPasswordStore(line, { userDataDir: dir, platform: 'win32', argv: [] })).to.equal(null)
    expect(line.switches).to.deep.equal([])
  })

  it('keeps the keyring once chosen, even when it is locked at a later start', function () {
    choosePasswordStore({ userDataDir: dir, backend: 'basic_text', platform: 'linux', argv: [], isUnlocked: open })
    // Secrets the keyring locked open only with it.
    const line = commandLine()
    applyPasswordStore(line, { userDataDir: dir, platform: 'linux', argv: [] })
    expect(line.switches).to.deep.equal([['password-store', KEYRING_STORE]])
    expect(choosePasswordStore({ userDataDir: dir, backend: 'gnome_libsecret', platform: 'linux', argv: [], isUnlocked: locked })).to.equal(false)
  })

  it('never goes over a --password-store given at launch', function () {
    fs.writeFileSync(path.join(dir, PASSWORD_STORE_FILE), JSON.stringify({ store: KEYRING_STORE }))
    for (const argv of [['--password-store=basic'], ['--password-store', 'kwallet6']]) {
      const line = commandLine()
      expect(applyPasswordStore(line, { userDataDir: dir, platform: 'linux', argv })).to.equal(null)
      expect(line.switches).to.deep.equal([])
    }
    fs.rmSync(path.join(dir, PASSWORD_STORE_FILE))
    expect(choosePasswordStore({ userDataDir: dir, backend: 'basic_text', platform: 'linux', argv: ['--password-store=basic'], isUnlocked: open })).to.equal(false)
  })

  it('ignores a file that names anything but the keyring', function () {
    fs.writeFileSync(path.join(dir, PASSWORD_STORE_FILE), JSON.stringify({ store: 'basic --no-sandbox' }))
    expect(chosenPasswordStore(dir)).to.equal(null)
    fs.writeFileSync(path.join(dir, PASSWORD_STORE_FILE), 'not json')
    expect(chosenPasswordStore(dir)).to.equal(null)
  })

  describe('asking whether the keyring is open', function () {
    function spawnAnswers (answers) {
      const calls = []
      return {
        calls,
        spawn: (command, args) => {
          calls.push([command, ...args])
          const answer = answers[command]
          if (answer instanceof Error) throw answer
          return answer || { status: 1, stdout: '' }
        }
      }
    }

    it('reads busctl, and never starts a keyring that is not running', function () {
      const { spawn, calls } = spawnAnswers({ busctl: { status: 0, stdout: 'b false\n' } })
      expect(keyringUnlocked({ spawn })).to.equal(true)
      expect(calls[0]).to.include('--auto-start=no')
      expect(keyringUnlocked({ spawn: spawnAnswers({ busctl: { status: 0, stdout: 'b true\n' } }).spawn })).to.equal(false)
    })

    it('falls back to gdbus where there is no busctl', function () {
      const missing = Object.assign(new Error('spawn busctl ENOENT'), { code: 'ENOENT' })
      expect(keyringUnlocked({ spawn: spawnAnswers({ busctl: missing, gdbus: { status: 0, stdout: '(<false>,)\n' } }).spawn })).to.equal(true)
      expect(keyringUnlocked({ spawn: spawnAnswers({ busctl: missing, gdbus: { status: 0, stdout: '(<true>,)\n' } }).spawn })).to.equal(false)
    })

    it('says no when there is no keyring running, without starting one through gdbus', function () {
      const { spawn, calls } = spawnAnswers({ gdbus: { status: 0, stdout: '(<false>,)\n' } })
      expect(keyringUnlocked({ spawn })).to.equal(false)
      expect(calls.map((call) => call[0])).to.deep.equal(['busctl'])
    })

    it('says no when neither can ask', function () {
      const missing = { error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), status: null }
      expect(keyringUnlocked({ spawn: spawnAnswers({ busctl: missing, gdbus: missing }).spawn })).to.equal(false)
    })
  })
})
