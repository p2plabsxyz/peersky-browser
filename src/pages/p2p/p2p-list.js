const p2pApps = [
  { id: "ai-chat", name: "AI Chat", icon: "robot.svg", url: "peersky://p2p/ai-chat/" },
  { id: "chat", name: "Chat", icon: "chat.svg", url: "peersky://p2p/chat/" },
  { id: "editor", name: "Editor", icon: "file-code.svg", url: "peersky://p2p/editor/" },
  { id: "upload", name: "Upload", icon: "file-upload.svg", url: "peersky://p2p/upload/" },
  { id: "wiki", name: "Wiki", icon: "wikipedia.svg", url: "peersky://p2p/wiki/" }
];

/**
 * Get pinned app IDs from settings via IPC.
 * Returns null (meaning all pinned) or an array of IDs.
 */
export const getPinnedApps = async () => {
  try {
    const stored = await window.electronAPI.settings.get('pinnedP2PApps');
    // null means all apps pinned (default)
    if (stored === null || stored === undefined) return p2pApps.map(a => a.id);
    return stored;
  } catch (e) {
    console.warn("Failed to read pinnedP2PApps from settings", e);
    return p2pApps.map(a => a.id);
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

export default p2pApps;
