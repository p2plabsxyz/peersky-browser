<p align="center">
    <img align="center" src="/public/icon.png" width="200" height="200"></img>
</p>

<h1 align="center">Peersky Browser</h1>

<div align="center">
    <img src="https://img.shields.io/badge/Platform-electron.js-black.svg?style=flat-square" alt="platform">
    <img src="https://img.shields.io/github/release-date-pre/p2plabsxyz/peersky-browser?color=green&style=flat-square" alt="Release" />
    <img src="https://img.shields.io/badge/license-MIT-orange.svg?style=flat-square" alt="License">
</div><br>

💻 [Download](https://github.com/p2plabsxyz/peersky-browser/releases/latest) | 🌐 [Website](https://peersky.p2plabs.xyz/)

<div>
  <img src="./peersky-demo.gif" />
</div>

## 🛠 Development

- Install dependencies

```bash
npm install
```

- Start the app

```bash
npm start
```

- Build
  After development of the browser, run the following command. This will create a `production` build.

```bash
npm run build
# For Intel and M1 macs
```

Now, the build folder will appear in the root directory.

```bash
npm run build-all
# For macOS, Linux, and Windows
```

## 🚧 Roadmap

> Please note that the following roadmap list is in random order, and these items represent high-priority tasks.

- [x] Browser navigation:

  - [x] Back
  - [x] Forward
  - [x] Reload
  - [x] Home page (peersky://home)

- [x] IPFS protocol handler:

  - [x] Run a local IPFS node
  - [x] `ipfs://` / `ipns://` native URLs support
  - [x] Directory listings support
  - [ ] [Helia](https://github.com/ipfs/helia) integration
    > JS-IPFS is deprecated: js-IPFS has been superseded by Helia

- [ ] Experiments:

  - [ ] `peersky://upload`
    - Upload files / directories
    - Publish blogs / websites
  - [ ] `Peersky://analytics` ([peerDiscovery](https://github.com/ipfs/js-ipfs/blob/master/docs/core-api/DHT.md#ipfsdhtfindpeerpeerid-options))
    - Fetch IPs from the DHT and count them as clicks, with regional sorting (visuals)
  - [ ] `Peersky://chat` ([libp2p/webRTC](https://github.com/libp2p/js-libp2p-webrtc]))
    - Chat with connected peers on the network

- [ ] Auto-updater (electron’s [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)):

  - [ ] Download and install the latest release from Github automatically

- [ ] QR Code generator:

  - [ ] An option to generate QR Code for every page in the URL prompt

- [ ] Context menu:

  - [ ] Back / forward
  - [ ] Reload
  - [ ] Generate QR code
  - [ ] Add to IPFS

- [ ] Browser history:

  - [ ] peersky://history
  - [ ] Suggestions based on the browser history when typing in URL prompt

- [ ] Bookmarks:

  - [ ] An option to add favourite pages in the nav bar (peersky://bookmarks)

- [ ] Keyboard shortcuts:

  - [ ] New window
  - [ ] Back / Forward
  - [ ] Reload
  - [ ] Find in page
  - [ ] Developer tools

- [ ] Extensions:
  - [ ] In-browser extensions
    - [Ad-blocker](https://github.com/gorhill/uBlock)
    - [DScan](https://github.com/p2plabsxyz/dscan)
    - ..
  - [ ] Load extensions from folders

## 📄 Contribute

- Thanks for your interest in contributing to Peersky Browser. There are many ways you can contribute to the project.
- To start, take a few minutes to read the "[contribution guide](https://github.com/p2plabsxyz/peersky-browser/blob/main/.github/CONTRIBUTING.md)".
- We look forward to your [pull requests](https://github.com/p2plabsxyz/peersky-browser/pulls) and / or involvement in our [issues page](https://github.com/p2plabsxyz/peersky-browser/issues).

## ⚖️ License

Peersky Browser is licensed under the [MIT License](https://github.com/p2plabsxyz/peersky-browser/blob/main/LICENSE).

<hr>
Don't forget to leave a star ⭐️ ~ <a href="https://twitter.com/PeerskyBrowser" target="_blank"><img src="https://img.shields.io/twitter/follow/PeerskyBrowser?style=social" alt="twitter" /></a>
