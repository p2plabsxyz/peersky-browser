import crypto from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { pipeline } from 'stream/promises'

export async function encryptFile (inputPath, outputPath, key, iv) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  await pipeline(createReadStream(inputPath), cipher, createWriteStream(outputPath))
  return cipher.getAuthTag()
}

export async function decryptFile (inputPath, outputPath, key, iv, authTag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  await pipeline(createReadStream(inputPath), decipher, createWriteStream(outputPath))
}

export function deriveScryptKey (passphrase, salt, options = {}) {
  const N = options.N || 32768
  const r = options.r || 8
  const p = options.p || 1
  return new Promise((resolve, reject) => {
    crypto.scrypt(passphrase, salt, 32, {
      N,
      r,
      p,
      maxmem: 128 * 1024 * 1024
    }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}
