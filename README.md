<p align="center">
    <img align="center" src="/public/icon.png" width="200" height="200"></img>
</p>

<h1 align="center">PeerSky Browser</h1>

<div align="center">
    <img src="https://img.shields.io/github/actions/workflow/status/p2plabsxyz/peersky-browser/build.yml" alt="GitHub Actions Workflow Status">
    <img src="https://img.shields.io/badge/Platform-electron.js-black.svg" alt="platform">
    <img src="https://img.shields.io/github/release-date-pre/p2plabsxyz/peersky-browser?color=green" alt="GitHub Pre-release" />
    <!-- <img src="https://img.shields.io/github/v/release/p2plabsxyz/peersky-browser?color=green" alt="GitHub Release"> -->
    <a href="https://mastodon.social/@peersky"><img src="https://img.shields.io/mastodon/follow/113323887574214930" alt="Mastodon Follow"></a>
    <a href="https://deepwiki.com/p2plabsxyz/peersky-browser"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
    <img src="/banner.gif" width="639" alt="A demo gif of the PeerSky P2P Editor showing HTML, CSS, and JavaScript panels, a live preview of a blue page with red ‘Spider-Man’ text, and AI code-generation controls">
</div>

💻 [Download](https://peersky.p2plabs.xyz/)

## Roadmap

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
  - [x] Tabs
    - Vertical tabs toggle

- [x] IPFS protocol handler:

  - [x] Run a local [Helia](https://helia.io/) node
  - [x] `ipfs://` / `ipns://` native URLs support
  - [x] Directory listings support
  - [x] Native ENS domain resolution:
    - [x] Resolve `.eth` domains directly to IPFS/IPNS content without centralized gateways (e.g., `ipfs://vitalik.eth`).
    - [x] Local caching for resolved ENS content to enhance performance and reduce RPC calls.

- [x] Hypercore protocol handler:

  - [x] Run a local [hyper](https://holepunch.to/) node
  - [x] `hyper://` native URLs support

- [x] BitTorrent protocol handler:

  - [x] [WebTorrent](https://webtorrent.io/) in isolated child process
  - [x] `bittorrent://` / `bt://` / `magnet:` native URLs support
  - [x] Real-time download progress UI with pause/resume
  - [x] Auto-destroy torrent on completion (no seeding)
  - [ ] 🚧 `bt://` website seeding and hosting

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

  - [x] `peersky://p2p/chat/`
    - Peer-to-peer messaging over Hyper
  - [x] `peersky://p2p/upload/`
    - Decentralized file storage
  - [x] `peersky://p2p/editor/`
    - Build and publish websites
  - [x] `peersky://p2p/wiki/`
    - Browse Wikipedia over IPFS
  - [x] [reader.p2plabs.xyz](https://reader.distributed.press/)
    - A p2p offline ActivityPub client for reading and following microblogs on the fediverse.

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
  - [x] Back: `CommandOrControl+[`
  - [x] Forward: `CommandOrControl+]`
  - [x] Reload: `CommandOrControl+R`
  - [x] Find in Page: `CommandOrControl+F`
  - [x] Open Dev Tools: `CommandOrControl+Shift+I`
  - [x] Focus URL Bar: `CommandOrControl+L`
  - [x] Minimize: `CommandOrControl+M`
  - [x] Close: `CommandOrControl+W`
  - [x] Toggle Full Screen: `F11`

- [x] Settings (peersky://settings):

  - [x] Switch search engines
  - [x] Set custom home page wallpapers
  - [x] Hide/show the home page clock
  - [x] Change themes
  - [x] Clear browser cache

- [x] [Local LLM](https://github.com/p2plabsxyz/peersky-browser/blob/main/docs/LLM.md) integration for P2P apps:
  - [x] `window.llm` APIs (chat + streaming, complete)
  - [x] Trusted-domain exposure (PeerSky-native + allowlist)
  - [x] AI Chat app (peersky://p2p/ai-chat/)
    - [x] Ported from [Agregore examples](https://github.com/AgregoreWeb/website/blob/main/docs/examples/llm-chat.html) with PeerSky updates
  - [x] P2P Editor integration (peersky://p2p/editor/)
    - [x] New AI generator (`ai-generator.js`) to generate code with AI

  - [ ] 🚧 [LLM Memory](https://github.com/p2plabsxyz/peersky-browser/issues/97)
    - [ ] `llm.json` to store prompts/responses across P2P apps
    - [ ] Reusable History component (P2P editor, AI chat, etc.)
    - [ ] Settings toggle to enable/disable memory
    - [ ] “Reset P2P Data” also clears `llm.json`

- [x] [Web extensions](https://github.com/p2plabsxyz/peersky-browser/issues/19):
  - [x] Ability to add and manage extensions
  - [x] [Default extensions](https://github.com/p2plabsxyz/essential-chromium-extensions)
  - [ ] 🚧 [Decentralized Extension Distribution](https://github.com/p2plabsxyz/peersky-browser/issues/42)

- [x] Bookmarks (peersky://bookmarks):

  - [x] Option to add favourite pages in the nav bar (peersky://bookmarks)

- [x] QR Code generator:

  - [x] Option to generate QR Code for every page in the URL prompt with [plan1](./docs/Plan1.md).

- [ ] Archive (peersky://archive):

  - [ ] List and showcase published content from `peersky://p2p/` apps for enhanced discoverability.
  - [ ] Provide metadata (e.g., creation date, content type) to improve navigation and usability.
  - [ ] Ability to download all the hashes of published data in a .json file.

## Development

### Node.js and npm Setup

Please refer to the [Node.js official documentation](https://nodejs.org/) to install Node.js. Once installed, npm (Node Package Manager) will be available, allowing you to run commands like `npx` and `npm`.

- **npm**: Comes bundled with Node.js. Verify installation by running:
  ```bash
  node -v
  npm -v
  ```

### Install dependencies

```bash
npm install
```

### Start the app

```bash
npm start
```

### Build
  After development of the browser, run the following command. This will create a production build.

```bash
npm run build
# For Intel and Silicon macs
```

```bash
npm run build-all
# For macOS, Linux, and Windows
```

Now, the `dist` folder will appear in the root directory.

## Contribute

- Thanks for your interest in contributing to PeerSky Browser. There are many ways you can contribute to the project.
- To start, take a few minutes to read the "[contribution guide](https://github.com/p2plabsxyz/peersky-browser/blob/main/.github/CONTRIBUTING.md)".
- We look forward to your [pull requests](https://github.com/p2plabsxyz/peersky-browser/pulls) and / or involvement in our [issues page](https://github.com/p2plabsxyz/peersky-browser/issues).

## License

PeerSky Browser is licensed under the [MIT License](https://github.com/p2plabsxyz/peersky-browser/blob/main/LICENSE).
