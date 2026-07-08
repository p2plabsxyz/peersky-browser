// Renderer logic for the dedicated peersky://backup page.

const api = window.electronAPI && window.electronAPI.backup

const createBtn = document.getElementById('backup-create')
const chooseBtn = document.getElementById('backup-choose')
const restoreBtn = document.getElementById('backup-restore')
const manifestRow = document.getElementById('backup-manifest')
const manifestDetails = document.getElementById('backup-manifest-details')
const progressBox = document.getElementById('backup-progress')
const progressBar = document.getElementById('backup-progress-bar')
const progressLabel = document.getElementById('backup-progress-label')
const statusBox = document.getElementById('backup-status')
const shareBtn = document.getElementById('backup-share')
const cidRow = document.getElementById('backup-cid-row')
const cidValue = document.getElementById('backup-cid-value')
const cidCopyBtn = document.getElementById('backup-cid-copy')

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
