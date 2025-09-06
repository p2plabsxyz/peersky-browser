# Repository Guidelines

## Project Structure & Module Organization
- `src/`: Electron app code. Key modules: `main.js` (entry), `session.js` (session helpers), `window-manager.js`, `renderer.js`, protocol handlers in `src/protocols/` (`*-handler.js`, `helia/`), UI pages in `src/pages/` (HTML/CSS/JS), and extensions in `src/extensions/`.
- `public/`: App icons and static assets.
- `docs/`: Feature docs (Theme, P2P, Settings, Extensions).
- `.github/`: Issue/PR templates, workflows.
- `scripts/`: Dev/QA helpers (e.g., `scripts/check-session.sh`).
- `dist/`: Build outputs (created by electron-builder).

## Build, Test, and Development Commands
- Install: `npm install`
- Run locally: `npm start` (launches Electron with `src/main.js`)
- Build (current OS): `npm run build` → packages to `dist/`
- Build all OSes: `npm run build-all`
- Unit tests (if present): `npm run test:unit` (placeholder in this repo)
- Session policy check: `./scripts/check-session.sh`

## Coding Style & Naming Conventions
- Language: ES Modules ("type": "module"). Indent 2 spaces, use semicolons and double quotes.
- Filenames: kebab-case for JS/Assets in pages (`src/pages/static/js/...`); handlers `*-handler.js` in `src/protocols/`.
- Formatting: run Prettier before committing (project follows Prettier defaults; no custom config committed).
- Security defaults: no Node in webviews; keep `contextIsolation: true`, `sandbox: true` unless justified.

## Testing Guidelines
- Framework: none enforced yet. Place tests under `tests/` and invoke via `npm run test:unit`.
- Naming: `*.test.js` or `tests/<module>.test.js`. Prefer fast, deterministic unit tests for utils and protocol handlers.
- Coverage: no minimum required; include tests for any bug fix or new feature where feasible.

## Commit & Pull Request Guidelines
- Commits: follow Conventional Commits (e.g., `feat: add ipfs directory listing`).
- PRs: open an issue first; include clear description, linked issue (`Closes #123`), test evidence, and screenshots for UI changes. Use `.github/PULL_REQUEST_TEMPLATE.md`.

## Security & Configuration Tips
- Always obtain the session via `getBrowserSession()` (`src/session.js`). Avoid `session.defaultSession` (use `scripts/check-session.sh`).
- Protocols: browser (`peersky://`, `browser://`) and P2P (`ipfs://`, `ipns://`, `hyper://`, `web3://`) register in `src/main.js` and `src/protocols/`.
