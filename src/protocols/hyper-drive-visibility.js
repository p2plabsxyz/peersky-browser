export const HYPERDRIVE_PUBLIC_DRIVE_NAME = 'hyperdrive-public'
export const HYPERDRIVE_PRIVATE_DRIVE_NAME = 'hyperdrive-private'

export function resolveHyperdriveUploadTarget (visibility) {
  if (visibility === 'public') {
    return { driveName: HYPERDRIVE_PUBLIC_DRIVE_NAME, autoJoin: true }
  }
  if (visibility === 'private') {
    return { driveName: HYPERDRIVE_PRIVATE_DRIVE_NAME, autoJoin: false }
  }
  return null
}

export async function getExistingNamedDrive (runtime, { driveName, autoJoin = false }) {
  const namespace = runtime.namespace(driveName)
  const discoveryKey = await namespace.storage.getAlias({
    name: 'db',
    namespace: namespace.ns
  })
  if (!discoveryKey || !await namespace.storage.hasCore(discoveryKey)) return null
  return runtime.getDrive(driveName, { autoJoin })
}
