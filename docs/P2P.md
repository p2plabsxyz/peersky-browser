# P2P Apps

Peersky includes a section of static apps served from the `peersky://p2p/` namespace. These apps are fully local or served via distributed protocols like IPFS, Hypercore, etc. This allows building collaborative and offline-capable tools that do not rely on centralized servers.

## 📄 p2p-list.js

The file [`p2p-list.js`](../src/pages/p2p/p2p-list.js) exports a list of registered P2P app names.

To register a new P2P app:

1. Add the folder for your app inside `./src/pages/p2p/`
2. Update `p2p-list.js` with the new app name (e.g. `"chat"` or `"upload"`)
3. Make sure your app is accessible at `peersky://p2p/your-app-name/`

This list is used by the main P2P apps page to display and link to available apps.

<!-- TODO: Add section about Git submodules for P2P apps -->
