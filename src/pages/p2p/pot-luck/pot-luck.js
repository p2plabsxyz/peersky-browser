// pot-luck.js — ported from plan1, running natively on elf.js's Holesail
// transport instead of geckos. As of the elf.js fork, linkState/broadcastElf
// hide all hs://, fetch, and EventSource plumbing — this file never touches
// the transport directly, same as it wouldn't on plan1's geckos-backed elf.
//
// One consequence of the deterministic-key room model: there's no real
// "host" vs "join" distinction anymore. linkState(tag, roomId) races to
// host-or-join automatically, so "creating" a room is just generating a
// fresh roomId and linking to it — whoever does that first becomes host.
//
// Scope note: this first port drops plan1 pot-luck's local multi-potluck
// registry and image upload (both were IndexedDB-backed conveniences,
// not core to proving the sync mechanism) — one room = one potluck.
// Avatars/offerings fall back to initials/emoji instead of uploaded pictures.
// It also drops the live/offline connection badge — elf.js's native
// transport doesn't yet surface a connection-state hook the way the
// hand-rolled EventSource did.

import $elf, { linkState, broadcastElf } from 'peersky://static/elves/elf.js'

const tag = 'pot-luck'

const CUT = '__cut__'
const RUN = 1, OUTPUT = 10, ERROR = 12, DONE = 13

function mergeRoomState (state, payload) {
  const out = { ...state };
  ['users', 'offerings', 'wishes'].forEach((field) => {
    if (payload[field]) {
      const base = { ...(state[field] || {}) }
      const inc = payload[field]
      Object.keys(inc).forEach((k) => {
        if (inc[k] === null) delete base[k]
        else base[k] = inc[k]
      })
      out[field] = base
    }
  })
  if (payload.lastMatch !== undefined) out.lastMatch = payload.lastMatch
  return out
}

const newData = () => ({ users: {}, offerings: {}, wishes: {}, lastMatch: null })

function nextId (prefix) { return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 8) }
function userById (id) { return $.learn().users[id] || null }
function activeUser () { return userById($.learn().activeUserId) }
function offeringById (id) { return $.learn().offerings[id] || null }

// commit: apply locally with the domain merge, then broadcast the same
// patch + merge function to the room — every peer (including late joiners
// via the cache pull) applies the identical merge on receipt.
function commit (patch) {
  $.teach(patch, mergeRoomState)
  broadcastElf(tag, patch, mergeRoomState.toString())
}

const LAST_ROOM_KEY = 'pot-luck:lastRoom'

async function enterRoom (roomId) {
  $.whisper({ connecting: true, connectError: null })
  try {
    await linkState(tag, roomId)
    // Persist to localStorage, not just the URL — a reload that doesn't
    // preserve the ?room= query string (e.g. relaunching from peersky's
    // app list, which always points at the bare app URL) would otherwise
    // silently drop back to an empty room with no error, indistinguishable
    // from the room's data actually being lost.
    try { localStorage.setItem(LAST_ROOM_KEY, roomId) } catch (e) {}
    history.replaceState(null, '', `?room=${encodeURIComponent(roomId)}`)
    $.whisper({ connecting: false, screen: 'home', roomKey: roomId })
  } catch (e) {
    $.whisper({ connecting: false, connectError: String(e.message || e) })
  }
}

// wish list: each user's wish is an ordered list of offering ids (not their own)
// plus the CUT divider. items before CUT are wanted (ranked); after are won't-trade.
function ensureWish (userId) {
  const pool = Object.values($.learn().offerings).filter(o => o.ownerId !== userId).map(o => o.id)
  let order = ($.learn().wishes[userId] || []).slice()
  order = order.filter(t => t === CUT || pool.includes(t))
  if (!order.includes(CUT)) order.push(CUT)
  const present = new Set(order)
  const cutAt = order.indexOf(CUT)
  order.splice(cutAt, 0, ...pool.filter(id => !present.has(id)))
  return order
}

