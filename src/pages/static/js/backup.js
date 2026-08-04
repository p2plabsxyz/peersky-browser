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
const shareBtn = document.getElementById('backup-share')
const cidRow = document.getElementById('backup-cid-section')
const cidValue = document.getElementById('backup-cid-value')
const cidCopyBtn = document.getElementById('backup-cid-copy')
const identityDeviceType = document.getElementById('identity-device-type')
const identityTargetKey = document.getElementById('identity-target-key')
const identityCreateBtn = document.getElementById('identity-create')
const identityUploadHyperBtn = document.getElementById('identity-upload-hyper')
const identityDeviceKey = document.getElementById('identity-device-key')
const identityKeyCopyBtn = document.getElementById('identity-key-copy')

let selectedZipPath = null
let lastCreatedPath = null

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

function showStatus (message, kind) {
  statusBox.textContent = message
  statusBox.className = `backup-status ${kind || 'info'}`
  statusBox.style.display = 'block'
}

function showProgress (label) {
  progressLabel.textContent = label
  progressBar.removeAttribute('value')
  progressBox.style.display = 'block'
}

function hideProgress () {
  progressBox.style.display = 'none'
  progressBar.value = 0
}

function setBusy (busy) {
  if (createBtn) createBtn.disabled = busy
  if (chooseBtn) chooseBtn.disabled = busy
  if (restoreBtn) restoreBtn.disabled = busy
  if (shareBtn) shareBtn.disabled = busy
  if (identityCreateBtn) identityCreateBtn.disabled = busy
  if (identityUploadHyperBtn) identityUploadHyperBtn.disabled = busy
}

async function loadDeviceInfo () {
  if (!api || !identityDeviceKey || typeof api.getDeviceInfo !== 'function') return
  const res = await api.getDeviceInfo()
  if (res.success) {
    identityDeviceKey.textContent = res.device.encryptionPublicKey
    const deviceQrImg = document.getElementById('device-key-qr-code')
    const deviceQrContainer = document.getElementById('device-key-qr-container')
    if (deviceQrImg && deviceQrContainer && res.qrDataUrl) {
      deviceQrImg.src = res.qrDataUrl
      deviceQrContainer.style.display = 'block'
    }
  } else {
    identityDeviceKey.textContent = `Could not load device key: ${res.error}`
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
    const res = await api.create()
    if (res.canceled) return
    if (res.success) {
      lastCreatedPath = res.filePath
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
      return
    }
    selectedZipPath = res.zipPath
    const entries = Object.keys(res.manifest.files || {})
    const created = res.manifest.createdAt
      ? new Date(res.manifest.createdAt).toLocaleString()
      : 'unknown'
    manifestDetails.textContent =
      `Created ${created} (Peersky ${res.manifest.peerskyVersion || 'unknown'}). ` +
      `Contains: ${entries.join(', ') || 'no recognized entries'}.`
    manifestRow.style.display = ''
  } catch (err) {
    showStatus(`Could not read backup: ${err.message}`, 'error')
  }
})

shareBtn?.addEventListener('click', async () => {
  if (!api) return
  setBusy(true)
  const protocolSelect = document.getElementById('backup-share-protocol')
  const protocol = protocolSelect ? protocolSelect.value : 'ipfs'
  showProgress(`Uploading to ${protocol.toUpperCase()}...`)
  statusBox.style.display = 'none'
  try {
    const res = await api.upload(lastCreatedPath || null, protocol)
    if (res.canceled) return
    if (res.success) {
      cidValue.textContent = res.address
      const qrImg = document.getElementById('backup-qr-code')
      if (qrImg && res.qrDataUrl) {
        qrImg.src = res.qrDataUrl
        qrImg.style.display = 'block'
      } else if (qrImg) {
        qrImg.style.display = 'none'
      }
      cidRow.style.display = ''
      showStatus(`Uploaded to ${protocol.toUpperCase()}. Share this address to restore on another device.`, 'success')
    } else {
      showStatus(`Upload failed: ${res.error}`, 'error')
    }
  } catch (err) {
    showStatus(`Upload failed: ${err.message}`, 'error')
  } finally {
    hideProgress()
    setBusy(false)
  }
})

