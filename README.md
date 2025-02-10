<p align="center">
    <img align="center" src="/public/icon.png" width="200" height="200"></img>
</p>

<h1 align="center">Peersky Browser</h1>

<div align="center">
    <img src="https://img.shields.io/badge/Platform-electron.js-black.svg" alt="platform">
    <img src="https://img.shields.io/github/release-date-pre/p2plabsxyz/peersky-browser?color=green" alt="Release" />
    <img src="https://img.shields.io/mastodon/follow/113323887574214930" alt="Mastodon Follow">
</div><br>

💻 [Download](https://peersky.p2plabs.xyz/)

## Roadmap

- [x] Basic browser navigation:

  - [x] Back
  - [x] Forward
  - [x] Reload
  - [x] Browser protocol (peersky://)
  - [x] Home page (peersky://home)
  - [x] Search engine
    - DuckDuckGo (default)
    - Ecosia
  - [ ] [Tabs?](https://github.com/p2plabsxyz/peersky-browser/issues/11)

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

- [x] Web3 protocol handler:

  - [x] Run a local [web3 protocol](https://docs.web3url.io/) node
    - [x] Access on-chain websites.
    - [x] Fetch data from smart contracts using auto, manual, and resource request resolve modes.
    - [x] Retrieve NFT metadata or content (e.g., web3://[contract]/tokenHTML/[tokenId]).
    - [x] Query account balances or other data directly from smart contracts.

- [x] P2P Applications:

  - [x] `peersky://p2p/chat/`
    - Peer-to-peer messaging
  - [x] `peersky://p2p/upload/`
    - Decentralized file storage
  - [x] `peersky://p2p/editor/`
    - Build and publish websites
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

- [ ] Settings (peersky://settings):

  - [ ] Switch search engines
  - [ ] Set custom home page wallpapers
  - [ ] Hide/show the home page clock
  - [ ] Change themes
  - [ ] Clear browser cache

- [ ] Web extensions:
  - [ ] Ability to add extensions
  - [ ] Default extensions
    - [Ad-blocker](https://github.com/gorhill/uBlock)
    - [DScan](https://github.com/p2plabsxyz/dscan)
    - ..

- [ ] History (peersky://history):

  - [ ] Suggestions based on the browser history when typing in URL prompt

- [ ] QR Code generator:

  - [ ] Option to generate QR Code for every page in the URL prompt

- [ ] Bookmarks (peersky://bookmarks):

  - [ ] Option to add favourite pages in the nav bar (peersky://bookmarks)

- [ ] Archive (peersky://archive):

  - [ ] List and showcase published content from `peersky://p2p/` apps for enhanced discoverability.
  - [ ] Provide metadata (e.g., creation date, content type) to improve navigation and usability.
  - [ ] Ability to download all the hashes of published data in a .json file.

## Development

### Install dependencies

```bash
npm install
```

### Start the app

```bash
npm start
```

### Build
  After development of the browser, run the following command. This will create a `production` build.

```bash
npm run build
# For Intel and M1 macs
```

Now, the `dist` folder will appear in the root directory.

```bash
npm run build-all
# For macOS, Linux, and Windows
```

## Contribute

- Thanks for your interest in contributing to Peersky Browser. There are many ways you can contribute to the project.
- To start, take a few minutes to read the "[contribution guide](https://github.com/p2plabsxyz/peersky-browser/blob/main/.github/CONTRIBUTING.md)".
- We look forward to your [pull requests](https://github.com/p2plabsxyz/peersky-browser/pulls) and / or involvement in our [issues page](https://github.com/p2plabsxyz/peersky-browser/issues).

## License

Peersky Browser is licensed under the [MIT License](https://github.com/p2plabsxyz/peersky-browser/blob/main/LICENSE).
