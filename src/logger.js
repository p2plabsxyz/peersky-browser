import log from 'electron-log'

log.transports.console.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{scope}] [{level}] {text}'
log.transports.file.level = false

// Console writes are synchronous, so lines on hot paths (per session save, per
// badge update, per protocol request) cost real time in the main process.
// Anything marked debug is off unless asked for.
log.transports.console.level = process.env.PEERSKY_LOG_LEVEL || 'info'

// This logger is main-process only; nothing in the renderers reads it. Left on,
// electron-log forwards every line to every window, and once a window's render
// frame is disposed each forward makes Electron print a stack trace of its own.
// The transport is absent outside Electron, so tests must not trip over it.
if (log.transports.ipc) log.transports.ipc.level = false

const logEnv = process.env.PEERSKY_LOGS || '*'
const scopes = logEnv.split(',').map(s => s.trim()).filter(Boolean)

log.hooks.push((message, transport) => {
  if (transport !== log.transports.console) return message

  const scope = message.scope || 'global'

  let allowed = false
  for (const pattern of scopes) {
    const isNegation = pattern.startsWith('-')
    const parsePattern = isNegation ? pattern.slice(1) : pattern

    let match = false
    if (parsePattern === '*') {
      match = true
    } else if (parsePattern.endsWith('*')) {
      match = scope.startsWith(parsePattern.slice(0, -1))
    } else {
      match = scope === parsePattern
    }

    if (match) allowed = !isNegation
  }

  return allowed ? message : false
})

export function createLogger (scope) {
  return log.scope(scope)
}

export default log
