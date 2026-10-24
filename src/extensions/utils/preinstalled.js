// Which bundled entry an installed preinstalled extension came from.
//
// preinstalled.json names an extension in its own words ("PeerSky History",
// "uBlock Origin MV3"), the extension's manifest in its own ("peersky-history",
// "uBlock Origin development build"). Matched on the exact name alone, History
// and uBlock were taken for removed extensions on every start: deleted and
// imported again, and a History tab left open crashed the next start while its
// page was gone. An import now records its entry (preinstalledEntry). One
// imported before that is matched by its name read loosely, then given it.

/** The key an import records for the entry it came from. */
export function preinstalledEntryKey (entry) {
  return entry?.id || entry?.name || entry?.archive || entry?.dir || ''
}

export function matchesPreinstalledEntry (ext, entry) {
  if (!ext || !entry) return false
  if (entry.id && ext.id === entry.id) return true
  if (ext.preinstalledEntry) return ext.preinstalledEntry === preinstalledEntryKey(entry)
  if (entry.name && (ext.displayName === entry.name || ext.name === entry.name)) return true
  return Boolean(entry.name) && (sameName(ext.displayName, entry.name) || sameName(ext.name, entry.name))
}

function looseName (value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// The same letters ("peersky-history", "PeerSky History"), or the same first
// two words ("uBlock Origin development build", "uBlock Origin MV3").
function sameName (a, b) {
  const left = looseName(a)
  const right = looseName(b)
  if (!left || !right) return false
  if (left.replace(/ /g, '') === right.replace(/ /g, '')) return true
  const leftWords = left.split(' ')
  const rightWords = right.split(' ')
  return leftWords.length >= 2 && rightWords.length >= 2 &&
    leftWords[0] === rightWords[0] && leftWords[1] === rightWords[1]
}
