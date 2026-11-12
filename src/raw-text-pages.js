// Raw code and text, as Chromium shows a .txt, .md or .json file, is white on
// black in PeerSky. The page preload (pages/unified-preload.js) styles it, but
// only once the page has loaded and its stylesheet has come back from the main
// process, which took seconds with many tabs open, and a large file can take
// as long to load. Meanwhile Chromium had already turned the text white for
// the dark system theme, over the white page behind web content (.tab-webview
// in pages/theme/index.css), so the text was white on white.
// Inserted from here as the page commits, the colours are there while it still
// loads, and a page's own rules cannot stop them: raw.githubusercontent.com
// sends a sandbox Content-Security-Policy.

// Chromium's raw text page: a single <pre> it marks with pre-wrap.
export const RAW_TEXT_CSS = 'html:has(> body > pre:first-child[style*="pre-wrap"]) { background: #000; color: #fff; }'

export function darkenRawTextPages (wc) {
  wc.on('did-navigate', () => {
    wc.insertCSS(RAW_TEXT_CSS).catch(() => {})
  })
}
