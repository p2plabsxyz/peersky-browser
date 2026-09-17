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

💻 [Download](https://peersky.p2plabs.xyz/) 📜 [Docs](./docs/)

PeerSky is a gateway to the peer-to-peer web, not just a browser. It turns your computer into a node (a server for the network), so pages and apps can come from the people who have them rather than from one company's server. The everyday web works as usual, and alongside it PeerSky carries a full ecosystem of apps built on the same idea: chat, collaborative editing, file sharing, a music player, a local AI, and more. Most of these keep working on a local network with no internet at all.

We are building a surveillance-free internet where you own your tools, your data, and your connections, and where no single company can shut you out. Our vision is to save the internet, one peer at a time.

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

Building the Linux AppImage also needs `zsyncmake`, from the `zsync` package, to
produce the `.zsync` that AppImage update tools use for incremental downloads.
Without it the build still succeeds and simply skips that file, but a release
should be built with it installed.

```bash
sudo apt-get install -y zsync   # or: brew install zsync
```

### Linting

This project uses [StandardJS](https://standardjs.com) for code style. To check for lint errors:

[![js-standard-style](https://cdn.rawgit.com/feross/standard/master/badge.svg)](https://github.com/feross/standard)

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
npm run test:perf         # Performance regression tests
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
