import { parentPort, workerData } from 'worker_threads'
import { createBackupZip, extractBackupZip } from './backup-core.js'

// Worker entry: runs heavy zip/extract IO off the main process event loop.
// workerData: { op, ...args }. Progress and result are posted to parentPort.
async function run () {
  const { op } = workerData

  if (op === 'create') {
    const { userDataDir, outPath, peerskyVersion } = workerData
    const result = await createBackupZip(userDataDir, outPath, {
      peerskyVersion,
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
