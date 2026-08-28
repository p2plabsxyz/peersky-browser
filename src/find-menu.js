class FindMenu extends HTMLElement {
  constructor () {
    super()

    this.currentSearchValue = ''
    this.matchCase = false
    this.currentRequestId = null
    this.matchesCount = 0
    this.currentMatchIndex = 0
    this.isPdf = false // Track if current document is PDF
    this.wrappingBackward = false // Tracks if we're wrapping around to the end
    this.updateTimeout = null
    this.searchTimeout = null
    this.sessionWebview = null
    this._resizeListener = null

    this.tabGroups = new Map() // Store group metadata
    this.tabGroupAssignments = new Map() // Map tab IDs to group IDs
    this.groupColors = ['#4285F4', '#EA4335', '#FBBC05', '#34A853', '#8AB4F8', '#F28B82', '#FDD663', '#81C995'] // Google Chrome-like colors

    this.addEventListener('keydown', ({ key }) => {
      if (key === 'Escape') this.hide()
    })
  }

  async connectedCallback () {
    this.innerHTML = `
      <input class="find-menu-input" title="Enter text to find in page" />
      <span class="match-count"></span>
      <button class="find-menu-button find-menu-previous" title="Find previous item"></button>
      <button class="find-menu-button find-menu-next" title="Find next item"></button>
      <button class="find-menu-button find-menu-hide" title="Hide find menu"></button>
    `

    this.input = this.querySelector('.find-menu-input')
    this.matchCountDisplay = this.querySelector('.match-count')
    this.previousButton = this.querySelector('.find-menu-previous')
    this.nextButton = this.querySelector('.find-menu-next')
    this.hideButton = this.querySelector('.find-menu-hide')

    await this.loadSVG(this.previousButton, 'peersky://static/assets/svg/up.svg')
    await this.loadSVG(this.nextButton, 'peersky://static/assets/svg/down.svg')
    await this.loadSVG(this.hideButton, 'peersky://static/assets/svg/close.svg')

    // Setup foundInPage listener on webview
    this.setupFoundInPageListener()

    // Setup webview navigation events to detect PDFs
    this.setupWebviewNavigationListener()

    this.input.addEventListener('input', () => {
      const { value } = this
      clearTimeout(this.searchTimeout)
      if (!value) {
        this.stopFindInPage('clearSelection')
        return
      }

      // A superseded request never reports, so search once typing settles.
      this.searchTimeout = setTimeout(() => {
        this.findInWebview(value, { forward: true })
      }, 120)
    })

    this.input.addEventListener('keydown', ({ keyCode, shiftKey }) => {
      if (keyCode === 13) {
        const { value } = this
        if (!value) return this.hide()

        const forward = !shiftKey
        this.findInWebview(value, { forward, findNext: true })
      }
    })

    this.previousButton.addEventListener('click', () => {
      const { value } = this
      if (!value) return
      this.findInWebview(value, { forward: false, findNext: true })
    })

    this.nextButton.addEventListener('click', () => {
      const { value } = this
      if (!value) return
      this.findInWebview(value, { forward: true, findNext: true })
    })

    this.hideButton.addEventListener('click', () => this.hide())
  }

  setupWebviewNavigationListener () {
    const webview = this.getWebviewElement()
    if (!webview) return

    // Listen for did-navigate events to detect content type
    webview.addEventListener('did-navigate', () => {
      this.detectContentType()
    })

    webview.addEventListener('did-navigate-in-page', () => {
      this.detectContentType()
    })

    // Also check when loading finishes
    webview.addEventListener('did-finish-load', () => {
      this.detectContentType()
    })
  }

  async detectContentType () {
    if (this.isPdf !== null) return // detect only once
    const webview = this.getWebviewElement()
    if (!webview) return

    try {
      // Check if current page is a PDF by examining the URL or content
      const url = await webview.getURL()
      this.isPdf = url.toLowerCase().endsWith('.pdf') ||
                   url.toLowerCase().includes('application/pdf')

      // If we need more precise detection, we can use executeJavaScript
      if (!this.isPdf) {
        const contentType = await webview.executeJavaScript(`
          document.contentType || 
          (document.querySelector('embed[type="application/pdf"]') ? 'application/pdf' : '')
        `)
        this.isPdf = contentType === 'application/pdf'
      }
    } catch (error) {
      console.error('Error detecting content type:', error)
    }
  }

  // Rebind per search: binding once on connect missed every tab opened later.
  setupFoundInPageListener () {
    const webview = this.getWebviewElement()
    if (!webview || webview === this._boundWebview) return

    if (this._boundWebview && this._onFoundInPage) {
      this._boundWebview.removeEventListener('found-in-page', this._onFoundInPage)
    }
    this._boundWebview = webview
    this._onFoundInPage = (event) => {
      const { requestId, matches, activeMatchOrdinal } = event.result
      if (requestId !== this.currentRequestId) return

      this.matchesCount = matches || 0
      this.currentMatchIndex = this.matchesCount ? activeMatchOrdinal : 0
      this.matchCountDisplay.textContent = this.matchesCount
        ? `${this.currentMatchIndex} of ${this.matchesCount}`
        : 'No matches'
    }
    webview.addEventListener('found-in-page', this._onFoundInPage)
  }

  findInWebview (value, options = {}) {
    const webview = this.getWebviewElement()
    if (!webview) return
    clearTimeout(this.searchTimeout)
    this.setupFoundInPageListener()

    // findNext:false steps through an existing session; only a repeat query on
    // the same guest has one, anything else must open a session with true.
    const canStep = value === this.currentSearchValue && webview === this.sessionWebview
    if (!canStep) {
      this.currentSearchValue = value
      this.sessionWebview = webview
      this.matchesCount = 0
      this.currentMatchIndex = 0
    }

    try {
      this.currentRequestId = webview.findInPage(value, {
        forward: options.forward !== false,
        findNext: !(canStep && options.findNext === true),
        matchCase: this.matchCase
      })
    } catch (error) {
      console.error('Error using findInPage:', error)
    }
  }

  stopFindInPage (action = 'keepSelection') {
    clearTimeout(this.searchTimeout)
    const webview = this.getWebviewElement()
    if (webview) {
      // Throws when the guest is not dom-ready; nothing to stop in that case.
      try { webview.stopFindInPage(action) } catch (error) {}
      if (action === 'clearSelection') {
        this.currentSearchValue = ''
        this.sessionWebview = null
        this.matchCountDisplay.textContent = ''
        this.matchesCount = 0
        this.currentMatchIndex = 0
      }
    }
  }

  getWebviewElement () {
    // First try getting the active tab's webview from TabBar
    const tabBar = document.querySelector('#tabbar')
    if (tabBar && typeof tabBar.getActiveWebview === 'function') {
      const activeWebview = tabBar.getActiveWebview()
      if (activeWebview) {
        return activeWebview
      }
    }

    // Final fallback to direct webview element
    return document.querySelector('webview')
  }

  async loadSVG (button, svgPath) {
    const response = await fetch(svgPath)
    const svgContent = await response.text()
    const svgContainer = document.createElement('div')
    svgContainer.innerHTML = svgContent
    svgContainer.querySelector('svg').setAttribute('width', '14')
    svgContainer.querySelector('svg').setAttribute('height', '14')
    svgContainer.querySelector('svg').setAttribute('fill', 'currentColor')
    button.appendChild(svgContainer.firstChild)
  }

  resetSearch () {
    this.stopFindInPage('clearSelection')
  }

  /** Anchor under the address bar, the way the toolbar popups anchor to their button. */
  anchorToToolbar () {
    const nav = document.querySelector('#navbox') || document.querySelector('nav-box')
    const anchor = nav?.querySelector('.url-bar-wrapper') || nav
    const rect = anchor?.getBoundingClientRect()
    // Toolbar not measurable yet: keep the CSS fallback instead of pinning to 0,0.
    if (!rect || !rect.width || !rect.height) return

    const margin = 8
    let right = Math.round(window.innerWidth - rect.right)
    const { width } = this.getBoundingClientRect()
    if (width) right = Math.min(right, Math.round(window.innerWidth - width - margin))

    this.style.top = `${Math.ceil(Math.max(rect.bottom + margin, nav.getBoundingClientRect().bottom))}px`
    this.style.right = `${Math.max(right, margin)}px`
  }

  get value () {
    return this.input.value
  }

  show () {
    // Unhide first: a display:none element measures as a zero rect.
    this.classList.toggle('hidden', false)
    this.anchorToToolbar()
    if (!this._resizeListener) {
      this._resizeListener = () => this.anchorToToolbar()
      window.addEventListener('resize', this._resizeListener)
    }
    // Check content type when showing search
    this.detectContentType()
    setTimeout(() => {
      this.focus()
    }, 10)
  }

  hide ({ restoreFocus = true } = {}) {
    if (this.classList.contains('hidden')) return
    this.stopFindInPage('clearSelection')
    this.classList.toggle('hidden', true)
    if (this._resizeListener) {
      window.removeEventListener('resize', this._resizeListener)
      this._resizeListener = null
    }
    this.dispatchEvent(new CustomEvent('hide', { detail: { restoreFocus } }))
  }

  toggle () {
    if (this.classList.contains('hidden')) this.show()
    else this.hide()
  }

  focus () {
    this.input.focus()
    this.input.select()
  }
}

customElements.define('find-menu', FindMenu)
