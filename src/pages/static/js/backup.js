// Link Device (peersky://backup), laid out as the phone's: my devices, sync
// with another device, and backup files.

const api = window.electronAPI && window.electronAPI.backup
const $ = (id) => document.getElementById(id)

// A pairing code works for an hour (pairing-sessions.js). A new one is shown
// a little before, so one scanned at the last moment still lands.
const PAIRING_LIFE_MS = 55 * 60 * 1000

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

function plural (count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function minutesLeft (ms) {
  return Math.max(1, Math.ceil(ms / 60000))
}

// Page messages

function showStatus (message, kind = 'info') {
  $('ld-status-text').textContent = message
  $('ld-status').className = `ld-status ${kind}`
  $('ld-status').hidden = false
  $('ld-status').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function hideStatus () {
  $('ld-status').hidden = true
}

$('ld-status-close').addEventListener('click', hideStatus)

function showProgress (label) {
  $('ld-progress-label').textContent = label
  $('ld-progress-bar').removeAttribute('value')
  $('ld-progress').hidden = false
  $('ld-progress').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

function hideProgress () {
  $('ld-progress').hidden = true
}

// Copying used to swallow every failure, so a click that copied nothing
// looked the same as one that did. Fall back to a selection copy.
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

async function copyFrom (button, text, done) {
  if (!text) return
  const before = button.textContent
  if (await copyText(text)) {
    button.textContent = done
    setTimeout(() => { button.textContent = before }, 1500)
  } else {
    setSyncError('Could not copy it. Select the text and copy it yourself.')
  }
}

// This computer

function thisComputerName () {
  const platform = String(navigator.userAgentData?.platform || navigator.platform || '')
  if (/mac/i.test(platform)) return 'Mac'
  if (/win/i.test(platform)) return 'Windows PC'
  return 'Linux computer'
}

$('ld-this-device').textContent = thisComputerName()

// My devices: the person's other devices this one has met, as the phone lists
// them. A device is never named, only numbered when there are two of a kind.

let pairedMobile = null
let shownDevice = null

function labelDevices (devices) {
  const byType = new Map()
  for (const device of [...devices].sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0))) {
    if (!byType.has(device.type)) byType.set(device.type, [])
    byType.get(device.type).push(device)
  }
  const labels = new Map()
  for (const [type, list] of byType) {
    const name = type === 'phone' ? 'Phone' : 'Desktop'
    list.forEach((device, index) => labels.set(device.id, list.length > 1 ? `${name} ${index + 1}` : name))
  }
  return labels
}

function describeDevice (device, now = Date.now()) {
  if (device.online) return 'Online now'
  if (!device.lastSeen) return 'Not connected yet'
  const minutes = Math.floor((now - device.lastSeen) / 60000)
  if (minutes < 1) return 'Seen just now'
  if (minutes < 60) return `Seen ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Seen ${plural(hours, 'hour')} ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `Seen ${plural(days, 'day')} ago`
  return `Seen on ${new Date(device.lastSeen).toLocaleDateString()}`
}

function deviceRow ({ icon, title, description, online, onClick }) {
  const row = document.createElement(onClick ? 'button' : 'div')
  row.className = 'ld-row'
  if (onClick) {
    row.type = 'button'
    row.addEventListener('click', onClick)
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'ld-row-icon')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', icon)
  svg.appendChild(use)
  const text = document.createElement('div')
  text.className = 'ld-row-text'
  const titleNode = document.createElement('div')
  titleNode.className = 'ld-row-title'
  titleNode.textContent = title
  text.appendChild(titleNode)
  if (description) {
    const desc = document.createElement('div')
    desc.className = 'ld-row-desc'
    if (online) {
      const dot = document.createElement('span')
      dot.className = 'ld-dot'
      desc.appendChild(dot)
    }
    desc.append(description)
    text.appendChild(desc)
  }
  row.append(svg, text)
  return row
}

async function loadDevices () {
  if (!api) return
  const [listed, paired] = await Promise.all([
    api.listDevices().catch(() => null),
    api.getPairedMobile().catch(() => null)
  ])
  pairedMobile = paired?.success ? paired.paired : null
  const devices = listed?.success && Array.isArray(listed.devices) ? listed.devices : []
  const labels = labelDevices(devices)
  const sorted = [...devices].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1
    return (b.lastSeen || 0) - (a.lastSeen || 0)
  })
  const list = $('ld-device-list')
  list.replaceChildren()
  for (const device of sorted) {
    const label = labels.get(device.id) || 'Device'
    list.appendChild(deviceRow({
      icon: device.type === 'phone' ? '#i-phone' : '#i-display',
      title: label,
      description: describeDevice(device),
      online: device.online,
      onClick: () => showDevice({ ...device, label })
    }))
  }
  // The phone this computer sent its identity to, before the two have met.
  if (pairedMobile && !devices.some((device) => device.type === 'phone')) {
    const since = pairedMobile.pairedAt ? new Date(pairedMobile.pairedAt).toLocaleDateString() : ''
    list.appendChild(deviceRow({
      icon: '#i-phone',
      title: 'Phone',
      description: since ? `Linked on ${since}. Not connected yet.` : 'Not connected yet.',
      onClick: () => showDevice({ type: 'phone', label: 'Phone', pairedOnly: true, description: since ? `Linked on ${since}. Not connected yet` : 'Not connected yet' })
    }))
  }
  if (list.childElementCount === 0) {
    list.appendChild(deviceRow({
      icon: '#i-display',
      title: 'No other device yet',
      description: 'Your phone and other computers show here once the latest PeerSky is open on them and both are online.'
    }))
  }
}

function showDevice (device) {
  shownDevice = device
  $('ld-device-title').textContent = device.label
  const status = device.pairedOnly ? device.description : describeDevice(device)
  $('ld-device-details').textContent = device.pairedOnly
    ? `${status}. It has this computer's identity.`
    : `${status}. Its private files show in Hyperdrive here, and this computer's show there.`
  const isPhone = device.type === 'phone' && Boolean(pairedMobile)
  $('ld-device-move').hidden = !isPhone
  $('ld-device-phone-note').hidden = !isPhone
  $('ld-device-forget').hidden = Boolean(device.pairedOnly)
  $('ld-device').showModal()
}

$('ld-device-ok').addEventListener('click', () => $('ld-device').close())

$('ld-device-forget').addEventListener('click', async () => {
  const device = shownDevice
  $('ld-device').close()
  if (!device?.id) return
  const result = await api.forgetDevice(device.id).catch((error) => ({ success: false, error: error.message }))
  if (!result?.success) showStatus(`Could not remove it: ${result?.error || 'unknown error'}`, 'error')
  await loadDevices()
})

// The old phone is not asked to confirm. It is usually broken, sold or
// already wiped by the time someone moves, so waiting on it would fail
// exactly when it is needed.
$('ld-device-move').addEventListener('click', async () => {
  $('ld-device').close()
  try {
    const result = await api.forgetPairedMobile()
    if (!result?.success) throw new Error(result?.error || 'Could not release the phone')
    await loadDevices()
    showStatus('This computer can send to a new phone now. Open Sync with another device and choose Send from here.', 'success')
  } catch (error) {
    showStatus(error.message, 'error')
  }
})

// Private files, which a transfer and a backup may leave out

let privateCount = null
let privateError = null

function updatePrivateSummaries () {
  for (const [checkbox, details] of [[$('ld-send-private'), $('ld-send-private-list')], [$('ld-backup-private'), $('ld-backup-private-list')]]) {
    const relevant = privateError !== null || privateCount > 0
    details.hidden = !relevant
    if (!relevant) continue
    details.dataset.excluded = String(!checkbox.checked)
    const noun = privateCount === 1 ? 'private file' : 'private files'
    details.querySelector('summary').textContent = privateError ||
      (checkbox.checked ? `${privateCount} ${noun} included.` : `${privateCount} ${noun} left out.`)
  }
}

async function loadPrivateFiles () {
  if (!api) return
  let items = []
  try {
    const response = await api.listPrivateHyperdrives()
    if (!response.success) throw new Error(response.error)
    items = Array.isArray(response.items) ? response.items : []
    privateCount = items.length
    privateError = null
  } catch (error) {
    privateCount = null
    privateError = `Could not list private files: ${error.message}`
  }
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
      list.appendChild(row)
    }
  }
  updatePrivateSummaries()
}

