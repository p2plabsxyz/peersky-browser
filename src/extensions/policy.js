import { promises as fs } from "fs";
import path from "path";

const DEFAULT_POLICY = {
  manifest: {
    requireMV3: true
  },
  files: {
    blockedExtensions: [
      ".exe", ".dll", ".dylib", ".so", ".bat", ".cmd", ".ps1", ".vbs", ".jar", ".pkg", ".dmg", ".bin", ".msi"
    ],
    blockedPatterns: [
      // Strings or regex patterns serialized as strings; only simple substring tests used here
      "node_modules/.bin/"
    ],
    allowBasenames: [
      "license", "licence", "copying", "notice", "readme", "changes", "changelog", "authors"
    ],
    warnUnknownExtensions: true,
    allowedExtensions: [
      ".js", ".mjs", ".json", ".html", ".css", ".map",
      ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".avif", ".bmp",
      ".woff", ".woff2", ".ttf", ".otf", ".eot", ".ico",
      ".md", ".txt", ".license", ".licence", ".wasm"
    ],
    maxFileSizeWarn: 20 * 1024 * 1024,
    maxFileSizeBlock: 60 * 1024 * 1024,
    maxTotalFilesWarn: 10000,
    maxTotalFilesBlock: 50000,
    maxTotalBytesWarn: 200 * 1024 * 1024,
    maxTotalBytesBlock: 750 * 1024 * 1024
  },
  permissions: {
    blocked: [
      "nativeMessaging", "debugger", "desktopCapture", "fileSystem", "fileSystemProvider"
    ],
    dangerous: [
      "<all_urls>", "webRequest", "webRequestBlocking", "proxy", "privacy", "enterprise.platformKeys"
    ]
  },
  behavior: {
    onWarn: "allow", // allow with warnings
    onDangerousPermission: "warn", // or "confirm"
    onBlocked: "deny",
    strictForLocalZips: false
  }
};

export async function loadPolicy(app) {
  try {
    const policyDir = path.join(app.getPath("userData"), "extensions");
    const policyPath = path.join(policyDir, "policy.json");
    const raw = await fs.readFile(policyPath, "utf8");
    const userPolicy = JSON.parse(raw);
    return deepMerge(DEFAULT_POLICY, userPolicy);
  } catch (_) {
    return DEFAULT_POLICY;
  }
}

function isObject(v) { return !!v && typeof v === "object" && !Array.isArray(v); }

function deepMerge(a, b) {
  if (!isObject(b)) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (Array.isArray(v)) out[k] = v.slice();
    else if (isObject(v)) out[k] = deepMerge(a[k] || {}, v);
    else out[k] = v;
  }
  return out;
}

export default DEFAULT_POLICY;

