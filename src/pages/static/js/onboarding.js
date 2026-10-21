// Theme initialization
(async () => {
  try {
    if (window.electronAPI && window.electronAPI.settings) {
      const theme = await window.electronAPI.settings.get('theme')
      if (theme) document.documentElement.setAttribute('data-theme', theme)
    }
  } catch (_) {}
})()

// Welcome to Import screen animation
const welcomeScreen = document.getElementById('welcome-screen')
const choosePathScreen = document.getElementById('choose-path-screen')
const importJsonScreen = document.getElementById('import-json-screen')

setTimeout(() => {
  welcomeScreen.classList.add('hidden')
  setTimeout(() => {
    choosePathScreen.classList.add('visible')
  }, 700)
}, 10000)

const api = window.electronAPI || {}
const { importOnboardingData, skipOnboarding, openExternalLink, restoreZip, restoreCid, applyRestore, discardRestore, getDeviceInfo, readCode } = api
const restoreScreen = document.getElementById('restore-screen')

const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/peersky-onboarding-extens/knegonpkagnjmkndlfhppgnpdmecklji'
const FIREFOX_ADDONS_URL = 'https://addons.mozilla.org/en-US/firefox/addon/peersky-onboarding-extension/'

let selectedExtensionUrl = ''

document.getElementById('chrome-btn').addEventListener('click', () => {
  selectedExtensionUrl = CHROME_STORE_URL
  showImportJsonScreen('Import from Chrome / Edge')
})

document.getElementById('firefox-btn').addEventListener('click', () => {
  selectedExtensionUrl = FIREFOX_ADDONS_URL
  showImportJsonScreen('Import from Firefox')
})

document.getElementById('extension-link-btn').addEventListener('click', () => {
  if (openExternalLink) openExternalLink(selectedExtensionUrl)
})

document.getElementById('back-btn').addEventListener('click', () => {
  importJsonScreen.classList.remove('visible')
  setTimeout(() => {
    importJsonScreen.classList.add('hidden-screen')
    choosePathScreen.classList.remove('hidden-screen')
    setTimeout(() => {
      choosePathScreen.classList.add('visible')
    }, 50)
  }, 500)
})

function showImportJsonScreen (title) {
  document.getElementById('import-json-title').innerText = title
  choosePathScreen.classList.remove('visible')
  setTimeout(() => {
    choosePathScreen.classList.add('hidden-screen')
    importJsonScreen.classList.remove('hidden-screen')
    setTimeout(() => {
      importJsonScreen.classList.add('visible')
    }, 50)
  }, 500)
}

document.getElementById('skip-btn').addEventListener('click', async () => {
  if (skipOnboarding) await skipOnboarding()
})

// Restore backup: reveal the dedicated restore screen
document.getElementById('backup-link').addEventListener('click', () => {
  showScreen(choosePathScreen, restoreScreen)
})

document.getElementById('restore-back-btn').addEventListener('click', () => {
  showScreen(restoreScreen, choosePathScreen)
})

// Generic screen transition between two import-screens
function showScreen (from, to) {
  from.classList.remove('visible')
  setTimeout(() => {
    from.classList.add('hidden-screen')
    to.classList.remove('hidden-screen')
    setTimeout(() => to.classList.add('visible'), 50)
  }, 500)
}

const restoreStatus = document.getElementById('restore-status')
const cidInput = document.getElementById('cid-input')
const cidPasteBtn = document.getElementById('cid-paste-btn')
const zipDropZone = document.getElementById('zip-drop-zone')
const zipInput = document.getElementById('zip-input')
const backupPassphrase = document.getElementById('backup-passphrase')

function setRestoreStatus (msg, kind) {
  restoreStatus.className = `status-msg ${kind}`
  restoreStatus.textContent = msg
  restoreStatus.style.display = 'block'
}

if (api && typeof api.onProgress === 'function') {
  api.onProgress((data) => {
    if (data.phase === 'fetch' && data.message) {
      setRestoreStatus(data.message, 'success')
    } else if (data.phase === 'restore' && data.totalBytes) {
      const pct = Math.min(100, Math.round((data.processedBytes / data.totalBytes) * 100))
      setRestoreStatus(`Restoring files... ${pct}%`, 'success')
    }
  })
}

function setRestoreBusy (busy) {
  cidPasteBtn.disabled = busy
  cidInput.disabled = busy
  zipDropZone.style.pointerEvents = busy ? 'none' : 'auto'
}

const restoreConfirm = document.getElementById('restore-confirm')
const restoreConfirmTitle = document.getElementById('restore-confirm-title')
const restoreConfirmCode = document.getElementById('restore-confirm-code')
const restoreConfirmDetails = document.getElementById('restore-confirm-details')
const restoreConfirmApply = document.getElementById('restore-confirm-apply')
const restoreConfirmCancel = document.getElementById('restore-confirm-cancel')
let waitingRestore = null