$('ld-send-private').addEventListener('change', updatePrivateSummaries)
$('ld-backup-private').addEventListener('change', updatePrivateSummaries)

// Sync with another device

const sync = {
  direction: 'receive',
  pairing: null, // { code, expiresAt }
  pairingRenewed: false,
  target: '', // the other device's pairing code, to send to
  sending: null, // { address, code, expiresAt, toPhone }
  incoming: null, // what came in, checked, waiting for a yes
  working: false,
  receiveEnded: false,
  sendEnded: false
}

function setSyncError (message) {
  $('ld-sync-error').textContent = message || ''
}

function show (id, visible) {
  $(id).hidden = !visible
}

function renderSync () {
  const choosing = !sync.working && !sync.incoming && !sync.sending
  show('ld-sync-working', sync.working)
  show('ld-sync-confirm', !sync.working && Boolean(sync.incoming))
  show('ld-sync-sending', !sync.working && !sync.incoming && Boolean(sync.sending))
  show('ld-sync-choose', choosing)
  $('ld-sync-close').disabled = sync.working

  const receiving = sync.direction === 'receive'
  $('ld-tab-receive').setAttribute('aria-selected', String(receiving))
  $('ld-tab-send').setAttribute('aria-selected', String(!receiving))
  show('ld-receive', receiving)
  show('ld-send', !receiving)
  show('ld-receive-ended', receiving && sync.receiveEnded)
  show('ld-send-ended', !receiving && sync.sendEnded)

  const hasTarget = !receiving && Boolean(sync.target)
  show('ld-send-target', hasTarget)
  show('ld-send-input', !receiving && !hasTarget)
  show('ld-code-buttons', !hasTarget)
  show('ld-send-buttons', hasTarget)
  show('ld-send-file-note', hasTarget)
  $('ld-paste').textContent = receiving ? 'Paste link' : 'Paste code'
  if (hasTarget) {
    const toPhone = deviceTypeOf(sync.target) === 'mobile'
    $('ld-send-target-text').textContent = toPhone ? 'Sending to a phone' : 'Sending to another computer'
    $('ld-send-target-icon').firstElementChild.setAttribute('href', toPhone ? '#i-phone' : '#i-display')
  }
  renderLives()
}

