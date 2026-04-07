const builtInP2PApps = [
  { id: "ai-chat", name: "AI Chat", icon: "robot.svg", url: "peersky://p2p/ai-chat/" },
  { id: "chat", name: "Chat", icon: "chat.svg", url: "peersky://p2p/peerchat/" },
  { id: "editor", name: "Editor", icon: "file-code.svg", url: "peersky://p2p/peerpad/" },
  { id: "p2pmd", name: "P2P Markdown", icon: "markdown.svg", url: "peersky://p2p/p2pmd/" },
  { id: "reader", name: "Social Reader", icon: "people.svg", url: "https://reader.distributed.press/" },
  { id: "upload", name: "Upload", icon: "file-upload.svg", url: "peersky://p2p/upload/" },
  { id: "wiki", name: "Wiki", icon: "wikipedia.svg", url: "peersky://p2p/wiki/" }
];

const defaultPinnedBuiltInIds = builtInP2PApps.filter((a) => a.id !== "reader").map((a) => a.id);
const defaultIconUrl = "peersky://static/assets/svg/default-extension-icon.svg";

const normalizeBuiltInApp = (app) => ({
  ...app,
  source: "built-in",
  iconUrl: `peersky://static/assets/svg/${app.icon}`
});

const normalizeUserApp = (app) => {
  if (!app || typeof app !== "object") return null;
  if (typeof app.id !== "string" || !app.id) return null;
  if (typeof app.name !== "string" || !app.name) return null;
  if (typeof app.url !== "string" || !app.url) return null;
  return {
    id: app.id,
    name: app.name,
    url: app.url,
    source: "user",
    iconUrl: typeof app.iconUrl === "string" && app.iconUrl ? app.iconUrl : defaultIconUrl
  };
};

export const getBuiltInApps = () => builtInP2PApps.map(normalizeBuiltInApp);

export const getUserApps = async () => {
  try {
    const result = await window.electronAPI?.p2pApps?.list?.();
    if (!result?.success || !Array.isArray(result.apps)) return [];
    return result.apps.map(normalizeUserApp).filter(Boolean);
  } catch (e) {
    console.warn("Failed to load user P2P apps", e);
    return [];
  }
};

export const getAllApps = async () => {
  const builtIn = getBuiltInApps();
  const userApps = await getUserApps();
  const seen = new Set(builtIn.map((a) => a.id));
  const uniqueUser = userApps.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  return [...builtIn, ...uniqueUser];
};

/**
 * Get pinned app IDs from settings via IPC.
 * @returns {Promise<string[]>} Returns an array of pinned app IDs. Returns all app IDs if none are explicitly pinned.
 */
export const getPinnedApps = async () => {
  try {
    const stored = await window.electronAPI.settings.get('pinnedP2PApps');
    // A stored value of null means all apps are pinned by default except Social Reader
    if (stored === null || stored === undefined) return defaultPinnedBuiltInIds;
    return stored;
  } catch (e) {
    console.warn("Failed to read pinnedP2PApps from settings", e);
    return defaultPinnedBuiltInIds;
  }
};

export const setPinnedApps = async (pinnedIds) => {
  try {
    await window.electronAPI.settings.set('pinnedP2PApps', pinnedIds);
  } catch (e) {
    console.warn("Failed to write pinnedP2PApps to settings", e);
  }
};

export const isPinned = async (id) => {
  const pinned = await getPinnedApps();
  return pinned.includes(id);
};

export const setPinnedState = async (id, pinned) => {
  let pinnedApps = await getPinnedApps();
  if (pinned) {
    if (!pinnedApps.includes(id)) pinnedApps.push(id);
  } else {
    pinnedApps = pinnedApps.filter(appId => appId !== id);
  }
  await setPinnedApps(pinnedApps);
};

export default builtInP2PApps;
