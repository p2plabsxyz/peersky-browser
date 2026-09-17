let currentInfo = null
let confirmClear = false

function escapeText (value) {
  if (value == null) return ''
  const div = document.createElement('div')
  div.textContent = String(value)
  return div.innerHTML
}

function privacyStatus (ext) {
  if (!ext?.installed) return 'Not installed'
  if (!ext.enabled) return 'Off'
  if (ext.badgeText) return `On · ${ext.badgeText}`
  return 'On'
}

function pageUrlFromLocation () {
  const params = new URLSearchParams(window.location.search)
  const url = params.get('url')
  if (url) return url
  const origin = params.get('origin')
  return origin || ''
}

function showEmpty () {
  document.getElementById('empty-state').hidden = false
  document.getElementById('site-settings-body').hidden = true
  document.title = 'Site settings'
}

function showBody () {
  document.getElementById('empty-state').hidden = true
  document.getElementById('site-settings-body').hidden = false
}

function render (info) {
  currentInfo = info
  showBody()

  document.getElementById('site-host').textContent = info.hostname || info.origin || 'Unknown'
  document.getElementById('site-connection').textContent = info.connection?.label || ''
  document.getElementById('site-origin').textContent = info.origin || ''
  document.getElementById('security-connection').textContent = info.connection?.label || '—'
  document.getElementById('security-protocol').textContent = info.protocol || '—'
  document.title = `Site settings — ${info.hostname || info.origin || 'site'}`

  const privacyRows = document.getElementById('privacy-rows')
  const privacy = info.privacy || {}
  privacyRows.innerHTML = ['ublock', 'consentAutodeny'].map(key => {
    const ext = privacy[key]
    if (!ext) return ''
    return `
      <div class="setting-row">
        <div class="setting-label">${escapeText(ext.name)}</div>
        <div class="setting-control">${escapeText(privacyStatus(ext))}</div>
      </div>
    `
  }).join('')

  const permSection = document.getElementById('section-permissions')
  const dataSection = document.getElementById('section-data')
  if (!info.canEditPermissions) {
    permSection.hidden = true
    dataSection.hidden = true
    return
  }

  permSection.hidden = false
  dataSection.hidden = false

  const meta = Array.isArray(info.permissionMeta) ? info.permissionMeta : []
  const states = info.permissions || {}
  const permRows = document.getElementById('permission-rows')
  permRows.innerHTML = meta.map(({ id, label }) => {
    const state = states[id] || 'ask'
    const allowSelected = state === 'allow' || state === 'allow-session'
    const allowLabel = state === 'allow-session' ? 'Allow this session' : 'Allow'
    return `
      <div class="setting-row">
        <div class="setting-label">${escapeText(label)}</div>
        <div class="setting-control">
          <select class="site-settings-perm-select" data-permission="${escapeText(id)}">
            <option value="ask"${state === 'ask' ? ' selected' : ''}>Ask</option>
            <option value="allow"${allowSelected ? ' selected' : ''}>${allowLabel}</option>
            <option value="block"${state === 'block' ? ' selected' : ''}>Block</option>
          </select>
        </div>
      </div>
    `
  }).join('')

  document.getElementById('cookie-count').textContent = String(info.cookies?.count ?? 0)
  renderClearConfirm()
}

function renderClearConfirm () {
  const actions = document.getElementById('clear-actions')
  const confirm = document.getElementById('clear-confirm')
  if (!actions || !confirm) return
  if (confirmClear) {
    actions.hidden = true
    confirm.hidden = false
    document.getElementById('clear-title').textContent =
      `Clear data from ${currentInfo?.hostname || currentInfo?.origin || 'this site'}?`
  } else {
    actions.hidden = false
    confirm.hidden = true
  }
}

async function load () {
  const pageUrl = pageUrlFromLocation()
  if (!pageUrl || !window.electronAPI?.siteInfo) {
    showEmpty()
    return
  }

  try {
    const info = await window.electronAPI.siteInfo.get(pageUrl)
    if (!info?.ok) {
      showEmpty()
      return
    }
    confirmClear = false
    render(info)
  } catch (err) {
    console.warn('[site-settings] load failed:', err?.message || err)
    showEmpty()
  }
}

async function onPermissionChange (event) {
  const select = event.target.closest('.site-settings-perm-select')
  if (!select || !currentInfo?.origin) return
  const permission = select.dataset.permission
  const state = select.value
  const result = await window.electronAPI.siteInfo.setPermission({
    origin: currentInfo.origin,
    permission,
    state
  })
  if (!result?.ok) {
    console.warn('[site-settings] setPermission failed:', result?.error)
    await load()
    return
  }
  if (!currentInfo.permissions) currentInfo.permissions = {}
  currentInfo.permissions[permission] = state
}

async function resetPermissions () {
  if (!currentInfo?.origin) return
  const result = await window.electronAPI.siteInfo.resetPermissions(currentInfo.origin)
  if (!result?.ok) {
    console.warn('[site-settings] resetPermissions failed:', result?.error)
    return
  }
  await load()
}

async function clearSiteData () {
  if (!currentInfo?.origin) return
  const result = await window.electronAPI.siteInfo.clearData(currentInfo.origin)
  if (!result?.ok) {
    console.warn('[site-settings] clearData failed:', result?.error)
    return
  }
  confirmClear = false
  if (currentInfo.cookies) currentInfo.cookies.count = 0
  renderClearConfirm()
  document.getElementById('cookie-count').textContent = '0'
}

function bind () {
  const root = document.getElementById('site-settings-root')
  root.addEventListener('change', onPermissionChange)
  document.getElementById('reset-permissions').addEventListener('click', resetPermissions)
  document.getElementById('clear-data').addEventListener('click', () => {
    confirmClear = true
    renderClearConfirm()
  })
  document.getElementById('clear-cancel').addEventListener('click', () => {
    confirmClear = false
    renderClearConfirm()
  })
  document.getElementById('clear-confirm-btn').addEventListener('click', clearSiteData)
}

document.addEventListener('DOMContentLoaded', () => {
  bind()
  load()
})