function wantedIds (userId) {
  const order = ensureWish(userId)
  return order.slice(0, order.indexOf(CUT)).filter(t => t !== CUT)
}

function buildWants () {
  const lines = ['#! REQUIRE-USERNAMES', '#! HIDE-NONTRADES', '', '!BEGIN-OFFICIAL-NAMES']
  for (const o of Object.values($.learn().offerings)) {
    lines.push(`${o.id} ==> "${String(o.note || 'gift').replace(/["\n\r]/g, ' ').slice(0, 80)}" (from ${o.ownerId})`)
  }
  lines.push('!END-OFFICIAL-NAMES', '')
  for (const u of Object.values($.learn().users)) {
    const wants = wantedIds(u.id)
    if (!wants.length) continue
    for (const o of Object.values($.learn().offerings).filter(o => o.ownerId === u.id)) {
      lines.push(`(${u.id}) ${o.id} : ${wants.join(' ')}`)
    }
  }
  return lines.join('\n')
}

function inputSignature () {
  return JSON.stringify({
    o: Object.values($.learn().offerings).map(o => [o.id, o.ownerId, o.note]),
    w: Object.values($.learn().users).map(u => wantedIds(u.id))
  })
}

function spawnTradeWorker () {
  const abs = 'peersky://static/js/vendor/trade-maximizer/trademax-worker.js'
  const blob = new Blob([`importScripts(${JSON.stringify(abs)});`], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  const w = new Worker(url)
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return w
}

function runMatch () {
  if (Object.keys($.learn().offerings).length < 2) { $.whisper({ matching: false }); return }
  $.whisper({ matching: true })
  const input = buildWants()
  let out = '', worker
  try { worker = spawnTradeWorker() } catch (e) {
    commit({ lastMatch: { edges: [], at: nowStamp(), sig: inputSignature(), error: String(e) } })
    $.whisper({ matching: false }); return
  }
  worker.onmessage = ({ data: [t, a, nl] }) => {
    if (t === OUTPUT) out += a + (nl ? '\n' : '')
    else if (t === ERROR) out += '\n[error] ' + a + '\n'
    else if (t === DONE) {
      worker.terminate()
      console.log('pot-luck match raw output:\n' + out)
      commit({ lastMatch: { edges: parseLoops(out), at: nowStamp(), sig: inputSignature(), raw: out } })
      $.whisper({ matching: false })
    }
  }
  worker.onerror = (err) => {
    worker.terminate()
    const detail = (err.message || '') + (err.filename ? ` @ ${err.filename}:${err.lineno}` : '')
    commit({ lastMatch: { edges: [], at: nowStamp(), sig: inputSignature(), error: detail.trim() || 'worker error (check console)' } })
    $.whisper({ matching: false })
  }
  console.log('pot-luck match input:\n' + input)
  worker.postMessage([RUN, input])
}

function nowStamp () { return new Date().toLocaleString() }

function parseLoops (out) {
  const edges = []; let inLoops = false
  for (const line of out.split('\n')) {
    if (/^TRADE LOOPS/.test(line)) { inLoops = true; continue }
    if (!inLoops) continue
    if (/^ITEM SUMMARY|^Num trades/.test(line)) break
    const m = line.match(/^\(([^)]+)\)\s+(\S+)\s+receives\s+\(([^)]+)\)\s+(\S+)\s*$/)
    if (m) edges.push({ recvItem: m[2].toUpperCase(), givenItem: m[4].toUpperCase() })
  }
  return edges
}

function offeringByUpper (id) { return Object.values($.learn().offerings).find(o => o.id.toUpperCase() === id) || null }

// === $elf ===
const $ = $elf(tag, {
  ...newData(),
  screen: 'setup', modal: null, matching: false, activeUserId: null,
  connecting: false, connectError: null, roomKey: null, joinKeyInput: ''
})

