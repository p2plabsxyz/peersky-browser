/**
 * A page's blocked fetch, XHR and beacon calls get an empty answer on the
 * device instead of a network error, through real Electron: a page that waits
 * on one of its blocked calls, as Figma's sign-up dialog did, carries on, and
 * nothing reaches the tracker. Scripts and images still fail as blocked. A
 * request the blocker answers with a data: address, as uBlock does every fetch
 * and XHR it redirects, gets that content, which Electron alone refuses.
 */

import { expect } from 'chai'
import os from 'os'
import path from 'path'
import { mkdtemp, rm } from 'fs/promises'
import { spawn } from 'child_process'
import electronPath from 'electron'

const RESULT_PREFIX = '__PEERSKY_RESULT__'

function runHarness (userDataDir, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const harness = path.resolve('test/integration/blocked-calls-harness.mjs')
    const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electronPath, [harness, '--user-data', userDataDir], {
      cwd: path.resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error(`Harness timed out\nstdout=${stdout}\nstderr=${stderr}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split(/\r?\n/).find((text) => text.startsWith(RESULT_PREFIX))
      if (!line) return reject(new Error(`Harness gave no result\nstdout=${stdout}\nstderr=${stderr}`))
      resolve(JSON.parse(line.slice(RESULT_PREFIX.length)))
    })
  })
}

describe('blocked calls answered on the device', function () {
  this.timeout(120000)

  let userDataDir
  let result

  before(async function () {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'peersky-blocked-calls-'))
    result = await runHarness(userDataDir)
    if (result.error) throw new Error(result.error)
  })

  after(async function () {
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true })
  })

  it("answers the page's fetch and XHR calls with an empty 204, under its CSP", () => {
    for (const name of ['fetch', 'json', 'keepalive']) {
      expect(result.calls[name], name).to.deep.equal({ status: 204, body: '' })
    }
    expect(result.calls.xhr).to.deep.equal({ status: 204 })
    expect(result.calls.beacon).to.equal(true)
  })

  it('still blocks scripts and images', () => {
    expect(result.calls.script).to.equal('blocked')
    expect(result.calls.image).to.equal('blocked')
  })

  it("gives a request the blocker answers with data: that content, under the page's CSP", () => {
    expect(result.calls.stub).to.deep.equal({ status: 200, body: 'stub' })
    expect(result.calls['stub-json']).to.deep.equal({ status: 200, body: 'stub' })
    expect(result.calls['stub-xhr']).to.deep.equal({ status: 200, body: 'stub' })
    expect(result.calls['stub-script']).to.equal('ran')
  })

  it('finds nothing at an address no request was given', () => {
    expect(result.calls.guess).to.equal(404)
  })

  it('needs the help: Electron alone will not follow a redirect to data:', () => {
    expect(result.calls.raw).to.have.property('error')
  })

  it('sends nothing to the tracker', () => {
    expect(result.reached).to.deep.equal([])
  })
})
