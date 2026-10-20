// peersky://version: fills in System Information from the main process.
(async function () {
  const show = (id, value) => {
    const el = document.getElementById(id)
    if (el) el.textContent = value || 'Unknown'
  }
  show('user-agent', navigator.userAgent)
  let info = {}
  try {
    info = await window.peerskyVersion.systemInfo()
  } catch {}
  show('version', info.version)
  show('os', info.os)
  show('electron', info.electron)
  show('chromium', info.chromium)
  show('node', info.node)
  show('v8', info.v8 && `V8 ${info.v8}`)
  show('exec-path', info.execPath)
  show('profile-path', info.profilePath)
})()