$.draw(() => {
  const s = $.learn()
  if (s.screen === 'setup') return setupScreen()

  const { screen, activeUserId } = s
  const me = activeUser()
  return `
    <div class="po-shell">
      <div class="po-topbar">
        <span class="po-home-btn">pot-luck</span>
        <nav class="po-nav">
          ${['offer', 'wish', 'match', 'settings'].map(sc => `<button class="po-tab ${screen === sc ? 'on' : ''}" data-screen="${sc}">${sc[0].toUpperCase() + sc.slice(1)}</button>`).join('')}
        </nav>
        <span class="po-active">${me ? `${avatar(me)} ${esc(me.name)}` : 'no participant'}</span>
      </div>
      <div class="po-body">
        <aside class="po-sidebar">
          <button class="po-btn po-new" data-new-user>+ New user</button>
          <div class="po-sidebar-label">participants — click to make active</div>
          <div class="po-userlist">
            ${Object.values(s.users).map(u => `
              <button class="po-userrow ${u.id === activeUserId ? 'on' : ''}" data-set-active="${u.id}">
                ${avatar(u)} <span class="po-userrow-name">${esc(u.name)}</span>
                ${u.id === activeUserId ? '<span class="po-dot">active</span>' : ''}
              </button>`).join('') || '<div class="po-empty">no participants</div>'}
          </div>
          <div class="po-sidebar-label">room name — share to invite</div>
          <div class="po-roomkey">${esc(s.roomKey || '')}</div>
        </aside>
        <main class="po-main">${(SCREENS[screen] || homeScreen)()}</main>
      </div>
      ${modalView()}
    </div>`
})

function setupScreen () {
  const s = $.learn()
  return `
    <div class="po-shell">
      <div class="po-topbar"><span class="po-home-btn">pot-luck</span></div>
      <div class="po-body"><main class="po-main">
        <div class="po-setup">
          <h1>pot-luck</h1>
          <p>a swap for good — bring a gift, wish for others', let the table find the trades. Runs over Holesail — no signaling server, just a room name. Whoever enters a room name first hosts it; everyone else who enters the same name joins automatically.</p>
          <button class="po-btn po-btn-go" data-create-room ${s.connecting ? 'disabled' : ''}>${s.connecting ? 'Working…' : 'Start a new pot-luck'}</button>
          <div class="po-join-row">
            <input class="po-pinput" id="po-join-key" placeholder="room name to join" value="${esc(s.joinKeyInput)}" />
            <button class="po-btn" data-join-room ${s.connecting ? 'disabled' : ''}>Join</button>
          </div>
          ${s.connectError ? `<div class="po-stale">connection failed: ${esc(s.connectError)}</div>` : ''}
        </div>
      </main></div>
    </div>`
}