function renderLives () {
  const now = Date.now()
  if (sync.pairing) {
    $('ld-pairing-life').textContent = `This code works for ${plural(minutesLeft(sync.pairing.expiresAt - now), 'more minute')}.`
  }
  show('ld-pairing-renewed', sync.pairingRenewed)
  if (sync.sending) {
    $('ld-sending-life').textContent = `The link works for ${plural(minutesLeft(sync.sending.expiresAt - now), 'more minute')}.`
  }
}

async function loadPairing (renewed = false) {
  if (!api) return
  $('ld-pairing-copy').disabled = true
  try {
    const res = await api.getDeviceInfo()
    if (!res.success) throw new Error(res.error)
    sync.pairing = { code: res.pairingPayload, expiresAt: Date.now() + PAIRING_LIFE_MS }
    sync.pairingRenewed = renewed
    $('ld-pairing-qr').setAttribute('src', res.pairingPayload)
    $('ld-pairing-qr').hidden = false
    $('ld-pairing-loading').hidden = true
    $('ld-pairing-copy').disabled = false
  } catch (error) {
    sync.pairing = null
    $('ld-pairing-loading').textContent = `Could not make a code: ${error.message}`
  }
  renderLives()
}

function deviceTypeOf (code) {
  try {
    return new URLSearchParams(String(code).split('?')[1] || '').get('deviceType') || ''
  } catch {
    return ''
  }
}

function setDirection (direction) {
  if (sync.direction !== direction) setSyncError('')
  sync.direction = direction
  renderSync()
}

