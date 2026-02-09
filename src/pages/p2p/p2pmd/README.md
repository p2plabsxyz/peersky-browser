# P2P Markdown

P2P Markdown is a real-time, peer-to-peer collaborative markdown editor built into [PeerSky Browser](https://github.com/p2plabsxyz/peersky-browser). It connects peers directly using [Holesail](https://holesail.io/) keys, syncs edits live, and lets you publish or export your content without relying on centralized servers.

## What it does
- Real-time P2P collaboration over Holesail (direct, encrypted connections)
- Join or host rooms using `hs://` keys
- Local publishing to `hyper://` or `ipfs://`
- Drag-and-drop image upload to IPFS (auto-compressed, inserted as markdown)
- Draft storage using local Hyperdrive
- Content generation via local LLMs
- Export to HTML or PDF (check [export examples](./examples))
- SSE keepalive + auto-reconnect for mobile/idle clients

## How it works (high level)
- The editor hosts a local HTTP session for the document and syncs changes over SSE.
- Holesail creates a direct peer connection using a shared key.
- Publishing writes to Hyper/IPFS, making content shareable via P2P URLs.
- Drag an image onto the editor to upload it to IPFS. Images are compressed (resized to max 1920px, re-encoded at 0.8 quality) before upload. GIFs are uploaded as-is to preserve animation. The resulting markdown link uses a `dweb.link` gateway URL.

## Build a similar P2P realtime app

### 1) Start a Holesail server
```js
import Holesail from "holesail";

const server = new Holesail({
  server: true,
  secure: true,
  port: 8989
});

await server.ready();
console.log("Share this key:", server.info.url);
```

### 2) Connect a client
```js
import Holesail from "holesail";

const client = new Holesail({
  client: true,
  key: "hs://s000yourkeyhere"
});

await client.ready();
console.log("Connected:", client.info);
```

More: https://docs.holesail.io/

### 3) Sync realtime state
Use HTTP endpoints (GET/POST) plus SSE/WebSocket for live updates. In PeerSky, a custom [hs-handler](https://github.com/p2plabsxyz/peersky-browser/blob/main/src/protocols/hs-handler.js) can expose these endpoints while keeping the transport peer-to-peer.

### 4) Publish to Hyper
```js
async function publishToHyper(file) {
  const response = await fetch(`hyper://localhost/?key=myapp`, { 
    method: 'POST' 
  });
  const hyperdriveUrl = await response.text();
  
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

### 5) Publish to IPFS
```js
async function publishToIPFS(files) {
  const formData = new FormData();
  for (const file of files) {
    formData.append('file', file, file.name);
  }
  
  const response = await fetch('ipfs://bafyaabakaieac/', {
    method: 'PUT',
    body: formData
  });
  
  if (response.ok) {
    const ipfsUrl = response.headers.get('Location');
    console.log('Published to:', ipfsUrl);
    return ipfsUrl;
  }
}
```

These examples show the core patterns used in p2pmd. You can adapt them to build your own P2P apps in PeerSky.
