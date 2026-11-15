// How often the counts on the apps are read while the home page is in view.
const BADGE_REFRESH_MS = 5000

// What a count reads as, and what it says to a screen reader.
function badgeText (count) {
  return count > 99 ? '99+' : String(count)
}

function badgeLabel (id, count) {
  if (id === 'chat') return count === 1 ? '1 unread message' : `${badgeText(count)} unread messages`
  if (id === 'upload') return count === 1 ? '1 new file from your devices' : `${badgeText(count)} new files from your devices`
  return count === 1 ? '1 new answer' : `${badgeText(count)} new answers`
}

class PeerBar extends HTMLElement {
  constructor () {
    super()
    this.appsData = null
    this._building = false
    this.badges = {}
    this._badgeTimer = null
    this._badgeRequest = 0
  }

  connectedCallback () {
    this.build()

    // Listen for pinned apps changes via IPC (same pattern as onShowClockChanged)
    if (window.electronAPI?.onPinnedAppsChanged) {
      window.electronAPI.onPinnedAppsChanged(() => this.build())
    }

    // The counts are read while the page is in view, and again as soon as it
    // is back, so they are right the moment the person looks.
    this.refreshBadges()
    this._badgeTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refreshBadges()
    }, BADGE_REFRESH_MS)
    this._onVisible = () => {
      if (document.visibilityState === 'visible') this.refreshBadges()
    }
    document.addEventListener('visibilitychange', this._onVisible)
  }

  disconnectedCallback () {
    clearInterval(this._badgeTimer)
    document.removeEventListener('visibilitychange', this._onVisible)
  }

  async refreshBadges () {
    const read = window.electronAPI?.p2pApps?.badges
    if (typeof read !== 'function') return
    // An older answer never replaces a newer one.
    const request = ++this._badgeRequest
    let counts
    try {
      counts = await read()
    } catch {
      return
    }
    if (request !== this._badgeRequest || !counts || typeof counts !== 'object') return
    this.badges = counts
    this.showBadges()
  }

  // A count on each pinned app that has one, by the app's id.
  showBadges () {
    for (const link of this.querySelectorAll('a[data-app-id]')) {
      const id = link.dataset.appId
      const value = Number(this.badges[id])
      const count = Number.isSafeInteger(value) && value > 0 ? value : 0
      let badge = link.querySelector('.peerbar-badge')
      if (count === 0) {
        badge?.remove()
        link.setAttribute('aria-label', link.dataset.appName)
        continue
      }
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'peerbar-badge'
        badge.setAttribute('aria-hidden', 'true')
        link.appendChild(badge)
      }
      badge.textContent = badgeText(count)
      link.setAttribute('aria-label', `${link.dataset.appName}, ${badgeLabel(id, count)}`)
    }
  }

  async fetchApps () {
    try {
      const module = await import('peersky://p2p/p2p-list.js')
      this.appsData = await module.getAllApps()
    } catch (e) {
      console.error('Failed to load p2p apps data', e)
      this.appsData = []
    }
  }

  async build () {
    if (this._building) return
    this._building = true
    try {
      await this.fetchApps()
      this.innerHTML = ''

      const container = document.createElement('div')
      container.className = 'peerbar'

      // 1. Always visible P2P base icon, on a tile like the apps after it
      const baseLink = document.createElement('a')
      baseLink.href = 'peersky://p2p/'
      baseLink.setAttribute('aria-label', 'P2P Apps')
      const baseTile = document.createElement('span')
      baseTile.className = 'p2p-base-tile'
      const baseDiv = document.createElement('div')
      baseDiv.className = 'p2p-base-icon'
      baseDiv.title = 'P2P Apps'
      baseTile.appendChild(baseDiv)
      baseLink.appendChild(baseTile)
      container.appendChild(baseLink)

      // 2. Pinned P2P apps
      const module = await import('peersky://p2p/p2p-list.js')
      const pinnedIds = await module.getPinnedApps()
      const pinnedApps = this.appsData.filter(app => pinnedIds.includes(app.id))

      pinnedApps.forEach((app, index) => {
        const a = document.createElement('a')
        a.href = app.url
        a.dataset.appId = app.id
        a.dataset.appName = app.name
        a.setAttribute('aria-label', app.name)
        const img = document.createElement('img')
        img.src = app.iconUrl || `peersky://static/assets/svg/${app.icon}`
        if (app.logo) img.classList.add('app-logo')
        img.title = app.name
        img.alt = app.name
        img.style.animationDelay = `${(index + 1) * 0.1}s`
        a.appendChild(img)
        container.appendChild(a)
      })

      this.appendChild(container)
      this.showBadges()
    } finally {
      this._building = false
    }
  }
}

window.customElements.define('peer-bar', PeerBar)
