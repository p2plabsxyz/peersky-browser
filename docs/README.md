# Peersky Browser Documentation

- [Settings](Settings.md)
- [Tabs](Tabs.md)
- [Site info](SiteInfo.md)
- [LLMs](LLM.md)
- [Extensions](Extensions.md)
- [Theme Protocol](Theme.md)
- [P2P Apps](P2P.md)
- [BitTorrent Protocol](BitTorrent.md)
- [Web3 Protocol](Web3.md)
- [Backup & Restore](Backup.md)
- [Logging](Logging.md)
- [Testing](Testing.md)

## Features

- [x] Basic browser navigation:

  - [x] Back
  - [x] Forward
  - [x] Reload
  - [x] Browser protocol (peersky://)
  - [x] Home page (peersky://home)
  - [x] Cross browser themeing ([browser://theme/](https://github.com/p2plabsxyz/peersky-browser/blob/main/docs/Theme.md))
  - [x] Search engine
    - DuckDuckGo (default)
    - Brave Search
    - Ecosia
    - Kagi
    - Startpage
  - [x] Page zoom, per tab, with a percentage readout
  - [x] Address bar suggestions drawn from browsing history
  - [x] Downloads, with progress in the toolbar (peersky://downloads)
    - Pause, resume or cancel a download in progress
  - [x] Browsing history (peersky://history), searchable
  - [x] First-run onboarding (peersky://onboarding)
  - [x] Tabs
    - Vertical tabs toggle
    - Tab groups, with colours and collapsing
    - Pinned tabs
    - Split view: two tabs side by side, with a draggable divider
    - Drag a tab onto another window, or out into one of its own
    - Preview card on hover
    - Memory saver: sleeps inactive tabs, with an exclusion list

- [x] Hypercore protocol handler:

  - [x] Run a local [hyper](https://holepunch.to/) node
  - [x] `hyper://` native URLs support

- [x] BitTorrent protocol handler:

  - [x] [WebTorrent](https://webtorrent.io/) in isolated child process
  - [x] `bittorrent://` / `bt://` / `magnet:` native URLs support
  - [x] Real-time download progress UI with pause/resume
  - [x] Auto-destroy torrent on completion (no seeding)
  - [x] Optional `bt://` seeding

- [x] IPFS protocol handler:

  - [x] Run a local [Helia](https://helia.io/) node
  - [x] `ipfs://` / `ipns://` native URLs support
  - [x] Directory listings support
  - [x] Native ENS domain resolution:
    - [x] Resolve `.eth` domains directly to IPFS/IPNS content without centralized gateways (e.g., `ipfs://vitalik.eth`).
    - [x] Local caching for resolved ENS content to enhance performance and reduce RPC calls.

- [x] Holesail protocol handler:

  - [x] `hs://` native URLs support
  - [x] Direct peer-to-peer connections for real-time apps, over [Holesail](https://holesail.io/)

- [x] Local `file://` browsing with P2P publishing:
  - [x] Custom `file://` support with privileged access
  - [x] Directory listings (Chrome-style)
  - [x] One-click P2P publishing to:
      - [x] IPFS (`ipfs://`)
      - [x] Hypercore (`hyper://`)

- [x] Web3 protocol handler:

  - [x] Run a local [web3 protocol](https://docs.web3url.io/) node
    - [x] Access on-chain websites.
    - [x] Fetch data from smart contracts using auto, manual, and resource request resolve modes.
    - [x] Query account balances or other data directly from smart contracts.

- [x] P2P Applications:

  - [x] `peersky://p2p/peerchat/`
    - Peer-to-peer messaging over Hyper
    - Works over the local network with no internet, via our [hyperdht mDNS](https://github.com/p2plabsxyz/hyperdht-mdns) discovery
  - [x] `peersky://p2p/p2pmd/`
    - Real-time collaborative markdown editor
    - Presentation slides mode with speaker notes
    - Offline KaTeX math mode with inline scientific templates
    - IEEE-style two-column research paper preview/export
    - AI-powered content generation
    - Publish to IPFS/Hypercore
    - Peers dashboard with roles, live editing status, and edit history
  - [x] `peersky://p2p/peertunes/`
    - iPod classic style music player with Cover Flow and click wheel
    - Syncs songs from `hyper://` drives or local folders, with tags and album art
  - [x] `peersky://p2p/ai-chat/`
    - Chat with local AI models, with nothing leaving the device
  - [x] `peersky://p2p/hyperdrive/`
    - Decentralized file storage, published as a public or private drive
  - [x] And several others, including a website builder, a Wikipedia reader over
    IPFS, and the [Social Reader](https://reader.distributed.press/) ActivityPub
    client for the fediverse.

- [x] Electron’s Auto-updater:

  - [x] Download and install the latest release from Github automatically

- [x] Context menu:

  - [x] Back / Forward
  - [x] Reload
  - [x] Inspect
  - [x] Undo / Redo
  - [x] Cut / Copy / Paste
  - [x] Copy Link Address
  - [x] Open Link in New Tab 

- [x] Find in page:
  - [x] Search for text within a document or web page

- [x] Window state persistence:
  - [x] Save and restore open windows on app launch

- [x] Keyboard shortcuts:

  - [x] New Window: `CommandOrControl+N`
  - [x] New Tab: `CommandOrControl+T`
  - [x] Close Tab: `CommandOrControl+Shift+W`
  - [x] Close Window: `CommandOrControl+W`
  - [x] Next Tab: `CommandOrControl+Option+Right`, or `CommandOrControl+Tab` off macOS
  - [x] Previous Tab: `CommandOrControl+Option+Left`, or `CommandOrControl+Shift+Tab` off macOS
  - [x] Back: `CommandOrControl+[`
  - [x] Forward: `CommandOrControl+]`
  - [x] Reload: `CommandOrControl+R`
  - [x] Zoom In: `CommandOrControl+Plus` or `CommandOrControl+=`
  - [x] Zoom Out: `CommandOrControl+-`
  - [x] Actual Size: `CommandOrControl+0`
  - [x] Print: `CommandOrControl+P`
  - [x] Find in Page: `CommandOrControl+F`
  - [x] Open Dev Tools: `CommandOrControl+Shift+I`
  - [x] Focus URL Bar: `CommandOrControl+L`
  - [x] Minimize: `CommandOrControl+M`
  - [x] Toggle Full Screen: `F11`

- [x] Settings (peersky://settings):

  - [x] Switch search engines, or point at a custom search URL
  - [x] Set custom home page wallpapers
  - [x] Hide/show the home page clock, and choose its format
  - [x] Change themes
  - [x] Clear browser cache
  - [x] Vertical tabs, and whether they stay expanded
  - [x] Memory saver, with an exclusion list
  - [x] Automatic updates, plus a manual check
  - [x] Set Peersky as the default browser
  - [x] About: version and release notes

- [x] [Local LLM](https://github.com/p2plabsxyz/peersky-browser/blob/main/docs/LLM.md) integration for P2P apps:
  - [x] `window.llm` APIs (chat + streaming, complete)
  - [x] Trusted-domain exposure (PeerSky-native + allowlist)
  - [x] AI Chat app (peersky://p2p/ai-chat/)
    - [x] Ported from [Agregore examples](https://github.com/AgregoreWeb/website/blob/main/docs/examples/llm-chat.html) with PeerSky updates
  - [x] P2P Editor integration (peersky://p2p/peerpad/)
    - [x] New AI generator (`ai-generator.js`) to generate code with AI

  - [x] [LLM Memory](https://github.com/p2plabsxyz/peersky-browser/issues/97)
    - [x] `llm.json` to store prompts/responses across P2P apps
    - [x] Reusable History component (P2P editor, AI chat, etc.)
    - [x] Settings toggle to enable/disable memory
    - [x] “Reset P2P Data” also clears `llm.json`

- [x] [Web extensions](https://github.com/p2plabsxyz/peersky-browser/issues/19):
  - [x] Ability to add and manage extensions
  - [x] [Default extensions](https://github.com/p2plabsxyz/essential-chromium-extensions)
  - [ ] 🚧 [Decentralized Extension Distribution](https://github.com/p2plabsxyz/peersky-browser/issues/42)

- [x] Bookmarks (peersky://bookmarks):

  - [x] Option to add favourite pages in the nav bar (peersky://bookmarks)

- [x] QR Code generator:

  - [x] Option to generate a QR code for any page, from the address bar.

- [x] Archive (peersky://archive):

  - [x] List and showcase published content from `peersky://p2p/` apps for enhanced discoverability.
  - [x] Provide metadata (e.g., creation date, content type) to improve navigation and usability.
  - [x] Ability to download all the hashes of published data in a .json file.

- [x] Backup & Restore (peersky://backup):

  - [x] Create offline `.zip` backups containing tabs, window layout, ENS cache, and full IPFS/Hypercore data.
  - [x] Upload backups to IPFS or Hypercore to share and restore via a P2P CID.
  - [x] **Note**: When restoring a backup from a P2P CID, the original device (or another peer) must remain online to serve the data.
