// An Ollama model that takes images was reported as text-only, so the settings
// page said "Input: text" and the chat hid its attach button.

import { expect } from 'chai'
import esmock from 'esmock'
import { readFile } from 'fs/promises'

const source = await readFile(new URL('../../src/llm.js', import.meta.url), 'utf8')
const { detectVision } = await esmock.strict('../../src/llm.js', {
  electron: { ipcMain: { handle () {}, on () {} }, dialog: {}, shell: {} },
  '../../src/settings-manager.js': { default: { settings: {} } }
})

describe('spotting an Ollama model that takes images', function () {
  it('believes the capabilities the model reports', function () {
    expect(detectVision('medgemma:4b', { capabilities: ['completion', 'vision'] })).to.equal(true)
    expect(detectVision('MODEL', { capabilities: ['VISION'] })).to.equal(true)
  })

  it('says no for a model that reports none', function () {
    expect(detectVision('qwen2.5-coder:3b', { capabilities: ['completion', 'tools'] })).to.equal(false)
    expect(detectVision('llama3:8b', {})).to.equal(false)
  })

  it('still reads the older signals, for Ollama versions that report no capabilities', function () {
    expect(detectVision('x', { details: { families: ['llama', 'clip'] } })).to.equal(true)
    expect(detectVision('x', { details: { families: ['mllama'] } })).to.equal(true)
    expect(detectVision('x', { projector_info: {} })).to.equal(true)
    expect(detectVision('x', { model_info: { 'clip.type': 'vit' } })).to.equal(true)
    expect(detectVision('llava:13b', {})).to.equal(true)
    expect(detectVision('qwen2.5-vl:7b', {})).to.equal(true)
  })

  it('survives a malformed response instead of throwing', function () {
    expect(detectVision('x', { capabilities: 'vision' })).to.equal(false)
    expect(detectVision('x', { details: { families: [null, 7] } })).to.equal(false)
    expect(detectVision('x')).to.equal(false)
  })
})

describe('asking Ollama about a model', function () {
  it('names it both ways, since the old key is deprecated and the new one is required', function () {
    const call = source.slice(source.indexOf('/api/show'), source.indexOf('/api/show') + 300)
    expect(call).to.contain('JSON.stringify({ model, name: model })')
  })
})