$('ld-tab-receive').addEventListener('click', () => setDirection('receive'))
$('ld-tab-send').addEventListener('click', () => setDirection('send'))

// A code or link from Paste, the camera or the fields, whichever tab it was
// given in: a pairing code is something to send to, a link something to get.
function takeCode (text) {
  const value = String(text || '').trim()
  setSyncError('')
  if (!value) return
  if (value.toLowerCase().startsWith('peersky-identity:')) {
    if (sync.pairing && value === sync.pairing.code) {
      setSyncError('That is this computer\'s own code. Scan it with the other device instead.')
      return
    }
    sync.target = value
    sync.sendEnded = false
    $('ld-send-input').value = ''
    setDirection('send')
    return
  }
  if (/^hyper:\/\//i.test(value)) {
    $('ld-receive-input').value = ''
    setDirection('receive')
    receive(value)
    return
  }
  setSyncError('That is not a PeerSky code or link.')
}

for (const input of [$('ld-receive-input'), $('ld-send-input')]) {
  input.addEventListener('paste', () => setTimeout(() => takeCode(input.value), 0))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') takeCode(input.value)
  })
}

$('ld-paste').addEventListener('click', async () => {
  const res = await api.readCode().catch(() => null)
  if (!res?.text) {
    setSyncError(sync.direction === 'receive'
      ? 'There is no PeerSky link on the clipboard. Copy the link the other device shows, then try again.'
      : 'There is no PeerSky code on the clipboard. Copy the code the other device shows, then try again.')
    return
  }
  takeCode(res.text)
})

$('ld-send-target-clear').addEventListener('click', () => {
  sync.target = ''
  renderSync()
})

$('ld-pairing-copy').addEventListener('click', () => copyFrom($('ld-pairing-copy'), sync.pairing?.code, 'Code copied'))
$('ld-sending-copy').addEventListener('click', () => copyFrom($('ld-sending-copy'), sync.sending?.address, 'Link copied'))

// The camera. A desktop's webcam is fiddly, so pasting is offered beside it.
let scannerStream = null
let scannerFrame = null

function stopScanner () {
  if (scannerFrame) cancelAnimationFrame(scannerFrame)
  scannerFrame = null
  if (scannerStream) scannerStream.getTracks().forEach((track) => track.stop())
  scannerStream = null
  $('ld-scanner').hidden = true
}

$('ld-scanner-cancel').addEventListener('click', stopScanner)

$('ld-scan').addEventListener('click', async () => {
  setSyncError('')
  if (!navigator.mediaDevices?.getUserMedia) {
    setSyncError('This computer has no camera PeerSky can use. Paste the code instead.')
    return
  }
  stopScanner()
  const video = $('ld-scanner-video')
  try {
    scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    video.srcObject = scannerStream
    await video.play()
    $('ld-scanner').hidden = false
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const tick = () => {
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const image = context.getImageData(0, 0, canvas.width, canvas.height)
        const found = window.jsQR?.(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })
        const text = found?.data?.trim() || ''
        if (/^(peersky-identity:|hyper:\/\/)/i.test(text)) {
          stopScanner()
          takeCode(text)
          return
        }
      }
      scannerFrame = requestAnimationFrame(tick)
    }
    scannerFrame = requestAnimationFrame(tick)
  } catch (error) {
    stopScanner()
    setSyncError(`The camera did not open: ${error.message}`)
  }
})

// Receive here: get the link, show its code, and apply it on a yes.

function startWorking (title) {
  sync.working = true
  $('ld-sync-working-title').textContent = title
  $('ld-sync-working-detail').textContent = ''
  $('ld-sync-working-bar').removeAttribute('value')
  renderSync()
}

function stopWorking () {
  sync.working = false
  renderSync()
}

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
  let text = list ? `${list} from your phone will be added here, skipping any already here.` : ''
  text = text.charAt(0).toUpperCase() + text.slice(1)
  // PeerChat takes the phone's name. Everything else here is kept.
  text += res.chatName ? ` PeerChat here takes your phone's name, ${res.chatName}.` : ' Nothing here is replaced.'
  if (res.tabs) text += ' The tabs open asleep in a group called Phone.'
  return text.trim()
}

