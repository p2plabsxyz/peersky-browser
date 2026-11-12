// Entries taken off the lists in Settings, P2P data, one row at a time. As
// with Clear All, only the entries go: the drives, blocks and files stay.
export const P2P_DATA_LISTS = Object.freeze(['hyper', 'ipfs', 'ens'])

// A row of P2P app drives stands for every entry under that app's name.
const MAX_IDS = 500
const MAX_ID_LENGTH = 1024

// What a row's remove button asks for: a list, and the drive keys, CIDs or
// ENS names to take off it. Anything else is refused.
export function parseListRemoval (request) {
  const list = request?.list
  if (!P2P_DATA_LISTS.includes(list)) throw new Error('Unknown list')
  const ids = Array.isArray(request?.ids) ? request.ids : []
  const valid = ids.length > 0 &&
    ids.length <= MAX_IDS &&
    ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH)
  if (!valid) throw new Error('Nothing to remove')
  return { list, ids: new Set(ids) }
}

// Takes the entries off the list in place: the Hyper and IPFS handlers add to
// these same arrays and map. Says how many went.
export function removeFromP2pDataList ({ hyperCache, ipfsCache, ensCache }, request) {
  const { list, ids } = parseListRemoval(request)
  if (list === 'ens') {
    let removed = 0
    for (const name of ids) {
      if (ensCache?.delete(name)) removed++
    }
    return { list, removed }
  }

  const entries = list === 'hyper' ? hyperCache : ipfsCache
  if (!Array.isArray(entries)) return { list, removed: 0 }
  const field = list === 'hyper' ? 'key' : 'cid'
  const kept = entries.filter((entry) => !ids.has(entry?.[field]))
  const removed = entries.length - kept.length
  if (removed > 0) {
    entries.length = 0
    for (const entry of kept) entries.push(entry)
  }
  return { list, removed }
}
