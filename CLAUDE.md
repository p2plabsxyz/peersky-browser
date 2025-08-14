# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Peersky Browser is a local-first, peer-to-peer web browser built with Electron that supports multiple decentralized protocols (IPFS, Hypercore, Web3) while maintaining compatibility with standard HTTP/HTTPS websites. It's currently in beta version 1.0.0-beta.9.

## Development Commands

```bash
# Install dependencies
npm install

# Start development mode
npm start

# Build for current platform only
npm run build

# Build for all platforms (macOS, Windows, Linux)
npm run build-all

# Post-install (rebuild native dependencies)
npm run postinstall
```

**Note**: No testing framework is currently configured. The test script is a placeholder.

## Architecture Overview

### Core Structure

- **Main Process**: `src/main.js` - Electron main process entry point, handles protocol registration and window management
- **Renderer Process**: `src/renderer.js` - Main browser UI logic and event handling
- **Window Management**: `src/window-manager.js` - Centralized window lifecycle and state persistence
- **Protocol Handlers**: `src/protocols/` - Custom protocol implementations for IPFS, Hypercore, Web3
- **IPC Handlers**: `src/ipc-handlers/` - Inter-process communication between main and renderer
- **Extensions**: `src/extensions/` - Chrome extension compatibility system (in development)

### Multi-Protocol System

The browser registers as default handler for multiple protocol schemes:

- **Standard**: `http`, `https`
- **IPFS**: `ipfs`, `ipns`, `ipld` (via Helia node)
- **Hypercore**: `hyper`, `dat` (via Hyper SDK)
- **Web3**: `web3` (blockchain-based websites)
- **Internal**: `peersky`, `browser` (built-in pages and theming)

### Key Dependencies

- **Helia (5.4.2)** - IPFS implementation with local node
- **Hyper SDK (5.1.0)** - Hypercore protocol support
- **Ethers.js (6.13.4)** - Ethereum/Web3 integration with ENS resolution
- **Web3protocol (0.6.0)** - On-chain website access
- **electron-find (1.0.7)** - In-page search functionality

### Code Patterns

1. **ES Modules**: All JavaScript uses `import`/`export` syntax (`"type": "module"` in package.json)
2. **Web Components**: Browser UI built with custom elements (`<tab-bar>`, `<nav-box>`, `<title-bar>`)
3. **Event-Driven Architecture**: Heavy use of custom events for component communication
4. **Protocol Isolation**: Each protocol handler is modular and sandboxed
5. **State Persistence**: Automatic save/restore of window states and tabs using JSON storage
6. **Graceful Shutdown**: Coordinated cleanup on application exit

### Window and Tab Management

- **PeerskyWindow Class**: Individual window wrapper with tab management
- **WindowManager**: Centralized lifecycle management
- **State Persistence**: Windows and tabs automatically saved/restored on app restart
- **Tab Grouping**: Support for organizing tabs (feature in development)

### P2P Applications

Built-in apps accessible via `peersky://p2p/`:
- `chat/` - Peer-to-peer messaging over Hyper
- `upload/` - Decentralized file storage
- `editor/` - Build and publish websites
- `wiki/` - Browse Wikipedia over IPFS

### Extension System ✅ COMPLETE

**Current Status**: UI implementation complete - Ready for backend integration

**Implemented Features**:
- **Extension Management UI**: Complete grid-based interface with modern design
- **Extension Cards**: Icon, name, description, enable/disable toggles, remove/update actions
- **Install from URL**: Input field with Chrome Web Store URL installation capability
- **Responsive Design**: 2-column desktop layout, 1-column mobile layout
- **Interactive Features**: Remove confirmation dialogs, toggle state management, console logging

**UI Architecture**:
- **HTML Structure**: `src/pages/extensions.html` - Clean semantic markup with settings integration
- **CSS Styling**: `src/pages/theme/extensions-page.css` - Grid system, card styling, responsive breakpoints
- **JavaScript Logic**: `src/pages/static/js/extensions-page.js` - Event handling, state management, DOM manipulation

