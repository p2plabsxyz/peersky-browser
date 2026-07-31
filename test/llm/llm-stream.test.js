import { expect } from 'chai'
import http from 'http'
import esmock from 'esmock'

function startServer (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve))
      })
    })
  })
}

function delta (content) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`
}

// Minimal Ollama-compatible stub:
//   GET  /api/tags            -> model list consumed by hasModel()
//   POST /v1/chat/completions -> delegated to onChat
function ollamaStub (onChat) {
  return async (req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'test-model' }] }))
      return
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const raw = await new Promise((resolve) => {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => resolve(body))
      })
      await onChat(JSON.parse(raw), res)
      return
    }
    res.writeHead(404).end()
  }
}

async function loadLLM (origin) {
  return esmock.strict('../../src/llm.js', {
    electron: {
      ipcMain: { handle () {} },
      dialog: { showMessageBox: async () => ({ response: 1 }) },
      shell: { openExternal: async () => {} }
    },
    '../../src/settings-manager.js': {
      default: {
        settings: {
          llm: { enabled: true, apiKey: 'ollama', baseURL: origin, model: 'test-model' },
          aiMesh: { enabled: false, routeChat: false }
        }
      }
    }
  })
}

async function collect (iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk.content)
  return out.join('')
}

const messages = [{ role: 'user', content: 'hi' }]

describe('LLM streaming over the undici agent', function () {
  let ctx

  afterEach(async function () {
    if (ctx) await ctx.close()
    ctx = null
  })

  it('yields deltas from a server-sent event stream', async function () {
    ctx = await startServer(ollamaStub(async (body, res) => {
      expect(body.stream).to.equal(true)
      expect(body.model).to.equal('test-model')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(delta('Hello'))
      res.write(delta(' world'))
      res.write('data: [DONE]\n')
      res.end()
    }))

    const llm = await loadLLM(ctx.origin)
    expect(await collect(llm.chatStream({ messages }))).to.equal('Hello world')
  })

  it('reassembles an event split across TCP writes', async function () {
    ctx = await startServer(ollamaStub(async (body, res) => {
      const frame = delta('split')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Break the frame mid-JSON so the reader has to buffer the remainder.
      res.write(frame.slice(0, 18))
      await new Promise((resolve) => setTimeout(resolve, 20))
      res.write(frame.slice(18))
      res.write(delta('-ok'))
      res.write('data: [DONE]\n')
      res.end()
    }))

    const llm = await loadLLM(ctx.origin)
    expect(await collect(llm.chatStream({ messages }))).to.equal('split-ok')
  })

  it('stops at [DONE] and ignores later events', async function () {
    ctx = await startServer(ollamaStub(async (body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(delta('kept'))
      res.write('data: [DONE]\n')
      res.write(delta('dropped'))
      res.end()
    }))

    const llm = await loadLLM(ctx.origin)
    expect(await collect(llm.chatStream({ messages }))).to.equal('kept')
  })

  it('skips malformed event payloads without aborting the stream', async function () {
    ctx = await startServer(ollamaStub(async (body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(delta('a'))
      res.write('data: {not-json\n')
      res.write(delta('b'))
      res.write('data: [DONE]\n')
      res.end()
    }))

    const llm = await loadLLM(ctx.origin)
    expect(await collect(llm.chatStream({ messages }))).to.equal('ab')
  })

  it('raises a guided error when the model cannot be loaded', async function () {
    ctx = await startServer(ollamaStub(async (body, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'model failed to load' } }))
    }))

    const llm = await loadLLM(ctx.origin)

    try {
      await collect(llm.chatStream({ messages }))
      throw new Error('expected chatStream to reject')
    } catch (error) {
      expect(error.message).to.contain('failed to load')
      expect(error.message).to.contain('ollama run test-model')
    }
  })

  it('returns a complete message for non-streaming chat', async function () {
    ctx = await startServer(ollamaStub(async (body, res) => {
      expect(body.stream).to.equal(false)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'done' } }]
      }))
    }))

    const llm = await loadLLM(ctx.origin)
    const message = await llm.chat({ messages })

    expect(message).to.deep.equal({ role: 'assistant', content: 'done' })
  })

  it('fails when the configured model is not installed', async function () {
    ctx = await startServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'some-other-model' }] }))
        return
      }
      res.writeHead(500).end()
    })

    const llm = await loadLLM(ctx.origin)

    try {
      await collect(llm.chatStream({ messages }))
      throw new Error('expected chatStream to reject')
    } catch (error) {
      expect(error.message).to.contain("Model 'test-model' is not installed")
    }
  })
})