async function receive (address) {
  if (!api) return
  if (sync.incoming) api.discardRestore(sync.incoming.stageId).catch(() => {})
  sync.incoming = null
  sync.receiveEnded = false
  startWorking('Getting your data')
  try {
    const res = await api.fetchRestore(address)
    if (!res.success) throw new Error(res.error)
    sync.incoming = res
    showIncoming(res)
  } catch (error) {
    setSyncError(`It did not come through: ${error.message}`)
  } finally {
    stopWorking()
  }
}

function showIncoming (res) {
  const code = res.verificationCode || ''
  $('ld-confirm-code').textContent = code
  show('ld-confirm-code-box', Boolean(code))
  $('ld-confirm-passphrase').value = ''
  show('ld-confirm-passphrase-field', res.kind === 'backup' && Boolean(res.encrypted))
  if (res.kind === 'phone') {
    $('ld-confirm-title').textContent = 'Does your phone show this code?'
    $('ld-confirm-details').textContent = describePhoneSync(res)
    $('ld-confirm-apply').textContent = 'It matches'
  } else if (res.kind === 'transfer') {
    $('ld-confirm-title').textContent = 'Does the other device show this code?'
    $('ld-confirm-details').textContent = 'Everything from the other computer will replace what is on this one: tabs, identity, PeerChat and P2P data. PeerSky restarts to finish.'
    $('ld-confirm-apply').textContent = 'It matches'
  } else {
    $('ld-confirm-title').textContent = 'Restore this backup?'
    $('ld-confirm-details').textContent = 'Everything from the backup will replace what is on this computer: tabs, identity, PeerChat and P2P data. PeerSky restarts to finish.'
    $('ld-confirm-apply').textContent = 'Restore'
  }
}

$('ld-confirm-cancel').addEventListener('click', () => {
  if (sync.incoming) api.discardRestore(sync.incoming.stageId).catch(() => {})
  sync.incoming = null
  renderSync()
})

$('ld-confirm-apply').addEventListener('click', async () => {
  const current = sync.incoming
  if (!api || !current) return
  let passphrase
  if (current.kind === 'backup' && current.encrypted) {
    passphrase = $('ld-confirm-passphrase').value
    if (!passphrase) {
      $('ld-confirm-passphrase').focus()
      return
    }
  }
  sync.incoming = null
  startWorking(current.kind === 'phone' ? 'Adding to this computer' : 'Restoring')
  try {
    const res = await api.applyRestore(current.stageId, passphrase)
    if (!res.success) throw new Error(res.error)
    // The code that was shown is used up. The next visit shows a new one.
    sync.pairing = null
    if (res.requiresRestart) {
      $('ld-sync').close()
      askRestart()
      return
    }
    $('ld-sync').close()
    const list = listPhoneSync(res.added || {})
    showStatus(list ? `Added ${list} from your phone.` : 'Everything the phone sent was already here.', 'success')
  } catch (error) {
    setSyncError(`The restore did not go through: ${error.message}`)
  } finally {
    stopWorking()
  }
})

// Send from here: pack this computer up for the other device's code.

async function send ({ toFile = false } = {}) {
  if (!api || !sync.target) return
  const includePrivate = $('ld-send-private').checked
  setSyncError('')
  if (toFile) {
    try {
      const res = await api.createIdentityTransfer(sync.target, includePrivate)
      if (res.canceled) return
      if (!res.success) throw new Error(res.error)
      $('ld-sync').close()
      showStatus(`Saved for the other device (${formatBytes(res.bytes)}): ${res.filePath}\n\nOpen it there with Restore from a backup file. It works for 10 minutes.`, 'success')
      await loadDevices()
    } catch (error) {
      setSyncError(`Could not save it: ${error.message}`)
    }
    return
  }
  startWorking('Packing up your data')
  try {
    const res = await api.uploadIdentityTransferHyper(sync.target, includePrivate)
    if (!res.success) throw new Error(res.error)
    sync.sending = {
      address: res.address,
      code: res.verificationCode,
      expiresAt: res.manifest?.identityTransfer?.expiresAt || Date.now() + 10 * 60 * 1000,
      toPhone: deviceTypeOf(sync.target) === 'mobile'
    }
    sync.target = ''
    $('ld-sending-qr').setAttribute('src', res.address)
    $('ld-sending-code').textContent = res.verificationCode || ''
    $('ld-sending-text').textContent = sync.sending.toPhone
      ? 'On the phone, under Receive here, tap Scan code and point it here.'
      : 'On the other computer, under Receive here, paste this link or scan it.'
    loadDevices().catch(() => {})
  } catch (error) {
    setSyncError(`Could not send: ${error.message}`)
  } finally {
    stopWorking()
  }
}

