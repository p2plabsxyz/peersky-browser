// Semver precedence, used to decide whether a release supersedes the running
// build. String collation is not a substitute: it ranks 1.0.0 below
// 1.0.0-beta.28, which would strand every beta user on a stable release.

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion (value) {
  const match = SEMVER.exec(String(value ?? '').trim())
  if (!match) return null
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : []
  }
}

function comparePrerelease (a, b) {
  // Having a prerelease at all ranks below not having one: 1.0.0 > 1.0.0-beta.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    const numA = /^\d+$/.test(a[i])
    const numB = /^\d+$/.test(b[i])
    // Numeric identifiers compare numerically and rank below alphanumeric ones.
    if (numA && numB) return Number(a[i]) < Number(b[i]) ? -1 : 1
    if (numA) return -1
    if (numB) return 1
    return a[i] < b[i] ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * Semver precedence. Returns null when either version cannot be parsed.
 */
export function compareVersions (a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null

  for (let i = 0; i < 3; i++) {
    if (left.release[i] !== right.release[i]) {
      return left.release[i] < right.release[i] ? -1 : 1
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * True when `latest` should replace `current`. Unparseable input means no.
 */
export function isNewerVersion (latest, current) {
  return compareVersions(latest, current) === 1
}
