/**
 * Whether an activation request from the extension system should move the UI.
 *
 * Adding a tab to ECE marks it active and calls the host back to select it. On
 * a session restore every tab registers in turn, so honouring those callbacks
 * walks the selection to the last registered tab and loses the one the user
 * left active. Activation that does not arrive during registration, which is
 * how chrome.tabs.update({ active: true }) reaches us, is still honoured.
 */
export function shouldHonourTabActivation ({ registering, window }) {
  if (registering) return false
  return Boolean(window) && !window.isDestroyed()
}
