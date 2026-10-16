// The AI memory holds every chat with the AI. PeerSky's own pages read and
// change it; an app added under peersky://myapps came from somewhere else, as
// did every website, so neither may read it or clear it.

import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, readFile } from 'fs/promises'
import esmock from 'esmock'

const NORMAL = { name: 'normal' }

async function loadMemory () {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-llm-memory-'))
  const handlers = new Map()
  await esmock.strict('../../src/llm-memory.js', {
    '../../src/settings-manager.js': { default: { settings: { llm: { memoryEnabled: true } } } },
    '../../src/session.js': { getIncognitoSession: () => ({ name: 'incognito' }) }
  }, {
    electron: {
      app: { getPath: () => userData },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
    }
  })
  return (url, channel, arg) => handlers.get(channel)({ senderFrame: url === null ? null : { url }, sender: { session: NORMAL } }, arg)
}

const CHANNELS = ['llm-memory-add', 'llm-memory-list', 'llm-memory-list-sessions', 'llm-memory-clear', 'llm-memory-enabled']

describe('the AI memory', function () {
  it("answers PeerSky's own pages", async function () {
    const call = await loadMemory()
    const entry = { appId: 'ai-chat', sessionId: 's1', role: 'user', content: 'a private question' }
    expect((await call('peersky://p2p/ai-chat/', 'llm-memory-add', entry)).ok).to.equal(true)
    expect((await call('peersky://p2p/p2pmd/', 'llm-memory-list', { sessionId: 's1' })).map((item) => item.content)).to.deep.equal(['a private question'])
    expect(await call('peersky://settings/', 'llm-memory-enabled')).to.equal(true)
  })

  it('refuses an app added under peersky://myapps, a website, and a frame that is gone', async function () {
    const call = await loadMemory()
    await call('peersky://p2p/ai-chat/', 'llm-memory-add', { appId: 'ai-chat', sessionId: 's1', role: 'user', content: 'a private question' })
    for (const url of ['peersky://myapps/notes/index.html', 'peersky://MyApps/notes/', 'https://site.example/', `hyper://${'a'.repeat(52)}/`, 'file:///tmp/page.html', null]) {
      for (const channel of CHANNELS) {
        let error = null
        try {
          await call(url, channel, {})
        } catch (caught) {
          error = caught
        }
        expect(error?.message, `${channel} from ${url}`).to.equal('Forbidden')
      }
    }
    // The refused clears cleared nothing.
    expect(await call('peersky://p2p/ai-chat/', 'llm-memory-list', {})).to.have.length(1)
  })

  it('is handed by the preload to none but PeerSky\'s own pages', async function () {
    const preload = await readFile(new URL('../../src/pages/unified-preload.js', import.meta.url), 'utf8')
    expect(preload).to.match(/if \(pageProtocol === 'peersky:' && !isUserP2PApp\) \{\s*contextBridge\.exposeInMainWorld\('llmMemory'/)
    expect(preload.match(/exposeInMainWorld\('llmMemory'/g)).to.have.length(1)
  })
})
