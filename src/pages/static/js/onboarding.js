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
const { importOnboardingData, skipOnboarding, openExternalLink } = api

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
