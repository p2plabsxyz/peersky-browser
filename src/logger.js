import log from 'electron-log';

// Default configuration for electron-log console format
log.transports.console.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{scope}] [{level}] {text}';

// Ensure the file transport is still active as configured in auto-updater.js, 
// but we'll apply our filtering only to the console transport so users can toggle what they see.

// Read process.env.PEERSKY_LOGS
// Examples:
// PEERSKY_LOGS="*" -> log everything (default)
// PEERSKY_LOGS="main,protocols:*" -> log main component and all protocol handlers
// PEERSKY_LOGS="*,-protocols:hyper" -> log everything EXCEPT hyper protocol
const logEnv = process.env.PEERSKY_LOGS || '*';
const scopes = logEnv.split(',').map(s => s.trim()).filter(Boolean);

log.hooks.push((message, transport) => {
  // Only filter console transport to allow terminal toggling, 
  // file transport can continue logging everything (at info level +)
  if (transport !== log.transports.console) return message;
  
  const scope = message.variables && message.variables.scope ? message.variables.scope : 'global';
  
  let allowed = false;
  
  for (const pattern of scopes) {
    const isNegation = pattern.startsWith('-');
    const parsePattern = isNegation ? pattern.slice(1) : pattern;
    
    let match = false;
    if (parsePattern === '*') {
      match = true;
    } else if (parsePattern.endsWith('*')) {
      const prefix = parsePattern.slice(0, -1);
      match = scope.startsWith(prefix);
    } else {
      match = scope === parsePattern;
    }
    
    if (match) {
      allowed = !isNegation;
    }
  }
  
  return allowed ? message : false;
});

/**
 * Create a scoped logger
 * @param {string} scope - The component name, e.g., 'main', 'session', 'protocols:ipfs'
 * @returns {import('electron-log').LogFunctions}
 */
export function createLogger(scope) {
  return log.scope(scope);
}

export default log;
