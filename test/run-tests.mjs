#!/usr/bin/env node
/**
 * Runs the test suites and prints one combined tally.
 *
 * Suites are discovered from the "test:*" scripts in package.json rather than
 * from the directory layout, because the two do not line up: test/fixtures
 * holds no specs, and test/p2p is split across test:p2p and test:p2p:e2e, the
 * latter needing its own env and a clean data dir.
 *
 * Each script's spec globs are expanded so that suites wholly contained in
 * another (test:p2p:bt inside test:p2p) are skipped instead of counted twice.
 * Specs no script claims are still run, grouped per directory with default
 * flags, so adding test/<name>/ needs no wiring; they are marked * in the
 * summary as a nudge to add a script when the defaults are not right.
 *
 * A failing suite does not stop the rest; the point is one full picture.
 * Exits non-zero if anything failed.
 *
 * Usage: node test/run-tests.mjs [suite ...]
 */

import { spawn } from 'node:child_process'
import { readFile, glob } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SPEC_GLOB = 'test/**/*.test.js'
const DEFAULT_TIMEOUT = 20000
const COUNTS = /^\s*(\d+)\s+(passing|failing|pending)\b/gm
/** Quoted or bare tokens that name a spec file or a glob over spec files. */
const SPEC_ARGS = /"([^"]+\.test\.js)"|'([^']+\.test\.js)'|(\S+\.test\.js)/g

const normalize = (p) => path.relative(ROOT, path.resolve(ROOT, p)).split(path.sep).join('/')

async function expandSpecs (script) {
  const specs = new Set()
  for (const match of script.matchAll(SPEC_ARGS)) {
    const pattern = match[1] || match[2] || match[3]
    for await (const file of glob(pattern, { cwd: ROOT })) {
      specs.add(normalize(file))
    }
  }
  return specs
}

const isSubset = (a, b) => a.size > 0 && a.size < b.size && [...a].every((f) => b.has(f))

async function discoverSuites (scripts) {
  const candidates = []
  for (const [name, script] of Object.entries(scripts)) {
    if (!name.startsWith('test:')) continue
    // Skip aggregates, including this runner, so it cannot invoke itself.
    if (script.includes('run-tests.mjs')) continue
    candidates.push({ suite: name.slice('test:'.length), specs: await expandSpecs(script) })
  }

  // Drop suites whose specs another suite already covers.
  return candidates.filter((c) => !candidates.some((other) => other !== c && isSubset(c.specs, other.specs)))
}

async function findOrphanSpecs (covered) {
  const orphans = []
  for await (const file of glob(SPEC_GLOB, { cwd: ROOT })) {
    const rel = normalize(file)
    if (!covered.has(rel)) orphans.push(rel)
  }
  return orphans.sort()
}

function parseCounts (output) {
  const totals = { passing: 0, failing: 0, pending: 0 }
  for (const [, count, kind] of output.matchAll(COUNTS)) totals[kind] += Number(count)
  return totals
}

/**
 * Specs no test:* script covers, grouped into a suite per directory so a new
 * test/<name>/ folder runs without any wiring. Explicit scripts still win: only
 * files nothing else claims land here.
 */
function implicitSuites (orphans) {
  const byDir = new Map()
  for (const file of orphans) {
    const dir = file.split('/')[1] ?? 'test'
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(file)
  }
  return [...byDir].map(([suite, files]) => ({ suite, files, implicit: true }))
}

