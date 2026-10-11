/**
 * Writes the notes of a desktop release on GitHub once its builds are up: the
 * pull requests merged here since the last release, as GitHub lists them, then
 * the ones merged in each built-in app over the same time.
 *
 * A build takes every app's default branch as it is when the build runs (the
 * postinstall updates the submodules with --remote), so an app's pull requests
 * count from when the last release was made, not from the commit recorded here.
 *
 *   node scripts/release-notes.js v1.0.0-beta.30
 *
 * Needs the gh CLI, signed in or given GH_TOKEN.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// A run again replaces what is between these, and nothing someone wrote.
export const NOTES_START = '<!-- release-notes -->'
export const NOTES_END = '<!-- /release-notes -->'

const APP_NAMES = {
  peerchat: 'PeerChat',
  hyperdrive: 'Hyperdrive',
  p2pmd: 'P2PMD',
  peertunes: 'PeerTunes',
  peerpad: 'PeerPad',
  'ai-chat': 'AI Chat',
  wiki: 'Wiki'
}

/** The submodules in a .gitmodules file, each with its GitHub repository. */
export function readSubmodules (text) {
  const entries = []
  let current = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[submodule')) {
      current = {}
      entries.push(current)
    } else if (current) {
      const match = line.match(/^(path|url)\s*=\s*(.+)$/)
      if (match) current[match[1]] = match[2].trim()
    }
  }
  return entries
    .map((entry) => {
      const repo = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(entry.url || '')?.[1]
      const folder = (entry.path || '').split('/').pop()
      return repo && folder ? { folder, name: APP_NAMES[folder] || folder, repo } : null
    })
    .filter(Boolean)
}

/** The release made before this one, leaving drafts out. */
export function previousRelease (releases, current) {
  const before = new Date(current?.created_at || Date.now()).getTime()
  return (releases || [])
    .filter((release) => !release.draft && release.tag_name !== current?.tag_name && new Date(release.created_at).getTime() < before)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null
}

/** A section for each app that had pull requests merged, oldest first. */
export function formatAppSections (apps) {
  const sections = (apps || [])
    .filter((app) => app.pulls?.length > 0)
    .map((app) => [
      `### ${app.name}`,
      ...[...app.pulls]
        .sort((a, b) => new Date(a.mergedAt) - new Date(b.mergedAt))
        .map((pull) => `* ${String(pull.title).trim()}${pull.author?.login ? ` by @${pull.author.login}` : ''} in ${pull.url}`)
    ].join('\n'))
  return sections.length > 0 ? `## Built-in apps\n\n${sections.join('\n\n')}\n` : ''
}

/** Puts the apps' sections in GitHub's notes, above the Full Changelog link. */
export function insertAppSections (notes, sections) {
  const text = String(notes || '').trim()
  if (!sections) return text
  const at = text.indexOf('**Full Changelog**')
  if (at === -1) return `${text}\n\n${sections}`.trim()
  return `${text.slice(0, at).trimEnd()}\n\n${sections}\n${text.slice(at)}`.trim()
}

/**
 * The release's new body. Notes someone wrote on the release stay, above the
 * generated ones, and a run again replaces only what an earlier run wrote.
 */
export function mergeNotes (body, generated) {
  const block = `${NOTES_START}\n${String(generated || '').trim()}\n${NOTES_END}`
  const text = String(body || '')
  const start = text.indexOf(NOTES_START)
  const end = text.indexOf(NOTES_END)
  if (start !== -1 && end > start) {
    return `${text.slice(0, start)}${block}${text.slice(end + NOTES_END.length)}`.trim()
  }
  return text.trim() ? `${text.trim()}\n\n${block}` : block
}

export async function writeReleaseNotes ({ tag, repo, gitmodules, gh, now = new Date(), log = console }) {
  const json = (args) => JSON.parse(gh(args))
  const releases = json(['api', `repos/${repo}/releases?per_page=50`])
  const current = releases.find((release) => release.tag_name === tag)
  if (!current) {
    log.log(`[release-notes] There is no release for ${tag} yet, so nothing to write.`)
    return null
  }
  const previous = previousRelease(releases, current)
  const generate = ['api', '-X', 'POST', `repos/${repo}/releases/generate-notes`, '-f', `tag_name=${tag}`]
  if (previous) generate.push('-f', `previous_tag_name=${previous.tag_name}`)
  const notes = json(generate).body

  // With no release before, every pull request an app ever had would count.
  const apps = []
  if (previous) {
    const merged = `merged:${new Date(previous.created_at).toISOString()}..${now.toISOString()}`
    for (const app of readSubmodules(gitmodules)) {
      // The API follows a renamed repository and search does not: the
      // Hyperdrive app's is still "upload" in .gitmodules.
      const [name, base] = gh(['api', `repos/${app.repo}`, '--jq', '[.full_name, .default_branch] | @tsv']).trim().split('\t')
      const pulls = json(['pr', 'list', '-R', name, '--state', 'merged', '--base', base, '--search', merged, '--limit', '100', '--json', 'number,title,author,url,mergedAt'])
      apps.push({ ...app, repo: name, pulls })
    }
  }

  const body = mergeNotes(current.body, insertAppSections(notes, formatAppSections(apps)))
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-')), 'notes.md')
  fs.writeFileSync(file, `${body}\n`)
  gh(['release', 'edit', tag, '-R', repo, '--notes-file', file])
  log.log(`[release-notes] Wrote the notes of ${tag}${previous ? `, since ${previous.tag_name}` : ''}.`)
  return body
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2]
  if (!tag) {
    console.error('Usage: node scripts/release-notes.js <tag>')
    process.exit(1)
  }
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  await writeReleaseNotes({
    tag,
    repo: process.env.GITHUB_REPOSITORY || 'p2plabsxyz/peersky-browser',
    gitmodules: fs.readFileSync(path.join(root, '.gitmodules'), 'utf8'),
    gh: (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  })
}
