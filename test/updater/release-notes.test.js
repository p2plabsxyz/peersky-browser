// The notes a desktop release gets once its builds are up: the pull requests
// merged here since the last release, and the ones merged in each built-in app
// over the same time.

import { expect } from 'chai'
import fs from 'node:fs'
import { readFile } from 'fs/promises'
import {
  NOTES_END,
  NOTES_START,
  formatAppSections,
  insertAppSections,
  mergeNotes,
  previousRelease,
  readSubmodules,
  writeReleaseNotes
} from '../../scripts/release-notes.js'

const gitmodules = await readFile(new URL('../../.gitmodules', import.meta.url), 'utf8')
const workflow = (await readFile(new URL('../../.github/workflows/build.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')

const GENERATED = [
  "## What's Changed",
  '* feat: tab groups by @akhileshthite in https://github.com/p2plabsxyz/peersky-browser/pull/232',
  '',
  '**Full Changelog**: https://github.com/p2plabsxyz/peersky-browser/compare/v1.0.0-beta.29...v1.0.0-beta.30'
].join('\n')

const pull = (number, title, mergedAt, repo = 'p2plabsxyz/peerchat') => ({
  number,
  title,
  mergedAt,
  author: { login: 'akhileshthite' },
  url: `https://github.com/${repo}/pull/${number}`
})

describe('release notes', function () {
  describe('the built-in apps', function () {
    it('reads each submodule with its GitHub repository and the app it is', function () {
      const apps = readSubmodules(gitmodules)
      expect(apps.map((app) => app.folder)).to.include.members(['peerchat', 'hyperdrive', 'p2pmd', 'peertunes'])
      expect(apps.find((app) => app.folder === 'peerchat')).to.deep.equal({ folder: 'peerchat', name: 'PeerChat', repo: 'p2plabsxyz/peerchat' })
      // The Hyperdrive app lives in a repository named otherwise.
      expect(apps.find((app) => app.folder === 'hyperdrive')).to.deep.equal({ folder: 'hyperdrive', name: 'Hyperdrive', repo: 'p2plabsxyz/upload' })
    })

    it('reads Windows line endings, urls ending in .git, and skips what is not on GitHub', function () {
      const text = '[submodule "a"]\r\n\tpath = src/pages/p2p/p2pmd\r\n\turl = https://github.com/p2plabsxyz/p2pmd.git\r\n[submodule "b"]\r\n\tpath = x/other\r\n\turl = https://example.com/other\r\n'
      expect(readSubmodules(text)).to.deep.equal([{ folder: 'p2pmd', name: 'P2PMD', repo: 'p2plabsxyz/p2pmd' }])
    })
  })

  describe('the release before', function () {
    const releases = [
      { tag_name: 'v1.0.0-beta.30', created_at: '2026-10-11T10:00:00Z' },
      { tag_name: 'v1.0.0-beta.31', created_at: '2026-10-20T10:00:00Z', draft: true },
      { tag_name: 'v1.0.0-beta.28', created_at: '2026-09-20T10:00:00Z' },
      { tag_name: 'v1.0.0-beta.29', created_at: '2026-10-01T10:00:00Z' }
    ]

    it('is the newest made before this one', function () {
      expect(previousRelease(releases, releases[0]).tag_name).to.equal('v1.0.0-beta.29')
    })

    it('is never a draft, nor the release itself', function () {
      expect(previousRelease(releases, { tag_name: 'v1.0.0-beta.32', created_at: '2026-10-25T10:00:00Z' }).tag_name).to.equal('v1.0.0-beta.30')
      expect(previousRelease([releases[0]], releases[0])).to.equal(null)
    })
  })

  describe('the text', function () {
    it('lists each app\'s pull requests oldest first, and leaves out an app with none', function () {
      const sections = formatAppSections([
        { name: 'PeerChat', pulls: [pull(38, 'feat: signed messages', '2026-10-10T09:00:00Z'), pull(36, 'fix: mentions', '2026-10-05T09:00:00Z')] },
        { name: 'Wiki', pulls: [] },
        { name: 'Hyperdrive', pulls: [pull(3, 'feat: From your devices ', '2026-10-10T08:00:00Z', 'p2plabsxyz/upload')] }
      ])
      expect(sections).to.equal([
        '## Built-in apps',
        '',
        '### PeerChat',
        '* fix: mentions by @akhileshthite in https://github.com/p2plabsxyz/peerchat/pull/36',
        '* feat: signed messages by @akhileshthite in https://github.com/p2plabsxyz/peerchat/pull/38',
        '',
        '### Hyperdrive',
        '* feat: From your devices by @akhileshthite in https://github.com/p2plabsxyz/upload/pull/3',
        ''
      ].join('\n'))
      expect(formatAppSections([{ name: 'Wiki', pulls: [] }])).to.equal('')
    })

    it('puts the apps above the Full Changelog link, or at the end when there is none', function () {
      const sections = '## Built-in apps\n\n### PeerChat\n* fix\n'
      const notes = insertAppSections(GENERATED, sections)
      expect(notes.indexOf('## Built-in apps')).to.be.above(notes.indexOf("## What's Changed"))
      expect(notes.indexOf('## Built-in apps')).to.be.below(notes.indexOf('**Full Changelog**'))
      expect(insertAppSections('## What\'s Changed\n* a', sections)).to.equal("## What's Changed\n* a\n\n## Built-in apps\n\n### PeerChat\n* fix")
      expect(insertAppSections(GENERATED, '')).to.equal(GENERATED)
    })

    it('keeps notes someone wrote on the release, and a run again replaces only its own', function () {
      const first = mergeNotes('Thanks to everyone who tested beta 29.', 'generated one')
      expect(first).to.equal(`Thanks to everyone who tested beta 29.\n\n${NOTES_START}\ngenerated one\n${NOTES_END}`)
      const again = mergeNotes(first, 'generated two')
      expect(again).to.equal(`Thanks to everyone who tested beta 29.\n\n${NOTES_START}\ngenerated two\n${NOTES_END}`)
      expect(mergeNotes('', 'generated')).to.equal(`${NOTES_START}\ngenerated\n${NOTES_END}`)
    })
  })

  describe('writing them', function () {
    function fakeGh ({ releases }) {
      const calls = []
      let written = null
      const gh = (args) => {
        calls.push(args)
        const [command, target] = args
        if (command === 'api' && target.endsWith('/releases?per_page=50')) return JSON.stringify(releases)
        if (command === 'api' && args.includes('-X')) return JSON.stringify({ body: GENERATED })
        // The API answers with the name a repository has now.
        if (command === 'api' && args.includes('--jq')) return `${target === 'repos/p2plabsxyz/upload' ? 'p2plabsxyz/hyperdrive' : target.slice(6)}\tmain\n`
        if (command === 'pr') {
          const repo = args[args.indexOf('-R') + 1]
          return JSON.stringify(repo === 'p2plabsxyz/peerchat' ? [pull(38, 'feat: signed messages', '2026-10-10T09:00:00Z')] : [])
        }
        if (command === 'release') {
          written = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8')
          return ''
        }
        throw new Error(`unexpected gh ${args.join(' ')}`)
      }
      return { gh, calls, written: () => written }
    }
    const quiet = { log () {} }

    it('writes this repository\'s notes and the apps\' since the release before', async function () {
      const releases = [
        { tag_name: 'v1.0.0-beta.30', created_at: '2026-10-11T10:00:00Z', body: '' },
        { tag_name: 'v1.0.0-beta.29', created_at: '2026-10-01T10:00:00Z' }
      ]
      const fake = fakeGh({ releases })
      await writeReleaseNotes({ tag: 'v1.0.0-beta.30', repo: 'p2plabsxyz/peersky-browser', gitmodules, gh: fake.gh, now: new Date('2026-10-11T10:30:00Z'), log: quiet })

      const generate = fake.calls.find((args) => args.includes('-X'))
      expect(generate).to.include('tag_name=v1.0.0-beta.30').and.include('previous_tag_name=v1.0.0-beta.29')
      const lists = fake.calls.filter((args) => args[0] === 'pr')
      // Search does not follow a renamed repository, so the lists ask by the name it has now.
      expect(lists.map((args) => args[args.indexOf('-R') + 1])).to.include.members(['p2plabsxyz/peerchat', 'p2plabsxyz/hyperdrive'])
      expect(lists.map((args) => args[args.indexOf('-R') + 1])).to.not.include('p2plabsxyz/upload')
      for (const args of lists) {
        expect(args).to.include('merged:2026-10-01T10:00:00.000Z..2026-10-11T10:30:00.000Z')
        expect(args[args.indexOf('--base') + 1]).to.equal('main')
      }

      const edit = fake.calls.find((args) => args[0] === 'release')
      expect(edit.slice(0, 4)).to.deep.equal(['release', 'edit', 'v1.0.0-beta.30', '-R'])
      const notes = fake.written()
      expect(notes).to.contain('* feat: tab groups by @akhileshthite')
      expect(notes).to.contain('### PeerChat\n* feat: signed messages by @akhileshthite in https://github.com/p2plabsxyz/peerchat/pull/38')
      expect(notes).to.not.contain('### Hyperdrive')
      expect(notes.indexOf('### PeerChat')).to.be.below(notes.indexOf('**Full Changelog**'))
      expect(notes.startsWith(NOTES_START)).to.equal(true)
    })

    it('writes nothing while the builds have not made the release yet', async function () {
      const fake = fakeGh({ releases: [{ tag_name: 'v1.0.0-beta.29', created_at: '2026-10-01T10:00:00Z' }] })
      const body = await writeReleaseNotes({ tag: 'v1.0.0-beta.30', repo: 'p2plabsxyz/peersky-browser', gitmodules, gh: fake.gh, log: quiet })
      expect(body).to.equal(null)
      expect(fake.calls.some((args) => args[0] === 'release')).to.equal(false)
    })
  })

  describe('the release workflow', function () {
    const job = workflow.slice(workflow.indexOf('\n  notes:\n'))

    it('writes the notes after the builds, for a version tag, even when one build failed', function () {
      expect(job).to.contain('needs: release')
      // eslint-disable-next-line no-template-curly-in-string
      expect(job).to.contain("if: ${{ !cancelled() && startsWith(github.ref, 'refs/tags/v') }}")
      expect(job).to.contain('contents: write')
    })

    it('runs the script with the workflow\'s token and the tag it was pushed with', function () {
      // eslint-disable-next-line no-template-curly-in-string
      expect(job).to.contain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
      expect(job).to.contain('run: node scripts/release-notes.js "$GITHUB_REF_NAME"')
    })
  })
})
