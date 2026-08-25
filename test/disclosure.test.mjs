import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  compileDisclosurePatterns,
  scanDisclosureContent,
} from '../src/disclosure/content-scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const command = path.join(root, 'src', 'commands', 'disclosure.mjs')
const sentinel = 'SENTINELXYZ'
const denylist = JSON.stringify({ patterns: [{ pattern: sentinel, label: 'synthetic-private-marker' }] })

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function makeRepo(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-consumer-disclosure-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  git(repo, ['init', '--quiet'])
  fs.writeFileSync(path.join(repo, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(repo, 'note.md'), 'invented public fixture\n')
  git(repo, ['add', '.gitignore', 'note.md'])
  return repo
}

function run(repo, args = [], env = {}) {
  const result = spawnSync(process.execPath, [command, 'check', '--root', repo, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ATELIER_DENYLIST_JSON: '', ...env },
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

test('the library scans a clean staged index', (t) => {
  const repo = makeRepo(t)
  const report = scanDisclosureContent({ root: repo, staged: true })
  assert.equal(report.ok, true)
  assert.equal(report.scannedFiles, 2)
})

test('the command fails closed when a private denylist is unavailable', (t) => {
  const repo = makeRepo(t)
  const result = run(repo, ['--staged'])
  assert.equal(result.status, 2, result.output)
  assert.match(result.output, /private denylist unavailable/)
})

test('structural-only is an explicit reduced-verdict lane', (t) => {
  const repo = makeRepo(t)
  const clean = run(repo, ['--staged', '--structural-only'])
  assert.equal(clean.status, 0, clean.output)

  const localPath = ['', 'Users', 'invented', 'scratch'].join('/')
  fs.writeFileSync(path.join(repo, 'path.md'), `${localPath}\n`)
  git(repo, ['add', 'path.md'])
  const blocked = run(repo, ['--staged', '--structural-only'])
  assert.equal(blocked.status, 1, blocked.output)
  assert.match(blocked.output, /absolute user path/)
})

test('an ignored private denylist catches content without echoing the match', (t) => {
  const repo = makeRepo(t)
  fs.mkdirSync(path.join(repo, '.atelier-local'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.atelier-local', 'disclosure-denylist.json'), denylist)
  fs.writeFileSync(path.join(repo, 'candidate.md'), `invented ${sentinel} content\n`)
  git(repo, ['add', 'candidate.md'])

  const result = run(repo, ['--staged'])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /synthetic-private-marker/)
  assert.doesNotMatch(result.output, new RegExp(sentinel))
})

test('a tracked repository-local denylist is refused even when gitignore covers it', (t) => {
  const repo = makeRepo(t)
  fs.mkdirSync(path.join(repo, '.atelier-local'), { recursive: true })
  const denylistPath = path.join(repo, '.atelier-local', 'disclosure-denylist.json')
  fs.writeFileSync(denylistPath, denylist)
  git(repo, ['add', '--force', '.atelier-local/disclosure-denylist.json'])

  const result = run(repo, ['--staged'])
  assert.equal(result.status, 2, result.output)
  assert.match(result.output, /refusing a Git-tracked private denylist/)
})

test('an alternate-cased tracked denylist cannot masquerade as local on a case-insensitive filesystem', (t) => {
  const repo = makeRepo(t)
  fs.mkdirSync(path.join(repo, '.Atelier-Local'), { recursive: true })
  const trackedPath = path.join(repo, '.Atelier-Local', 'disclosure-denylist.json')
  fs.writeFileSync(trackedPath, denylist)
  git(repo, ['add', '--force', '.Atelier-Local/disclosure-denylist.json'])

  const defaultPath = path.join(repo, '.atelier-local', 'disclosure-denylist.json')
  if (!fs.existsSync(defaultPath)) {
    t.skip('filesystem is case-sensitive')
    return
  }

  const result = run(repo, ['--staged'])
  assert.equal(result.status, 2, result.output)
  assert.match(result.output, /refusing a Git-tracked private denylist/)
})

test('staged mode scans the index blob rather than a later worktree edit', (t) => {
  const repo = makeRepo(t)
  fs.writeFileSync(path.join(repo, 'candidate.md'), `${sentinel} staged\n`)
  git(repo, ['add', 'candidate.md'])
  fs.writeFileSync(path.join(repo, 'candidate.md'), 'scrubbed only in the worktree\n')

  const result = run(repo, ['--staged'], { ATELIER_DENYLIST_JSON: denylist })
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /synthetic-private-marker/)
  assert.doesNotMatch(result.output, new RegExp(sentinel))
})

test('binary content can be made blocking for public text-only surfaces', (t) => {
  const repo = makeRepo(t)
  fs.writeFileSync(path.join(repo, 'opaque.bin'), Buffer.from([0, 1, 2, 3]))
  git(repo, ['add', 'opaque.bin'])

  const result = run(repo, ['--staged', '--structural-only', '--fail-on-binary'])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /binary content cannot be disclosure-scanned/)
})

test('invalid UTF-8 cannot pass as scanned public text', (t) => {
  const repo = makeRepo(t)
  fs.writeFileSync(path.join(repo, 'invalid.txt'), Buffer.from([0xc3, 0x28]))
  git(repo, ['add', 'invalid.txt'])

  const result = run(repo, ['--staged', '--structural-only', '--fail-on-binary'])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /binary content cannot be disclosure-scanned/)
})

test('untrusted mode suppresses labels, paths, and match values', (t) => {
  const repo = makeRepo(t)
  fs.writeFileSync(path.join(repo, 'candidate.md'), `${sentinel}\n`)
  git(repo, ['add', 'candidate.md'])
  const result = run(repo, ['--staged', '--untrusted'], { ATELIER_DENYLIST_JSON: denylist })
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /findings present/)
  assert.doesNotMatch(result.output, /synthetic-private-marker|candidate\.md/)
  assert.doesNotMatch(result.output, new RegExp(sentinel))
})

test('denylist compilation strips stateful flags and reports only the label on failure', () => {
  const compiled = compileDisclosurePatterns([{ pattern: 'invented', flags: 'gy', label: 'synthetic' }])
  assert.equal(compiled[0].pattern.global, false)
  assert.equal(compiled[0].pattern.sticky, false)
  assert.throws(
    () => compileDisclosurePatterns([{ pattern: '[', label: 'broken-synthetic' }]),
    /broken-synthetic/,
  )
})
