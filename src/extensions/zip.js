import { promises as fs } from "fs";
import path from "path";

async function getUnzipper() {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const mod = await import("unzipper");
    return mod;
  } catch (_) {
    return null;
  }
}

function ensureInside(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Extract a ZIP file from disk to destination directory with zip-slip prevention.
 * @param {string} zipFilePath
 * @param {string} destDir
 */
export async function extractZipFile(zipFilePath, destDir) {
  const unzipper = await getUnzipper();
  if (!unzipper) throw new Error("Missing dependency 'unzipper'. Please install dependencies.");
  await fs.mkdir(destDir, { recursive: true });

  const directory = await unzipper.Open.file(zipFilePath);
  for (const entry of directory.files) {
    const filePath = path.join(destDir, entry.path);
    if (!ensureInside(destDir, filePath)) {
      throw new Error("ZIP contains illegal path traversal entries");
    }
    if (entry.type === "Directory") {
      await fs.mkdir(filePath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const readStream = entry.stream();
      const chunks = [];
      await new Promise((resolve, reject) => {
        readStream.on("data", (c) => chunks.push(c));
        readStream.on("error", reject);
        readStream.on("end", resolve);
      });
      await fs.writeFile(filePath, Buffer.concat(chunks));
    }
  }
}

/**
 * Extract a ZIP buffer to destination directory with zip-slip prevention.
 * @param {Buffer} zipBuffer
 * @param {string} destDir
 */
export async function extractZipBuffer(zipBuffer, destDir) {
  const unzipper = await getUnzipper();
  if (!unzipper) throw new Error("Missing dependency 'unzipper'. Please install dependencies.");
  await fs.mkdir(destDir, { recursive: true });

  const directory = await unzipper.Open.buffer(zipBuffer);
  for (const entry of directory.files) {
    const filePath = path.join(destDir, entry.path);
    if (!ensureInside(destDir, filePath)) {
      throw new Error("ZIP contains illegal path traversal entries");
    }
    if (entry.type === "Directory") {
      await fs.mkdir(filePath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const readStream = entry.stream();
      const chunks = [];
      await new Promise((resolve, reject) => {
        readStream.on("data", (c) => chunks.push(c));
        readStream.on("error", reject);
        readStream.on("end", resolve);
      });
      await fs.writeFile(filePath, Buffer.concat(chunks));
    }
  }
}
