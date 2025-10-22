import { promises as fs } from "fs";
import path from "path";

async function getCef() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const mod = await import("chrome-extension-fetch");
    return mod;
  } catch (_) {
    return null;
  }
}

/**
 * Check whether a file is a CRX archive by inspecting the magic bytes.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function isCrx(filePath) {
  const fh = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.toString("ascii") === "Cr24";
  } finally {
    await fh.close();
  }
}

/**
 * Parse a CRX buffer and return header info and the embedded zip buffer.
 * Supports CRX v2 and v3 header layouts.
 * @param {Buffer} crxBuf
 * @returns {{ version:number, zipBuffer:Buffer, publicKeyDer?:Buffer }}
 */
export function parseCrxBuffer(crxBuf) {
  if (crxBuf.length < 16) throw new Error("Invalid CRX file: too small");
  const magic = crxBuf.subarray(0, 4).toString("ascii");
  if (magic !== "Cr24") throw new Error("Invalid CRX file: bad magic");
  const version = crxBuf.readUInt32LE(4);

  if (version === 2) {
    // CRX2: [magic(4) version(4) pubKeyLen(4) sigLen(4) pubKey(pubKeyLen) sig(sigLen) zip...]
    const pubKeyLen = crxBuf.readUInt32LE(8);
    const sigLen = crxBuf.readUInt32LE(12);
    const headerLen = 16 + pubKeyLen + sigLen;
    if (crxBuf.length < headerLen) throw new Error("Invalid CRX2: header length exceeds file size");
    const publicKeyDer = crxBuf.subarray(16, 16 + pubKeyLen);
    const zipBuffer = crxBuf.subarray(headerLen);
    return { version, zipBuffer, publicKeyDer };
  }

  if (version === 3) {
    // CRX3: [magic(4) version(4) headerSize(4) header(headerSize) zip...]
    const headerSize = crxBuf.readUInt32LE(8);
    const zipOffset = 12 + headerSize;
    if (crxBuf.length < zipOffset) throw new Error("Invalid CRX3: header size exceeds file size");
    const zipBuffer = crxBuf.subarray(zipOffset);

    // CRX3 header does not contain public key directly here (we may recover later via cef)
    return { version, zipBuffer };
  }

  throw new Error(`Unsupported CRX version: ${version}`);
}

/**
 * Extract a CRX file to destination directory.
 * Uses CRX header parsing to get embedded ZIP, then delegates ZIP extraction.
 * @param {string} filePath
 * @param {string} destDir
 * @param {(zipBuffer:Buffer, dest:string)=>Promise<void>} extractZipBuffer
 * @returns {Promise<{ publicKeyDer?: Buffer }>} metadata
 */
export async function extractCrx(filePath, destDir, extractZipBuffer) {
  const crxBuf = await fs.readFile(filePath);
  const parsed = parseCrxBuffer(crxBuf);
  let publicKeyDer = parsed.publicKeyDer;
  const zipBuffer = parsed.zipBuffer;

  // For CRX3 try to recover public key via chrome-extension-fetch
  if (!publicKeyDer) {
    const cef = await getCef();
    if (cef && typeof cef.parseCrx === "function") {
      try {
        const meta = await cef.parseCrx(crxBuf);
        const pk = meta?.publicKey || meta?.publicKeyDer || null;
        if (pk) publicKeyDer = Buffer.isBuffer(pk) ? pk : Buffer.from(pk, "base64");
      } catch (_) {
        // ignore
      }
    }
  }
  await extractZipBuffer(zipBuffer, destDir);
  return { publicKeyDer };
}

/**
 * Convert a DER public key to base64 string for manifest.key.
 * @param {Buffer} der
 * @returns {string}
 */
export function derToBase64(der) {
  return der.toString("base64");
}
