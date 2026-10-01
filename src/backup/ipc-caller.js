// Backup & Restore and onboarding are the only callers of their channels. The
// preload hands those channels to no other page; this check holds even if a
// page ever got hold of one, as the bt-api-token handler does.
export function isPeerskyPage (rawUrl, ...pages) {
  try {
    const { protocol, hostname } = new URL(rawUrl)
    return protocol === 'peersky:' && pages.includes(hostname)
  } catch {
    return false
  }
}

export function assertCaller (event, ...pages) {
  if (!isPeerskyPage(event?.senderFrame?.url, ...pages)) throw new Error('Forbidden')
}
