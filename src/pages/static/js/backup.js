// Renderer logic for the dedicated peersky://backup page.

const api = window.electronAPI && window.electronAPI.backup

const createBtn = document.getElementById('backup-create')
const chooseBtn = document.getElementById('backup-choose')
const restoreBtn = document.getElementById('backup-restore')
const manifestRow = document.getElementById('backup-manifest-section')
const manifestDetails = document.getElementById('backup-manifest-details')
const progressBox = document.getElementById('backup-progress')
const progressBar = document.getElementById('backup-progress-bar')
const progressLabel = document.getElementById('backup-progress-label')
const statusBox = document.getElementById('backup-status')
const identityTransferStatus = document.getElementById('identity-transfer-status')
const cidRow = document.getElementById('backup-cid-section')
const cidValue = document.getElementById('backup-cid-value')
const cidCopyBtn = document.getElementById('backup-cid-copy')
const identityTargetKey = document.getElementById('identity-target-key')
const identityCreateBtn = document.getElementById('identity-create')
const identityUploadHyperBtn = document.getElementById('identity-upload-hyper')
const identityDeviceKey = document.getElementById('identity-device-key')
const identityKeyCopyBtn = document.getElementById('identity-key-copy')
const backupIncludePrivate = document.getElementById('backup-include-private')
const identityIncludePrivate = document.getElementById('identity-include-private')
const backupPrivateUploads = document.getElementById('backup-private-uploads')
const identityPrivateUploads = document.getElementById('identity-private-uploads')
const privateListError = { message: null }

let selectedZipPath = null
let selectedManifest = null
let privateHyperdriveCount = null

