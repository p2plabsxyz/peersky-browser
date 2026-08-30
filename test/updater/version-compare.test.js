// The updater used to compare versions with localeCompare, which ranks 1.0.0
// below 1.0.0-beta.28 because the shorter string sorts first. Beta users would
// have been stranded on the first stable release, silently.

import { expect } from 'chai'
import { compareVersions, isNewerVersion } from '../../src/version-compare.js'

describe('version comparison', function () {
  describe('the beta to stable transition', function () {
    it('treats a stable release as newer than its own prerelease', function () {
      expect(isNewerVersion('1.0.0', '1.0.0-beta.28')).to.equal(true)
      expect(isNewerVersion('1.0.0', '1.0.0-beta.1')).to.equal(true)
      expect(isNewerVersion('1.0.0', '1.0.0-rc.1')).to.equal(true)
    })

    it('never offers a prerelease to someone already on the stable release', function () {
      expect(isNewerVersion('1.0.0-beta.28', '1.0.0')).to.equal(false)
      expect(isNewerVersion('1.0.0-rc.1', '1.0.0')).to.equal(false)
    })
  })

  describe('prerelease ordering', function () {
    it('compares numeric identifiers numerically, not as text', function () {
      expect(isNewerVersion('1.0.0-beta.10', '1.0.0-beta.9')).to.equal(true)
      expect(isNewerVersion('1.0.0-beta.9', '1.0.0-beta.10')).to.equal(false)
      expect(isNewerVersion('1.0.0-beta.29', '1.0.0-beta.28')).to.equal(true)
      expect(isNewerVersion('1.0.0-beta.28', '1.0.0-beta.29')).to.equal(false)
    })

    it('orders alphanumeric identifiers lexically', function () {
      expect(isNewerVersion('1.0.0-beta', '1.0.0-alpha')).to.equal(true)
      expect(isNewerVersion('1.0.0-rc', '1.0.0-beta')).to.equal(true)
      expect(isNewerVersion('1.0.0-alpha', '1.0.0-beta')).to.equal(false)
    })

    it('ranks a numeric identifier below an alphanumeric one', function () {
      expect(compareVersions('1.0.0-1', '1.0.0-alpha')).to.equal(-1)
      expect(compareVersions('1.0.0-alpha', '1.0.0-1')).to.equal(1)
    })

    it('ranks more identifiers above fewer when the prefix matches', function () {
      expect(isNewerVersion('1.0.0-beta.1', '1.0.0-beta')).to.equal(true)
      expect(isNewerVersion('1.0.0-beta', '1.0.0-beta.1')).to.equal(false)
    })
  })

  describe('release numbers', function () {
    it('compares each part numerically', function () {
      expect(isNewerVersion('1.10.0', '1.9.0')).to.equal(true)
      expect(isNewerVersion('1.0.10', '1.0.9')).to.equal(true)
      expect(isNewerVersion('2.0.0', '1.99.99')).to.equal(true)
      expect(isNewerVersion('1.9.0', '1.10.0')).to.equal(false)
    })

    it('reports equal versions as not newer', function () {
      expect(isNewerVersion('1.0.0', '1.0.0')).to.equal(false)
      expect(isNewerVersion('1.0.0-beta.28', '1.0.0-beta.28')).to.equal(false)
      expect(compareVersions('1.0.0', '1.0.0')).to.equal(0)
    })

    it('accepts a leading v, as git tags carry one', function () {
      expect(isNewerVersion('v1.0.1', '1.0.0')).to.equal(true)
      expect(isNewerVersion('v1.0.0', 'v1.0.0-beta.28')).to.equal(true)
    })

    it('ignores build metadata, which carries no precedence', function () {
      expect(compareVersions('1.0.0+build.5', '1.0.0')).to.equal(0)
      expect(compareVersions('1.0.0+a', '1.0.0+b')).to.equal(0)
      expect(isNewerVersion('1.0.1+build', '1.0.0')).to.equal(true)
    })
  })

  describe('refusing to guess', function () {
    const junk = ['', '   ', 'garbage', '1.0', '1', 'v', '1.0.0.0', null, undefined, '1.0.0-', 'x.y.z', '-1.0.0', '1.0.0 ; rm -rf /']

    for (const value of junk) {
      it(`never offers an update for ${JSON.stringify(value)}`, function () {
        expect(isNewerVersion(value, '1.0.0-beta.28')).to.equal(false)
        expect(isNewerVersion('1.0.0', value)).to.equal(false)
        expect(compareVersions(value, '1.0.0')).to.equal(null)
      })
    }

    it('tolerates surrounding whitespace', function () {
      expect(isNewerVersion(' 1.0.1 ', '1.0.0')).to.equal(true)
    })
  })

  describe('the exact cases the old comparison got wrong', function () {
    const localeCompare = (latest, current) =>
      latest.localeCompare(current, undefined, { numeric: true, sensitivity: 'base' }) > 0

    it('disagrees with localeCompare where localeCompare was wrong', function () {
      expect(localeCompare('1.0.0', '1.0.0-beta.28')).to.equal(false)
      expect(isNewerVersion('1.0.0', '1.0.0-beta.28')).to.equal(true)

      expect(localeCompare('1.0.0-beta.28', '1.0.0')).to.equal(true)
      expect(isNewerVersion('1.0.0-beta.28', '1.0.0')).to.equal(false)
    })

    it('still agrees with localeCompare where it was right', function () {
      for (const [l, c] of [['1.0.0-beta.29', '1.0.0-beta.28'], ['1.0.1', '1.0.0-beta.28'], ['1.1.0', '1.0.0-beta.28'], ['2.0.0', '1.0.0-beta.28']]) {
        expect(localeCompare(l, c), `${l} vs ${c}`).to.equal(true)
        expect(isNewerVersion(l, c), `${l} vs ${c}`).to.equal(true)
      }
    })
  })
})
