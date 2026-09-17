export class SiteInfoPopup {
  constructor (ipc) {
    this.ipc = ipc
    this.popup = null
    this.isVisible = false
    this.targetButton = null
    this._originExpanded = false
    this._openPermission = null
    this._confirmClear = false
    this._info = null
    this._pageUrl = ''

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
      <div class="site-info-permissions" hidden>
        <div class="site-info-section-head">
          <h3>Permissions</h3>
          <p class="site-info-perm-summary"></p>
        </div>
        <div class="site-info-perm-list" role="list"></div>
        <button type="button" class="site-info-reset-perms">Reset permissions</button>
      </div>
      <div class="site-info-data" hidden>
        <div class="site-info-section-head">
          <h3>Site data</h3>
        </div>
        <div class="site-info-data-row">
          <span>Cookies</span>
          <span class="site-info-cookie-count">0</span>
        </div>
        <div class="site-info-data-actions">
          <button type="button" class="site-info-clear-data">Clear site data</button>
        </div>
        <div class="site-info-clear-confirm" hidden>
          <p class="site-info-clear-title"></p>
          <p class="site-info-clear-detail">This will remove cookies, local storage, IndexedDB, cached data, and service workers for this site.</p>
          <div class="site-info-clear-buttons">
            <button type="button" class="site-info-clear-cancel">Cancel</button>
            <button type="button" class="site-info-clear-confirm-btn">Clear</button>
          </div>
        </div>
      </div>
    `

    document.body.appendChild(popup)
    return popup
  }

  async show (targetButton, pageUrl) {
    if (this.isVisible) return
    this.targetButton = targetButton
    this._originExpanded = false
    this._openPermission = null
    this._confirmClear = false
    this._pageUrl = pageUrl || ''

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
    this._openPermission = null
    this._confirmClear = false
    this._pageUrl = ''

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
    this._pageUrl = pageUrl || ''
    this._openPermission = null
    this._confirmClear = false

    if (!pageUrl) {
      this._info = null
      this.renderIdentity(null)
      this.renderPermissions(null)
      this.renderSiteData(null)
      return
    }

    try {
      const info = await this.ipc.invoke('site-info-get', pageUrl)
      this._info = info?.ok ? info : null
      this.renderIdentity(this._info)
      this.renderPermissions(this._info)
      this.renderSiteData(this._info)
    } catch (err) {
      console.warn('[SiteInfoPopup] site-info-get failed:', err?.message || err)
      this._info = null
      this.renderIdentity(null)
      this.renderPermissions(null)
      this.renderSiteData(null)
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

  renderPermissions (info) {
    const section = this.popup.querySelector('.site-info-permissions')
    const list = this.popup.querySelector('.site-info-perm-list')
    const summary = this.popup.querySelector('.site-info-perm-summary')
    const resetBtn = this.popup.querySelector('.site-info-reset-perms')
    if (!section || !list) return

    if (!info?.canEditPermissions) {
      section.hidden = true
      list.innerHTML = ''
      if (summary) summary.textContent = ''
      return
    }

    section.hidden = false
    const meta = Array.isArray(info.permissionMeta) ? info.permissionMeta : []
    const states = info.permissions || {}

    let allowed = 0
    let blocked = 0
    let asking = 0
    for (const { id } of meta) {
      const state = states[id] || 'ask'
      if (state === 'allow') allowed++
      else if (state === 'block') blocked++
      else asking++
    }
    if (summary) {
      summary.textContent = `${allowed} allowed · ${blocked} blocked · ${asking} ask`
    }

    list.innerHTML = meta.map(({ id, label }) => {
      const state = states[id] || 'ask'
      const open = this._openPermission === id
      return `
        <div class="site-info-perm-row${open ? ' is-open' : ''}" role="listitem" data-permission="${id}">
          <button type="button" class="site-info-perm-toggle" data-permission="${id}">
            <span class="site-info-perm-label">${this.escapeHtml(label)}</span>
            <span class="site-info-perm-state">${stateLabel(state)}</span>
          </button>
          ${open ? permissionChooserHtml(id, state) : ''}
        </div>
      `
    }).join('')

    if (resetBtn) {
      resetBtn.disabled = allowed + blocked === 0
    }
  }

  renderSiteData (info) {
    const section = this.popup.querySelector('.site-info-data')
    const countEl = this.popup.querySelector('.site-info-cookie-count')
    const actions = this.popup.querySelector('.site-info-data-actions')
    const confirm = this.popup.querySelector('.site-info-clear-confirm')
    const title = this.popup.querySelector('.site-info-clear-title')
    if (!section) return

    // Same origin constraint as clearStorageData / permission store.
    if (!info?.canEditPermissions) {
      section.hidden = true
      this._confirmClear = false
      return
    }

    section.hidden = false
    const count = info.cookies?.count ?? 0
    if (countEl) countEl.textContent = String(count)

    if (this._confirmClear) {
      if (actions) actions.hidden = true
      if (confirm) confirm.hidden = false
      if (title) {
        title.textContent = `Clear data from ${info.hostname || info.origin}?`
      }
    } else {
      if (actions) actions.hidden = false
      if (confirm) confirm.hidden = true
    }
  }

  setupEventListeners () {
    if (!this.popup) return

    this.popup.addEventListener('click', (event) => {
      const hostBtn = event.target.closest('.site-info-host')
      if (hostBtn && !hostBtn.disabled) {
        event.preventDefault()
        event.stopPropagation()
        this._originExpanded = !this._originExpanded
        const originEl = this.popup.querySelector('.site-info-origin')
        if (originEl) {
          originEl.hidden = !this._originExpanded
          hostBtn.setAttribute('aria-expanded', String(this._originExpanded))
        }
        return
      }

      const choice = event.target.closest('.site-info-perm-choice')
      if (choice) {
        event.preventDefault()
        event.stopPropagation()
        this.setPermissionState(choice.dataset.permission, choice.dataset.state)
        return
      }

      const toggle = event.target.closest('.site-info-perm-toggle')
      if (toggle) {
        event.preventDefault()
        event.stopPropagation()
        const id = toggle.dataset.permission
        this._openPermission = this._openPermission === id ? null : id
        this.renderPermissions(this._info)
        requestAnimationFrame(() => this.positionPopup())
        return
      }

      const resetBtn = event.target.closest('.site-info-reset-perms')
      if (resetBtn) {
        event.preventDefault()
        event.stopPropagation()
        this.resetPermissions()
        return
      }

      const clearBtn = event.target.closest('.site-info-clear-data')
      if (clearBtn) {
        event.preventDefault()
        event.stopPropagation()
        this._confirmClear = true
        this.renderSiteData(this._info)
        requestAnimationFrame(() => this.positionPopup())
        return
      }

      const clearCancel = event.target.closest('.site-info-clear-cancel')
      if (clearCancel) {
        event.preventDefault()
        event.stopPropagation()
        this._confirmClear = false
        this.renderSiteData(this._info)
        requestAnimationFrame(() => this.positionPopup())
        return
      }

      const clearConfirm = event.target.closest('.site-info-clear-confirm-btn')
      if (clearConfirm) {
        event.preventDefault()
        event.stopPropagation()
        this.clearSiteData()
      }
    })
  }

  async setPermissionState (permission, state) {
    if (!this._info?.origin || !permission || !state) return

    const result = await this.ipc.invoke('site-info-set-permission', {
      origin: this._info.origin,
      permission,
      state
    })
    if (!result?.ok) {
      console.warn('[SiteInfoPopup] set-permission failed:', result?.error)
      return
    }

    if (!this._info.permissions) this._info.permissions = {}
    this._info.permissions[permission] = state
    this._openPermission = null
    this.renderPermissions(this._info)
    requestAnimationFrame(() => this.positionPopup())
  }

  async resetPermissions () {
    if (!this._info?.origin) return

    const result = await this.ipc.invoke(
      'site-info-reset-permissions',
      this._info.origin
    )
    if (!result?.ok) {
      console.warn('[SiteInfoPopup] reset-permissions failed:', result?.error)
      return
    }

    await this.refresh(this._pageUrl || this._info.url)
  }

  async clearSiteData () {
    if (!this._info?.origin) return

    const result = await this.ipc.invoke(
      'site-info-clear-data',
      this._info.origin
    )
    if (!result?.ok) {
      console.warn('[SiteInfoPopup] clear-data failed:', result?.error)
      return
    }

    this._confirmClear = false
    if (this._info.cookies) this._info.cookies.count = 0
    this.renderSiteData(this._info)
    requestAnimationFrame(() => this.positionPopup())
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
    if (event.key !== 'Escape') return
    event.preventDefault()
    if (this._confirmClear) {
      this._confirmClear = false
      this.renderSiteData(this._info)
      requestAnimationFrame(() => this.positionPopup())
      return
    }
    if (this._openPermission) {
      this._openPermission = null
      this.renderPermissions(this._info)
      requestAnimationFrame(() => this.positionPopup())
      return
    }
    this.hide()
    this.targetButton?.focus()
  }

  _handleWindowBlur () {
    if (this.isVisible) this.hide()
  }

  escapeHtml (text) {
    if (!text || typeof text !== 'string') return ''
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
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

function stateLabel (state) {
  if (state === 'allow') return 'Allow'
  if (state === 'block') return 'Block'
  return 'Ask'
}

function permissionChooserHtml (permission, current) {
  return `
    <div class="site-info-perm-chooser" role="group" aria-label="Permission options">
      ${['ask', 'allow', 'block'].map(state => `
        <button
          type="button"
          class="site-info-perm-choice${current === state ? ' is-selected' : ''}"
          data-permission="${permission}"
          data-state="${state}"
        >${stateLabel(state)}</button>
      `).join('')}
    </div>
  `
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