function formatBytes (bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(1)} ${units[i]}`
}

// Anything the user is meant to read is brought on screen. These blocks used to
// appear wherever the page happened to be scrolled, so a long operation or a
// verification code could go unnoticed below the fold.
function reveal (element) {
  element.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function showStatus (message, kind) {
  statusBox.textContent = message
  statusBox.className = `backup-status ${kind || 'info'}`
  statusBox.style.display = 'block'
  reveal(statusBox)
}

function showIdentityTransferStatus (message) {
  identityTransferStatus.textContent = message
  identityTransferStatus.style.display = 'block'
  reveal(identityTransferStatus)
}

function showProgress (label) {
  progressLabel.textContent = label
  progressBar.removeAttribute('value')
  progressBox.style.display = 'block'
  reveal(progressBox)
}

function hideProgress () {
  progressBox.style.display = 'none'
  progressBar.value = 0
}

function setBusy (busy) {
  for (const control of [
    createBtn,
    chooseBtn,
    restoreBtn,
    identityCreateBtn,
    identityUploadHyperBtn,
    backupIncludePrivate,
    identityIncludePrivate,
    document.getElementById('backup-cid-download'),
    document.getElementById('backup-incoming-apply'),
    document.getElementById('backup-incoming-cancel')
  ]) {
    if (control) control.disabled = busy
  }
}

// The summary doubles as the old warning line: it says whether the private
// uploads are in or out, and opening it lists them.
function summaryText (included) {
  if (privateListError.message) return privateListError.message
  const noun = privateHyperdriveCount === 1 ? 'upload' : 'uploads'
  return included
    ? `${privateHyperdriveCount} private ${noun} included.`
    : `${privateHyperdriveCount} private ${noun} not included.`
}

function updatePrivateWarnings () {
  for (const [checkbox, details] of [
    [backupIncludePrivate, backupPrivateUploads],
    [identityIncludePrivate, identityPrivateUploads]
  ]) {
    if (!checkbox || !details) continue
    // Nothing to say when the device has no private uploads at all.
    const relevant = privateListError.message !== null || privateHyperdriveCount > 0
    details.hidden = !relevant
    if (!relevant) continue
    const included = checkbox.checked
    details.dataset.excluded = String(!included)
    details.querySelector('summary').textContent = summaryText(included)
  }
}

function renderPrivateList (items) {
  for (const list of document.querySelectorAll('[data-private-list]')) {
    list.replaceChildren()
    for (const item of items) {
      const row = document.createElement('li')
      const link = document.createElement('a')
      link.href = item.url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = item.name
      row.appendChild(link)
      const created = new Date(item.timestamp)
      if (!Number.isNaN(created.getTime())) row.append(` - ${created.toLocaleString()}`)
      list.appendChild(row)
    }
  }
}

async function loadPrivateHyperdrives () {
  if (!api || typeof api.listPrivateHyperdrives !== 'function') return
  const response = await api.listPrivateHyperdrives()
  if (!response.success) {
    privateHyperdriveCount = null
    privateListError.message = `Could not list private uploads: ${response.error}`
    renderPrivateList([])
    updatePrivateWarnings()
    return
  }

  const items = Array.isArray(response.items) ? response.items : []
  privateHyperdriveCount = items.length
  privateListError.message = null
  renderPrivateList(items)
  updatePrivateWarnings()
}

backupIncludePrivate?.addEventListener('change', updatePrivateWarnings)
identityIncludePrivate?.addEventListener('change', updatePrivateWarnings)

function requestPassphrase ({ confirmation, description }) {
  const dialog = document.getElementById('backup-passphrase-dialog')
  const form = document.getElementById('backup-passphrase-form')
  const input = document.getElementById('backup-passphrase-input')
  const confirmInput = document.getElementById('backup-passphrase-confirm')
  const confirmRow = document.getElementById('backup-passphrase-confirm-row')
  const descriptionNode = document.getElementById('backup-passphrase-description')
  const errorNode = document.getElementById('backup-passphrase-error')
  const cancel = document.getElementById('backup-passphrase-cancel')

  input.value = ''
  confirmInput.value = ''
  confirmRow.style.display = confirmation ? '' : 'none'
  descriptionNode.textContent = description
  errorNode.textContent = ''

  return new Promise((resolve) => {
    const finish = (value) => {
      form.removeEventListener('submit', submit)
      cancel.removeEventListener('click', cancelRequest)
      dialog.removeEventListener('cancel', cancelDialog)
      if (dialog.open) dialog.close()
      input.value = ''
      confirmInput.value = ''
      resolve(value)
    }
    const submit = (event) => {
      event.preventDefault()
      if (input.value.length < 12 && confirmation) {
        errorNode.textContent = 'Backup passphrase must be at least 12 characters.'
        return
      }
      if (confirmation && input.value !== confirmInput.value) {
        errorNode.textContent = 'Backup passphrases do not match.'
        return
      }
      finish(input.value)
    }
    const cancelRequest = () => finish(null)
    const cancelDialog = (event) => {
      event.preventDefault()
      finish(null)
    }
    form.addEventListener('submit', submit)
    cancel.addEventListener('click', cancelRequest)
    dialog.addEventListener('cancel', cancelDialog)
    dialog.showModal()
    input.focus()
  })
}

function requestNewPassphrase () {
  return requestPassphrase({
    confirmation: true,
    description: 'Use at least 12 characters. This passphrase cannot be recovered.'
  })
}

function requestRestorePassphrase () {
  if (!selectedManifest || selectedManifest.kind !== 'peersky-encrypted-backup') return undefined
  return requestPassphrase({
    confirmation: false,
    description: 'Enter the passphrase used when this backup was created.'
  })
}

async function loadDeviceInfo () {
  if (!api || !identityDeviceKey || typeof api.getDeviceInfo !== 'function') return
  const res = await api.getDeviceInfo()
  if (res.success) {
    identityDeviceKey.textContent = res.pairingPayload
    const deviceQrImg = document.getElementById('device-key-qr-code')
    const deviceQrContainer = document.getElementById('device-key-qr-container')
    if (deviceQrImg && deviceQrContainer && res.pairingPayload) {
      deviceQrImg.setAttribute('src', res.pairingPayload)
      deviceQrContainer.style.display = 'block'
    }
  } else {
    identityDeviceKey.textContent = `Could not load device pairing code: ${res.error}`
  }
}

if (api && typeof api.onProgress === 'function') {
  api.onProgress((data) => {
    if (data.phase === 'create' && data.totalBytes) {
      const pct = Math.min(100, Math.round((data.processedBytes / data.totalBytes) * 100))
      progressBar.value = pct
      progressLabel.textContent = `Compressing... ${pct}%`
    } else if (data.phase === 'restore' && data.totalBytes) {
      const pct = Math.min(100, Math.round((data.processedBytes / data.totalBytes) * 100))
      progressBar.value = pct
      progressLabel.textContent = `Restoring files... ${pct}%`
    } else if (data.phase === 'fetch' && data.message) {
      progressBar.removeAttribute('value')
      progressLabel.textContent = data.message
    }
  })
}

createBtn?.addEventListener('click', async () => {
  if (!api) return
  setBusy(true)
  showProgress('Preparing backup...')
  statusBox.style.display = 'none'
  try {
    const passphrase = await requestNewPassphrase()
    if (passphrase === null) return
    const res = await api.create(passphrase, backupIncludePrivate?.checked === true)
    if (res.canceled) return
    if (res.success) {
      showStatus(`Backup saved (${formatBytes(res.bytes)}): ${res.filePath}`, 'success')
    } else {
      showStatus(`Backup failed: ${res.error}`, 'error')
    }
  } catch (err) {
    showStatus(`Backup failed: ${err.message}`, 'error')
  } finally {
    hideProgress()
    setBusy(false)
  }
})

chooseBtn?.addEventListener('click', async () => {
  if (!api) return
  statusBox.style.display = 'none'
  try {
    const res = await api.validate()
    if (res.canceled) return
    if (!res.success) {
      showStatus(`Invalid backup: ${res.error}`, 'error')
      manifestRow.style.display = 'none'
      selectedZipPath = null
      selectedManifest = null
      return
    }
    selectedZipPath = res.zipPath
    selectedManifest = res.manifest
    const entries = res.manifest.contents || Object.keys(res.manifest.files || {})
    const created = res.manifest.createdAt
      ? new Date(res.manifest.createdAt).toLocaleString()
      : 'unknown'
    manifestDetails.textContent =
      `Created ${created} (Peersky ${res.manifest.peerskyVersion || 'unknown'}). ` +
      `${res.manifest.kind === 'peersky-encrypted-backup' ? 'Passphrase encrypted. ' : ''}` +
      `Contains: ${entries.join(', ') || 'encrypted payload'}.`
    manifestRow.style.display = ''
  } catch (err) {
    showStatus(`Could not read backup: ${err.message}`, 'error')
  }
})

// Copying used to swallow every failure, so a click on a value that was still
// loading, or a clipboard write the page was not allowed to make, looked
// identical to success. Fall back to a selection copy and say so when it fails.
async function copyText (text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (_) {}
  }
  const scratch = document.createElement('textarea')
  scratch.value = text
  scratch.setAttribute('readonly', '')
  scratch.style.position = 'fixed'
  scratch.style.opacity = '0'
  document.body.appendChild(scratch)
  try {
    scratch.select()
    return document.execCommand('copy')
  } catch (_) {
    return false
  } finally {
    scratch.remove()
  }
}

function wireCopyButton (button, read, label) {
  button?.addEventListener('click', async () => {
    const text = (read() || '').trim()
    if (!text || text.endsWith('...')) {
      showStatus(`${label} is not ready yet.`, 'error')
      return
    }
    if (await copyText(text)) {
      button.textContent = 'Copied'
      setTimeout(() => { button.textContent = 'Copy' }, 1500)
    } else {
      showStatus(`Could not copy the ${label.toLowerCase()}. Select the text and copy it manually.`, 'error')
    }
  })
}

wireCopyButton(cidCopyBtn, () => cidValue.textContent, 'Identity transfer address')
wireCopyButton(identityKeyCopyBtn, () => identityDeviceKey.textContent, 'Device pairing code')

// An identity lives on one phone at a time. Showing which one, and offering a
// way to release it, is the difference between a cap that looks like a bug
// and one the user can act on.
const pairedMobileRow = document.getElementById('paired-mobile-row')
const pairedMobileDetail = document.getElementById('paired-mobile-detail')
const pairedMobileForgetBtn = document.getElementById('paired-mobile-forget')

async function refreshPairedMobile () {
  if (!pairedMobileRow) return
  try {
    const result = await api.getPairedMobile()
    const paired = result?.success ? result.paired : null
    if (!paired) {
      pairedMobileRow.style.display = 'none'
      return
    }
    const when = paired.pairedAt ? new Date(paired.pairedAt).toLocaleDateString() : 'an earlier date'
    pairedMobileDetail.textContent = `Paired ${when}. Key ${paired.encryptionPublicKey.slice(0, 16)}...`
    pairedMobileRow.style.display = ''
  } catch {
    pairedMobileRow.style.display = 'none'
  }
}

pairedMobileForgetBtn?.addEventListener('click', async () => {
  // The old phone is not asked to confirm. It is usually broken, sold or
  // already wiped by the time someone clicks this, so waiting on it would
  // fail exactly when it is needed. Say plainly what that means instead.
  const confirmed = window.confirm(
    'Move this identity to a new phone?\n\n' +
    'Delete PeerSky data on the old phone first, or remove the app. ' +
    'Two phones on one identity will split your messages, and each phone ' +
    'keeps whatever it already has.'
  )
  if (!confirmed) return

  try {
    const result = await api.forgetPairedMobile()
    if (!result?.success) throw new Error(result?.error || 'Could not release the phone')
    await refreshPairedMobile()
    showIdentityTransferStatus('Phone released. Pair a new one with its pairing code.')
  } catch (error) {
    showStatus(error.message, 'error')
  }
})

refreshPairedMobile()

const identityScanQrBtn = document.getElementById('identity-scan-qr')
const qrScannerContainer = document.getElementById('qr-scanner-container')
const qrScannerVideo = document.getElementById('qr-scanner-video')
const qrScannerCancel = document.getElementById('qr-scanner-cancel')
let qrScannerStream = null
let qrScannerAnimationFrame = null

function stopQrScanner () {
  if (qrScannerAnimationFrame) cancelAnimationFrame(qrScannerAnimationFrame)
  if (qrScannerStream) {
    qrScannerStream.getTracks().forEach((track) => track.stop())
    qrScannerStream = null
  }
  if (qrScannerContainer) qrScannerContainer.style.display = 'none'
}

qrScannerCancel?.addEventListener('click', stopQrScanner)

// One camera view for both kinds of code. onCode returns true once it has
// taken a code, which closes the camera; anything else keeps scanning.
async function startQrScanner (onCode) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStatus('Camera access is not supported by your system.', 'error')
    return
  }
  stopQrScanner()

  try {
    qrScannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    qrScannerVideo.srcObject = qrScannerStream
    qrScannerVideo.setAttribute('playsinline', true)
    qrScannerVideo.play()
    qrScannerContainer.style.display = 'block'
    reveal(qrScannerContainer)

    const canvasElement = document.createElement('canvas')
    const canvas = canvasElement.getContext('2d')

    const tick = () => {
      if (qrScannerVideo.readyState === qrScannerVideo.HAVE_ENOUGH_DATA) {
        canvasElement.height = qrScannerVideo.videoHeight
        canvasElement.width = qrScannerVideo.videoWidth
        canvas.drawImage(qrScannerVideo, 0, 0, canvasElement.width, canvasElement.height)

        const imageData = canvas.getImageData(0, 0, canvasElement.width, canvasElement.height)
        const code = window.jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        })

        if (code && code.data && onCode(code.data)) {
          stopQrScanner()
          return
        }
      }
      qrScannerAnimationFrame = requestAnimationFrame(tick)
    }

    qrScannerAnimationFrame = requestAnimationFrame(tick)
  } catch (err) {
    showStatus(`Camera error: ${err.message}`, 'error')
    stopQrScanner()
  }
}

identityScanQrBtn?.addEventListener('click', () => startQrScanner((text) => {
  if (!text.startsWith('peersky-identity:')) return false
  identityTargetKey.value = text
  showStatus('Successfully scanned the receiving device pairing code.', 'success')
  return true
}))

// Both identity buttons used to return silently when the pairing code box was
// empty, so a click looked like the feature was broken. Point at the field that
// is actually missing instead.
function requireIdentityTargetKey () {
  if (identityTargetKey?.value.trim()) return true
  showStatus('Paste or scan the receiving device\'s pairing code first. PeerSky Mobile shows it under Settings > Link Device, and PeerSky Desktop under Backup & Restore > This device pairing code.', 'error')
  identityTargetKey?.focus()
  identityTargetKey?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return false
}

identityCreateBtn?.addEventListener('click', async () => {
  if (!api || !requireIdentityTargetKey()) return

  setBusy(true)
  showProgress('Creating encrypted identity transfer...')
  statusBox.style.display = 'none'
  try {
    const res = await api.createIdentityTransfer(
      identityTargetKey.value.trim(),
      identityIncludePrivate?.checked !== false
    )
    if (res.canceled) return
    if (res.success) {
      // The phone slot is taken now, so the row that releases it has to
      // appear without making the user reload the page to find it.
      await refreshPairedMobile()
      showStatus(`Identity transfer saved (${formatBytes(res.bytes)}): ${res.filePath}`, 'success')
    } else {
      showStatus(`Identity transfer failed: ${res.error}`, 'error')
    }
  } catch (err) {
    showStatus(`Identity transfer failed: ${err.message}`, 'error')
  } finally {
    hideProgress()
    setBusy(false)
  }
})

identityUploadHyperBtn?.addEventListener('click', async () => {
  if (!api || !requireIdentityTargetKey()) return

  setBusy(true)
  showProgress('Uploading encrypted identity transfer to Hyper...')
  statusBox.style.display = 'none'
  identityTransferStatus.style.display = 'none'
  cidRow.style.display = 'none'
  try {
    const res = await api.uploadIdentityTransferHyper(
      identityTargetKey.value.trim(),
      identityIncludePrivate?.checked !== false
    )
    if (res.success) {
      cidValue.textContent = res.address
      const qrImg = document.getElementById('backup-qr-code')
      if (qrImg && res.address) {
        qrImg.setAttribute('src', res.address)
        qrImg.style.display = 'block'
      } else if (qrImg) {
        qrImg.style.display = 'none'
      }
      cidRow.style.display = ''
      await refreshPairedMobile()
      showIdentityTransferStatus(`Encrypted identity transfer uploaded to Hyper.\n\nVERIFICATION CODE: ${res.verificationCode}\n\nOn a phone, scan the QR code below with PeerSky Mobile (Settings > Link Device). On a computer, open Backup & Restore in PeerSky Desktop. Under Restore from the network, paste the identity transfer address shown below or scan the QR code, then press Download.\n\nNote: Ensure the verification code matches exactly.`)
    } else {
      showStatus(`Identity transfer upload failed: ${res.error}`, 'error')
    }
  } catch (err) {
    showStatus(`Identity transfer upload failed: ${err.message}`, 'error')
  } finally {
    hideProgress()
    setBusy(false)
  }
})

const cidInput = document.getElementById('backup-cid-input')
const cidPassphrase = document.getElementById('backup-cid-passphrase')
const cidDownloadBtn = document.getElementById('backup-cid-download')
const cidScanBtn = document.getElementById('backup-cid-scan')
const incomingSection = document.getElementById('backup-incoming-section')
const incomingTitle = document.getElementById('backup-incoming-title')
const incomingCode = document.getElementById('backup-incoming-code')
const incomingDetails = document.getElementById('backup-incoming-details')
const incomingApplyBtn = document.getElementById('backup-incoming-apply')
const incomingCancelBtn = document.getElementById('backup-incoming-cancel')

// What the last download turned out to be, waiting for the person to say yes.
let incoming = null

function plural (count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

// "3 tabs, 12 bookmarks and access to its private files", or null for none.
function listPhoneSync ({ tabs, bookmarks, privateDrives, chatRooms, notes }) {
  const parts = []
  if (tabs) parts.push(plural(tabs, 'tab'))
  if (bookmarks) parts.push(plural(bookmarks, 'bookmark'))
  if (privateDrives) parts.push('access to its private files')
  if (chatRooms) parts.push(plural(chatRooms, 'PeerChat room'))
  if (notes) parts.push(plural(notes, 'P2PMD note'))
  if (parts.length === 0) return null
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]
}

function describePhoneSync (res) {
  const list = listPhoneSync(res)
  if (!list && !res.chatName) return 'The phone sent no tabs or bookmarks.'
  let text = list ? `Adds ${list} from your phone, skipping any already here.` : ''
  // PeerChat takes the phone's name. Everything else here is kept.
  text += res.chatName ? ` PeerChat here takes your phone's name, ${res.chatName}.` : ' Nothing here is replaced.'
  if (res.tabs) text += ' The tabs open asleep in a group called Phone.'
  return text.trim()
}

