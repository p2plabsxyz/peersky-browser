const { ipcRenderer,contextBridge } = require('electron')

// API Bridging for Bookmark feature

const url = window.location.href;
console.log(url)
const isBookmarkPage = url.includes('peersky://bookmarks') || url.includes('peersky://bookmarks.html');
if (isBookmarkPage) {
  console.log('Bookmark page detected, exposing bookmark API');
  contextBridge.exposeInMainWorld('electronAPI', {
    getBookmarks: () => ipcRenderer.invoke('get-bookmarks'),
    deleteBookmark: (url) => ipcRenderer.invoke('delete-bookmark', { url }),

  })
  console.log('Bookmark API exposed');  
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
      sheet.insertRule('body { background: #000; color: #fff }', sheet.cssRules.length)
    }
  } catch (err) {
    console.error('Error injecting default styles:', err)
  }
})
