import { expect } from 'chai'
import esmock from 'esmock'
import sinon from 'sinon'
import os from 'os'
import path from 'path'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'

// P2PMD keeps its notes in its own page's storage, so the desktop asks P2PMD's
// own page for them, loaded out of sight in the session its tabs use.
async function loadNotes ({ pageExists = true, answer = null, loadError = null } = {}) {
  const pagesPath = await mkdtemp(path.join(os.tmpdir(), 'peersky-p2pmd-pages-'))
  if (pageExists) {
    await mkdir(path.join(pagesPath, 'p2p', 'p2pmd'), { recursive: true })
    await writeFile(path.join(pagesPath, 'p2p', 'p2pmd', 'notes-transfer.html'), '<!doctype html>')
  }

  const views = []
  class WebContentsView {
    constructor (options) {
      this.options = options
      this.webContents = {
        loadURL: sinon.stub().callsFake(async () => {
          if (loadError) throw loadError
        }),
        executeJavaScript: sinon.stub().callsFake(async (code) => typeof answer === 'function' ? answer(code) : answer),
        close: sinon.stub()
      }
      views.push(this)
    }
  }
  const session = { name: 'the tabs session' }
  const module = await esmock.strict('../../src/backup/p2pmd-notes.js', {
    electron: { default: { WebContentsView }, WebContentsView },
    '../../src/session.js': { getBrowserSession: () => session },
    '../../src/protocols/peersky-protocol.js': { getPagesPath: () => pagesPath },
    '../../src/logger.js': { createLogger: () => ({ info () {}, warn () {}, error () {} }) }
  })
  return { ...module, views, session }
}

describe('P2PMD notes in a transfer', function () {
  afterEach(function () {
    sinon.restore()
  })

  it('goes in a transfer only when this P2PMD has its notes page', async function () {
    expect((await loadNotes()).p2pmdTakesTransfers()).to.equal(true)
    // An install that moved P2PMD to a main without the page.
    expect((await loadNotes({ pageExists: false })).p2pmdTakesTransfers()).to.equal(false)
  })

  it('asks P2PMD\'s own page for the notes, in the session its tabs use, and closes it', async function () {
    const notes = { version: 1, name: 'Ada', notes: [{ key: `hs://${'q'.repeat(52)}`, role: 'host', content: '# Plans' }] }
    const { exportP2pmdNotes, views, session } = await loadNotes({ answer: notes })

    expect(await exportP2pmdNotes()).to.deep.equal(notes)

    expect(views).to.have.length(1)
    const [view] = views
    expect(view.options.webPreferences).to.deep.include({ session, sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(view.webContents.loadURL.calledOnceWith('peersky://p2p/p2pmd/notes-transfer.html')).to.equal(true)
    expect(view.webContents.executeJavaScript.firstCall.args[0]).to.include('return window.p2pmdNotes.export()')
    expect(view.webContents.close.calledOnce).to.equal(true)
  })

  it('sends nothing when there is nothing, or when P2PMD cannot say', async function () {
    expect(await (await loadNotes({ answer: { version: 1, name: '', notes: [] } })).exportP2pmdNotes()).to.equal(null)

    const missing = await loadNotes({ pageExists: false, answer: { version: 1, name: 'Ada', notes: [] } })
    expect(await missing.exportP2pmdNotes()).to.equal(null)
    expect(missing.views).to.have.length(0)

    const broken = await loadNotes({ loadError: new Error('ERR_FILE_NOT_FOUND') })
    expect(await broken.exportP2pmdNotes()).to.equal(null)
    expect(broken.views[0].webContents.close.calledOnce).to.equal(true)
  })

  it('hands a phone\'s notes to P2PMD as data, never as code', async function () {
    const transfer = {
      version: 1,
      name: 'Bea"); window.evil = true; ("',
      notes: [{ key: `hs://${'q'.repeat(52)}`, role: 'host', content: '</script><script>evil()</script>' }]
    }
    const { importP2pmdNotes, views } = await loadNotes({ answer: { ok: true, added: 1 } })

    expect(await importP2pmdNotes(transfer)).to.deep.equal({ ok: true, added: 1 })
    // The whole transfer is one JSON literal in the call.
    expect(views[0].webContents.executeJavaScript.firstCall.args[0]).to.include(`return window.p2pmdNotes.import(${JSON.stringify(transfer)})`)
    expect(views[0].webContents.close.calledOnce).to.equal(true)
  })

  it('takes nothing when P2PMD cannot', async function () {
    expect(await (await loadNotes({ pageExists: false })).importP2pmdNotes({ version: 1, notes: [] })).to.deep.equal({ ok: false, added: 0 })
    expect(await (await loadNotes({ loadError: new Error('gone') })).importP2pmdNotes({ version: 1, notes: [] })).to.deep.equal({ ok: false, added: 0 })
    expect(await (await loadNotes({ answer: { ok: false, added: 0 } })).importP2pmdNotes({ version: 2 })).to.deep.equal({ ok: false, added: 0 })
    expect(await (await loadNotes()).importP2pmdNotes(null)).to.deep.equal({ ok: false, added: 0 })
  })
})
