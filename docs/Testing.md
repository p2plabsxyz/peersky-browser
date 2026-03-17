# Testing Guide

Peersky Browser has **40 tests** across 5 suites (unit, E2E, extensions, security, integration). All tests verify protocol handlers, P2P networking, file sync, extension lifecycle, and security policies.

## Running Tests

```bash
npm test                    # All tests (~8 min)
npm run test:p2p            # Unit only (~2s)
npm run test:p2p:e2e        # E2E sync (~2-3 min)
npm run test:extensions     # Extension lifecycle (~10s)
npm run test:security       # Security policies (~5s)
npm run test:integration    # App restart (~5+ min)
npm run test:coverage       # Coverage report
```

Run single test:
```bash
npx mocha test/p2p/ipfs-handler.test.js --timeout 20000
npx mocha test/p2p/ipfs-handler.test.js --grep "CID norm" --timeout 20000
```

## Test Architecture

### Files
- `test/setup.js` — Polyfill `Promise.withResolvers` for Node.js <22
- `test/p2p/*.test.js` — Unit & E2E tests with mocked/real nodes
- `test/extensions/` — Extension lifecycle tests
- `test/security/` — Write policy & manifest validation
- `test/integration/` — Real Electron app restart

### Key Components
- **esmock** — Isolates handlers with mocked dependencies (no filesystem, network, or libp2p calls)
- **Promise wrapper** — Converts Electron callback style to async/await
- **PEERSKY_TEST_USERDATA** env var — Isolates test data per run

## Test Coverage

### Unit Tests (17 tests)
- **CID**: v0→v1 normalization
- **PeerId**: `Qm...` (base58) → peerIdFromString, `bafz...` (base32 CID) → peerIdFromCID
- **ENS**: `ipfs-ns` codec (serve CID), `ipns-ns` codec (route via IPNS), fallback (strip prefix)
- **Upload naming**: Single file → filename, directory → folder name, multiple → parent dir
- **MIME detection**: By extension + HTML sniffing (first 512 bytes)
- **Upload cache**: Metadata tracking with timestamp/URL/name

### E2E Tests (12 tests)
- Protocol initialization (IPFS & Hyper)
- File upload & DHT discovery (local + delegated routing)
- Directory serving & index.html auto-serve
- File content round-trip verification
- libdatachannel error suppression (non-fatal WebRTC teardown errors)

### Extension Tests (3 tests)
- Install/update/uninstall lifecycle
- Service worker reload & state persistence

### Security Tests (5 tests)
- GET always allowed, POST/PUT/PATCH require `p2pWrite` permission
- Dangerous permissions blocked (nativeMessaging, debugger, desktopCapture)
- Path traversal protection (`../` rejected)
- Extension detection via `chrome-extension://` in referrer

### Integration Tests (3 tests)
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

### Extension Test Issues
```bash
rm -rf .test-e2e-data-*   # Delete stale test data
npx mocha test/extensions/*.test.js --reporter spec
```

### Coverage Report (nyc)
```bash
npm run test:coverage     # Generate NYC coverage report
# Opens coverage/index.html with line/branch/function/statement coverage
# Config: .nycrc.json or package.json nyc field
# Includes: src/protocols/*.js, test/p2p/*.js
# Excludes: node_modules, test fixtures, preload.js
```

## Adding New Tests

1. **Choose suite**: Unit (mocked) → `test/p2p/*-handler.test.js`, E2E (real) → `test/p2p/p2p-e2e.test.js`, Security → `test/security/`, Integration → `test/integration/`
2. **Write test** using `callHandler(handler, request)` wrapper & `expect()` assertions
3. **Run & verify**: `npx mocha test/p2p/ipfs-handler.test.js --grep "name" --timeout 20000`
4. **Update this guide** if demonstrating new behavior


