/**
 * Error Page Handler
 * Dynamically renders network error details from URL parameters.
 */
(function () {
  const params = new URLSearchParams(location.search)

  const errorCode = params.get('code')
  const errorName = params.get('name')
  const errorMsg = params.get('msg')
  const errorUrl = params.get('url')

  // Set document title
  document.title = `${errorName || 'Error'} - Peersky`

  const titleEl = document.getElementById('errorTitle')
  const codeEl = document.getElementById('errorCode')
  const msgEl = document.getElementById('errorMessage')
  const urlEl = document.getElementById('errorUrl')
  const retryBtn = document.getElementById('retryButton')
  const homeBtn = document.getElementById('homeButton')

  // Update DOM safely
  if (titleEl) titleEl.textContent = errorName || 'Connection Error'
  if (msgEl) msgEl.textContent = errorMsg || 'Unable to connect to the server.'
  if (codeEl && errorCode) codeEl.textContent = `Error Code: ${errorCode}`
  if (urlEl && errorUrl) {
    try {
      urlEl.textContent = decodeURIComponent(errorUrl)
    } catch {
      urlEl.textContent = errorUrl
    }
  }

  // Reloading this page would just rebuild the error; retry means the address
  // that failed. The scheme is checked because the parameter arrives in a URL.
  const RETRY_SCHEMES = new Set([
    'http:', 'https:', 'peersky:', 'browser:', 'ipfs:', 'ipns:', 'pubsub:',
    'hyper:', 'hs:', 'web3:', 'bittorrent:', 'bt:', 'magnet:', 'file:'
  ])

  const retryTarget = (() => {
    if (!errorUrl) return null
    try {
      return RETRY_SCHEMES.has(new URL(errorUrl).protocol) ? errorUrl : null
    } catch {
      return null
    }
  })()

  // Button actions
  retryBtn?.addEventListener('click', () => {
    if (retryTarget) window.location.href = retryTarget
    else window.location.reload()
  })
  homeBtn?.addEventListener('click', () => (window.location.href = 'peersky://home'))
})()
