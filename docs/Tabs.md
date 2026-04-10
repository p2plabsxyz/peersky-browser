# Tabs (`peersky://settings/tabs`)

## 1. Overview

Peersky's tab system provides a full-featured browser tab experience with support for horizontal and vertical layouts, tab groups, pinning, drag-and-drop reordering, and a **Memory Saver** (tab suspension) feature that reduces RAM usage when tabs are idle.

Tab state — including open tabs, active tab, groups, pinned status, and navigation history — is persisted to `localStorage` under the key `peersky-browser-tabs`, keyed by window ID.

---

## 2. Tab Bar Layout

Tabs can be displayed in two modes, configurable from **Settings → Tabs**:

| Mode | Description |
|------|-------------|
| **Horizontal** (default) | Tab strip runs along the top of the browser |
| **Vertical** | Tab strip runs along the left side (enable via "Enable vertical tabs" toggle) |

The **"Keep tabs expanded"** toggle keeps each tab full-width in vertical mode, rather than collapsing to just a favicon.

---

## 3. Tab Lifecycle

### Creating Tabs

- **New tab button** (`+`): opens `peersky://home`
- **Keyboard shortcut** / context menus: open a URL directly in a new tab

### Closing Tabs

- Close button (`×`) on the tab
- Context menu → **Close tab**
- Closing the last tab creates a fresh home tab

### Restoring Tabs on Restart

On startup, tabs are restored from `localStorage`. Each tab record includes:
- `id`, `url`, `title`, `protocol`
- `isPinned`, `groupId`
- `isSuspended` — whether the tab was sleeping when the browser closed
- `navigation` — back/forward history snapshot

Active tab, tab counter, and tab group definitions are also restored.

---

## 4. Tab Groups

Tab groups allow you to visually organize related tabs with a shared color border and an optional label.

### Creating a Group

1. Right-click a tab → **Add to group** → **New group**
2. Name the group and choose a color.

### Managing Groups

- Tabs in the same group show a colored top border.
- Groups can be expanded (tabs visible) or collapsed (tabs hidden, showing only the group header).
- Drag tabs between groups or out of a group entirely.

### Persistence

Tab group definitions (id, name, color, expanded state) and each tab's `groupId` are saved to `localStorage` on every state change and on browser close.

---

## 5. Pinned Tabs

- Right-click a tab → **Pin tab** to pin it.
- Pinned tabs:
  - Show only a favicon (no close button, no title in horizontal mode).
  - Are never automatically suspended by Memory Saver.
  - Their pinned state is restored on restart.

---

## 6. Memory Saver

Memory Saver automatically **suspends** (puts to sleep) inactive background tabs to free RAM. It is configured under **Settings → Tabs → Memory Saver**.

### How It Works

1. A background check runs every **60 seconds**.
2. For each non-active, non-pinned, non-suspended tab it checks:
   - **Idle time** — was the tab last active more than 30 minutes ago?
   - **Audibility** — is the tab playing audio/video? If so, skip it.
   - **Exclusion list** — does the tab's URL match any user-configured exclusion pattern? If so, skip it.
3. If all checks pass, the tab is suspended: its navigation history is saved and its webview is destroyed.

### Suspension

When a tab is suspended:
- A `get-tab-navigation` IPC call captures the current back/forward history into `tab.savedNavigation`.
- The webview element is removed from the DOM and deleted from the webview map.
- `tab.isSuspended = true` is set.
- The tab element gains the `sleeping` CSS class (visual indicator).
- Memory freed is proportional to the page complexity of the suspended tab.

### Waking Up

When a user clicks a suspended tab:
- A new webview is created for the tab's URL.
- `restore-navigation-history` is invoked to replay the saved back/forward stack.
- The `sleeping` class is removed.

### Persistence Across Restarts

`isSuspended` and `savedNavigation` are both included in the `localStorage` snapshot saved by `getTabsStateForSaving()`. On restart, `restoreTabs()` detects `tabData.isSuspended === true` and:
- Immediately destroys the webview created by `addTabWithId()` (avoids a wasted page load).
- Sets `tab.isSuspended = true` and `tab.savedNavigation` from the snapshot.
- Re-applies the `sleeping` CSS class.

This means **back/forward history is fully preserved across browser restarts** for suspended tabs.

### Exclusion List

Users can add domain patterns to an exclusion list so those sites are never suspended:
- Plain domain: `youtube.com` — matches `youtube.com` and all subdomains
- Wildcard: `*.google.com` — matches any subdomain of `google.com`
- Full URL prefix: `https://app.example.com/dashboard`

Exclusions are stored in settings under `memorySaverExclusions` and applied synchronously on each Memory Saver check cycle.

### Settings

| Setting key | Type | Default | Description |
|---|---|---|---|
| `memorySaverEnabled` | `boolean` | `false` | Enable/disable Memory Saver globally |
| `memorySaverExclusions` | `string[]` | `[]` | List of domain/URL patterns exempt from suspension |

Changes are applied immediately via an `ipcRenderer` listener on the `memory-saver-changed` event.

---

## 7. Tab Context Menu

Right-clicking any tab opens a context menu with:

| Action | Description |
|--------|-------------|
| Pin / Unpin tab | Toggle pinned state |
| Duplicate tab | Open a copy of the current tab |
| Move to group… | Assign tab to an existing or new group |
| Remove from group | Detach tab from its current group |
| Close tab | Close the tab |
| Close other tabs | Close all tabs except this one |
| Close tabs to the right | Close tabs to the right of this one |

---

## 8. Hover Card

Hovering over a tab for ~800 ms shows a hover card with:
- Tab title and full URL
- Live memory usage (MB) from the main process, or `"Tab is sleeping"` for suspended tabs

---

## 9. File Reference

| File | Purpose |
|------|---------|
| [tab-bar.js](../src/pages/tab-bar.js) | Core tab management (TabBar custom element) |
| [tabs.css](../src/pages/theme/tabs.css) | Tab bar and tab element styling |
| [settings.html](../src/pages/settings.html) | Memory Saver UI (Tabs → Memory Saver subsection) |
| [settings.js](../src/pages/static/js/settings.js) | Memory Saver settings load/save logic |
| [settings-manager.js](../src/settings-manager.js) | `memorySaverEnabled` / `memorySaverExclusions` IPC handlers |
| [main.js](../src/main.js) | `get-tab-navigation`, `restore-navigation-history`, `is-webcontents-audible` IPC handlers |