$.when('click', '[data-screen]', (e) => $.whisper({ screen: e.target.closest('[data-screen]').dataset.screen }))
$.when('click', '[data-create-room]', () => enterRoom(nextId('room-')))
$.when('click', '[data-join-room]', (e) => {
  const input = e.target.closest('.po-shell').querySelector('#po-join-key')
  const roomId = (input?.value || '').trim()
  if (roomId) enterRoom(roomId)
})
$.when('click', '[data-new-user]', () => {
  const id = nextId('u_')
  const n = Object.keys($.learn().users).length + 1
  commit({ users: { [id]: { id, name: 'Guest ' + n, color: '#5b8def', bio: '' } } })
  $.whisper({ activeUserId: id })
})
$.when('click', '[data-set-active]', (e) => $.whisper({ activeUserId: e.target.closest('[data-set-active]').dataset.setActive }))
$.when('click', '[data-del-user]', (e) => {
  const id = e.target.closest('[data-del-user]').dataset.delUser
  const u = userById(id)
  if (!u || !confirm(`Delete ${u.name} and their offerings?`)) return
  const s = $.learn()
  const ownedIds = Object.values(s.offerings).filter(o => o.ownerId === id).map(o => o.id)
  const offeringsDelta = {}; ownedIds.forEach(oid => { offeringsDelta[oid] = null })
  const wishesDelta = {}
  for (const uid of Object.keys(s.wishes)) wishesDelta[uid] = uid === id ? null : s.wishes[uid].filter(t => !ownedIds.includes(t))
  commit({ users: { [id]: null }, offerings: offeringsDelta, wishes: wishesDelta })
  if ($.learn().activeUserId === id) $.whisper({ activeUserId: null })
})
$.when('click', '[data-save-profile]', (e) => {
  const u = userById(e.target.closest('[data-save-profile]').dataset.saveProfile)
  if (!u) return
  const patch = {}
  e.target.closest('.po-profile').querySelectorAll('[data-field]').forEach(el => { patch[el.dataset.field] = el.value })
  commit({ users: { [u.id]: { ...u, ...patch } } })
})
$.when('click', '[data-modal]', (e) => $.whisper({ modal: e.target.closest('[data-modal]').dataset.modal }))
$.when('click', '[data-close-modal]', (e) => { if (e.target.matches('[data-close-modal]')) $.whisper({ modal: null }) })
$.when('click', '[data-save-offer]', (e) => {
  const me = activeUser()
  if (!me) return
  const note = e.target.closest('.po-modal')?.querySelector('#po-add-note')?.value || ''
  const oid = nextId('o_')
  commit({ offerings: { [oid]: { id: oid, ownerId: me.id, note: note.trim() } } })
  $.whisper({ modal: null })
})
$.when('click', '[data-del-offer]', (e) => {
  const id = e.target.closest('[data-del-offer]').dataset.delOffer
  const s = $.learn()
  const wishes = {}
  for (const uid of Object.keys(s.wishes)) wishes[uid] = s.wishes[uid].filter(t => t !== id)
  commit({ offerings: { [id]: null }, wishes })
})
$.when('click', '[data-match]', () => runMatch())

let hold = null
$.when('pointerdown', '[data-hold]', (e) => {
  const btn = e.target.closest('[data-hold]')
  const token = btn.dataset.wid, dir = btn.dataset.hold
  hold = { token, dir, fired: false }
  hold.timer = setTimeout(() => {
    if (!hold) return
    hold.fired = true
    moveWish($.learn().activeUserId, token, dir === 'up' ? 'top' : 'bottom')
  }, 500)
})
$.when('pointerup', '[data-hold]', () => { if (hold) { clearTimeout(hold.timer); if (!hold.fired) moveWish($.learn().activeUserId, hold.token, hold.dir); hold = null } })
$.when('pointerleave', '[data-hold]', () => { if (hold) { clearTimeout(hold.timer); hold = null } })
$.when('pointercancel', '[data-hold]', () => { if (hold) { clearTimeout(hold.timer); hold = null } })

function moveWish (userId, token, kind) {
  const order = ensureWish(userId)
  const i = order.indexOf(token)
  if (i === -1) return
  order.splice(i, 1)
  if (kind === 'up') order.splice(Math.max(0, i - 1), 0, token)
  else if (kind === 'down') order.splice(Math.min(order.length, i + 1), 0, token)
  else if (kind === 'top') order.unshift(token)
  else if (kind === 'bottom') order.push(token)
  commit({ wishes: { [userId]: order } })
}

