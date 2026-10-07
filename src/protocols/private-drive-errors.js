// Reading an encrypted drive without its key: its first block is ciphertext
// rather than a Hyperbee header, and hypercore-fetch answers 500 with the
// decoding error's stack. That, and only that, means the drive is private.
export function isUnreadableDriveError (error) {
  if (error?.code === 'DECODING_ERROR') return true
  const message = String(error?.message || error || '')
  return /decoded message is not valid|decoding[ _]error|invalid header|not a hyperbee/i.test(message)
}

export const PRIVATE_DRIVE_ERROR = 'This drive is private. Only devices linked to the one that made it can open it.'

// What a private drive found this way is listed as here: a linked phone's, or
// another desktop's on the same identity. Read-only on this desktop.
export const LINKED_PRIVATE_DRIVE_NAME = 'Private files from a linked device'
