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
const importScreen = document.getElementById('import-screen')

setTimeout(() => {
  welcomeScreen.classList.add('hidden')
  setTimeout(() => {
    importScreen.classList.add('visible')
  }, 400)
}, 2000)

const api = window.electronAPI || {}
const { importOnboardingData, skipOnboarding, openExternalLink } = api

const CHROME_STORE_URL = 'https://chromewebstore.google.com/'
const FIREFOX_ADDONS_URL = 'https://addons.mozilla.org/'

document.getElementById('chrome-btn').addEventListener('click', () => {
  if (openExternalLink) openExternalLink(CHROME_STORE_URL)
})

document.getElementById('firefox-btn').addEventListener('click', () => {
  if (openExternalLink) openExternalLink(FIREFOX_ADDONS_URL)
})

document.getElementById('skip-btn').addEventListener('click', async () => {
  if (skipOnboarding) await skipOnboarding()
})

// UI-only placeholder for zip restore
document.getElementById('backup-link').addEventListener('click', () => {
  alert('Peersky backup restore coming soon.')
})

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