$('ld-send-go').addEventListener('click', () => send())
$('ld-send-file').addEventListener('click', () => send({ toFile: true }))

$('ld-sending-stop').addEventListener('click', async () => {
  const current = sync.sending
  sync.sending = null
  renderSync()
  if (current) await api.stopSending(current.address).catch(() => {})
})

// Opening and closing

$('ld-sync-open').addEventListener('click', () => {
  hideStatus()
  setSyncError('')
  if (!sync.pairing || Date.now() > sync.pairing.expiresAt) {
    $('ld-pairing-qr').hidden = true
    $('ld-pairing-loading').hidden = false
    $('ld-pairing-loading').textContent = 'Loading...'
    loadPairing().catch(() => {})
  }
  renderSync()
  $('ld-sync').showModal()
})

function closeSync () {
  if (sync.working) return
  stopScanner()
  // What came in and was not taken is dropped, so it is not kept decrypted.
  if (sync.incoming) api.discardRestore(sync.incoming.stageId).catch(() => {})
  sync.incoming = null
  $('ld-sync').close()
}

$('ld-sync-close').addEventListener('click', closeSync)
$('ld-sync').addEventListener('cancel', (event) => {
  event.preventDefault()
  closeSync()
})

// Codes and links run out. A pairing code is replaced; a link that ran out
// is said to have, as on the phone.
setInterval(() => {
  const now = Date.now()
  if ($('ld-sync').open && sync.pairing && now > sync.pairing.expiresAt) loadPairing(true).catch(() => {})
  if (sync.sending && now > sync.sending.expiresAt) {
    sync.sending = null
    sync.sendEnded = true
    sync.direction = 'send'
    renderSync()
  }
  renderLives()
}, 15 * 1000)

if (api && typeof api.onProgress === 'function') {
  api.onProgress((data) => {
    const inDialog = sync.working
    const bar = inDialog ? $('ld-sync-working-bar') : $('ld-progress-bar')
    const label = inDialog ? $('ld-sync-working-detail') : $('ld-progress-label')
    if ((data.phase === 'create' || data.phase === 'restore') && data.totalBytes) {
      const pct = Math.min(100, Math.round((data.processedBytes / data.totalBytes) * 100))
      bar.value = pct
      label.textContent = data.phase === 'create' ? `Packing up... ${pct}%` : `Unpacking... ${pct}%`
    } else if (data.phase === 'fetch' && data.message) {
      bar.removeAttribute('value')
      label.textContent = data.message
    }
  })
}

// Save a backup file

$('ld-backup-open').addEventListener('click', () => {
  hideStatus()
  $('ld-backup-passphrase').value = ''
  $('ld-backup-confirm').value = ''
  $('ld-backup-show').checked = false
  $('ld-backup-passphrase').type = 'password'
  $('ld-backup-confirm').type = 'password'
  $('ld-backup-error').textContent = ''
  updatePrivateSummaries()
  $('ld-backup').showModal()
  $('ld-backup-passphrase').focus()
})

$('ld-backup-close').addEventListener('click', () => $('ld-backup').close())

$('ld-backup-show').addEventListener('change', () => {
  const type = $('ld-backup-show').checked ? 'text' : 'password'
  $('ld-backup-passphrase').type = type
  $('ld-backup-confirm').type = type
})

