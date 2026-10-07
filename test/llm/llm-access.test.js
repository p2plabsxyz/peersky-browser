// Any hyper:// or ipfs:// page could call window.llm without asking, so a page
// anyone published could spend the cloud key set up in Settings. PeerSky's own
// pages still use AI freely; every other page with the bridge asks first.

import { expect } from 'chai'
import http from 'http'
import os from 'os'
import path from 'path'
import { mkdtemp } from 'fs/promises'
import esmock from 'esmock'

const NORMAL = { name: 'normal' }
const INCOGNITO = { name: 'incognito' }

function pageEvent (url, session = NORMAL) {
  return { senderFrame: url === null ? null : { url }, sender: { session } }
}

// The real permission store, with Electron's dialog answering from a list.
async function loadAccess (answers = []) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'peersky-llm-access-'))
  const prompts = []
  const dialog = {
    async showMessageBox (...args) {
      prompts.push(args[args.length - 1])
      return { response: answers.length ? answers.shift() : 1 }
    }
  }
  const mod = await esmock('../../src/llm-access.js', {
    '../../src/session.js': { getIncognitoSession: () => INCOGNITO }
  }, {
    electron: {
      app: { getPath: () => userData },
      dialog,
      BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] }
    }
  })
  return { ...mod, prompts }
}

describe('who may use window.llm', function () {
  it("lets PeerSky's own pages use AI without asking", async function () {
    const { mayUseLLM, prompts } = await loadAccess()
    for (const url of ['peersky://p2p/ai-chat/', 'peersky://p2p/p2pmd/', 'peersky://settings']) {
      expect(await mayUseLLM(pageEvent(url)), url).to.equal(true)
    }
    expect(prompts).to.have.length(0)
  })

  it('asks a hyper:// page once, and remembers Allow always', async function () {
    const { mayUseLLM, prompts } = await loadAccess([0])
    expect(await mayUseLLM(pageEvent('hyper://abc123/app/index.html'))).to.equal(true)
    expect(await mayUseLLM(pageEvent('hyper://abc123/other.html'))).to.equal(true)
    expect(prompts).to.have.length(1)
    expect(prompts[0].message).to.equal('Allow "AI"?')
    expect(prompts[0].detail).to.match(/^hyper:\/\/abc123\n\n/)
    expect(prompts[0].buttons).to.deep.equal(['Allow always', 'Allow this time', 'Block'])
  })

  it('refuses a blocked page from then on, without asking again', async function () {
    const { mayUseLLM, prompts } = await loadAccess([2])
    const event = pageEvent('ipfs://bafyabc/')
    expect(await mayUseLLM(event)).to.equal(false)
    expect(await mayUseLLM(event)).to.equal(false)
    expect(await mayUseLLM(event, { ask: false })).to.equal(false)
    expect(prompts).to.have.length(1)
  })

  it('lets the quiet check through for a page never asked, without a prompt', async function () {
    const { mayUseLLM, prompts } = await loadAccess()
    expect(await mayUseLLM(pageEvent('hyper://never-asked/'), { ask: false })).to.equal(true)
    expect(prompts).to.have.length(0)
  })

  it('asks on every other page that gets the bridge, once per site', async function () {
    const { mayUseLLM, prompts } = await loadAccess()
    const pages = {
      'ipfs://bafyabc/index.html': 'ipfs://bafyabc',
      'ipns://example.org/': 'ipns://example.org',
      'hs://abc/': 'hs://abc',
      'file:///tmp/page.html': 'file://',
      'peersky://myapps/app1/': 'peersky://myapps',
      'http://localhost:8080/': 'http://localhost:8080',
      'https://agregore.mauve.moe/docs/': 'https://agregore.mauve.moe'
    }
    for (const url of Object.keys(pages)) {
      expect(await mayUseLLM(pageEvent(url)), url).to.equal(true)
    }
    expect(prompts.map(p => p.detail.split('\n')[0])).to.deep.equal(Object.values(pages))
  })

  it('refuses other websites and frames that are gone, without a prompt', async function () {
    const { mayUseLLM, prompts } = await loadAccess()
    for (const url of ['https://example.com/', 'about:blank', '', null]) {
      expect(await mayUseLLM(pageEvent(url)), String(url)).to.equal(false)
    }
    expect(prompts).to.have.length(0)
  })

  it('shows one prompt for calls that arrive together', async function () {
    const { mayUseLLM, prompts } = await loadAccess([1])
    const event = pageEvent('hyper://together/')
    expect(await Promise.all([mayUseLLM(event), mayUseLLM(event)])).to.deep.equal([true, true])
    expect(prompts).to.have.length(1)
  })

  it('keeps an answer given in incognito out of the normal profile', async function () {
    const { mayUseLLM, prompts } = await loadAccess([0, 2])
    expect(await mayUseLLM(pageEvent('hyper://shared/', INCOGNITO))).to.equal(true)
    expect(prompts[0].buttons).to.deep.equal(['Allow', 'Block'])
    expect(await mayUseLLM(pageEvent('hyper://shared/'))).to.equal(false)
    expect(prompts).to.have.length(2)
  })
})

