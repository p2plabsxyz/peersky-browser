# Testing Guide

Peersky Browser has **230 tests** across 9 suites. They cover protocol handlers, P2P networking and file sync, backup and identity transfer, extension lifecycle, security policies, LLM streaming, the auto-updater, and performance regressions.

## Running Tests

```bash
npm test                    # Every suite + combined tally (~8 min)
npm run test:ci             # Everything except integration (what CI runs)
npm run test:p2p            # Protocol handler units (~15s)
npm run test:p2p:e2e        # E2E sync (~2-3 min)
npm run test:backup         # Backup / restore / identity transfer (~2s)
npm run test:extensions     # Extension lifecycle (~1s)
npm run test:security       # Security policies (~1s)
npm run test:llm            # LLM streaming + dispatcher contract (~1s)
npm run test:updater        # Auto-updater (~1s)
npm run test:perf           # Performance regressions (~5s)
npm run test:integration    # App restart (~5+ min)
npm run coverage            # Coverage report
```

`npm test` and `npm run test:ci` go through `test/run-tests.mjs`, which runs
each suite as its own mocha process and prints one table at the end:

```
SUITE        PASS   FAIL   SKIP   RESULT
-----------------------------------------------
p2p          58     0      0      ok
backup       42     0      0      ok
...
-----------------------------------------------
TOTAL        186    0      0
```

It does not stop at the first failure, so one run shows the whole picture. A
suite that dies before mocha prints its epilogue is reported as `CRASH` rather
than counted as zero, and the run exits non-zero naming what failed.

Pass suite names to run a subset: `node test/run-tests.mjs backup llm`.

Run single test:
```bash
npx mocha test/p2p/ipfs-handler.test.js --timeout 20000
npx mocha test/p2p/ipfs-handler.test.js --grep "CID norm" --timeout 20000
```

## Test Architecture

### Files
- `test/run-tests.mjs` — Suite runner and combined tally (not a spec)
- `test/setup.js` — Polyfill `Promise.withResolvers` for Node.js <22
- `test/p2p/*.test.js` — Unit & E2E tests with mocked/real nodes
- `test/backup/` — Archive, encryption, restore, identity transfer
- `test/extensions/` — Extension lifecycle, browser-action broadcast, CRX parsing
- `test/security/` — Write policy & manifest validation
- `test/llm/` — Streaming and dispatcher contract
- `test/updater/` — Auto-updater states
- `test/perf/` — Performance regressions (see `test/perf/README.md`)
- `test/integration/` — Real Electron app restart
- `test/fixtures/` — Shared fixtures (no specs)

### Key Components
- **esmock** — Isolates handlers with mocked dependencies (no filesystem, network, or libp2p calls)
- **Promise wrapper** — Converts Electron callback style to async/await
- **PEERSKY_TEST_USERDATA** env var — Isolates test data per run

## Test Coverage

### Protocol Unit Tests — `test:p2p` (58 tests)
- **CID**: v0→v1 normalization
- **PeerId**: `Qm...` (base58) → peerIdFromString, `bafz...` (base32 CID) → peerIdFromCID
- **ENS**: `ipfs-ns` codec (serve CID), `ipns-ns` codec (route via IPNS), fallback (strip prefix)
- **Upload naming**: Single file → filename, directory → folder name, multiple → parent dir
- **MIME detection**: By extension + HTML sniffing (first 512 bytes)
- **Upload cache**: Metadata tracking with timestamp/URL/name

### E2E Tests — `test:p2p:e2e` (12 tests)
- Protocol initialization (IPFS & Hyper)
- File upload & DHT discovery (local + delegated routing)
- Directory serving & index.html auto-serve
- File content round-trip verification
- libdatachannel error suppression (non-fatal WebRTC teardown errors)

### Extension Tests — `test:extensions` (32 tests)
- Install/update/uninstall lifecycle
- Service worker reload & state persistence

### Security Tests — `test:security` (6 tests)
- GET always allowed, POST/PUT/PATCH require `p2pWrite` permission
- Dangerous permissions blocked (nativeMessaging, debugger, desktopCapture)
- Path traversal protection (`../` rejected)
- Extension detection via `chrome-extension://` in referrer

### Backup Tests — `test:backup` (42 tests)
- Archive streaming, SHA-256 manifests, zip-slip path validation
- Passphrase-encrypted wrapper (scrypt + AES-256-GCM)
- Transactional restore: staging, swap, rollback on failure
- Receiver-sealed identity transfer and verification-code derivation

