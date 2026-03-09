# P2P Apps

Peersky includes a section of static apps served from the `peersky://p2p/` namespace. These apps are fully local or served via distributed protocols like IPFS, Hypercore, etc. This allows building collaborative and offline-capable tools that do not rely on centralized servers.

## 🛠️ Building P2P static apps

Static apps work especially well with P2P protocols: they can be **served locally**, cached by peers, and stay available even when your origin server is offline. Publishing a bundle of HTML/CSS/JS to Hyper or IPFS gives you:

- **Offline / flaky-network resilience** – once content is seeded, peers can load it without a central server.
- **Versioned, content-addressed builds** – immutable URLs for each deploy, easy rollbacks and integrity checks.
- **Low/zero infra** – no origin to maintain; distribution happens over the P2P network.

### Publish to Hyper

```js
async function publishToHyper(file) {
  // Create (or reuse) a Hyperdrive keyed by "myapp"
  const response = await fetch('hyper://localhost/?key=myapp', {
    method: 'POST'
  });
  const hyperdriveUrl = await response.text(); // e.g. "hyper://abcdef.../"

  // Upload the static file into that drive
  const uploadUrl = `${hyperdriveUrl}${encodeURIComponent(file.name)}`;
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type || 'text/html' }
  });

  if (uploadResponse.ok) {
    console.log('Published to:', uploadUrl);
    return uploadUrl;
  }
}
```

### Publish to IPFS

```js
async function publishToIPFS(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('file', file, file.name);
  }

  // Example writable IPFS root; in practice you will use
  // a CID or path that your node exposes for writes.
  const response = await fetch('ipfs://bafyaabakaieac/', {
    method: 'PUT',
    body: formData
  });

  if (response.ok) {
    const ipfsUrl = response.headers.get('Location'); // e.g. "ipfs://bafy.../index.html"
    console.log('Published to:', ipfsUrl);
    return ipfsUrl;
  }
}
```

Check our p2p apps in `/pages/p2p/`: https://github.com/p2plabsxyz/peersky-browser/tree/main/src/pages/p2p

## 🤖 LLM-powered P2P apps

To build P2P apps that call a local or cloud LLM from the browser, see [`docs/LLM.md`](./LLM.md) for the `window.llm` API, configuration, and examples.

## Web3 protocol

For `web3://` examples (contract reads, HTML resources, and `fetch` usage), see [`docs/web3.md`](./web3.md).

## 📄 p2p-list.js

The file [`p2p-list.js`](../src/pages/p2p/p2p-list.js) exports a list of registered P2P app objects.
It also provides helpers to manage pinned apps on the home screen:

- `getPinnedApps()`: Returns an array of pinned app IDs (async, reads from the main-process settings via IPC).
- `setPinnedState(id, isPinned)`: Updates the `pinnedP2PApps` setting and broadcasts a `pinned-apps-changed` event to sync the home screen P2P bar dynamically (follows the same IPC pattern as `showClock`).
- `isPinned(id)`: Checks if a specific app is pinned (async).

### Always-visible P2P bar

The home screen includes a **P2P bar** (`<peer-bar>` web component in `peer-bar.js`) that is always visible at the bottom. It contains:

1. A **constant box icon** (colored with `--browser-theme-primary-highlight`) that always links to `peersky://p2p/` — the P2P app management page. This icon cannot be removed or unpinned.
2. **Pinned app icons** — each P2P app that the user has pinned appears as an SVG icon in the bar.
3. A **Social Reader** link at the end.

Icons appear with a "scale pop-in" animation on page load for a polished feel.

### Managing apps at peersky://p2p/

The page at `peersky://p2p/` (`pages/p2p/index.html`) serves as the P2P app management UI. It uses a `<p2p-app-manager>` web component that displays a table with columns:

| Pin / Unpin | App Name | Open |
|---|---|---|
| Button to toggle pin state | Link to the app | Direct open link |

Pin/unpin changes are persisted via the main-process settings system (`pinnedP2PApps` key in `settings.json`), ensuring the home screen P2P bar updates across windows in real time.

To register a new P2P app:

1. Add the folder for your app inside `./src/pages/p2p/`
2. Update the `p2pApps` array in `p2p-list.js` with the new app object (e.g. `{ id: "chat", name: "Chat", icon: "chat.svg", url: "peersky://p2p/chat/" }`)
3. Make sure your app is accessible at `peersky://p2p/your-app-id/`

<!-- TODO: Add section about Git submodules for P2P apps -->
