// Where tab groups sit in the strip, worked out without the DOM so it can be
// tested. Loaded as a plain script before tab-bar.js, which reads it from
// globalThis.TabGroupLayout; tests import it the same way.
//
// A group is its header followed by all its tabs, kept together where its
// first tab is. A tab added to a group from anywhere in the strip therefore
// moves under it, and a tab taken out of a group moves out past it.
(() => {
  /**
   * The order the strip should show.
   *
   * tabs: the strip's tabs in their current order, as
   *   { id, groupId, pairWith }: groupId null when ungrouped, pairWith the
   *   right tab's id on the left tab of a split pair.
   * groupIds: the groups that exist, so a stale assignment is ignored.
   *
   * Returns entries in order: { type: 'header', groupId } or { type: 'tab', id }.
   */
  function arrangeStrip (tabs, groupIds) {
    const known = groupIds instanceof Set ? groupIds : new Set(groupIds || [])
    const byId = new Map(tabs.map(tab => [tab.id, tab]))
    const groupOf = (tab) => (tab.groupId && known.has(tab.groupId) ? tab.groupId : null)
    const members = new Map()
    for (const tab of tabs) {
      const groupId = groupOf(tab)
      if (!groupId) continue
      if (!members.has(groupId)) members.set(groupId, [])
      members.get(groupId).push(tab)
    }

    const placed = new Set()
    const out = []
    // A split pair stays side by side, so the right tab follows the left one
    // wherever that goes.
    const emit = (tab) => {
      if (placed.has(tab.id)) return
      placed.add(tab.id)
      out.push({ type: 'tab', id: tab.id })
      const partner = tab.pairWith && byId.get(tab.pairWith)
      if (partner && !placed.has(partner.id)) {
        placed.add(partner.id)
        out.push({ type: 'tab', id: partner.id })
      }
    }

    for (const tab of tabs) {
      if (placed.has(tab.id)) continue
      const groupId = groupOf(tab)
      if (groupId && !placed.has(`group:${groupId}`)) {
        placed.add(`group:${groupId}`)
        out.push({ type: 'header', groupId })
        for (const member of members.get(groupId)) emit(member)
      } else {
        emit(tab)
      }
    }
    return out
  }

  /**
   * The group a dragged tab ends up in, from what sits either side of where
   * it was dropped: { type: 'header', groupId }, { type: 'tab', groupId } or
   * null for nothing.
   *
   * Dropped under a header, or between two tabs of one group, it joins that
   * group. Dropped straight after a group's last tab it stays in the group
   * only if it came from it, so a tab can be put right after a group without
   * joining it. Anywhere else it is on its own.
   */
  function groupForDrop (prev, next, fromGroupId = null) {
    if (prev && prev.type === 'header') return prev.groupId || null
    if (prev && prev.type === 'tab' && prev.groupId) {
      if (next && next.type === 'tab' && next.groupId === prev.groupId) return prev.groupId
      if (fromGroupId && fromGroupId === prev.groupId) return prev.groupId
    }
    return null
  }

  globalThis.TabGroupLayout = { arrangeStrip, groupForDrop }
})()
