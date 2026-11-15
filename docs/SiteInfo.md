# Site info

The shield control in the URL bar opens a panel for the active page: identity, privacy extension status, permissions, and site data. Deeper controls live at `peersky://site-settings?url=…`.

## Panel

- **Identity** — host, connection label, expand for full origin
- **Privacy** — observes preinstalled uBlock Origin and Consent Autodeny (on/off, toolbar badge when present). Not a built-in shields engine.
- **Permissions** — Ask / Allow / Block for managed Electron permissions on navigable origins (`http`/`https` and browser schemes keyed as `scheme://host`). Opaque URLs (`about:`, `blob:`, `data:`) cannot store grants. Session grants from the prompt show as “Allow this session”.
- **Site data** — cookie count and clear for that origin (does not reset permissions)

`clipboard-sanitized-write` is granted silently (Chromium’s usual copy-on-gesture behavior) and is not listed in the panel.

A page reads the same answers before it asks. `navigator.permissions.query()` reads `prompt` for location, notifications, camera, microphone and MIDI while the site is on Ask, `granted` once allowed and `denied` once blocked, and `Notification.permission` reads `default`, `granted` or `denied` the same way. Electron’s permission check can only say yes or no, so every site nobody had answered read `denied`, and a site that looks before it asks never asked. The preload (`src/pages/unified-preload.js`) reads the answer from the main process over `page-permission-answer` (`savedAnswerFor` in `src/permissions.js`), in a page’s top frame. A page that could not have the permission anyway keeps `denied`: one that is not secure, or one whose Permissions-Policy turns the feature off.

## Pages and IPC

| Surface | Notes |
|---------|--------|
| URL-bar popup | `src/pages/static/js/site-info-popup.js` |
| Full page | `peersky://site-settings` |
| Main process | `src/site-info-ipc.js`, `src/permissions.js` |

IPC channels: `site-info-get`, `site-info-set-permission`, `site-info-reset-permissions`, `site-info-clear-data`.
