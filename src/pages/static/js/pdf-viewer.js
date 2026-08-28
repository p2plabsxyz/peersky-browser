import * as pdfjs from 'peersky://static/js/vendor/pdfjs/pdf.min.mjs'

pdfjs.GlobalWorkerOptions.workerSrc = 'peersky://static/js/vendor/pdfjs/pdf.worker.min.mjs'

const params = new URL(location.href).searchParams
// The bytes come through peersky:// so the viewer is same-origin with them;
// fetching the remote URL directly would be blocked by CORS.
const fileUrl = params.get('id') ? `peersky://pdf-source/${params.get('id')}` : ''
const fileName = decodeURIComponent(params.get('name') || 'PDF')
const pagesEl = document.getElementById('pages')
const statusEl = document.getElementById('status')
const zoomEl = document.getElementById('zoom')

let doc = null
let scale = 1.2

function setStatus (text) {
  statusEl.textContent = text
  statusEl.style.display = text ? '' : 'none'
}

async function renderPage (page, container) {
  const viewport = page.getViewport({ scale })
  const ratio = window.devicePixelRatio || 1

  const canvas = document.createElement('canvas')
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  canvas.style.width = `${Math.floor(viewport.width)}px`
  canvas.style.height = `${Math.floor(viewport.height)}px`
  container.appendChild(canvas)

  await page.render({
    canvasContext: canvas.getContext('2d'),
    viewport,
    transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]
  }).promise

  // Invisible text over the canvas, so find-in-page and copy work.
  const textLayer = document.createElement('div')
  textLayer.className = 'textLayer'
  textLayer.style.width = `${Math.floor(viewport.width)}px`
  textLayer.style.height = `${Math.floor(viewport.height)}px`
  container.appendChild(textLayer)
  await new pdfjs.TextLayer({
    textContentSource: await page.getTextContent(),
    container: textLayer,
    viewport
  }).render()
}

async function render () {
  pagesEl.replaceChildren()
  zoomEl.textContent = `${Math.round(scale / 1.2 * 100)}%`
  for (let n = 1; n <= doc.numPages; n++) {
    const container = document.createElement('div')
    container.className = 'page'
    pagesEl.appendChild(container)
    await renderPage(await doc.getPage(n), container)
  }
}

async function main () {
  if (!fileUrl) return setStatus('No file specified.')
  document.getElementById('name').textContent = fileName
  document.title = fileName

  try {
    doc = await pdfjs.getDocument({ url: fileUrl }).promise
    setStatus('')
    await render()
  } catch (error) {
    setStatus(`Could not open this PDF: ${error.message}`)
  }
}

document.getElementById('in').addEventListener('click', () => { scale = Math.min(scale * 1.25, 6); render() })
document.getElementById('out').addEventListener('click', () => { scale = Math.max(scale / 1.25, 0.25); render() })
document.getElementById('download').addEventListener('click', () => {
  const a = document.createElement('a')
  a.href = fileUrl
  a.download = fileName
  a.click()
})

main()
