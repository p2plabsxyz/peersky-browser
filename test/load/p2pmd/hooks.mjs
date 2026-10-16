// Module hooks for running the desktop P2PMD host under plain Node.
// hs-handler.js imports electron and holesail, and both come from stubs here,
// so nothing starts Electron or reaches the network. Modules that could reach
// the network are refused, in case the host ever imports one of them.
const STUBS = {
  electron: new URL('./electron-stub.mjs', import.meta.url).href,
  holesail: new URL('./holesail-stub.mjs', import.meta.url).href
}
const REFUSED = new Set(['hyperdht', 'hyperswarm', 'hyper-sdk', 'udx-native', 'holesail-server', 'holesail-client'])

export async function resolve (specifier, context, nextResolve) {
  if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true }
  if (REFUSED.has(specifier)) throw new Error(`The P2PMD load test does not load ${specifier}, so nothing reaches the network.`)
  return nextResolve(specifier, context)
}
