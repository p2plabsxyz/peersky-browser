// Module hooks for running the desktop P2PMD host under plain Node.
// hs-handler.js imports electron and holesail, and both come from stubs here,
// so nothing starts Electron or reaches the internet. Modules that could reach
// it are refused, in case the host ever imports one of them. hyperdht is let
// in: p2pmd-lan.js works out a note's keys with it, which reaches nothing.
// With --lan the host is on the local network, as PeerSky is with no
// internet: hs-handler.js gets its local network instance from lan.mjs in
// place of Hyper's (hyper-handler.js), and hyperswarm, which that needs, is
// let in too.
const LAN = Boolean(process.env.P2PMD_LOAD_LAN)
const STUBS = {
  electron: new URL('./electron-stub.mjs', import.meta.url).href,
  holesail: new URL('./holesail-stub.mjs', import.meta.url).href
}
const LAN_INSTANCE = new URL('./lan.mjs', import.meta.url).href
const REFUSED = new Set(['hyper-sdk', 'holesail-server', 'holesail-client', ...(LAN ? [] : ['hyperswarm'])])

export async function resolve (specifier, context, nextResolve) {
  if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true }
  if (LAN && specifier === './hyper-handler.js' && context.parentURL?.endsWith('/src/protocols/hs-handler.js')) {
    return { url: LAN_INSTANCE, shortCircuit: true }
  }
  if (REFUSED.has(specifier)) throw new Error(`The P2PMD load test does not load ${specifier}, so nothing reaches the internet.`)
  return nextResolve(specifier, context)
}
