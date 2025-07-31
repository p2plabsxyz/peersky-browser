const { ipcRenderer,contextBridge } = require('electron')

const url = window.location.href;
const isBookmarkPage = url.includes('peersky://bookmarks');
const isTabsPage = url.includes('peersky://tabs');

if (isBookmarkPage) {
  // Expose the bookmark API to the renderer process
  contextBridge.exposeInMainWorld('electronAPI', {
    getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
    deleteBookmark: (url) => ipcRenderer.invoke('delete-bookmark', { url })
  })
} else if (isTabsPage) {
  contextBridge.exposeInMainWorld('electronAPI', {
    getTabs: () => ipcRenderer.invoke('get-tabs'),
    closeTab: (id) => ipcRenderer.invoke('close-tab', id),
    activateTab: (id) => ipcRenderer.invoke('activate-tab', id),
    groupAction: (action, groupId) => ipcRenderer.invoke('group-action', { action, groupId })
  })
}

const HAS_SHEET = `
  [...document.styleSheets].some(s => {
    try { return !!s.cssRules } catch { return false }
  }) || !!document.querySelector('style,link[rel="stylesheet"]')
`

window.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1) skip pages that already have CSS
    const has = (new Function(`return ${HAS_SHEET}`))()
    if (!has) {
      // 2) ask main for vars.css & base.css
      const [varsCss, baseCss] = await Promise.all([
        ipcRenderer.invoke('peersky-read-css', 'vars'),
        ipcRenderer.invoke('peersky-read-css', 'base')
      ])

      // 3) inject as inline <style>
      const style = document.createElement('style')
      style.textContent = varsCss + '\n' + baseCss
      document.head.appendChild(style)
    }

    function isXMLContent() {
      // Check if the document contains common XML/RSS elements or <pre> tag
      return (
        window.location.pathname.endsWith('.xml') ||
        document.querySelector('rss, feed, body > pre') !== null
      )
    }
    
    if (isXMLContent()) {
      const sheet = document.styleSheets[document.styleSheets.length - 1]
      sheet.insertRule('body,body pre { background: #000; color: #fff }', sheet.cssRules.length)
    }
  } catch (err) {
    console.error('Error injecting default styles:', err)
  }
})
