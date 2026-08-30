# Logging

Peersky uses `electron-log` with scoped loggers for structured output.

## Console Output

Two independent filters apply: a **level** and a **scope**.

### Level — `PEERSKY_LOG_LEVEL`

Defaults to `info`. Console writes are synchronous, so a line on a hot path
(one per session save, per badge update, per protocol request) costs real time
in the main process; those are logged at `debug` and are off by default.

```bash
PEERSKY_LOG_LEVEL=debug npm start   # include hot-path detail
```

Use `log.debug()` for anything that fires proportionally to user activity, and
`log.info()` for one-off lifecycle events.

### Scope — `PEERSKY_LOGS`

Defaults to `*` — every scope.

| Example | Effect |
|---|---|
| `PEERSKY_LOGS="*"` | Log all scopes (default) |
| `PEERSKY_LOGS="main,extensions"` | Log only `main` and `extensions` |
| `PEERSKY_LOGS="protocols:*"` | Log all protocol handlers |
| `PEERSKY_LOGS="*,-protocols:hyper"` | Log everything except `protocols:hyper` |

## Scopes

Each module creates its own scoped logger:

```js
import { createLogger } from '../logger.js';
const log = createLogger('my-scope');

log.debug('Detail'); // → [ (my-scope) ] [debug]  (hidden unless PEERSKY_LOG_LEVEL=debug)
log.info('Hello');   // → [ (my-scope) ] [info]
log.warn('Careful'); // → [ (my-scope) ] [warn]
log.error('Oh no');  // → [ (my-scope) ] [error]
```

| Scope | Module |
|---|---|
| `main` | `src/main.js` |
| `session` | `src/session.js` |
| `extensions` | `src/extensions/` |
| `protocols:ipfs` | IPFS / Helia |
| `protocols:hyper` | Hypercore |
| `protocols:bt` | BitTorrent |
| `protocols:config` | Config / caches |
| `window-manager` | Window lifecycle |