cidCopyBtn?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(cidValue.textContent || '')
    cidCopyBtn.textContent = 'Copied'
    setTimeout(() => { cidCopyBtn.textContent = 'Copy' }, 1500)
  } catch (_) {}
})

identityKeyCopyBtn?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(identityDeviceKey.textContent || '')
    identityKeyCopyBtn.textContent = 'Copied'
    setTimeout(() => { identityKeyCopyBtn.textContent = 'Copy' }, 1500)
  } catch (_) {}
})

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

identityScanQrBtn?.addEventListener('click', async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showStatus('Camera access is not supported by your system.', 'error')
    return
  }

  try {
    qrScannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    qrScannerVideo.srcObject = qrScannerStream
    qrScannerVideo.setAttribute('playsinline', true)
    qrScannerVideo.play()
    qrScannerContainer.style.display = 'block'

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

        if (code && code.data) {
          if (code.data.length === 64 || code.data.startsWith('peersky-identity:')) {
            identityTargetKey.value = code.data
            stopQrScanner()
            showStatus('Successfully scanned Mobile Key!', 'success')
            return
          }
        }
      }
      qrScannerAnimationFrame = requestAnimationFrame(tick)
    }

    qrScannerAnimationFrame = requestAnimationFrame(tick)
  } catch (err) {
    showStatus(`Camera error: ${err.message}`, 'error')
    stopQrScanner()
  }
})

identityCreateBtn?.addEventListener('click', async () => {
  if (!api || !identityTargetKey.value.trim()) return

  setBusy(true)
  showProgress('Creating encrypted identity transfer...')
  statusBox.style.display = 'none'
  try {
    const res = await api.createIdentityTransfer(identityDeviceType.value, identityTargetKey.value.trim())
    if (res.canceled) return
    if (res.success) {
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
  if (!api || !identityTargetKey.value.trim()) return

  setBusy(true)
  showProgress('Uploading encrypted identity transfer to Hyper...')
  statusBox.style.display = 'none'
  try {
    const res = await api.uploadIdentityTransferHyper(identityDeviceType.value, identityTargetKey.value.trim())
    if (res.success) {
      cidValue.textContent = res.address
      const qrImg = document.getElementById('backup-qr-code')
      if (qrImg && res.qrDataUrl) {
        qrImg.src = res.qrDataUrl
        qrImg.style.display = 'block'
      } else if (qrImg) {
        qrImg.style.display = 'none'
      }
      cidRow.style.display = ''
      showStatus(`Encrypted identity transfer uploaded to Hyper.\n\nVERIFICATION CODE: ${res.verificationCode}\n\nScan the QR code below with PeerSky Mobile (Settings > Link Device) to restore identity automatically. Ensure the Verification Code matches exactly!`, 'success')
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
const cidDownloadBtn = document.getElementById('backup-cid-download')

cidDownloadBtn?.addEventListener('click', async () => {
  if (!api || !cidInput.value.trim()) return
  const ok = window.confirm(
    'Restoring will overwrite your current tabs, P2P identities, and IPFS/Hyper ' +
    'data with the backup contents. Peersky will restart. Continue?')
  if (!ok) return

  setBusy(true)
  showProgress('Fetching backup from the network...')
  statusBox.style.display = 'none'
  try {
    const res = await api.restoreCid(cidInput.value.trim())
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

restoreBtn?.addEventListener('click', async () => {
  if (!api || !selectedZipPath) return
  const ok = window.confirm(
    'Restoring will overwrite your current tabs, P2P identities, and IPFS/Hyper ' +
    'data with the backup contents. Peersky will restart. Continue?')
  if (!ok) return

  setBusy(true)
  showProgress('Restoring backup...')
  statusBox.style.display = 'none'
  try {
    const res = await api.restore(selectedZipPath)
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
  if (identityDeviceKey) identityDeviceKey.textContent = `Could not load device key: ${err.message}`
})
