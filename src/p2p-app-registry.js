import path from "path";
import { app, ipcMain, dialog, net } from "electron";
import { promises as fs } from "fs";

const MAX_ICON_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
const MAX_BUNDLE_FILES = 500;
const ALLOWED_BUNDLE_EXTENSIONS = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".map", ".txt"
]);

function getUserAppsDir() {
  return path.join(app.getPath("userData"), "p2p-user-apps");
}

function getRegistryFilePath() {
  return path.join(getUserAppsDir(), "registry.json");
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function sanitizeId(id) {
  const safe = String(id || "").trim();
  return /^[a-z0-9-]{1,64}$/.test(safe) ? safe : null;
}

function isSafeUserAppUrl(urlObj) {
  const allowed = new Set(["peersky:", "ipfs:", "ipns:", "hyper:", "hs:", "web3:"]);
  return allowed.has(urlObj.protocol);
}

function inferNameFromUrl(urlObj) {
  const pathname = (urlObj.pathname || "").replace(/\/+$/, "");
  const tail = pathname.split("/").filter(Boolean).pop();
  if (tail) {
    return tail
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (urlObj.hostname) {
    return urlObj.hostname
      .replace(/^www\./, "")
      .split(".")[0]
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return "User App";
}

function sanitizeBundlePath(inputPath) {
  const value = String(inputPath || "").replace(/\\/g, "/").trim();
  if (!value || value.startsWith("/") || value.includes("\0")) return null;
  const segments = value.split("/").filter(Boolean);
  if (!segments.length) return null;
  if (segments.some((seg) => seg === "." || seg === "..")) return null;
  return segments.join("/");
}

class P2PAppRegistry {
  constructor() {
    this.registry = [];
  }

  async init() {
    await fs.mkdir(getUserAppsDir(), { recursive: true });
    this.registry = await this.loadRegistry();
  }

  async loadRegistry() {
    try {
      const raw = await fs.readFile(getRegistryFilePath(), "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((entry) => this.normalizeEntry(entry))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") return null;
    const id = sanitizeId(entry.id);
    if (!id) return null;
    if (typeof entry.name !== "string" || !entry.name.trim()) return null;
    if (typeof entry.url !== "string" || !entry.url.trim()) return null;
    try {
      const urlObj = new URL(entry.url);
      if (!isSafeUserAppUrl(urlObj)) return null;
    } catch {
      return null;
    }
    const iconFilename = entry.hasIcon ? "icon.svg" : null;
    return {
      id,
      name: entry.name.trim().slice(0, 80),
      url: entry.url.trim(),
      hasIcon: !!entry.hasIcon,
      iconUrl: iconFilename ? `peersky://user-p2p-apps/${id}/${iconFilename}` : null,
      createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString()
    };
  }

  async saveRegistry() {
    const serializable = this.registry.map((entry) => ({
      id: entry.id,
      name: entry.name,
      url: entry.url,
      hasIcon: !!entry.hasIcon,
      createdAt: entry.createdAt
    }));
    await fs.writeFile(getRegistryFilePath(), JSON.stringify(serializable, null, 2), "utf8");
  }

  getUserApps() {
    return this.registry.map((entry) => ({ ...entry }));
  }

  findById(id) {
    return this.registry.find((entry) => entry.id === id) || null;
  }

  makeUniqueId(base, existingIds) {
    if (!existingIds.has(base)) return base;
    let i = 2;
    while (existingIds.has(`${base}-${i}`) && i < 9999) i += 1;
    return `${base}-${i}`;
  }

  async addFromUrl(rawUrl) {
    let urlObj;
    try {
      urlObj = new URL(String(rawUrl || "").trim());
    } catch {
      throw new Error("Please drop a valid URL");
    }
    if (!isSafeUserAppUrl(urlObj)) {
      throw new Error("This URL scheme is not allowed");
    }
    const normalizedUrl = urlObj.toString();
    const existingByUrl = this.registry.find((entry) => entry.url === normalizedUrl);
    if (existingByUrl) return { ...existingByUrl };

    const inferredName = inferNameFromUrl(urlObj);
    
    // Try to download as a folder first using the custom peersky manifest
    try {
      const manifestUrl = new URL(normalizedUrl);
      manifestUrl.searchParams.set('__peerskyManifest', '1');
      
      const manifestResp = await net.fetch(manifestUrl.toString());
      if (manifestResp.ok) {
        const contentType = manifestResp.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const manifest = await manifestResp.json();
          if (Array.isArray(manifest) && manifest.length > 0) {
            const filesContent = [];
            const requestedPath = manifestUrl.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
            
            for (const fileDesc of manifest) {
              if (fileDesc.type === 'file') {
                const fileUrl = new URL(normalizedUrl);
                // The manifest paths are absolute to the domain/CID root
                fileUrl.pathname = '/' + fileDesc.path;
                
                const fileResp = await net.fetch(fileUrl.toString());
                if (!fileResp.ok) throw new Error(`Failed to fetch ${fileDesc.path}`);
                const arrayBuf = await fileResp.arrayBuffer();
                
                // calculate relative path to map exactly to local root
                let relPath = fileDesc.path;
                if (requestedPath && relPath.startsWith(requestedPath + '/')) {
                  relPath = relPath.slice(requestedPath.length + 1);
                }
                filesContent.push({ path: relPath, data: arrayBuf });
              }
            }
            
            const uniqueId = this.makeUniqueId(slugify(inferredName) || "user-app", new Set(this.registry.map((a) => a.id)));
            const appDir = path.join(getUserAppsDir(), uniqueId, "app");
            await fs.mkdir(appDir, { recursive: true });

            let hasIndexHtml = false;
            for (const file of filesContent) {
              const destination = path.join(appDir, file.path);
              await fs.mkdir(path.dirname(destination), { recursive: true });
              await fs.writeFile(destination, Buffer.from(file.data));
              if (file.path.toLowerCase() === 'index.html') hasIndexHtml = true;
            }

            // Only complete the local folder clone if it has an index.html at root, 
            // otherwise treating it as a standard external application might be better.
            if (hasIndexHtml) {
              const entry = {
                id: uniqueId,
                name: inferredName.slice(0, 80),
                url: `peersky://user-p2p-apps/${uniqueId}/`,
                hasIcon: false,
                iconUrl: null,
                createdAt: new Date().toISOString()
              };
              this.registry.push(entry);
              await this.saveRegistry();
              return { ...entry };
            } else {
              // Revert files since we fall back
              await fs.rm(path.join(getUserAppsDir(), uniqueId), { recursive: true, force: true }).catch(()=>{});
            }
          }
        }
      }
    } catch (e) {
      console.log("Failed to download P2P app as a folder. Falling back to single URL entry. Error:", e);
    }
    
    // Fallback if downloading failed, it's not a folder, or no index.html found.
    const baseId = slugify(inferredName) || "user-app";
    const uniqueId = this.makeUniqueId(baseId, new Set(this.registry.map((a) => a.id)));

    const entry = {
      id: uniqueId,
      name: inferredName.slice(0, 80),
      url: normalizedUrl,
      hasIcon: false,
      iconUrl: null,
      createdAt: new Date().toISOString()
    };
    this.registry.push(entry);
    await this.saveRegistry();
    return { ...entry };
  }

  async uploadIcon(payload) {
    const appId = sanitizeId(payload?.appId);
    if (!appId) throw new Error("Invalid app id");
    const name = String(payload?.name || "").toLowerCase();
    if (!name.endsWith(".svg")) {
      throw new Error("Only SVG icons are supported");
    }

    const appEntry = this.findById(appId);
    if (!appEntry) throw new Error("App not found");

    const dataAny = payload?.data;
    const byteLength = Buffer.isBuffer(dataAny)
      ? dataAny.length
      : (typeof dataAny === "object" && dataAny !== null && typeof dataAny.byteLength === "number")
        ? dataAny.byteLength
        : (ArrayBuffer.isView(dataAny) ? dataAny.byteLength : 0);
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
      throw new Error("Invalid icon payload");
    }
    if (byteLength > MAX_ICON_BYTES) {
      throw new Error("Icon exceeds 512KB");
    }

    const iconBuffer = Buffer.isBuffer(dataAny)
      ? dataAny
      : Buffer.from(dataAny instanceof ArrayBuffer ? new Uint8Array(dataAny) : dataAny);
    const sample = iconBuffer.toString("utf8", 0, Math.min(iconBuffer.length, 512)).toLowerCase();
    if (!sample.includes("<svg")) {
      throw new Error("Uploaded file is not a valid SVG");
    }

    const appDir = path.join(getUserAppsDir(), appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "icon.svg"), iconBuffer);

    appEntry.hasIcon = true;
    appEntry.iconUrl = `peersky://user-p2p-apps/${appId}/icon.svg`;
    await this.saveRegistry();
    return { ...appEntry };
  }

  async importFolder(payload) {
    const files = Array.isArray(payload?.files) ? payload.files : [];
    if (!files.length) throw new Error("Folder is empty");
    if (files.length > MAX_BUNDLE_FILES) {
      throw new Error(`Too many files (max ${MAX_BUNDLE_FILES})`);
    }

    const normalizedFiles = [];
    let totalBytes = 0;
    for (const file of files) {
      const relPath = sanitizeBundlePath(file?.path);
      if (!relPath) throw new Error("Folder contains invalid file paths");

      const ext = path.extname(relPath).toLowerCase();
      if (!ALLOWED_BUNDLE_EXTENSIONS.has(ext)) {
        throw new Error(`Unsupported file type in bundle: ${relPath}`);
      }

      const dataAny = file?.data;
      const byteLength = Buffer.isBuffer(dataAny)
        ? dataAny.length
        : (typeof dataAny === "object" && dataAny !== null && typeof dataAny.byteLength === "number")
          ? dataAny.byteLength
          : (ArrayBuffer.isView(dataAny) ? dataAny.byteLength : 0);
      if (!Number.isFinite(byteLength) || byteLength < 0) {
        throw new Error(`Invalid file payload: ${relPath}`);
      }
      totalBytes += byteLength;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error(`Bundle too large (max ${Math.floor(MAX_BUNDLE_BYTES / (1024 * 1024))}MB)`);
      }

      const buffer = Buffer.isBuffer(dataAny)
        ? dataAny
        : Buffer.from(dataAny instanceof ArrayBuffer ? new Uint8Array(dataAny) : dataAny);
      normalizedFiles.push({ relPath, buffer });
    }

    const hasRootIndex = normalizedFiles.some((f) => f.relPath.toLowerCase() === "index.html");
    if (!hasRootIndex) {
      throw new Error("Folder must include index.html at the root");
    }

    const inferredName = String(payload?.name || "").trim() || "Local App";
    const baseId = slugify(inferredName) || "local-app";
    const uniqueId = this.makeUniqueId(baseId, new Set(this.registry.map((a) => a.id)));
    const appDir = path.join(getUserAppsDir(), uniqueId, "app");
    await fs.mkdir(appDir, { recursive: true });

    for (const file of normalizedFiles) {
      const destination = path.join(appDir, file.relPath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, file.buffer);
    }

    const entry = {
      id: uniqueId,
      name: inferredName.slice(0, 80),
      url: `peersky://user-p2p-apps/${uniqueId}/`,
      hasIcon: false,
      iconUrl: null,
      createdAt: new Date().toISOString()
    };
    this.registry.push(entry);
    await this.saveRegistry();
    return { ...entry };
  }

  async importFolderFromPath(folderPath) {
    const stat = await fs.stat(folderPath).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      throw new Error("Dropped item is not a valid folder");
    }

    const folderName = path.basename(folderPath);

    const getFiles = async (dirPath, baseDir) => {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      let fileList = [];
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          fileList = fileList.concat(await getFiles(fullPath, baseDir));
        } else {
          const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
          const data = await fs.readFile(fullPath);
          fileList.push({ path: relPath, data });
        }
      }
      return fileList;
    };

    const files = await getFiles(folderPath, folderPath);
    return await this.importFolder({ name: folderName, files });
  }

  async removeApp(appId) {
    const safeId = sanitizeId(appId);
    if (!safeId) throw new Error("Invalid app id");

    const index = this.registry.findIndex(a => a.id === safeId);
    if (index === -1) throw new Error("App not found");

    this.registry.splice(index, 1);
    await this.saveRegistry();

    const appDir = path.join(getUserAppsDir(), safeId);
    try {
      await fs.rm(appDir, { recursive: true, force: true });
    } catch {
      // Ignore deletion errors gracefully
    }

    return { success: true, id: safeId };
  }

  setupIpc() {
    ipcMain.handle("p2p-user-apps-list", async () => {
      try {
        return { success: true, apps: this.getUserApps() };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("p2p-user-apps-add-from-url", async (_event, rawUrl) => {
      try {
        const entry = await this.addFromUrl(rawUrl);
        return { success: true, app: entry };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("p2p-user-apps-upload-icon", async (_event, payload) => {
      try {
        const entry = await this.uploadIcon(payload);
        return { success: true, app: entry };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("p2p-user-apps-import-folder", async (_event, payload) => {
      try {
        const entry = await this.importFolder(payload);
        return { success: true, app: entry };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("p2p-user-apps-select-folder", async () => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ["openDirectory"]
        });
        if (result.canceled || !result.filePaths.length) {
          return { success: true, canceled: true };
        }

        const imported = await this.importFolderFromPath(result.filePaths[0]);
        return { success: true, app: imported };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("p2p-user-apps-import-drop", async (_event, folderPath) => {
      try {
        const imported = await this.importFolderFromPath(folderPath);
        return { success: true, app: imported };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle("p2p-user-apps-remove", async (_event, appId) => {
      try {
        return await this.removeApp(appId);
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
  }
}

const p2pAppRegistry = new P2PAppRegistry();

export default p2pAppRegistry;
