// Runs in Electron for blocked-calls.e2e.test.js: a page with a strict
// Content-Security-Policy calls a tracker that a stand-in blocker cancels, the
// way uBlock does through main.js's webRequest bridge, and reports what each
// call got and what reached the tracker.
import http from 'http'
import path from 'path'
import electron from 'electron'

import {
  BLOCKED_SCHEME,
  BLOCKED_SCHEME_PRIVILEGES,
  answerBlockedCall,
  blockedCallHandler
} from '../../src/extensions/blocked-requests.js'

const { app, protocol, session, BrowserWindow } = electron

const RESULT_PREFIX = '__PEERSKY_RESULT__'

const userDataAt = process.argv.indexOf('--user-data')
if (userDataAt !== -1) app.setPath('userData', path.resolve(process.argv[userDataAt + 1]))

protocol.registerSchemesAsPrivileged([{ scheme: BLOCKED_SCHEME, privileges: BLOCKED_SCHEME_PRIVILEGES }])

function listen (handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function run () {
  const reached = []
  const tracker = await listen((req, res) => {
    reached.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' })
    res.end('sent')
  })
  const trackerUrl = `http://127.0.0.1:${tracker.address().port}`
  const page = await listen((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline' ${trackerUrl}; img-src ${trackerUrl}; connect-src 'self' ${trackerUrl}`
    })
    res.end('<!doctype html><title>blocked calls</title>')
  })

  const ses = session.fromPartition('blocked-calls-test')
  ses.protocol.handle(BLOCKED_SCHEME, blockedCallHandler)
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    // The stand-in blocker: everything bound for the tracker is cancelled.
    const blocked = details.url.startsWith(trackerUrl) ? { cancel: true } : {}
    callback(answerBlockedCall(details, blocked))
  })

  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } })
  // The page is served from localhost, so the tracker is another site.
  await win.loadURL(`http://localhost:${page.address().port}/`)
  const calls = await win.webContents.executeJavaScript(`(async () => {
    const tracker = ${JSON.stringify(trackerUrl)}
    const out = {}
    const call = async (name, init) => {
      try {
        const response = await fetch(tracker + '/' + name, init)
        out[name] = { status: response.status, body: await response.text() }
      } catch (error) {
        out[name] = { error: error.message }
      }
    }
    await call('fetch', {})
    await call('json', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{"event":"show"}' })
    await call('keepalive', { method: 'POST', keepalive: true, body: 'event=show' })
    out.xhr = await new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', tracker + '/xhr')
      xhr.onload = () => resolve({ status: xhr.status })
      xhr.onerror = () => resolve({ error: 'network error' })
      xhr.send('event=show')
    })
    out.beacon = navigator.sendBeacon(tracker + '/beacon', 'event=show')
    const element = (tag, attr) => new Promise((resolve) => {
      const el = document.createElement(tag)
      el.onload = () => resolve('loaded')
      el.onerror = () => resolve('blocked')
      el[attr] = tracker + '/' + tag
      document.body.appendChild(el)
    })
    out.script = await element('script', 'src')
    out.image = await element('img', 'src')
    await new Promise((resolve) => setTimeout(resolve, 500))
    return out
  })()`)

  console.log(`${RESULT_PREFIX}${JSON.stringify({ calls, reached })}`)
  tracker.close()
  page.close()
}

app.whenReady()
  .then(run)
  .catch((error) => console.log(`${RESULT_PREFIX}${JSON.stringify({ error: error?.stack || String(error) })}`))
  .finally(() => {
    app.exit(0)
    setTimeout(() => process.exit(0), 3000)
  })
