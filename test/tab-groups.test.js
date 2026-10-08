// A tab group stays together in the strip: its header, then all its tabs,
// where the group's first tab is. The rules live in tab-group-layout.js so
// they can be checked here without a DOM; tab-bar.js applies them.
import { describe, it } from 'mocha'
import { expect } from 'chai'
import { readFile } from 'fs/promises'

await import('../src/pages/tab-group-layout.js')
const { arrangeStrip, groupForDrop } = globalThis.TabGroupLayout
const tabBar = await readFile(new URL('../src/pages/tab-bar.js', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/pages/index.html', import.meta.url), 'utf8')

const shown = (entries) => entries.map(e => e.type === 'header' ? `[${e.groupId}]` : e.id).join(' ')

describe('keeping a tab group together', function () {
  it('puts a tab added to a group under it, wherever the tab was', function () {
    const tabs = [{ id: 'a', groupId: 'g' }, { id: 'b', groupId: 'g' }, { id: 'c' }, { id: 'd' }, { id: 'e', groupId: 'g' }]
    expect(shown(arrangeStrip(tabs, ['g']))).to.equal('[g] a b e c d')
  })

  it('moves a tab taken out of a group past it', function () {
    const tabs = [{ id: 'a', groupId: 'g' }, { id: 'x' }, { id: 'b', groupId: 'g' }]
    expect(shown(arrangeStrip(tabs, ['g']))).to.equal('[g] a b x')
  })

  it('keeps each group where its first tab is and other tabs in their order', function () {
    const tabs = [{ id: 'x' }, { id: 'h1', groupId: 'h' }, { id: 'a', groupId: 'g' }, { id: 'y' }, { id: 'b', groupId: 'g' }, { id: 'h2', groupId: 'h' }]
    expect(shown(arrangeStrip(tabs, new Set(['g', 'h'])))).to.equal('x [h] h1 h2 [g] a b y')
  })

  it('ignores a group that no longer exists', function () {
    expect(shown(arrangeStrip([{ id: 'a', groupId: 'gone' }, { id: 'b' }], []))).to.equal('a b')
  })

  it('keeps a split pair side by side', function () {
    const tabs = [{ id: 'l', groupId: 'g', pairWith: 'r' }, { id: 'x' }, { id: 'r' }]
    expect(shown(arrangeStrip(tabs, ['g']))).to.equal('[g] l r x')
  })
})

describe('dropping a tab near a group', function () {
  const header = { type: 'header', groupId: 'g' }
  const inGroup = { type: 'tab', groupId: 'g' }
  const loose = { type: 'tab', groupId: null }

  it('joins the group when dropped under its header', function () {
    expect(groupForDrop(header, inGroup, null)).to.equal('g')
  })

  it('joins the group when dropped between two of its tabs', function () {
    expect(groupForDrop(inGroup, inGroup, null)).to.equal('g')
  })

  it('stays out when dropped straight after a group it was not in', function () {
    expect(groupForDrop(inGroup, loose, null)).to.equal(null)
    expect(groupForDrop(inGroup, null, null)).to.equal(null)
  })

  it('stays in when moved to the end of its own group', function () {
    expect(groupForDrop(inGroup, loose, 'g')).to.equal('g')
  })

  it('leaves its group when dropped among loose tabs or above a header', function () {
    expect(groupForDrop(loose, loose, 'g')).to.equal(null)
    expect(groupForDrop(loose, header, 'g')).to.equal(null)
    expect(groupForDrop(null, header, 'g')).to.equal(null)
  })
})

describe('the strip uses those rules', function () {
  it('loads them before the tab bar', function () {
    expect(page.indexOf('./tab-group-layout.js')).to.be.greaterThan(-1)
    expect(page.indexOf('./tab-group-layout.js')).to.be.lessThan(page.indexOf('./tab-bar.js'))
  })

  it('puts groups back together after a drop, an add, a removal and a restore', function () {
    const settle = tabBar.slice(tabBar.indexOf('  settleDrag () {'), tabBar.indexOf('  // Split View Divider Drag Handlers'))
    expect(settle).to.contain('TabGroupLayout.groupForDrop(prev, next, from)')
    expect(settle).to.contain('this.normalizeGroupLayout()')
    const add = tabBar.slice(tabBar.indexOf('  addTabToGroupAcrossWindows ('), tabBar.indexOf('  animateTabReorder ('))
    expect(add.match(/this\.normalizeGroupLayout\(\)/g)).to.have.length(2)
    expect(add).to.contain('this.saveTabsState()')
    expect(tabBar).to.match(/case 'remove-from-group':\s*this\.removeTabFromGroup\(tabId\)\s*\/\/[^\n]*\n\s*this\.normalizeGroupLayout\(\)/)
    expect(tabBar).to.contain("// Older versions could save a group's tabs apart; this puts them back.\n    this.normalizeGroupLayout()")
  })

  it('drags a group by its header, not from its buttons, and never off the strip', function () {
    const down = tabBar.slice(tabBar.indexOf('  handlePointerDown (e) {'), tabBar.indexOf('  handlePointerMove (e) {'))
    expect(down).to.contain("e.target.closest('.tab-group-toggle, .tab-group-edit, .tab-group-close')")
    expect(down).to.contain('this.dragGroupId = groupId')
    const move = tabBar.slice(tabBar.indexOf('  handlePointerMove (e) {'), tabBar.indexOf('  handlePointerUp (e) {'))
    // rects[lead] is the tab in the hand: the first, unless picked tabs travel together.
    expect(move).to.contain('if (!this.dragGroupId) this.startDragPreview(rects[lead])')
    expect(move).to.match(/if \(this\.dragGroupId\) \{\s*this\.isOutsideContainer = false/)
    expect(move).to.contain('this.dragGroupId ? this.groupDropTargets() : this.tabDropTargets()')
  })
})

describe('dragging in the strip', function () {
  it('never lets the browser start its own drag, which cancelled a slow one', function () {
    expect(tabBar).to.contain('tab.draggable = false')
    expect(tabBar).to.not.contain('tab.draggable = true')
    expect(tabBar).to.contain("this.tabContainer.addEventListener('dragstart', (e) => e.preventDefault())")
  })
})