**Backend Integration Ready**:
- **ExtensionManager**: Backend class structure (`src/extensions/index.js`) ready for connection
- **IPC Handlers**: Communication layer (`src/ipc-handlers/`) prepared for UI integration
- **Mock Data**: Realistic extension data structure for testing and development

**Ready for**:
- Backend ExtensionManager integration
- Real Chrome Web Store URL processing
- Actual extension file loading and management
- Browser toolbar integration (actions, popups, badges)

### Cross-Browser Compatibility

- **Theme Protocol**: `browser://theme/` for standardized theming across P2P browsers
- **Agregore Compatibility**: Apps designed to run in both Peersky and Agregore browsers

## File Organization Conventions

- **Protocol Handlers**: Each protocol has its own file in `src/protocols/`
- **IPC Communication**: Clear separation of main/renderer process communication
- **Scoped File Access**: Uses ScopedFS library for secure file operations
- **CSS Custom Properties**: Advanced theming system with CSS variables
- **No Framework**: Pure JavaScript with modern DOM APIs, no React/Vue/etc.

## Build Configuration

- **electron-builder**: Cross-platform building with comprehensive platform support
- **Target Platforms**: macOS (x64/arm64), Windows (NSIS/portable), Linux (deb/AppImage/pacman/apk)
- **ASAR Packaging**: Enabled for performance optimization
- **Auto-updater**: GitHub-based automatic updates via electron-updater

## Security Considerations

- **Protocol Sandboxing**: Each protocol handler is isolated
- **Extension Security**: Manifest validation and permission system for extensions
- **File System Access**: Scoped access to prevent directory traversal attacks
- **ENS Resolution**: Local caching for resolved ENS content to reduce RPC calls

## Development Notes

- Currently uses manual testing - no automated test suite
- Extension system is work in progress (see GitHub issues)
- Tab system supports both horizontal and vertical layouts
- Built-in context menu with standard browser actions
- Keyboard shortcuts follow standard browser conventions
- Window state persistence happens automatically on app close/restart

### Electron Import Issues (Critical)

**Problem**: Electron is a CommonJS module, not an ES module. Named imports like `import { app, session } from 'electron'` will fail with:
```
Named export 'app' not found. The requested module 'electron' is a CommonJS module, which may not support all module.exports as named exports.
```

**Solution**: Always use default import + destructuring:
```javascript
// ❌ Wrong - will fail
import { app, session, ipcMain } from 'electron';

// ✅ Correct - always use this pattern  
import pkg from 'electron';
const { app, session, ipcMain } = pkg;
```

**Files affected**: Any file importing from 'electron' (`src/main.js`, `src/extensions/index.js`, `src/ipc-handlers/extensions.js`, etc.)

### Session 1 Extension System Issues (Critical)

**Problem**: Session 1 implementation broke the UI by creating session mismatch:
- Protocols registered on `session.fromPartition('persist:peersky')`  
- But webviews still using `partition=""` (defaultSession)
- Result: Blank pages because webviews can't access protocols

**Root Cause**: In `src/pages/tab-bar.js:505`:
```javascript
webview.setAttribute("partition", ""); // Uses defaultSession
// But protocols are on persist:peersky session
```

**Additional Issues Introduced**:
- Missing preload path in BrowserWindow creation
- Security settings inconsistency (nodeIntegration: true with extensions)

### Debugging Blank Pages (From GPT Analysis)

**1. Add Diagnostics First**:
```javascript
// Add to BrowserWindow creation
win.webContents.on('did-fail-load', (_e, code, desc, url) => {
  console.error('[did-fail-load]', code, desc, url);
});
win.webContents.on('render-process-gone', (_e, details) => {
  console.error('[render-process-gone]', details);
});
win.webContents.openDevTools({ mode: 'detach' }); // temporarily
```

**2. Session Consistency**: 
- Use same session for protocol registration AND all windows/webviews
- Either all on `persist:peersky` OR all on defaultSession

**3. Preload Path Verification**:
```javascript
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(__dirname, 'pages', 'unified-preload.js');
console.log('[preload exists?]', existsSync(PRELOAD_PATH));
```

**4. WebView Partition Alignment**:
```javascript
// If protocols on persist:peersky, then:
webview.setAttribute('partition', 'persist:peersky');
// NOT partition=""
```