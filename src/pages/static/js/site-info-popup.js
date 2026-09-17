export class SiteInfoPopup {
  constructor (ipc) {
    this.ipc = ipc
    this.popup = null
    this.isVisible = false
    this.targetButton = null
    this._originExpanded = false
    this._info = null

    this.hide = this.hide.bind(this)
    this.handleClickOutside = this.handleClickOutside.bind(this)
    this.handleKeyDown = this.handleKeyDown.bind(this)
    this._handleWindowBlur = this._handleWindowBlur.bind(this)
  }

  createPopup () {
    const popup = document.createElement('div')
    popup.className = 'site-info-popup'
    popup.setAttribute('role', 'dialog')
    popup.setAttribute('aria-label', 'Site information')
    popup.setAttribute('aria-modal', 'true')

    popup.innerHTML = `
      <div class="site-info-identity">
        <button type="button" class="site-info-host" aria-expanded="false" title="Show full origin">
          <span class="site-info-icon" aria-hidden="true"></span>
          <span class="site-info-host-text"></span>
        </button>
        <p class="site-info-connection"></p>
        <p class="site-info-origin" hidden></p>
      </div>
    `

    document.body.appendChild(popup)
    return popup
  }

  async show (targetButton, pageUrl) {
    if (this.isVisible) return
    this.targetButton = targetButton
    this._originExpanded = false

    if (!this.popup) {
      this.popup = this.createPopup()
      this.setupEventListeners()
    }

    this.popup.classList.add('open')
    this.isVisible = true

    await this.refresh(pageUrl)

    requestAnimationFrame(() => this.positionPopup())

    document.addEventListener('click', this.handleClickOutside)
    document.addEventListener('keydown', this.handleKeyDown)
    window.addEventListener('blur', this._handleWindowBlur)
  }

  hide () {
    if (!this.isVisible) return
    this.popup?.classList.remove('open')
    this.isVisible = false
    this._info = null

    document.removeEventListener('click', this.handleClickOutside)
    document.removeEventListener('keydown', this.handleKeyDown)
    window.removeEventListener('blur', this._handleWindowBlur)
  }

  async toggle (targetButton, pageUrl) {
    if (this.isVisible) {
      this.hide()
      return
    }
    await this.show(targetButton, pageUrl)
  }

  async refresh (pageUrl) {
    if (!this.popup || !this.isVisible) return

    if (!pageUrl) {
      this._info = null
      this.renderIdentity(null)
      return
    }

    try {
      const info = await this.ipc.invoke('site-info-get', pageUrl)
      this._info = info?.ok ? info : null
      this.renderIdentity(this._info)
    } catch (err) {
      console.warn('[SiteInfoPopup] site-info-get failed:', err?.message || err)
      this._info = null
      this.renderIdentity(null)
    }

    requestAnimationFrame(() => this.positionPopup())
  }

  renderIdentity (info) {
    const hostBtn = this.popup.querySelector('.site-info-host')
    const hostText = this.popup.querySelector('.site-info-host-text')
    const icon = this.popup.querySelector('.site-info-icon')
    const connection = this.popup.querySelector('.site-info-connection')
    const originEl = this.popup.querySelector('.site-info-origin')

    if (!info) {
      hostText.textContent = 'No site'
      connection.textContent = ''
      originEl.hidden = true
      originEl.textContent = ''
      hostBtn.setAttribute('aria-expanded', 'false')
      hostBtn.disabled = true
      this.popup.classList.remove('is-secure', 'is-insecure')
      this.loadIcon(icon, 'shield-x.svg')
      return
    }

    hostBtn.disabled = false
    hostText.textContent = info.hostname || info.origin || 'Unknown'
    connection.textContent = info.connection?.label || ''
    originEl.textContent = info.origin || ''
    originEl.hidden = !this._originExpanded
    hostBtn.setAttribute('aria-expanded', String(this._originExpanded))

    this.popup.classList.toggle('is-secure', !!info.connection?.secure)
    this.popup.classList.toggle('is-insecure', !info.connection?.secure)
    this.loadIcon(icon, info.connection?.secure ? 'shield-check.svg' : 'shield-x.svg')
  }

  setupEventListeners () {
    if (!this.popup) return

    this.popup.addEventListener('click', (event) => {
      const hostBtn = event.target.closest('.site-info-host')
      if (!hostBtn || hostBtn.disabled) return
      event.preventDefault()
      event.stopPropagation()
      this._originExpanded = !this._originExpanded
      const originEl = this.popup.querySelector('.site-info-origin')
      if (originEl) {
        originEl.hidden = !this._originExpanded
        hostBtn.setAttribute('aria-expanded', String(this._originExpanded))
      }
    })
  }

  positionPopup () {
    if (!this.popup || !this.targetButton) return

    const buttonRect = this.targetButton.getBoundingClientRect()
    const popupRect = this.popup.getBoundingClientRect()

    let left = buttonRect.left
    let top = buttonRect.bottom + 8

    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight

    if (left + popupRect.width > viewportWidth - 20) {
      left = viewportWidth - popupRect.width - 20
    }
    if (left < 20) left = 20

    if (top + popupRect.height > viewportHeight - 20) {
      top = buttonRect.top - popupRect.height - 8
    }

    this.popup.style.left = `${left}px`
    this.popup.style.top = `${top}px`
  }

  handleClickOutside (event) {
    if (!this.popup || !this.isVisible) return
    if (
      this.popup.contains(event.target) ||
      (this.targetButton && this.targetButton.contains(event.target))
    ) {
      return
    }
    this.hide()
  }

  handleKeyDown (event) {
    if (!this.isVisible) return
    if (event.key === 'Escape') {
      event.preventDefault()
      this.hide()
      this.targetButton?.focus()
    }
  }

  _handleWindowBlur () {
    if (this.isVisible) this.hide()
  }

  loadIcon (container, fileName) {
    if (!container) return
    fetch(`peersky://static/assets/svg/${fileName}`)
      .then(r => r.text())
      .then(svg => {
        container.innerHTML = svg
        const el = container.querySelector('svg')
        if (!el) return
        el.setAttribute('width', '16')
        el.setAttribute('height', '16')
        el.setAttribute('fill', 'currentColor')
      })
      .catch(() => {})
  }

  destroy () {
    this.hide()
    this.popup?.remove()
    this.popup = null
    this.targetButton = null
  }
}

const SECURE_PROTOCOLS = new Set([
  'https:',
  'peersky:',
  'ipfs:',
  'ipns:',
  'hyper:',
  'bt:',
  'bittorrent:',
  'magnet:',
  'web3:',
  'file:'
])

export function isSecurePageUrl (url) {
  if (!url || typeof url !== 'string') return false
  try {
    return SECURE_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}