function runSuite ({ suite, files, implicit }) {
  return new Promise((resolve) => {
    // --exit so an auto-discovered suite that leaks a handle cannot hang CI.
    const [command, args] = implicit
      ? ['npx', ['mocha', ...files, '--timeout', String(DEFAULT_TIMEOUT), '--exit']]
      : ['npm', ['run', `test:${suite}`]]

    const child = spawn(command, args, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      stdio: ['inherit', 'pipe', 'pipe']
    })

    let output = ''
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on('data', (chunk) => {
        output += chunk
        sink.write(chunk)
      })
    }

    child.on('error', (error) => {
      process.stderr.write(`Failed to start ${suite}: ${error.message}\n`)
      resolve({ suite, implicit, code: 1, passing: 0, failing: 0, pending: 0, crashed: true })
    })

    child.on('close', (code) => {
      const counts = parseCounts(output)
      // A suite can die before mocha prints an epilogue (import error, crash).
      resolve({ suite, implicit, code: code ?? 1, ...counts, crashed: code !== 0 && counts.failing === 0 })
    })
  })
}

const pad = (value, width) => String(value).padEnd(width)

function printSummary (results) {
  const total = results.reduce(
    (acc, r) => ({
      passing: acc.passing + r.passing,
      failing: acc.failing + r.failing,
      pending: acc.pending + r.pending
    }),
    { passing: 0, failing: 0, pending: 0 }
  )

  const width = Math.max(...results.map((r) => r.suite.length), 'SUITE'.length) + 2
  const rule = '='.repeat(width + 34)

  process.stdout.write(`\n${rule}\n`)
  process.stdout.write(`${pad('SUITE', width)}${pad('PASS', 7)}${pad('FAIL', 7)}${pad('SKIP', 7)}RESULT\n`)
  process.stdout.write(`${'-'.repeat(width + 34)}\n`)
  for (const r of results) {
    const status = r.crashed ? 'CRASH' : r.code === 0 ? 'ok' : 'FAILED'
    process.stdout.write(
      `${pad(r.implicit ? `${r.suite} *` : r.suite, width)}${pad(r.passing, 7)}${pad(r.failing, 7)}${pad(r.pending, 7)}${status}\n`
    )
  }
  process.stdout.write(`${'-'.repeat(width + 34)}\n`)
  process.stdout.write(
    `${pad('TOTAL', width)}${pad(total.passing, 7)}${pad(total.failing, 7)}${pad(total.pending, 7)}\n`
  )

  const broken = results.filter((r) => r.code !== 0)
  if (broken.length === 0) {
    process.stdout.write(`\nAll ${results.length} suites passed — ${total.passing} tests.\n`)
  } else {
    process.stdout.write(
      `\n${broken.length} of ${results.length} suites failed: ${broken.map((r) => `test:${r.suite}`).join(', ')}\n`
    )
  }

  const auto = results.filter((r) => r.implicit)
  if (auto.length > 0) {
    const names = auto.map((r) => r.suite).join(', ')
    process.stdout.write(
      `\n* auto-discovered (${names}) — add a test:<name> script to control its flags.\n`
    )
  }

  process.stdout.write(`${rule}\n`)
  return broken.length === 0
}

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
const discovered = await discoverSuites(pkg.scripts || {})

const requested = process.argv.slice(2)
const selected = requested.length
  ? discovered.filter((d) => requested.includes(d.suite))
  : discovered

const unknown = requested.filter((name) => !discovered.some((d) => d.suite === name))
if (unknown.length > 0) {
  process.stderr.write(`Unknown suite(s): ${unknown.join(', ')}\n`)
  process.stderr.write(`Available: ${discovered.map((d) => d.suite).join(', ')}\n`)
  process.exit(1)
}

// Measured against every discovered suite, not just the selected ones, so that
// running a subset does not pick up the rest of the tree.
const covered = new Set(discovered.flatMap((s) => [...s.specs]))

// Only when running everything: an explicit selection means the caller named
// what they wanted.
const implicit = requested.length ? [] : implicitSuites(await findOrphanSpecs(covered))
const toRun = [...selected, ...implicit]

const results = []
for (const suite of toRun) {
  process.stdout.write(`\n──── ${suite.implicit ? `${suite.suite} (auto)` : `test:${suite.suite}`} ────\n`)
  results.push(await runSuite(suite))
}

process.exit(printSummary(results) ? 0 : 1)