function showIncoming (res) {
  incoming = res
  incomingCode.hidden = !res.verificationCode
  incomingCode.textContent = res.verificationCode || ''
  if (res.kind === 'phone') {
    incomingTitle.textContent = 'From your phone. Does it show this code?'
    incomingDetails.textContent = describePhoneSync(res)
    incomingApplyBtn.textContent = 'Add to this desktop'
  } else if (res.kind === 'transfer') {
    incomingTitle.textContent = 'Identity transfer. Does the other device show this code?'
    incomingDetails.textContent = 'Replaces this desktop\'s tabs, identity and P2P data with the other device\'s, then restarts PeerSky.'
    incomingApplyBtn.textContent = 'Restore'
  } else {
    incomingTitle.textContent = 'Backup'
    incomingDetails.textContent = 'Replaces this desktop\'s tabs, identity and P2P data with the backup, then restarts PeerSky.' +
      (res.encrypted ? ' It needs the passphrase it was made with.' : '')
    incomingApplyBtn.textContent = 'Restore'
  }
  incomingSection.style.display = ''
  reveal(incomingSection)
}

function hideIncoming () {
  incoming = null
  incomingSection.style.display = 'none'
  incomingCode.textContent = ''
}

async function restartAfterRestore () {
  showStatus('Restore complete. Restart to apply the restored data.', 'success')
  if (window.confirm('Restore complete. Restart Peersky now?')) {
    await api.relaunch()
  } else {
    showStatus('Browser must restart to apply backup. Forcing restart in 5 seconds...', 'error')
    setTimeout(() => api.relaunch(), 5000)
  }
}