### LLM Tests — `test:llm` (11 tests)
- Streaming response parsing, including malformed chunks
- undici dispatcher contract: the Agent must not reach global fetch

### Updater Tests — `test:updater` (22 tests)
- Manual check, pending update, and already-latest states
- Squirrel error handling and install restart

### Performance Tests — `test:perf` (44 tests)

These pin the *work* the browser does on its hot paths — renderer round-trips,
disk stats, node boots, state writes — rather than wall-clock times, which vary
too much across machines to assert on. Each one guards a shape that was slow
once, so re-introducing it fails the build.

- p2p backends (Helia, hyper-sdk, the WebTorrent worker) do not start before the
  first window can paint, and a burst of requests starts exactly one of each
- Extensions load into the session together, and a tab that attaches while the
  extension host is still booting is queued rather than lost
- A drag-sized burst of window/tab events writes the session once, not once per
  event, and the last request in a burst is never dropped
- Internal assets resolve once and revalidate (304) instead of being re-read,
  and `browser://theme` no longer stamps a fresh ETag per request
- Opening an extension popup costs no renderer round-trip and no directory scan

### Integration Tests — `test:integration` (3 tests)
- Real Electron app restart with extension persistence
- Service worker survives restart

## Debugging

### DHT Test Flakiness
DHT test passes if **any** of these:
1. Local DHT finds provider (<10s, happens if test ran before)
2. Delegated routing finds provider (2+ min, needs internet)
3. 0 providers after 2 min — test skips (expected)

If failing: `curl https://delegated-ipfs.dev/health` (check delegated routing)

### Test Data
```bash
cross-env PEERSKY_TEST_USERDATA=.my-test npm run test:p2p:e2e
ls -la .test-e2e-data/  # View test data after run
```

### Verbose Logging
```bash
DEBUG_P2P=1 npm run test:p2p:e2e
```

The app's own console transport is set to `info`. Hot-path lines (per session
save, per badge update) are logged at `debug`, so raise the level to see them:

```bash
PEERSKY_LOG_LEVEL=debug npm start
```

### Extension Test Issues
```bash
rm -rf .test-e2e-data-*   # Delete stale test data
npx mocha test/extensions/*.test.js --reporter spec
```

### Coverage Report (nyc)
```bash
npm run coverage          # Generate NYC coverage report
# Opens coverage/index.html with line/branch/function/statement coverage
# Config: .nycrc.json or package.json nyc field
# Includes: src/protocols/*.js, test/p2p/*.js
# Excludes: node_modules, test fixtures, preload.js
```

## Adding New Tests

1. **Choose a suite**: mocked handler → `test/p2p/*-handler.test.js`, real nodes →
   `test/p2p/p2p-e2e.test.js`, backup → `test/backup/`, extensions →
   `test/extensions/`, security → `test/security/`, integration → `test/integration/`
2. **Write the test** using the `callHandler(handler, request)` wrapper and `expect()`
3. **Run it**: `npx mocha test/p2p/ipfs-handler.test.js --grep "name" --timeout 20000`
4. **Update this guide** if it demonstrates new behaviour

### Adding a whole new suite

Adding a file to an existing directory needs no wiring — the suite's glob picks
it up and the count rolls into the total.

A **new directory** also runs with no wiring. `test/run-tests.mjs` runs any spec
no `test:*` script claims, grouped per directory, with default flags
(`--timeout 20000 --exit`). It appears in the table marked `*`:

```
settings *   2      0      0      ok

* auto-discovered (settings) — add a test:<name> script to control its flags.
```

Add a `test:<name>` script when the defaults are not right — a longer timeout,
env vars, or a pre-step like `rimraf`. Once the script exists it takes over, and
the `*` disappears.

Two rules the runner applies so this stays predictable:

- **Explicit scripts win.** Only specs nothing else claims are auto-discovered,
  so `test/p2p/p2p-e2e.test.js` keeps running through `test:p2p:e2e` with its
  env and clean data dir rather than being picked up bare.
- **Subsumed suites are skipped.** A script whose specs are a subset of another's
  (`test:p2p:bt` inside `test:p2p`) is not run twice. It still works on its own.

Auto-discovery only applies to a full run. Naming suites
(`node test/run-tests.mjs backup llm`) runs exactly those.


