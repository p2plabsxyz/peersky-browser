// Chromium in Electron decodes no Dolby or DTS sound, so a torrent's .mkv
// played silent with nothing saying why. Its tab now says so.

import { expect } from 'chai'
import { EventEmitter } from 'events'
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { unplayableSoundOf, soundNoteText, soundNoteScript, noteUnplayableSound, HEAD_SCRIPT, MEDIA_PAGE_CHECK } from '../src/media-sound-notes.js'

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

// A Matroska head with the given codec IDs, in the order of their tracks.
function matroskaHead (...codecs) {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64), ...codecs.map((id) => Buffer.concat([Buffer.from([0x86, 0x80 | id.length]), Buffer.from(id, 'latin1'), Buffer.alloc(32)]))])
}

// A tab whose page answers the media-page check and reads `head` as its own start.
function fakeTab (url, { mediaPage = true, head = null } = {}) {
  const wc = new EventEmitter()
  wc.scripts = []
  wc.getURL = () => url
  wc.isDestroyed = () => false
  wc.executeJavaScript = async (code) => {
    wc.scripts.push(code)
    if (code === MEDIA_PAGE_CHECK) return mediaPage
    if (code === HEAD_SCRIPT) return head && head.toString('latin1')
    return undefined
  }
  return wc
}

const noted = (wc) => wc.scripts.find((code) => code.includes('peersky-sound-note'))
const headReads = (wc) => wc.scripts.filter((code) => code === HEAD_SCRIPT).length

async function settle (wc) {
  wc.emit('dom-ready')
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('sound a video tab cannot play', function () {
  it('names Dolby and DTS sound from a Matroska or MP4 head', function () {
    expect(unplayableSoundOf(matroskaHead('V_MPEGH/ISO/HEVC', 'A_EAC3', 'S_TEXT/UTF8'))).to.equal('Dolby Digital Plus (E-AC-3)')
    expect(unplayableSoundOf(matroskaHead('V_MPEG4/ISO/AVC', 'A_AC3'))).to.equal('Dolby Digital (AC-3)')
    expect(unplayableSoundOf(matroskaHead('V_MPEG4/ISO/AVC', 'A_DTS'))).to.equal('DTS')
    expect(unplayableSoundOf(matroskaHead('V_MPEG4/ISO/AVC', 'A_TRUEHD'))).to.equal('Dolby TrueHD')
    expect(unplayableSoundOf(Buffer.from('....stsd........ec-3....', 'latin1'))).to.equal('Dolby Digital Plus (E-AC-3)')
  })

  it('finds nothing in a file with sound this engine plays', function () {
    expect(unplayableSoundOf(matroskaHead('V_MPEG4/ISO/AVC', 'A_AAC'))).to.equal(null)
    expect(unplayableSoundOf(matroskaHead('V_VP9', 'A_OPUS'))).to.equal(null)
  })

  it('names the first sound track when a file has two', function () {
    expect(unplayableSoundOf(matroskaHead('V_MPEG4/ISO/AVC', 'A_DTS', 'A_EAC3'))).to.equal('DTS')
  })

  it('has a torrent\'s video read its own start and shows the note there', async function () {
    const wc = fakeTab('bt://abc123/The.Movie.2025.1080p.DDP5.1.mkv', { head: matroskaHead('V_MPEGH/ISO/HEVC', 'A_EAC3') })
    noteUnplayableSound(wc)
    await settle(wc)
    expect(headReads(wc)).to.equal(1)
    expect(noted(wc)).to.include(JSON.stringify(soundNoteText('Dolby Digital Plus (E-AC-3)')))
  })

  // The file:// gate turns away a page's fetch of a local file.
  it('reads a local video from disk', async function () {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sound-note-'))
    const file = path.join(dir, 'clip.mkv')
    writeFileSync(file, Buffer.concat([matroskaHead('V_MPEG4/ISO/AVC', 'A_DTS'), Buffer.alloc(300 * 1024)]))
    const wc = fakeTab('file://' + file)
    noteUnplayableSound(wc)
    await settle(wc)
    expect(headReads(wc)).to.equal(0)
    expect(noted(wc)).to.include(JSON.stringify(soundNoteText('DTS')))
  })

  it('reads at most the first 256 KB', function () {
    expect(HEAD_SCRIPT).to.include("Range: 'bytes=0-262143'")
    expect(HEAD_SCRIPT).to.include('while (size < 262144)')
    expect(HEAD_SCRIPT).to.include('reader.cancel()')
    expect(() => new Function(HEAD_SCRIPT)).not.to.throw() // eslint-disable-line no-new-func
  })

  it('leaves pages that are not a video alone', async function () {
    for (const [url, options] of [['https://example.com/', {}], ['bt://abc123/movie.mkv', { mediaPage: false }]]) {
      const wc = fakeTab(url, { ...options, head: matroskaHead('A_EAC3') })
      noteUnplayableSound(wc)
      await settle(wc)
      expect(headReads(wc), url).to.equal(0)
      expect(noted(wc), url).to.equal(undefined)
    }
  })

  it('knows Chromium\'s media page by its type, so an HTML page cannot pass for one', function () {
    expect(MEDIA_PAGE_CHECK).to.include("document.contentType.startsWith('video/')")
  })

  it('says nothing about a video whose sound plays', async function () {
    const wc = fakeTab('hyper://abc/clip.mkv', { head: matroskaHead('V_MPEG4/ISO/AVC', 'A_AAC') })
    noteUnplayableSound(wc)
    await settle(wc)
    expect(noted(wc)).to.equal(undefined)
  })

  it('shows the note only once the playing video has decoded a picture and no sound', function () {
    const script = soundNoteScript('words')
    expect(script).to.include('video.webkitVideoDecodedByteCount > 0')
    expect(script).to.include('video.webkitAudioDecodedByteCount !== 0')
    expect(script).to.include('"words"')
    expect(() => new Function(script)).not.to.throw() // eslint-disable-line no-new-func
  })

  it('watches every tab', function () {
    const main = readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8')
    expect(main).to.match(/darkenRawTextPages\(wc\)\s+noteUnplayableSound\(wc\)/)
  })
})
