import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises'
import {
  PRIVATE_DRIVE_OWNERSHIP_FILE,
  isOwnedPrivateDrive,
  readPrivateDriveOwnership,
  setPrivateDriveOwnership,
  currentPrivateDriveIds
} from '../../src/protocols/private-drive-ownership.js'
import { PRIVATE_HYPER_BACKUP_TARGETS } from '../../src/backup/backup-core.js'
import { PRIVATE_HYPERDRIVE_REGISTRY_FILE } from '../../src/protocols/private-hyperdrive-registry.js'

const DRIVE_A = 'a'.repeat(64)
const DRIVE_B = 'b'.repeat(64)

describe('private drive ownership', function () {
  it('treats drives with no ownership record as owned', async function () {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-own-'))
    try {
      expect(await isOwnedPrivateDrive(userDataDir, DRIVE_A)).to.equal(true)
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('marks an adopted drive as read-only and back again', async function () {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-own-'))
    try {
      expect(await setPrivateDriveOwnership(userDataDir, DRIVE_A, false)).to.equal(true)
      expect(await isOwnedPrivateDrive(userDataDir, DRIVE_A)).to.equal(false)

      const persisted = JSON.parse(await readFile(path.join(userDataDir, PRIVATE_DRIVE_OWNERSHIP_FILE), 'utf8'))
      expect(persisted[DRIVE_A]).to.deep.equal({ owned: false })

      await setPrivateDriveOwnership(userDataDir, DRIVE_A, true)
      expect(await isOwnedPrivateDrive(userDataDir, DRIVE_A)).to.equal(true)
      expect(await readPrivateDriveOwnership(userDataDir)).to.deep.equal({ [DRIVE_A]: { owned: true } })
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('ignores malformed drive ids and records when writing', async function () {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-own-'))
    try {
      expect(await setPrivateDriveOwnership(userDataDir, 'not-hex', false)).to.equal(false)
      expect(await isOwnedPrivateDrive(userDataDir, 'not-hex')).to.equal(true)

      await writeFile(path.join(userDataDir, PRIVATE_DRIVE_OWNERSHIP_FILE), JSON.stringify({
        [DRIVE_A]: { owned: true },
        zzz: { owned: false }
      }))
      expect(await readPrivateDriveOwnership(userDataDir)).to.deep.equal({ [DRIVE_A]: { owned: true } })
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('resolves the set of drive ids currently listed in the registry', async function () {
    const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-own-'))
    try {
      expect([...(await currentPrivateDriveIds(userDataDir))]).to.deep.equal([])

      await writeFile(path.join(userDataDir, PRIVATE_HYPERDRIVE_REGISTRY_FILE), JSON.stringify([
        { name: 'a', url: `hyper://${DRIVE_A}/`, timestamp: 1, encrypted: true },
        { name: 'b', url: `hyper://${DRIVE_B}/`, timestamp: 2, encrypted: true }
      ]))

      const ids = await currentPrivateDriveIds(userDataDir)
      expect(ids.has(DRIVE_A)).to.equal(true)
      expect(ids.has(DRIVE_B)).to.equal(true)
    } finally {
      await rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('keeps ownership out of private backup targets', async function () {
    const names = PRIVATE_HYPER_BACKUP_TARGETS.map((target) => target.name)
    expect(names).to.not.include(PRIVATE_DRIVE_OWNERSHIP_FILE)
  })
})
