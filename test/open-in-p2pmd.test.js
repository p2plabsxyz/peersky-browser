import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect } from 'chai'
import { urlFromArgv } from '../src/launch-url.js'
import {
  OPEN_IN_P2PMD_FLAG,
  filesFromArgv,
  textFromBytes,
  readFileForNote,
  keepOpenedFile,
  takeOpenedFile,
  p2pmdPageForOpenedFile
} from '../src/open-in-p2pmd.js'

const readPackage = async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const readRepoFile = (rel) => readFile(new URL(`../${rel}`, import.meta.url))

describe('files the OS asks to open in P2PMD', () => {
  describe('finding them in argv', () => {
    it('finds the file the Windows menu item passes after the flag', () => {
      const file = path.join(os.tmpdir(), 'Test notes.md')
      expect(filesFromArgv(['C:\\Peersky\\Peersky Browser.exe', OPEN_IN_P2PMD_FLAG, file])).to.deep.equal([file])
    })

    it('turns the file:// URL a Linux file manager passes into a path', () => {
      const file = path.join(os.tmpdir(), 'Test notes.md')
      const argv = ['/opt/Peersky Browser/peersky-browser', '--enable-accelerated-video', pathToFileURL(file).href]
      expect(filesFromArgv(argv)).to.deep.equal([file])
    })

    it('finds a relative path in the folder the launch came from', () => {
      const cwd = path.join(os.tmpdir(), 'Test folder')
      expect(filesFromArgv(['peersky-browser', 'Test.md'], { cwd })).to.deep.equal([path.join(cwd, 'Test.md')])
    })

    it('skips flags and the app folder of a dev run', () => {
      const cwd = os.tmpdir()
      expect(filesFromArgv(['electron', '.', '--user-data-dir=/tmp/x', '--remote-debugging-port=9333'], { cwd, devRun: true })).to.deep.equal([])
      expect(filesFromArgv(['electron', '--inspect', '.', OPEN_IN_P2PMD_FLAG, 'Test.md'], { cwd, devRun: true }))
        .to.deep.equal([path.join(cwd, 'Test.md')])
    })

    it('leaves links to launch-url.js, and file paths stay out of it', () => {
      const links = ['https://example.com/', 'peersky://settings', 'hyper://abc123/', 'magnet:?xt=urn:btih:deadbeef']
      for (const link of links) {
        expect(filesFromArgv(['Peersky.exe', link]), link).to.deep.equal([])
      }
      const file = pathToFileURL(path.join(os.tmpdir(), 'Test.md')).href
      expect(urlFromArgv(['peersky-browser', file])).to.equal(null)
    })

    it('reads a Windows drive as part of a path, not as a scheme', () => {
      const files = filesFromArgv(['Peersky.exe', OPEN_IN_P2PMD_FLAG, 'C:\\Users\\me\\Test.md'])
      expect(files).to.have.lengthOf(1)
      expect(files[0].endsWith('Test.md')).to.equal(true)
      expect(urlFromArgv(['Peersky.exe', 'C:\\Users\\me\\Test.md'])).to.equal(null)
    })
  })

  describe('what counts as text', () => {
    it('takes UTF-8, with or without a byte order mark', () => {
      expect(textFromBytes(Buffer.from('# Café notes\n'))).to.equal('# Café notes\n')
      expect(textFromBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]))).to.equal('hi')
      expect(textFromBytes(Buffer.alloc(0))).to.equal('')
    })

    it('takes UTF-16 with a byte order mark, as Notepad and PowerShell save it', () => {
      const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('notes ✓', 'utf16le')])
      expect(textFromBytes(little)).to.equal('notes ✓')
      const big = Buffer.from(little).swap16()
      expect(textFromBytes(big)).to.equal('notes ✓')
    })

    it('refuses NUL bytes, which binary files have and text does not', () => {
      expect(textFromBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]))).to.equal(null)
      expect(textFromBytes(Buffer.from('abc\u0000def'))).to.equal(null)
      expect(textFromBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\u0000b', 'utf16le')]))).to.equal(null)
    })

    it('refuses bytes that are not UTF-8', () => {
      // "café" saved as Latin-1.
      expect(textFromBytes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).to.equal(null)
    })
  })

  describe('reading a file for a note', () => {
    let dir

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'peersky-open-in-p2pmd-'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('reads the text and the file name', async () => {
      const file = path.join(dir, 'Test notes.md')
      writeFileSync(file, '# Test\n\nHello\n')
      expect(await readFileForNote(file, { maxBytes: 1024 })).to.deep.equal({ name: 'Test notes.md', content: '# Test\n\nHello\n' })
    })

    it('takes a file right at the limit and refuses one byte more', async () => {
      const atLimit = path.join(dir, 'Test-at-limit.txt')
      const over = path.join(dir, 'Test-over.txt')
      writeFileSync(atLimit, 'a'.repeat(64))
      writeFileSync(over, 'a'.repeat(65))
      expect((await readFileForNote(atLimit, { maxBytes: 64 })).content).to.have.lengthOf(64)
      expect(await readFileForNote(over, { maxBytes: 64 })).to.deep.equal({ name: 'Test-over.txt', error: 'too-big' })
    })

    it('refuses a file that is not text', async () => {
      const file = path.join(dir, 'Test.png')
      writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]))
      expect(await readFileForNote(file, { maxBytes: 1024 })).to.deep.equal({ name: 'Test.png', error: 'not-text' })
    })

    it('says so for a file that is gone or a folder', async () => {
      expect((await readFileForNote(path.join(dir, 'Test-gone.md'), { maxBytes: 1024 })).error).to.equal('missing')
      const folder = path.join(dir, 'Test folder')
      mkdirSync(folder)
      expect((await readFileForNote(folder, { maxBytes: 1024 })).error).to.equal('not-a-file')
    })
  })

  describe('handing the text to the P2PMD page', () => {
    it('opens P2PMD with a random id, never the path or the text', () => {
      const id = keepOpenedFile({ name: 'Test.md', content: 'secret' })
      expect(id).to.match(/^[0-9a-f]{32}$/)
      expect(p2pmdPageForOpenedFile(id)).to.equal(`peersky://p2p/p2pmd/?open=${id}`)
      takeOpenedFile(id)
    })

    it('gives the file once', () => {
      const id = keepOpenedFile({ name: 'Test.md', content: '# Test\n' })
      expect(takeOpenedFile(id)).to.deep.equal({ name: 'Test.md', content: '# Test\n' })
      expect(takeOpenedFile(id)).to.equal(null)
    })

    it('drops a file no page asked for in time', async () => {
      const id = keepOpenedFile({ name: 'Test.md', content: 'x' }, { ttlMs: 10 })
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(takeOpenedFile(id)).to.equal(null)
    })

    it('has nothing for an id it never gave out', () => {
      for (const id of ['0'.repeat(32), '', '__proto__', undefined, null, 42]) {
        expect(takeOpenedFile(id), String(id)).to.equal(null)
      }
    })
  })

  describe('what the installers register', () => {
    it('lists Peersky for text files on macOS without becoming their default app', async () => {
      const { build } = await readPackage()
      const types = build.mac.extendInfo.CFBundleDocumentTypes
      expect(types.flatMap((t) => t.LSItemContentTypes)).to.include.members(['public.plain-text', 'net.daringfireball.markdown', 'public.text'])
      for (const type of types) expect(type.LSHandlerRank).to.equal('Alternate')
      // electron-builder's own fileAssociations would make Peersky the default.
      expect(build.fileAssociations ?? []).to.deep.equal([])
      expect(build.mac.fileAssociations ?? []).to.deep.equal([])
      expect(build.win.fileAssociations ?? []).to.deep.equal([])
    })

    it('gives the Windows menu item the flag and an icon that is a real .ico', async () => {
      const { build } = await readPackage()
      const script = (await readRepoFile(build.nsis.include)).toString()
      expect(script).to.include(`'"$appExe" ${OPEN_IN_P2PMD_FLAG} "%1"'`)
      expect(script).to.include('$INSTDIR\\resources\\p2pmd.ico')
      expect(build.win.extraResources).to.deep.include({ from: 'buildResources/p2pmd.ico', to: 'p2pmd.ico' })
      const ico = await readRepoFile('buildResources/p2pmd.ico')
      expect([...ico.subarray(0, 4)]).to.deep.equal([0, 0, 1, 0])
    })

    it('runs the installed app from the Linux P2PMD entry', async () => {
      const pkg = await readPackage()
      const [desktop, icon] = pkg.build.deb.fpm.map((mapping) => mapping.split('=')[0])
      const entry = (await readRepoFile(desktop)).toString()
      const exec = entry.split(/\r?\n/).find((line) => line.startsWith('Exec='))
      expect(exec).to.equal(`Exec="/opt/${pkg.build.productName}/${pkg.name}" ${pkg.build.linux.executableArgs.join(' ')} ${OPEN_IN_P2PMD_FLAG} %F`)
      expect(entry).to.include('NoDisplay=true')
      expect(await readRepoFile(icon)).to.have.length.greaterThan(0)
      expect(pkg.build.linux.mimeTypes).to.include.members(['text/plain', 'text/markdown'])
    })
  })

  // Finder offers Peersky for every text file, web pages included. A page
  // opened that way shows as a page; only "Open with P2PMD" makes a note of
  // its source.
  it('opens a web page as a page unless P2PMD was asked for', async () => {
    const main = (await readRepoFile('src/main.js')).toString()
    const page = main.match(/const WEB_PAGE_FILE = (\/.+\/i)$/m)[1]
    // eslint-disable-next-line no-new-func
    const isPage = new Function(`return ${page}`)()
    for (const name of ['Test.html', 'Test.HTM', 'Test.xhtml', 'Test.svg']) expect(isPage.test(name), name).to.equal(true)
    for (const name of ['Test.md', 'Test.txt', 'Test.json', 'Test.html.md']) expect(isPage.test(name), name).to.equal(false)
    expect(main).to.match(/if \(!asNote && WEB_PAGE_FILE\.test\(filePath\)\) \{\s*queueLaunchUrl\(pathToFileURL\(filePath\)\.href\)/)
    expect(main).to.include('openFileInP2pmd(file, { explicit, asNote: explicit })')
  })
})