cidScanBtn?.addEventListener('click', () => startQrScanner((text) => {
  if (!text.trim().toLowerCase().startsWith('hyper://')) return false
  cidInput.value = text.trim()
  showStatus('Scanned. Press Download to get it.', 'success')
  return true
}))

cidDownloadBtn?.addEventListener('click', async () => {
  if (!api || !cidInput.value.trim()) return
  if (incoming) api.discardRestore(incoming.stageId).catch(() => {})
  hideIncoming()

  setBusy(true)
  showProgress('Fetching from the network...')
  statusBox.style.display = 'none'
  try {
    const res = await api.fetchRestore(cidInput.value.trim())
    if (res.success) {
      hideProgress()
      showIncoming(res)
    } else {
      showStatus(`Could not get it: ${res.error}`, 'error')
    }
  } catch (err) {
    showStatus(`Could not get it: ${err.message}`, 'error')
  } finally {
    hideProgress()
    setBusy(false)
  }
})

incomingCancelBtn?.addEventListener('click', () => {
  if (incoming) api.discardRestore(incoming.stageId).catch(() => {})
  hideIncoming()
  showStatus('Cancelled. Nothing was changed.', 'info')
})

incomingApplyBtn?.addEventListener('click', async () => {
  if (!api || !incoming) return
  const current = incoming
  let passphrase
  if (current.kind === 'backup' && current.encrypted) {
    passphrase = cidPassphrase.value || await requestPassphrase({
      confirmation: false,
      description: 'Enter the passphrase used when this backup was created.'
    })
    if (passphrase === null) return
  }

  setBusy(true)
  showProgress(current.kind === 'phone' ? 'Adding tabs and bookmarks...' : 'Restoring...')
  statusBox.style.display = 'none'
  try {
    const res = await api.applyRestore(current.stageId, passphrase)
    if (!res.success) {
      showStatus(`Restore failed: ${res.error}`, 'error')
      return
    }
    hideIncoming()
    hideProgress()
    if (res.requiresRestart) {
      await restartAfterRestore()
      return
    }
    const list = listPhoneSync(res.added || {})
    showStatus(list ? `Added ${list} from your phone.` : 'Everything the phone sent was already here.', 'success')
    // The code that was shown has been used. A fresh one is ready for next time.
    loadDeviceInfo().catch(() => {})
  } catch (err) {
    showStatus(`Restore failed: ${err.message}`, 'error')
  } finally {
    hideProgress()
    setBusy(false)
  }
})

