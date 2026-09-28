# Security Policy

## Supported versions

Security fixes land in the latest release only. Peersky updates itself, so keeping automatic updates on is the best protection.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/p2plabsxyz/peersky-browser/security/advisories/new). Do not open a public issue, pull request or discussion for a security problem.

Include what you can of:

- the Peersky version and operating system
- the steps, or a minimal page, that reproduce it
- what an attacker gains, for example reading local files or running code outside the page

We will reply in the advisory, keep you updated while we work on a fix, and credit you in the release notes unless you would rather stay anonymous. Please give us a chance to ship the fix before disclosing the issue publicly.

### Scope

In scope:

- the Peersky app, its installers and its updater
- the protocol handlers: `peersky:`, `browser:`, `hyper:`, `ipfs:`, `ipns:`, `pubsub:`, `hs:`, `bt:`, `bittorrent:`, `magnet:`, `web3:` and `file:`
- the bundled P2P apps under `peersky://p2p/`
- how Peersky installs and runs extensions
- backup, restore and identity transfer

Out of scope: third-party websites, extensions you install yourself, and upstream projects such as Electron, Hypercore, Helia and WebTorrent. Report those upstream, and tell us as well if Peersky needs a change.

## Security model

- The browser window (the shell) runs with Node.js integration and loads only Peersky's own page. A content security policy blocks inline scripts, inline event handlers and `eval` in it.
- Web pages run in separate `<webview>` guests with context isolation, the Chromium sandbox and no Node.js. One preload decides from the page's scheme and host which APIs it gets. Ordinary websites get no privileged APIs.
- Electron applies no CORS to custom schemes, so Peersky checks the calling page before a request reaches a protocol handler:
  - The browser's control APIs (the BitTorrent API, p2pmd rooms and the peerchat API) answer only their own pages.
  - A site that writes to `hyper://`, `ipfs://` or `ipns://` needs the **P2P publishing** permission. It is asked once per site and kept in site settings. Built-in `peersky://` pages do not ask.
  - Extensions need the `p2pWrite` manifest permission to write.
  - Service workers cannot call the control APIs or write, because the browser cannot see which page sent their requests.
- Camera, microphone, location, notifications, MIDI, pointer lock and full screen prompt per site. USB, serial, HID and clipboard reads are denied.
- Links to other applications (`mailto:`, `tel:` and custom protocols) open only after a confirmation dialog.
- Installing an extension never replaces an installed one.

## Design trade-offs

These follow from how Peersky works rather than being open bugs:

- Content published to Hyper or IPFS is public, unless you use a private Hyperdrive. Joining a swarm shows your IP address to its peers.
- When the LLM feature is on, `window.llm` is available without a per-site prompt to every Hyper, IPFS and IPNS site, to local files and to `https://agregore.mauve.moe`. With a paid cloud API key configured, that spends your credit.

## Security review

In September 2026 the codebase went through an AI-assisted security review with Claude Opus 5.5, Anthropic's model, running in Claude Code. The final hardening round ran at maximum reasoning effort. Findings were checked against the code and, where it mattered, reproduced in a running build before anything was changed.

Covered: the IPC and preload surface, every custom protocol handler, the shell and navigation (HTML injection, external protocols, permissions, downloads and launch URLs), extensions, the updater, backup and restore, the LLM integration, settings, and a dependency audit.

Fixed as a result:

- Websites could call the BitTorrent, p2pmd and peerchat APIs through custom schemes and read the replies, including from service workers.
- Websites could create or overwrite files in the user's Hyperdrives and add content to the IPFS node without asking.
- A sideloaded extension could replace the files of an installed one.
- In packaged builds DevTools opened on the Node-enabled shell, tab group names reached `innerHTML` unescaped, and the shell had no content security policy.
- The p2pmd PDF export rendered the calling page's HTML with scripts on and the sandbox off.
- Shipped dependencies included vulnerable versions of `adm-zip` and `ws`. `npm audit` still reports `ip` through `bittorrent-tracker`, but only in its tracker server code, which Peersky never runs.

Not covered in depth: native modules and upstream libraries beyond advisory triage.

This review is not a certification, and it is not affiliated with or endorsed by Anthropic. Independent audits and reports are welcome.
