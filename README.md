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
    <a href="https://standardjs.com"><img src="https://img.shields.io/badge/code_style-standard-brightgreen.svg" alt="JavaScript Style Guide"></a>
    <img src="/demo.png" width="800" alt="PeerSky Browser home page">
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
  - [x] Optional `bt://` seeding

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
  - [x] `peersky://p2p/hyperdrive/`
    - Decentralized file storage
  - [x] `peersky://p2p/peerpad/`
    - Build and publish websites
  - [x] `peersky://p2p/p2pmd/`
    - Real-time collaborative markdown editor
    - Presentation slides mode with speaker notes
    - Offline KaTeX math mode with inline scientific templates
    - IEEE-style two-column research paper preview/export
    - AI-powered content generation
    - Publish to IPFS/Hypercore
    - Peers dashboard with roles, live editing status, and edit history
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

  - [x] Option to generate QR Code for every page in the URL prompt with [plan1](./docs/Plan1.md).

- [x] Archive (peersky://archive):

  - [x] List and showcase published content from `peersky://p2p/` apps for enhanced discoverability.
  - [x] Provide metadata (e.g., creation date, content type) to improve navigation and usability.
  - [x] Ability to download all the hashes of published data in a .json file.

- [x] Backup & Restore (peersky://backup):

  - [x] Create offline `.zip` backups containing tabs, window layout, ENS cache, and full IPFS/Hypercore data.
  - [x] Upload backups to IPFS or Hypercore to share and restore via a P2P CID.
  - [x] **Note**: When restoring a backup from a P2P CID, the original device (or another peer) must remain online to serve the data.

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
  After development of the browser, run the following command. This will create a production build for the platform you are on.

```bash
npm run build
```

Now, the `dist` folder will appear in the root directory.

### Linting

This project uses [StandardJS](https://standardjs.com) for code style. To check for lint errors:

```bash
npm run lint
```

To auto-fix lint errors:

```bash
npx standard --fix
```

### Testing

Run all tests:

```bash
npm test
```

Run specific test suites:

```bash
npm run test:p2p          # Protocol handler unit tests (IPFS/Hyper/HS/BitTorrent)
npm run test:p2p:e2e      # End-to-end sync tests (2-3 min)
npm run test:backup       # Backup, restore, and identity transfer
npm run test:extensions   # Extension lifecycle tests
npm run test:security     # Security and isolation tests
npm run test:llm          # LLM streaming and dispatcher contract
npm run test:updater      # Auto-updater tests
npm run test:integration  # Real app restart tests (5+ min)
```

`npm test` runs every suite and prints a combined pass/fail tally. It keeps
going after a failure so one run shows the whole picture, then exits non-zero
naming the suites that failed. `npm run test:ci` is the same minus the slow
integration suite, and is what the workflows run.

For detailed testing documentation, see [Testing Guide](./docs/Testing.md).

### Logging

For details on the Peersky logging system, see the [Logging Documentation](./docs/Logging.md). 

## Contribute

- Thanks for your interest in contributing to PeerSky Browser. There are many ways you can contribute to the project.
- To start, take a few minutes to read the "[contribution guide](https://github.com/p2plabsxyz/peersky-browser/blob/main/.github/CONTRIBUTING.md)".
- We look forward to your [pull requests](https://github.com/p2plabsxyz/peersky-browser/pulls) and / or involvement in our [issues page](https://github.com/p2plabsxyz/peersky-browser/issues).

## License

PeerSky Browser is licensed under the [MIT License](https://github.com/p2plabsxyz/peersky-browser/blob/main/LICENSE).