function esc (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

function thumb (cls = '') { return `<span class="po-thumb po-thumb-empty ${cls}">🎁</span>` }

function avatar (user, cls = '') {
  if (!user) return ''
  return `<span class="po-avatar po-avatar-empty ${cls}" style="background:${user.color || '#888'}">${(user.name || '?')[0]}</span>`
}

function needUser () { return `<div class="po-empty">Pick or create a participant in the sidebar to begin.</div>` }

function homeScreen () {
  return `
    <div class="po-home">
      <div class="po-hero">
        <h1>pot-luck</h1>
        <p>a swap for good — bring a gift, wish for others', let the table find the trades.</p>
      </div>
      <div class="po-cards">
        ${[['offer', '🎁 Offer', "Share a gift that you're willing to trade"],
           ['wish', '⭐ Wish', 'For items in the potluck offering pool'],
           ['match', '🔀 Match', 'With who you will give to and who you will receive from']
          ].map(([sc, t, d]) => `<button class="po-card" data-screen="${sc}"><span class="po-card-title">${t}</span><span class="po-card-desc">${d}</span></button>`).join('')}
      </div>
    </div>`
}

function offerScreen () {
  const me = activeUser()
  if (!me) return needUser()
  const mine = Object.values($.learn().offerings).filter(o => o.ownerId === me.id)
  const all = Object.values($.learn().offerings)
  const card = o => `
    <div class="po-offer" data-oid="${o.id}">
      ${thumb()}
      <span class="po-offer-note">${esc(o.note) || '<em>untitled</em>'}</span>
      <span class="po-offer-owner">${avatar(userById(o.ownerId))} ${esc(userById(o.ownerId)?.name)}</span>
      ${o.ownerId === me.id ? `<button class="po-del" data-del-offer="${o.id}" title="remove">✕</button>` : ''}
    </div>`
  return `
    <div class="po-screen">
      <div class="po-sec-head"><h2>My Offerings</h2><button class="po-btn" data-modal="add-offer">+ Add</button></div>
      <div class="po-grid">${mine.length ? mine.map(card).join('') : '<div class="po-empty">No offerings yet — add a gift.</div>'}</div>
      <div class="po-sec-head"><h2>All Offerings</h2></div>
      <div class="po-grid">${all.length ? all.map(card).join('') : '<div class="po-empty">The pool is empty.</div>'}</div>
    </div>`
}

function wishScreen () {
  const me = activeUser()
  if (!me) return needUser()
  const order = ensureWish(me.id)
  if (order.length <= 1) return `<div class="po-screen"><h2>Wish</h2><div class="po-empty">No one else has offered anything yet.</div></div>`
  let rank = 0
  const rows = order.map(token => {
    if (token === CUT) return `<div class="po-cut"><span>won't trade ↓</span></div>`
    const o = offeringById(token)
    if (!o) return ''
    rank++
    return `
      <div class="po-wish" data-wid="${token}">
        <span class="po-rank">${rank}</span>
        ${thumb()}
        <span class="po-wish-note">${esc(o.note) || '<em>untitled</em>'}<small>${esc(userById(o.ownerId)?.name)}</small></span>
        <span class="po-wish-ctrl">
          <button class="po-arrow" data-hold="up" data-wid="${token}">▲</button>
          <button class="po-arrow" data-hold="down" data-wid="${token}">▼</button>
        </span>
      </div>`
  }).join('')
  return `
    <div class="po-screen">
      <div class="po-sec-head"><h2>Wish</h2><span class="po-hint">rank what you want · tap ▲▼ to move · hold to send to top/bottom</span></div>
      <div class="po-wishlist">${rows}</div>
    </div>`
}

function matchScreen () {
  const me = activeUser()
  if (!me) return needUser()
  const { matching, lastMatch: lm } = $.learn()
  const runBar = `<button class="po-btn po-btn-go" data-match ${matching ? 'disabled' : ''}>${matching ? 'Matching…' : (lm ? 'Re-run Match' : 'Match')}</button>`
  if (!lm) return `<div class="po-screen"><div class="po-sec-head"><h2>Match</h2>${runBar}</div><div class="po-empty">Press <strong>Match</strong> to find who gives to whom.</div></div>`
  if (lm.error) return `<div class="po-screen"><div class="po-sec-head"><h2>Match</h2>${runBar}</div><div class="po-empty">Match failed: ${esc(lm.error)}</div></div>`
  const stale = lm.sig !== inputSignature()
  const edges = lm.edges || []
  const giveTo = edges.filter(e => offeringByUpper(e.givenItem)?.ownerId === me.id).map(e => ({ item: offeringByUpper(e.givenItem), to: userById(offeringByUpper(e.recvItem)?.ownerId) })).filter(x => x.item && x.to)
  const receiveFrom = edges.filter(e => offeringByUpper(e.recvItem)?.ownerId === me.id).map(e => ({ item: offeringByUpper(e.givenItem), from: userById(offeringByUpper(e.givenItem)?.ownerId) })).filter(x => x.item && x.from)
  const trades = edges.map(e => ({ giver: userById(offeringByUpper(e.givenItem)?.ownerId), item: offeringByUpper(e.givenItem), receiver: userById(offeringByUpper(e.recvItem)?.ownerId) })).filter(t => t.giver && t.item && t.receiver)
  return `
    <div class="po-screen">
      <div class="po-sec-head"><h2>Match</h2>${runBar}</div>
      ${stale ? `<div class="po-stale">offerings or wishes changed since this run — results may be out of date.</div>` : ''}
      <div class="po-sub">last run ${esc(lm.at)} · ${trades.length} trade(s)</div>
      <h3>Give To</h3>
      <div class="po-matches">${giveTo.length ? giveTo.map(x => `<div class="po-match-row">${thumb('sm')}${esc(x.item.note) || 'gift'} → ${avatar(x.to)}<b>${esc(x.to.name)}</b></div>`).join('') : '<div class="po-empty">None of your gifts found a home this run.</div>'}</div>
      <h3>Receive From</h3>
      <div class="po-matches">${receiveFrom.length ? receiveFrom.map(x => `<div class="po-match-row">${avatar(x.from)}<b>${esc(x.from.name)}</b> → ${thumb('sm')}${esc(x.item.note) || 'gift'}</div>`).join('') : '<div class="po-empty">You receive nothing this run.</div>'}</div>
      <h3>All Matches</h3>
      <div class="po-allmatch">
        <div class="po-col"><h4>Gifts</h4>${trades.length ? trades.map(t => `<div class="po-match-row">${avatar(t.giver)}<b>${esc(t.giver.name)}</b> gives ${thumb('sm')}${esc(t.item.note) || 'gift'} → ${avatar(t.receiver)}<b>${esc(t.receiver.name)}</b></div>`).join('') : '<div class="po-empty">No trades.</div>'}</div>
        <div class="po-col"><h4>Receipts</h4>${trades.length ? trades.map(t => `<div class="po-match-row">${avatar(t.receiver)}<b>${esc(t.receiver.name)}</b> receives ${thumb('sm')}${esc(t.item.note) || 'gift'} from ${esc(t.giver.name)}</div>`).join('') : '<div class="po-empty">No trades.</div>'}</div>
      </div>
    </div>`
}

function settingsScreen () {
  const u = activeUser()
  if (!u) return `<div class="po-screen"><h2>Settings</h2>${needUser()}</div>`
  return `
    <div class="po-screen po-profile">
      <div class="po-sec-head"><h2>Settings — ${esc(u.name)}</h2></div>
      <label class="po-pfield"><span>Name</span><input class="po-pinput" data-field="name" value="${esc(u.name)}" /></label>
      <label class="po-pfield"><span>Favorite color</span><input type="color" class="po-pcolor" data-field="color" value="${u.color || '#5b8def'}" /></label>
      <label class="po-pfield"><span>Bio</span><textarea class="po-pinput" data-field="bio" rows="4">${esc(u.bio)}</textarea></label>
      <div class="po-prow">
        <button class="po-btn po-btn-go" data-save-profile="${u.id}">Save</button>
        <button class="po-btn po-btn-danger" data-del-user="${u.id}">Delete participant</button>
      </div>
    </div>`
}

function modalView () {
  if ($.learn().modal !== 'add-offer') return ''
  return `
    <div class="po-modal-bg" data-close-modal>
      <div class="po-modal">
        <h3>Add an offering</h3>
        <textarea class="po-modal-note" id="po-add-note" rows="3" placeholder="a note about the gift…"></textarea>
        <div class="po-modal-actions">
          <button class="po-btn" data-close-modal>Cancel</button>
          <button class="po-btn po-btn-go" data-save-offer>Add</button>
        </div>
      </div>
    </div>`
}

const SCREENS = { home: homeScreen, offer: offerScreen, wish: wishScreen, match: matchScreen, settings: settingsScreen }

;(function boot () {
  const params = new URLSearchParams(location.search)
  let roomId = params.get('room')
  if (!roomId) {
    try { roomId = localStorage.getItem(LAST_ROOM_KEY) } catch (e) {}
  }
  if (roomId) enterRoom(roomId)
})()

$.style(`
  & { display:block; height:100%; overflow:hidden; font-family:system-ui,sans-serif; color:#1a1a1a; background:#f3f1ea; }
  & button * { pointer-events:none; }
  & .po-shell { display:flex; flex-direction:column; height:100%; }
  & .po-topbar { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem 1rem; padding:.5rem .9rem; background:#1a1a1a; color:#fff; }
  & .po-home-btn { color:#fff; font-weight:700; font-size:1.05rem; }
  & .po-nav { display:flex; flex-wrap:wrap; gap:.4rem; flex:1; }
  & .po-tab { background:rgba(255,255,255,.12); color:#fff; border:none; padding:.35rem .8rem; border-radius:.4rem; cursor:pointer; text-transform:capitalize; }
  & .po-tab.on { background:#5b8def; }
  & .po-active { display:flex; align-items:center; gap:.4rem; font-size:.85rem; opacity:.85; }
  & .po-body { display:flex; flex:1; min-height:0; }
  & .po-sidebar { width:14rem; flex:0 0 14rem; background:#e7e3d8; border-right:1px solid #d3cdbd; padding:.7rem; display:flex; flex-direction:column; gap:.5rem; overflow-y:auto; }
  & .po-sidebar-label { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; opacity:.5; margin-top:.2rem; }
  & .po-userlist { display:flex; flex-direction:column; gap:.25rem; }
  & .po-userrow { display:flex; align-items:center; gap:.45rem; background:#fff; border:1px solid #d8d2c2; border-radius:.4rem; padding:.3rem .45rem; cursor:pointer; text-align:left; }
  & .po-userrow-name { flex:1; }
  & .po-userrow.on { border-color:#5b8def; box-shadow:0 0 0 1px #5b8def inset; }
  & .po-dot { font-size:.6rem; text-transform:uppercase; letter-spacing:.04em; color:#fff; background:#5b8def; border-radius:.25rem; padding:.1rem .35rem; }
  & .po-roomkey { font-family:ui-monospace,monospace; font-size:.65rem; word-break:break-all; opacity:.6; background:#fff; border:1px solid #d8d2c2; border-radius:.3rem; padding:.3rem; }
  & .po-main { flex:1; min-width:0; overflow:auto; padding:1rem 1.2rem; }
  & .po-screen { display:flex; flex-direction:column; gap:.6rem; max-width:780px; }
  & .po-sec-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-top:.6rem; }
  & h1 { margin:.2rem 0; } & h2 { margin:.2rem 0; font-size:1.15rem; } & h3 { margin:.7rem 0 .1rem; }
  & .po-hint, & .po-sub { font-size:.78rem; opacity:.6; }
  & .po-btn { background:#1a1a1a; color:#fff; border:none; border-radius:.4rem; padding:.4rem .8rem; cursor:pointer; }
  & .po-btn-go { background:#2e9e5b; } & .po-btn[disabled] { opacity:.5; cursor:default; }
  & .po-btn-danger { background:#b4452e; }
  & .po-prow { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem; }
  & .po-new { background:#5b8def; }
  & .po-empty { opacity:.55; padding:.6rem 0; font-size:.9rem; }
  & .po-home { display:flex; flex-direction:column; gap:1.2rem; align-items:center; padding-top:1.5rem; }
  & .po-hero { text-align:center; } & .po-hero p { opacity:.65; max-width:34rem; }
  & .po-cards { display:flex; gap:1rem; flex-wrap:wrap; justify-content:center; }
  & .po-card { width:13rem; min-height:8rem; background:#fff; border:1px solid #d8d2c2; border-radius:.7rem; padding:1rem; display:flex; flex-direction:column; gap:.5rem; cursor:pointer; text-align:left; }
  & .po-card-title { font-size:1.1rem; font-weight:700; } & .po-card-desc { opacity:.7; font-size:.9rem; }
  & .po-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(11rem,1fr)); gap:.6rem; }
  & .po-offer { position:relative; background:#fff; border:1px solid #d8d2c2; border-radius:.5rem; padding:.5rem; display:flex; flex-direction:column; gap:.35rem; }
  & .po-offer-note { font-size:.9rem; } & .po-offer-owner { display:flex; align-items:center; gap:.3rem; font-size:.75rem; opacity:.7; }
  & .po-del { position:absolute; top:.3rem; right:.3rem; background:rgba(0,0,0,.55); color:#fff; border:none; border-radius:50%; width:1.3rem; height:1.3rem; cursor:pointer; }
  & .po-thumb { display:flex; align-items:center; justify-content:center; width:100%; height:6rem; border-radius:.35rem; background:#eee; font-size:1.6rem; }
  & .po-thumb.sm { width:2.2rem; height:2.2rem; display:inline-flex; vertical-align:middle; }
  & .po-avatar { display:inline-flex; align-items:center; justify-content:center; width:1.5rem; height:1.5rem; border-radius:50%; color:#fff; font-weight:700; text-transform:uppercase; vertical-align:middle; }
  & .po-wishlist { display:flex; flex-direction:column; gap:.3rem; }
  & .po-wish { display:flex; align-items:center; gap:.5rem; background:#fff; border:1px solid #d8d2c2; border-radius:.45rem; padding:.3rem .5rem; }
  & .po-rank { width:1.3rem; text-align:center; font-weight:700; opacity:.5; }
  & .po-wish-note { flex:1; display:flex; flex-direction:column; font-size:.9rem; } & .po-wish-note small { opacity:.55; font-size:.72rem; }
  & .po-wish-ctrl { display:flex; gap:.2rem; }
  & .po-arrow { background:#eee; border:1px solid #ccc; border-radius:.3rem; width:2rem; height:2rem; cursor:pointer; font-size:.8rem; touch-action:none; user-select:none; }
  & .po-cut { display:flex; align-items:center; margin:.3rem 0; color:#b4452e; font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; }
  & .po-cut span { background:#f3f1ea; padding-right:.6rem; } & .po-cut:after { content:''; flex:1; border-top:2px dashed #c98; }
  & .po-matches, & .po-col { display:flex; flex-direction:column; gap:.3rem; }
  & .po-match-row { display:flex; align-items:center; gap:.35rem; background:#fff; border:1px solid #e0dac9; border-radius:.4rem; padding:.3rem .5rem; font-size:.88rem; }
  & .po-allmatch { display:flex; gap:1rem; flex-wrap:wrap; } & .po-allmatch .po-col { flex:1; min-width:14rem; }
  & .po-stale { background:#fff3cd; border:1px solid #e6d39a; border-radius:.4rem; padding:.4rem .6rem; font-size:.82rem; }
  & .po-profile { max-width:30rem; } & .po-pfield { display:flex; flex-direction:column; gap:.25rem; margin:.4rem 0; }
  & .po-pinput { padding:.4rem; border:1px solid #c9c2af; border-radius:.35rem; font:inherit; }
  & .po-modal-bg { position:absolute; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:50; }
  & .po-modal { background:#fff; border-radius:.6rem; padding:1rem; width:min(92%,22rem); display:flex; flex-direction:column; gap:.6rem; }
  & .po-modal-note { padding:.4rem; border:1px solid #c9c2af; border-radius:.35rem; font:inherit; }
  & .po-modal-actions { display:flex; justify-content:flex-end; gap:.5rem; }
  & .po-setup { display:flex; flex-direction:column; gap:.8rem; max-width:28rem; padding-top:1.5rem; }
  & .po-join-row { display:flex; gap:.5rem; }
  & .po-join-row .po-pinput { flex:1; }
`)

$elf($)
