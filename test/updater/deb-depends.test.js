// The deb installed on Ubuntu Server but would not start: the app binary links
// libasound.so.2, and a server has no sound library, while electron-builder's
// default Depends leaves it out. The binary also links libgbm.so.1, which GTK
// only happens to bring on some systems. Setting deb.depends replaces the
// defaults, so they have to stay in the list.

import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { expect } from 'chai'

const root = path.resolve(import.meta.dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const depends = pkg.build.deb.depends

// electron-builder's own list, so a newer version that adds to it is noticed.
function builderDefaults () {
  const require = createRequire(path.join(root, 'package.json'))
  const FpmTarget = require('app-builder-lib/out/targets/FpmTarget').default
  return FpmTarget.prototype.getDefaultDepends.call({}, 'deb')
}

describe('Linux deb dependencies', () => {
  it('keeps every library electron-builder would list by default', () => {
    const defaults = builderDefaults()
    expect(defaults.length).to.be.greaterThan(0)
    for (const name of defaults) expect(depends, name).to.include(name)
  })

  it('adds the sound and GPU buffer libraries the app binary links', () => {
    expect(depends).to.include('libgbm1')
    // Ubuntu 24.04 renamed it libasound2t64; older Ubuntu and Debian 12 have libasound2.
    expect(depends).to.include('libasound2t64 | libasound2')
  })

  it('lists plain package names only, each once', () => {
    expect(new Set(depends).size).to.equal(depends.length)
    // Names, with | between alternatives: no versions or anything a shell or
    // the control file would read differently.
    for (const entry of depends) {
      expect(entry).to.match(/^[a-z0-9][a-z0-9.+-]+( \| [a-z0-9][a-z0-9.+-]+)*$/, entry)
    }
  })

  it('leaves the other Linux packages and the AppImage alone', () => {
    expect(pkg.build.linux.depends).to.equal(undefined)
    expect(pkg.build.linux.target).to.include.members(['deb', 'AppImage', 'apk', 'pacman'])
    expect(pkg.build.deb.fpm).to.have.length(2)
  })
})
