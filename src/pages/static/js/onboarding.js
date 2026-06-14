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
  }, 400)
}, 2000)

const api = window.electronAPI || {}
const { importOnboardingData, skipOnboarding, openExternalLink, restoreZip, restoreCid } = api
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
const cidRestoreBtn = document.getElementById('cid-restore-btn')
const zipDropZone = document.getElementById('zip-drop-zone')
const zipInput = document.getElementById('zip-input')

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
  cidRestoreBtn.disabled = busy
  zipDropZone.style.pointerEvents = busy ? 'none' : 'auto'
}

cidRestoreBtn.addEventListener('click', async () => {
  const address = cidInput.value.trim()
  if (!address) {
    setRestoreStatus('Enter a CID or ipfs:// link.', 'error')
    return
  }
  if (!restoreCid) return
  setRestoreBusy(true)
  setRestoreStatus('Fetching backup from the network...', 'success')
  try {
    const res = await restoreCid(address)
    if (res.success) setRestoreStatus('Restored. Restarting...', 'success')
    else setRestoreStatus(res.error || 'Restore failed.', 'error')
  } catch (err) {
    setRestoreStatus(err.message || 'Restore failed.', 'error')
  } finally {
    setRestoreBusy(false)
  }
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
    setRestoreStatus('Could not read the file path. Try the Backup page instead.', 'error')
    return
  }
  if (!restoreZip) return
  setRestoreBusy(true)
  setRestoreStatus('Restoring backup...', 'success')
  try {
    const res = await restoreZip(zipPath)
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
