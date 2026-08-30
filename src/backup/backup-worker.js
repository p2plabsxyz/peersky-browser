import { parentPort, workerData } from 'worker_threads'
import { extractBackupZip } from './backup-core.js'
import { createEncryptedBackupZip } from './encrypted-backup.js'

// Worker entry: runs heavy zip/extract IO off the main process event loop.
// workerData: { op, ...args }. Progress and result are posted to parentPort.
async function run () {
  const { op } = workerData

  if (op === 'create') {
    const { userDataDir, outPath, peerskyVersion, passphrase, includePrivate } = workerData
    const result = await createEncryptedBackupZip(userDataDir, outPath, {
      peerskyVersion,
      passphrase,
      includePrivate: includePrivate === true,
      onProgress: (data) => parentPort.postMessage({ type: 'progress', data })
    })
    return { filePath: result.filePath, bytes: result.bytes, manifest: result.manifest }
  }

  if (op === 'extract') {
    const { zipPath, destDir } = workerData
    await extractBackupZip(zipPath, destDir)
    return { destDir }
  }

  throw new Error(`Unknown backup worker op: ${op}`)
}

run()
  .then((result) => parentPort.postMessage({ type: 'done', result }))
  .catch((error) => parentPort.postMessage({ type: 'error', message: error.message }))
