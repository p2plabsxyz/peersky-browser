# Logging

Peersky uses `electron-log` with scoped loggers for structured output.

## Console Output

Console output is filtered by the `PEERSKY_LOGS` environment variable (default: `*` — log everything).

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