function plural (count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// A transfer is fetched and checked, then waits here for the person to
// compare the code with the other device.
function showRestoreConfirm (res) {
  waitingRestore = res
  restoreConfirmCode.textContent = res.verificationCode || ''
  if (res.kind === 'phone') {
    const parts = []
    if (res.tabs) parts.push(plural(res.tabs, 'tab'))
    if (res.bookmarks) parts.push(plural(res.bookmarks, 'bookmark'))
    if (res.privateDrives) parts.push('access to its private files')
    if (res.chatRooms) parts.push(plural(res.chatRooms, 'PeerChat room'))
    if (res.notes) parts.push(plural(res.notes, 'P2PMD note'))
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
    restoreConfirmTitle.textContent = 'Does your phone show this code?'
    restoreConfirmDetails.textContent = parts.length
      ? `${list.charAt(0).toUpperCase()}${list.slice(1)} from your phone will be added here.` + (res.chatName ? ` PeerChat takes your phone's name, ${res.chatName}.` : '')
      : 'The phone sent no tabs or bookmarks.'
    restoreConfirmApply.textContent = 'It matches'
  } else {
    restoreConfirmTitle.textContent = 'Does the other device show this code?'
    restoreConfirmDetails.textContent = 'Everything from the other computer comes here: tabs, identity, PeerChat and P2P data. PeerSky restarts to finish.'
    restoreConfirmApply.textContent = 'It matches'
  }
  restoreConfirm.hidden = false
  restoreStatus.style.display = 'none'
}

function hideRestoreConfirm () {
  waitingRestore = null
  restoreConfirm.hidden = true
  restoreConfirmCode.textContent = ''
}

// The link from the other device, pasted into the field or with Paste link.
async function fetchLink (text) {
  const address = String(text || '').trim()
  if (!address) return
  if (!/^hyper:\/\//i.test(address)) {
    setRestoreStatus(address.toLowerCase().startsWith('peersky-identity:')
      ? 'That is a code for sending to. Scan this computer\'s code with the other device instead, then paste the link it shows.'
      : 'That is not a PeerSky link.', 'error')
    return
  }
  cidInput.value = address
  if (!restoreCid) return
  if (waitingRestore && discardRestore) discardRestore(waitingRestore.stageId).catch(() => {})
  hideRestoreConfirm()
  setRestoreBusy(true)
  setRestoreStatus('Fetching from the network...', 'success')
  try {
    const res = await restoreCid(address, backupPassphrase.value || undefined)
    if (!res.success) setRestoreStatus(res.error || 'Restore failed.', 'error')
    else if (res.stageId) showRestoreConfirm(res)
    else setRestoreStatus('Restored. Restarting...', 'success')
  } catch (err) {
    setRestoreStatus(err.message || 'Restore failed.', 'error')
  } finally {
    setRestoreBusy(false)
  }
}

cidInput.addEventListener('paste', () => setTimeout(() => fetchLink(cidInput.value), 0))
cidInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fetchLink(cidInput.value)
})

// Pages may not read the clipboard. The main process hands over a PeerSky
// link or code only.
cidPasteBtn.addEventListener('click', async () => {
  const res = readCode ? await readCode().catch(() => null) : null
  if (!res?.text) {
    setRestoreStatus('There is no PeerSky link on the clipboard. Copy the link the other device shows, then try again.', 'error')
    return
  }
  fetchLink(res.text)
})

restoreConfirmApply.addEventListener('click', async () => {
  if (!waitingRestore || !applyRestore) return
  const current = waitingRestore
  restoreConfirmApply.disabled = true
  setRestoreBusy(true)
  setRestoreStatus(current.kind === 'phone' ? 'Adding to this computer...' : 'Restoring...', 'success')
  try {
    const res = await applyRestore(current.stageId)
    if (!res.success) {
      setRestoreStatus(res.error || 'Restore failed.', 'error')
      return
    }
    hideRestoreConfirm()
    setRestoreStatus(current.kind === 'phone' ? 'Added. Opening PeerSky...' : 'Restored. Restarting...', 'success')
  } catch (err) {
    setRestoreStatus(err.message || 'Restore failed.', 'error')
  } finally {
    restoreConfirmApply.disabled = false
    setRestoreBusy(false)
  }
})

restoreConfirmCancel.addEventListener('click', () => {
  if (waitingRestore && discardRestore) discardRestore(waitingRestore.stageId).catch(() => {})
  hideRestoreConfirm()
  setRestoreStatus('Cancelled. Nothing was changed.', 'success')
})

zipDropZone.addEventListener('click', () => zipInput.click())

;['dragenter', 'dragover'].forEach(ev => {
  zipDropZone.addEventListener(ev, (e) => {
    e.preventDefault()
    zipDropZone.classList.add('drag-over')
  }, false)
})

