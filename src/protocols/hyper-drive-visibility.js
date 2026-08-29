export function resolveHyperdriveUploadTarget (visibility, driveName) {
  if (visibility === 'public') {
    return { driveName, autoJoin: true }
  }
  if (visibility === 'private') {
    return { driveName, autoJoin: false }
  }
  return null
}
