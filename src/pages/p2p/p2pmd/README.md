# P2P Markdown

<div align="center">
    <img src="./demo.png" width="639" alt="Three synced devices (laptop, external monitor, and iPhone) running the PeerSky p2pmd editor showing shared markdown text ‘Hello from phone/Desktop/Laptop!’ and a dog photo inserted via IPFS.">
</div>

P2P Markdown is a real-time, peer-to-peer collaborative markdown editor built into [PeerSky Browser](https://github.com/p2plabsxyz/peersky-browser). It connects peers directly using [Holesail](https://holesail.io/) keys, syncs edits live, and lets you publish or export your content without relying on centralized servers.

## What it does
- Real-time P2P collaboration over Holesail (direct, encrypted connections)
- Incremental CRDT document sync with Yjs (plus safe fallback sync path)
- Join or host rooms using `hs://` keys
- Local publishing to `hyper://` or `ipfs://`
- Presentation slides mode with speaker notes and navigation
- Drag-and-drop image upload to IPFS (auto-compressed, inserted as markdown)
- Draft storage using local Hyperdrive
- Content generation via local LLMs (with slides format support)
- Export to HTML, PDF, or Slides (check [export examples](./examples))
- SSE keepalive + auto-reconnect for mobile/idle clients
- Peer visibility dashboard for connected peers, roles, live editing state, and edit history
- Colored cursor and line traces with hover name chips for collaborative context

## Features

### Slides Mode
Create presentations with markdown using `---` to separate slides:
```markdown
# Title Slide
Your opening content
<!-- Speaker notes: Introduce yourself and topic -->
---
# Key Points
- Point 1
- Point 2
<!-- Speaker notes: Elaborate on each point -->
```

**Navigation:**
- Arrow keys: `←` / `→` to navigate slides
- Click left/right half of screen to navigate
- Progress bar and slide counter at bottom
- Auto-detection: slides render automatically when `---` delimiters are present

**Features:**
- Speaker notes as HTML comments (hidden from slides, visible in markdown)
- Full-screen preview mode
- Export/publish as interactive HTML slides
- Footer with p2pmd and PeerSky branding

### Formatting Toolbar

![Formatting toolbar](./toolbar.png)

Quick formatting buttons with keyboard shortcuts:
- **Bold** (`Ctrl/Cmd+B`): `**text**`
- **Italic** (`Ctrl/Cmd+I`): `*text*`
- **Heading 1**: `# text`
- **Heading 2**: `## text`
- **Bullet List**: `- item`
- **Numbered List**: `1. item`
- **Link** (`Ctrl/Cmd+K`): `[text](url)`
- **Image**: `![alt](url)`
- **Inline Code**: `` `code` ``
- **Code Block**: ` ```language\ncode\n``` `
- **Quote**: `> text`
- **Slides Mode**: Toggle presentation view

### Peers Dashboard

<img src="./peers-dashboard.png" width="500" alt="p2pmd peers dashboard showing connected peers and edit history">

- Peer count opens `./peers.html` with room context.
- Connected peers list with role badges (`host` / `client`) and live cursor status.
- "Currently Editing" panel for active typers.
- "Edit History" panel for join/leave/edit activity.

### In-Editor Visibility

<img src="./peers-visibility.png" width="500" alt="p2pmd editor showing host badge, peer count, and colored collaborative line traces">

- Host/client role badge next to the room key.
- Peer count with quick navigation to the peers dashboard.
- Colored cursor indicators for active collaborators.
- Persistent colored line traces with hover labels showing editor names.
- Fallback naming (`Peer #N`) for unnamed peers.

### Themes

<img src="./themes.png" width="639" alt="Different themes available in p2pmd">

## Security
P2PMD implements production-grade security measures:
- **Encrypted Seeds**: Room keys encrypted at rest using Electron's `safeStorage` (OS-level keychain)
- **Rate Limiting**: DoS protection (5 room creations/min, 10 rehosts/min)
- **CORS Policy**: Protocol-level origin validation prevents external API access
- **Minimal Logging**: Sensitive data (keys, seeds) redacted from production logs
- **Modern API**: Uses Electron's `protocol.handle()` with native Request/Response objects

## How it works (high level)
- The editor hosts a local HTTP session and syncs content using incremental Yjs CRDT updates (with a full-state fallback path when needed).
- On reconnect, CRDT state is merged so edits made during temporary disconnects are preserved.
- Peer metadata (role, cursor, typing, and line hints) is shared via SSE + presence endpoints to power the peers page.
- Holesail creates a direct peer connection using a shared key.
- Publishing writes to Hyper/IPFS, making content shareable via P2P URLs.
- Drag an image onto the editor to upload it to IPFS. Images are compressed (resized to max 1920px, re-encoded at 0.8 quality) before upload. GIFs are uploaded as-is to preserve animation. The resulting markdown link uses a `dweb.link` gateway URL.

## Access 
### Desktop
Download [PeerSky Browser](https://peersky.p2plabs.xyz/) and open `peersky://p2p/p2pmd/` to access p2pmd.

### Mobile
To open p2pmd on your phone:
1. Download the Holesail mobile app ([iOS](https://apps.apple.com/us/app/holesail-go/id6503728841)/[Android](https://play.google.com/store/apps/details?id=io.holesail.holesail.go&hl=en_US&pli=1))
2. Enter the room key (`hs://...`) in the app to connect as a client
3. Open the localhost URL (e.g., `http://127.0.0.1:8989`) in your phone's browser
4. Edit and collaborate in real-time with desktop peers

**Note:** A dedicated p2pmd iOS/Android app with native editing would provide a similar experience without needing the Holesail app as an intermediary.

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
Use HTTP endpoints (GET/POST) plus SSE/WebSocket for live updates. In PeerSky, a custom [hs-handler](https://github.com/p2plabsxyz/peersky-browser/blob/main/src/protocols/hs-handler.js) can expose these endpoints while keeping the transport peer-to-peer. Incremental Yjs CRDT updates are exchanged over HTTP/SSE, while peer presence metadata is sent through presence endpoints.

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