// Leaving the page drops anything still waiting, so it is not kept decrypted.
window.addEventListener('pagehide', () => {
  if (incoming) api?.discardRestore(incoming.stageId).catch(() => {})
})

restoreBtn?.addEventListener('click', async () => {
  if (!api || !selectedZipPath) return
  const ok = window.confirm(
    'Restoring will overwrite your current tabs, P2P identities and Hyper data ' +
    'with the backup contents. Peersky will restart. Continue?')
  if (!ok) return

  setBusy(true)
  showProgress('Restoring backup...')
  statusBox.style.display = 'none'
  try {
    const passphrase = await requestRestorePassphrase()
    if (passphrase === null) return
    const res = await api.restore(selectedZipPath, passphrase)
    if (res.success) {
      hideProgress()
      showStatus('Restore complete. Restart to apply the restored data.', 'success')
      if (window.confirm('Restore complete. Restart Peersky now?')) {
        await api.relaunch()
      } else {
        showStatus('Browser must restart to apply backup. Forcing restart in 5 seconds...', 'error')
        setTimeout(() => api.relaunch(), 5000)
      }
    } else {
      showStatus(`Restore failed: ${res.error}`, 'error')
    }
  } catch (err) {
    showStatus(`Restore failed: ${err.message}`, 'error')
  } finally {
    hideProgress()
    setBusy(false)
  }
})

loadDeviceInfo().catch((err) => {
  if (identityDeviceKey) identityDeviceKey.textContent = `Could not load device pairing code: ${err.message}`
})

loadPrivateHyperdrives().catch((err) => {
  privateHyperdriveCount = null
  privateListError.message = `Could not list private uploads: ${err.message}`
  updatePrivateWarnings()
})
