import { expect } from 'chai'
import { readFile } from 'fs/promises'

// The × beside a download says Remove from history, and it deleted the file
// from disk, with no question asked and nothing in the Trash.
describe('removing a download from the Downloads page', function () {
  it('takes it off the list and leaves the file where it was saved', async function () {
    const main = (await readFile(new URL('../../src/main.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
    const start = main.indexOf("ipcMain.handle('remove-download'")
    const handler = main.slice(start, main.indexOf('\n})\n', start))
    expect(start).to.be.greaterThan(-1)
    expect(handler).to.contain('downloads = downloads.filter((d) => d.id !== id)')
    expect(handler).to.not.match(/unlink|trashItem|\brm\(/)
    const page = await readFile(new URL('../../src/pages/static/js/downloads.js', import.meta.url), 'utf8')
    expect(page).to.contain('title="Remove from history"')
  })
})