;['dragleave', 'drop'].forEach(ev => {
  zipDropZone.addEventListener(ev, (e) => {
    e.preventDefault()
    zipDropZone.classList.remove('drag-over')
  }, false)
})

zipDropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length > 0) handleZipFile(e.dataTransfer.files[0])
})

zipInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) handleZipFile(e.target.files[0])
})

async function handleZipFile (file) {
  if (!file.name.endsWith('.zip')) {
    setRestoreStatus('Please select a .zip backup file.', 'error')
    return
  }
  let zipPath = file.path
  if (!zipPath && typeof api.getPathForFile === 'function') {
    try { zipPath = api.getPathForFile(file) } catch (_) {}
  }
  if (!zipPath) {
    setRestoreStatus('Could not read where the file is. Skip for now, then use Restore from a backup file in Settings > Link Device.', 'error')
    return
  }
  if (!restoreZip) return
  setRestoreBusy(true)
  setRestoreStatus('Restoring backup...', 'success')
  try {
    const res = await restoreZip(zipPath, backupPassphrase.value || undefined)
    if (res.success) setRestoreStatus('Restored. Restarting...', 'success')
    else setRestoreStatus(res.error || 'Restore failed.', 'error')
  } catch (err) {
    setRestoreStatus(err.message || 'Restore failed.', 'error')
  } finally {
    setRestoreBusy(false)
  }
}

const dropZone = document.getElementById('drop-zone')
const fileInput = document.getElementById('file-input')
const statusText = document.getElementById('status-text')

dropZone.addEventListener('click', () => fileInput.click())

;['dragenter', 'dragover'].forEach(ev => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault()
    dropZone.classList.add('drag-over')
  }, false)
})

;['dragleave', 'drop'].forEach(ev => {
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault()
    dropZone.classList.remove('drag-over')
  }, false)
})

dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0])
})

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) handleFile(e.target.files[0])
})

function handleFile (file) {
  if (!file.name.endsWith('.json')) {
    showError('Please select a .json file.')
    return
  }

  const reader = new FileReader()
  reader.onload = async (e) => {
    const text = e.target.result
    try {
      const data = JSON.parse(text)
      if (!data || typeof data !== 'object') {
        showError('Invalid file.')
        return
      }

      if (importOnboardingData) {
        showSuccess('Importing...')
        const res = await importOnboardingData(text)
        if (res.success) showSuccess('Done! Loading browser...')
        else showError(res.error || 'Import failed.')
      }
    } catch (_) {
      showError('Failed to parse JSON.')
    }
  }
  reader.readAsText(file)
}

function showError (msg) {
  statusText.className = 'status-msg error'
  statusText.textContent = msg
  statusText.style.display = 'block'
}

function showSuccess (msg) {
  statusText.className = 'status-msg success'
  statusText.textContent = msg
  statusText.style.display = 'block'
}

// This computer's code, for the other device to send to. It works for an
// hour, and a new one is shown a little before.
const PAIRING_LIFE_MS = 55 * 60 * 1000
const identityKeyCopyBtn = document.getElementById('identity-key-copy')
const identityDeviceLife = document.getElementById('identity-device-life')
let pairingCode = ''
let pairingExpiresAt = 0

function showPairingLife () {
  if (!pairingCode) return
  const minutes = Math.max(1, Math.ceil((pairingExpiresAt - Date.now()) / 60000))
  identityDeviceLife.textContent = `This code works for ${minutes} more minute${minutes === 1 ? '' : 's'}.`
}

async function loadDeviceInfo () {
  if (!getDeviceInfo) return
  const loading = document.getElementById('identity-device-loading')
  try {
    const res = await getDeviceInfo()
    if (!res.success) throw new Error(res.error)
    pairingCode = res.pairingPayload
    pairingExpiresAt = Date.now() + PAIRING_LIFE_MS
    const qr = document.getElementById('identity-device-qr')
    qr.setAttribute('src', pairingCode)
    qr.hidden = false
    loading.hidden = true
    identityKeyCopyBtn.disabled = false
    showPairingLife()
  } catch (err) {
    loading.textContent = `Could not make a code: ${err.message}`
  }
}

identityKeyCopyBtn?.addEventListener('click', async () => {
  if (!pairingCode) return
  try {
    await navigator.clipboard.writeText(pairingCode)
    identityKeyCopyBtn.textContent = 'Code copied'
    setTimeout(() => { identityKeyCopyBtn.textContent = 'Copy code instead' }, 1500)
  } catch (_) {}
})

setInterval(() => {
  if (pairingCode && Date.now() > pairingExpiresAt) loadDeviceInfo()
  else showPairingLife()
}, 15 * 1000)

loadDeviceInfo()
