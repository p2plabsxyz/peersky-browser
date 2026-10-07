// The dock on the right of the window that a page's DevTools are drawn in
// (src/devtools-dock.js, issue 22).
//
// The DevTools themselves are a native view main lays over this dock, so this
// page only keeps the space free, says where it is, and hides them while
// something of its own, such as the address bar's suggestions or a toolbar
// popup, is drawn over that space: a native view would cover it.
(function () {
  const { ipcRenderer } = require('electron')

  const WIDTH_KEY = 'peersky-devtools-dock-width'
  const MIN_WIDTH = 320
  // What is left for the page at the least.
  const MIN_PAGE_WIDTH = 360
  // How far apart the points are that check whether anything covers the dock.
  const PROBE_STEP = 24

  const openGuests = new Set()
  let dock = null
  let body = null
  let width = null
  let scheduled = false
  let lastSent = ''
  let tabBarWatched = null
  let observer = null

  function tabBar () {
    return document.querySelector('#tabbar')
  }

  function activeGuestId () {
    try {
      const id = tabBar()?.getActiveWebview?.()?.getWebContentsId?.()
      return Number.isInteger(id) ? id : null
    } catch (_) {
      return null
    }
  }

  function sidePanelWidth () {
    if (!document.body.classList.contains('extension-side-panel-open')) return 0
    return document.getElementById('extension-side-panel')?.getBoundingClientRect().width || 0
  }

  function clampWidth (value) {
    const max = Math.max(MIN_WIDTH, window.innerWidth - sidePanelWidth() - MIN_PAGE_WIDTH)
    return Math.round(Math.min(Math.max(value, MIN_WIDTH), max))
  }

  function savedWidth () {
    try {
      const value = Number(localStorage.getItem(WIDTH_KEY))
      if (Number.isFinite(value) && value > 0) return value
    } catch (_) {}
    return window.innerWidth * 0.4
  }

  function setWidth (value) {
    width = clampWidth(value)
    document.documentElement.style.setProperty('--devtools-dock-width', `${width}px`)
  }

  // Writes only what changed: the page is watched for changes, this one too.
  function setOpen (open) {
    if (document.body.classList.contains('devtools-dock-open') !== open) {
      document.body.classList.toggle('devtools-dock-open', open)
    }
  }

  function ensureDock () {
    if (dock) return dock
    dock = document.createElement('aside')
    dock.id = 'devtools-dock'
    dock.className = 'devtools-dock'
    dock.innerHTML = `
      <div class="devtools-dock-resizer" title="Drag to resize"></div>
      <div class="devtools-dock-main">
        <div class="devtools-dock-header">
          <span class="devtools-dock-title">DevTools</span>
          <button type="button" class="devtools-dock-close" aria-label="Close DevTools">×</button>
        </div>
        <div class="devtools-dock-body"></div>
      </div>
    `
    body = dock.querySelector('.devtools-dock-body')
    dock.querySelector('.devtools-dock-close').addEventListener('click', () => {
      const guestId = activeGuestId()
      if (guestId !== null && openGuests.has(guestId)) ipcRenderer.send('devtools-dock-close', guestId)
    })
    watchResizer(dock.querySelector('.devtools-dock-resizer'))
    document.body.appendChild(dock)
    setWidth(savedWidth())
    return dock
  }

  function watchResizer (resizer) {
    resizer.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      resizer.setPointerCapture(event.pointerId)
      document.body.classList.toggle('devtools-dock-resizing', true)
      const move = (moveEvent) => {
        setWidth(window.innerWidth - sidePanelWidth() - moveEvent.clientX)
        schedule()
      }
      const stop = () => {
        resizer.removeEventListener('pointermove', move)
        resizer.removeEventListener('pointerup', stop)
        resizer.removeEventListener('pointercancel', stop)
        resizer.removeEventListener('lostpointercapture', stop)
        document.body.classList.toggle('devtools-dock-resizing', false)
        try { localStorage.setItem(WIDTH_KEY, String(width)) } catch (_) {}
        schedule()
      }
      resizer.addEventListener('pointermove', move)
      resizer.addEventListener('pointerup', stop)
      resizer.addEventListener('pointercancel', stop)
      resizer.addEventListener('lostpointercapture', stop)
    })
  }

  function watchTabBar () {
    const bar = tabBar()
    if (!bar || bar === tabBarWatched) return
    tabBarWatched = bar
    bar.addEventListener('tab-selected', schedule)
    bar.addEventListener('tab-closed', schedule)
  }

  function watchPage () {
    if (observer) return
    // Anything this page shows or hides may now be over the dock, or no longer.
    observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open']
    })
    window.addEventListener('resize', () => {
      if (width !== null) setWidth(width)
      schedule()
    })
  }

  // Whether something of this page is drawn over the dock's body.
  function covered (rect) {
    for (let y = rect.top + 2; y < rect.bottom; y += PROBE_STEP) {
      for (let x = rect.left + 2; x < rect.right; x += PROBE_STEP) {
        const hit = document.elementFromPoint(x, y)
        if (hit && !dock.contains(hit)) return true
      }
    }
    return false
  }

  function schedule () {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(update)
  }

  function update () {
    scheduled = false
    const guestId = activeGuestId()
    const show = guestId !== null && openGuests.has(guestId)
    const wasOpen = document.body.classList.contains('devtools-dock-open')

    let layout = { visibleGuestId: null, bounds: null }
    if (show) {
      ensureDock()
      // Level with the pages, whatever the toolbar's height is now.
      const pages = document.getElementById('webview-container')?.getBoundingClientRect()
      const top = pages ? `${Math.round(pages.top)}px` : ''
      if (top && dock.style.top !== top) dock.style.top = top
      setOpen(true)
      const rect = body.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0 && !covered(rect)) {
        layout = {
          visibleGuestId: guestId,
          bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        }
      }
    } else {
      setOpen(false)
    }

    // The find bar sits left of the dock, so the two never cover each other.
    if (wasOpen !== show) {
      const find = document.querySelector('#find')
      if (find && !find.classList.contains('hidden')) find.anchorToToolbar?.()
    }

    const message = JSON.stringify(layout)
    if (message === lastSent) return
    lastSent = message
    ipcRenderer.send('devtools-dock-layout', layout)
  }

  ipcRenderer.on('devtools-dock-opened', (_event, guestId) => {
    openGuests.add(guestId)
    watchTabBar()
    watchPage()
    schedule()
  })

  ipcRenderer.on('devtools-dock-closed', (_event, guestId) => {
    openGuests.delete(guestId)
    schedule()
  })
})()
