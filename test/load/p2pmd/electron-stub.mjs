// What hs-handler.js takes from Electron, for running it under plain Node.
// Every app data path is the load test's temp folder, which run.mjs removes at
// the end, so the real PeerSky data folder is never touched.
import { fileURLToPath } from 'node:url'

const dataDir = process.env.P2PMD_LOAD_DIR
if (!dataDir) throw new Error('P2PMD_LOAD_DIR is not set. Start the load test with run.mjs.')

export const app = {
  getAppPath: () => fileURLToPath(new URL('../../../', import.meta.url)),
  getPath: () => dataDir
}

// As in test/p2p/hs-handler.test.js: no keychain, so a room's seed is saved as it is.
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value) => Buffer.from(String(value)),
  decryptString: (buffer) => Buffer.from(buffer).toString()
}

export default { app, safeStorage }