$('ld-backup-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const passphrase = $('ld-backup-passphrase').value
  if (passphrase.length < 12) {
    $('ld-backup-error').textContent = 'Use at least 12 characters.'
    return
  }
  if (passphrase !== $('ld-backup-confirm').value) {
    $('ld-backup-error').textContent = 'The two passphrases are not the same.'
    return
  }
  const includePrivate = $('ld-backup-private').checked
  $('ld-backup').close()
  $('ld-backup-passphrase').value = ''
  $('ld-backup-confirm').value = ''
  for (const id of ['ld-backup-open', 'ld-restore-open']) $(id).disabled = true
  showProgress('Packing up your data')
  try {
    const res = await api.create(passphrase, includePrivate)
    if (res.canceled) return
    if (!res.success) throw new Error(res.error)
    showStatus(`Your backup is ready (${formatBytes(res.bytes)}): ${res.filePath}\n\nKeep it somewhere that is not this computer, and keep the passphrase with it. PeerSky cannot open the file without it.`, 'success')
  } catch (error) {
    showStatus(`Could not make the backup: ${error.message}`, 'error')
  } finally {
    hideProgress()
    for (const id of ['ld-backup-open', 'ld-restore-open']) $(id).disabled = false
  }
})

// Restore from a backup file

let chosenBackup = null

$('ld-restore-open').addEventListener('click', async () => {
  if (!api) return
  hideStatus()
  const res = await api.validate().catch((error) => ({ success: false, error: error.message }))
  if (res.canceled) return
  if (!res.success) {
    showStatus(`That file is not a PeerSky backup: ${res.error}`, 'error')
    return
  }
  chosenBackup = res
  const manifest = res.manifest || {}
  const made = manifest.createdAt ? new Date(manifest.createdAt).toLocaleString() : ''
  const encrypted = manifest.kind === 'peersky-encrypted-backup'
  $('ld-restore-details').textContent =
    (made ? `Made ${made}${manifest.peerskyVersion ? ` with PeerSky ${manifest.peerskyVersion}` : ''}. ` : '') +
    'Everything from the backup will replace what is on this computer: tabs, identity, PeerChat and P2P data. PeerSky restarts to finish.'
  $('ld-restore-passphrase').value = ''
  show('ld-restore-passphrase-field', encrypted)
  $('ld-restore-error').textContent = ''
  $('ld-restore').showModal()
  if (encrypted) $('ld-restore-passphrase').focus()
})

$('ld-restore-cancel').addEventListener('click', () => {
  chosenBackup = null
  $('ld-restore').close()
})

$('ld-restore-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!chosenBackup) return
  const encrypted = chosenBackup.manifest?.kind === 'peersky-encrypted-backup'
  const passphrase = encrypted ? $('ld-restore-passphrase').value : undefined
  if (encrypted && !passphrase) {
    $('ld-restore-error').textContent = 'Enter the passphrase for this backup.'
    return
  }
  $('ld-restore-go').disabled = true
  $('ld-restore-cancel').disabled = true
  $('ld-restore-error').textContent = ''
  showProgress('Unpacking your backup')
  try {
    const res = await api.restore(chosenBackup.zipPath, passphrase)
    if (!res.success) throw new Error(res.error)
    chosenBackup = null
    $('ld-restore').close()
    askRestart()
  } catch (error) {
    $('ld-restore-error').textContent = `Could not open the backup: ${error.message}`
  } finally {
    hideProgress()
    $('ld-restore-go').disabled = false
    $('ld-restore-cancel').disabled = false
  }
})

// After a restore the data on disk is new, and what runs is not: PeerSky
// starts again before anything else happens.
function askRestart () {
  $('ld-restart').showModal()
}

$('ld-restart').addEventListener('cancel', (event) => event.preventDefault())
$('ld-restart-go').addEventListener('click', () => api.relaunch())

// Leaving the page drops anything still waiting, so it is not kept decrypted.
window.addEventListener('pagehide', () => {
  if (sync.incoming) api?.discardRestore(sync.incoming.stageId).catch(() => {})
})

loadDevices().catch(() => {})
loadPrivateFiles().catch(() => {})
// Online and last seen change while the page is open.
setInterval(() => {
  if (!document.hidden) loadDevices().catch(() => {})
}, 15 * 1000)