function startModel () {
  let chats = 0
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      chats++
      await new Promise((resolve) => { req.on('end', resolve); req.resume() })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hi there' } }] }))
      return
    }
    res.writeHead(404).end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      chats: () => chats,
      close: () => new Promise((resolve) => server.close(resolve))
    }))
  })
}

async function loadHandlers ({ allowed, enabled = true, origin }) {
  const handlers = {}
  const checks = []
  const llm = await esmock.strict('../../src/llm.js', {
    electron: {
      ipcMain: { handle (name, fn) { handlers[name] = fn } },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      shell: { openExternal: async () => {} }
    },
    '../../src/settings-manager.js': {
      default: { settings: { llm: { enabled, apiKey: 'ollama', baseURL: origin, model: 'test-model' } } }
    },
    '../../src/llm-access.js': {
      mayUseLLM: async (_event, opts) => { checks.push(opts || {}); return allowed }
    }
  })
  return { handlers, checks, NOT_ALLOWED: llm.NOT_ALLOWED }
}

async function rejectionOf (promise) {
  try {
    await promise
  } catch (err) {
    return err.message
  }
  throw new Error('expected the call to be refused')
}

const event = pageEvent('hyper://somebody/')
const messages = [{ role: 'user', content: 'hi' }]

describe('the window.llm calls in the main process', function () {
  let model

  beforeEach(async function () { model = await startModel() })
  afterEach(async function () { await model.close() })

  it('turn a refused page away before anything reaches the model', async function () {
    const { handlers, NOT_ALLOWED } = await loadHandlers({ allowed: false, origin: model.origin })
    expect(await rejectionOf(handlers['llm-chat'](event, { messages }))).to.equal(NOT_ALLOWED)
    expect(await rejectionOf(handlers['llm-complete'](event, { prompt: 'hi' }))).to.equal(NOT_ALLOWED)
    expect(await rejectionOf(handlers['llm-chat-stream'](event, { messages }))).to.equal(NOT_ALLOWED)
    expect(await rejectionOf(handlers['llm-complete-stream'](event, { prompt: 'hi' }))).to.equal(NOT_ALLOWED)
    expect(await handlers['llm-model-info'](event)).to.deep.equal({ model: '', vision: false })
    expect(await handlers['llm-supported'](event)).to.equal(false)
    expect(model.chats()).to.equal(0)
  })

  it('answer a page that is allowed', async function () {
    const { handlers } = await loadHandlers({ allowed: true, origin: model.origin })
    expect(await handlers['llm-chat'](event, { messages })).to.deep.equal({ role: 'assistant', content: 'hi there' })
    expect(await handlers['llm-supported'](event)).to.equal(true)
    expect(model.chats()).to.equal(1)
  })

  it('never ask while AI is off in Settings', async function () {
    const { handlers, checks } = await loadHandlers({ allowed: true, enabled: false, origin: model.origin })
    expect(await rejectionOf(handlers['llm-chat'](event, { messages }))).to.equal('LLM API is disabled')
    expect(await rejectionOf(handlers['llm-chat-stream'](event, { messages }))).to.equal('LLM API is disabled')
    expect(await handlers['llm-supported'](event)).to.equal(false)
    expect(await handlers['llm-model-info'](event)).to.deep.equal({ model: '', vision: false })
    expect(checks).to.have.length(0)
  })

  it('check support without a prompt, and ask on the first real call', async function () {
    const { handlers, checks } = await loadHandlers({ allowed: true, origin: model.origin })
    await handlers['llm-supported'](event)
    await handlers['llm-chat'](event, { messages })
    expect(checks).to.deep.equal([{ ask: false }, {}])
  })
})
