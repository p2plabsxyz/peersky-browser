# Site info

The shield control in the URL bar opens a panel for the active page: identity, privacy extension status, permissions, and site data. Deeper controls live at `peersky://site-settings?url=…`.

## Panel

- **Identity** — host, connection label, expand for full origin
- **Privacy** — observes preinstalled uBlock Origin and Consent Autodeny (on/off, toolbar badge when present). Not a built-in shields engine.
- **Permissions** — Ask / Allow / Block for managed Electron permissions (`http`/`https` origins only)
- **Site data** — cookie count and clear for that origin (does not reset permissions)

## Pages and IPC

| Surface | Notes |
|---------|--------|
| URL-bar popup | `src/pages/static/js/site-info-popup.js` |
| Full page | `peersky://site-settings` |
| Main process | `src/site-info-ipc.js`, `src/permissions.js` |

IPC channels: `site-info-get`, `site-info-set-permission`, `site-info-reset-permissions`, `site-info-clear-data`, `site-info-get-cookies`.
