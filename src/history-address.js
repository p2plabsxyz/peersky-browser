// peersky://history answers with a redirect to the History extension's page.
// Chromium does not follow a page's redirect into an extension, so typing the
// address or clicking a link to it left the tab where it was, with the address
// bar showing peersky://history. The browser follows it itself instead.
const HISTORY_ADDRESS = /^peersky:\/\/history\/?$/i
const EXTENSION_VIEW = /^chrome-extension:\/\/[a-p]{32}\/view\.html$/

export function isHistoryRedirect (from, to) {
  return HISTORY_ADDRESS.test(String(from || '')) && EXTENSION_VIEW.test(String(to || ''))
}

export function followHistoryRedirect (wc) {
  let started = ''
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) started = details.url
  })
  wc.on('will-redirect', (details) => {
    if (!details.isMainFrame || !isHistoryRedirect(started, details.url)) return
    details.preventDefault()
    wc.loadURL(details.url).catch(() => {})
  })
}
