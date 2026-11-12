const BaseTabBar = customElements.get('tab-bar')

export default class VerticalTabs extends BaseTabBar {
  constructor () {
    super()
    this.isExpanded = false
    this.hoverTimeout = null // Add timeout for hover delay
    this.leaveTimeout = null // Add timeout for leave delay
  }

  buildTabBar () {
    super.buildTabBar()
    this.classList.add('vertical-tabs')
    if (this.tabContainer) {
      this.tabContainer.classList.add('vertical-tabs-container')

      this.addButton = this.tabContainer.querySelector('#add-tab')
      this.placeAddButton()

      // Allow vertical scrolling with mouse wheel and stop horizontal handler
      this.tabContainer.addEventListener(
        'wheel',
        (e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.stopImmediatePropagation()
            // default vertical scrolling is preserved
          }
        },
        { capture: true }
      )

      this.tabContainer.addEventListener('scroll', () =>
        this.updateAddButtonShadow()
      )
    }

    // Add hover event listeners with delays for smooth expansion
    this.addEventListener('mouseenter', () => {
      if (this.classList.contains('keep-expanded')) return
      // Clear any pending leave timeout
      if (this.leaveTimeout) {
        clearTimeout(this.leaveTimeout)
        this.leaveTimeout = null
      }

      // Set hover timeout for delayed expansion
      this.hoverTimeout = setTimeout(() => {
        this.isExpanded = true
        this.classList.add('expanded')
      }, 300)
    })

    this.addEventListener('mouseleave', () => {
      if (this.classList.contains('keep-expanded')) return
      // Clear any pending hover timeout
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout)
        this.hoverTimeout = null
      }

      // Set leave timeout for delayed collapse
      this.leaveTimeout = setTimeout(() => {
        this.isExpanded = false
        this.classList.remove('expanded')
      }, 300)
    })

    window.addEventListener('resize', () => this.updateAddButtonShadow())

    document.body.classList.add('vertical-tabs-layout')
    this._layoutSync = new MutationObserver(() => this._syncBodyExpanded())
    this._layoutSync.observe(this, { attributes: true, attributeFilter: ['class'] })
    this._syncBodyExpanded()

    // Ensure CSS is loaded before applying styles
    this.loadVerticalTabsCSS()

    this.updateAddButtonShadow()

    // On macOS, collapse the titlebar when vertical tabs are enabled
    if (process.platform === 'darwin') {
      this.collapseTitlebarOnDarwin()
    }
  }

  _syncBodyExpanded () {
    // Only the pinned mode resizes the page. Hover expansion floats over it,
    // so the webview never repaints mid-animation.
    const expanded = this.classList.contains('keep-expanded')
    document.body.classList.toggle('vertical-tabs-expanded', expanded)
  }

  disconnectedCallback () {
    super.disconnectedCallback?.()
    this._layoutSync?.disconnect()
    document.body.classList.remove('vertical-tabs-layout', 'vertical-tabs-expanded')
  }

  collapseTitlebarOnDarwin () {
    const titlebar = document.querySelector('title-bar')
    if (titlebar && typeof titlebar.toggleDarwinCollapse === 'function') {
      titlebar.toggleDarwinCollapse(true)
    }
  }

  loadVerticalTabsCSS () {
    // Check if CSS is already loaded
    if (document.querySelector('link[href*="vertical-tabs.css"]')) {
      return
    }

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'browser://theme/vertical-tabs.css'
    link.onload = () => {
      // Force a reflow to apply styles
      this.style.display = 'none'
      this.offsetHeight // eslint-disable-line no-unused-expressions
      this.style.display = ''
    }
    document.head.appendChild(link)
  }

  // Override tab creation to ensure proper favicon handling
  addTabWithId (tabId, url = 'peersky://home', title = 'Home', tabData = {}) {
    const result = super.addTabWithId(tabId, url, title, tabData)

    this.updateAddButtonShadow()

    // Ensure favicon is properly sized for vertical tabs
    const tabElement = document.getElementById(tabId)
    if (tabElement) {
      const favicon = tabElement.querySelector('.tab-favicon')
      if ((favicon && !favicon.style.backgroundImage) || favicon.style.backgroundImage === 'none') {
        favicon.style.backgroundImage = 'url(peersky://static/assets/favicon.ico)'
      }
    }

    return result
  }

  closeTab (tabId) {
    super.closeTab(tabId)
    this.updateAddButtonShadow()
  }

  selectTab (tabId, isNewTab = false) {
    super.selectTab(tabId, isNewTab)
    this.revealTab(tabId)
  }

  // The button sits under the list, not in it. Inside it, it stuck to the
  // bottom of a long list, so tabs scrolled behind it and showed through
  // the gap under it. New tabs still go at the end of the list.
  placeAddButton () {
    if (this.addButton && this.addButton.previousElementSibling !== this.tabContainer) {
      this.tabContainer.after(this.addButton)
    }
  }

  // A shadow over the button while tabs are out of sight under it.
  updateAddButtonShadow () {
    if (!this.addButton) return
    const list = this.tabContainer
    const below = list.scrollHeight - list.scrollTop - list.clientHeight > 1
    this.addButton.classList.toggle('tabs-below', below)
  }

  // A tab opened at the end of a long list landed out of sight, so the list
  // scrolls to the selected tab. A new tab grows in from no height after its
  // entrance delay, so it is shown again once it has grown (0.28s).
  revealTab (tabId) {
    const tab = document.getElementById(tabId)
    const list = this.tabContainer
    if (!tab || tab.parentElement !== list) return
    const reveal = () => {
      if (!tab.isConnected || !tab.getClientRects().length) return
      const box = list.getBoundingClientRect()
      const row = tab.getBoundingClientRect()
      let top = null
      if (!tab.nextElementSibling) top = list.scrollHeight
      else if (row.bottom > box.bottom) top = list.scrollTop + row.bottom - box.bottom + 4
      else if (row.top < box.top) top = list.scrollTop - (box.top - row.top + 4)
      // A smooth scroll never moves while the window is hidden.
      if (top !== null) list.scrollTo({ top, behavior: document.hidden ? 'instant' : 'smooth' })
    }
    reveal()
    if (tab.classList.contains('opening')) {
      setTimeout(reveal, (parseFloat(tab.style.transitionDelay) || 0) + 300)
    }
  }

  // Override hover behavior when keep-expanded is active
  updateKeepExpandedState (keepExpanded) {
    if (keepExpanded) {
      this.classList.add('keep-expanded')
      // Clear any timeouts
      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout)
        this.hoverTimeout = null
      }
      if (this.leaveTimeout) {
        clearTimeout(this.leaveTimeout)
        this.leaveTimeout = null
      }
      // Force expanded state
      this.isExpanded = true
      this.classList.add('expanded')
    } else {
      this.classList.remove('keep-expanded')
      // Re-enable hover behavior
      this.isExpanded = false
      this.classList.remove('expanded')
    }
  }
}

customElements.define('vertical-tabs', VerticalTabs)
