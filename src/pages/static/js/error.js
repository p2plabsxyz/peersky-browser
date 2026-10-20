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

  // The tab is named for the site, as in other browsers, not for the error.
  const failedHost = (() => {
    try {
      return new URL(errorUrl).host
    } catch {
      return ''
    }
  })()
  document.title = failedHost || `${errorName || 'Error'} - Peersky`

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
    'hyper:', 'hs:', 'web3:', 'bittorrent:', 'bt:', 'magnet:', 'webtorrent:', 'file:'
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

  // A site that failed for want of a network loads by itself once the network
  // is back, as in other browsers: when the computer comes online, when the
  // tab is shown, and on a timer that slows down. The site is asked first, so
  // a network that is still down does not stack error pages in the history.
  const NETWORK_ERRORS = new Set(['-7', '-15', '-21', '-100', '-101', '-103', '-104', '-105', '-106', '-109', '-118', '-137'])
  const webTarget = (() => {
    try {
      const url = new URL(retryTarget)
      return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
    } catch {
      return null
    }
  })()
  if (!webTarget || !NETWORK_ERRORS.has(errorCode)) return

  const RETRY_DELAYS_MS = [2000, 5000, 10000, 30000, 60000]
  let attempt = 0
  let timer = null
  let checking = false
  let leaving = false

  const siteAnswers = () => fetch(`${webTarget.origin}/`, {
    mode: 'no-cors',
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(10000)
  }).then(() => true, () => false)

  const schedule = () => {
    clearTimeout(timer)
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
    attempt++
    timer = setTimeout(check, delay)
  }

  async function check () {
    if (leaving || checking) return
    if (navigator.onLine === false) return
    checking = true
    const answered = await siteAnswers()
    checking = false
    if (answered && !leaving) {
      leaving = true
      clearTimeout(timer)
      window.location.replace(retryTarget)
      return
    }
    schedule()
  }

  window.addEventListener('online', () => {
    attempt = 0
    clearTimeout(timer)
    // The network says it is up a moment before names resolve again.
    timer = setTimeout(check, 1000)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
  schedule()
})()
