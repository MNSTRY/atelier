import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const script = path.join(packageRoot, 'scripts', 'check-repo-disclosure.mjs')

const AUTHOR_NAME = 'Erik Desrosiers'
const AUTHOR_EMAIL = 'erik@mnstry.ai'

// The planted secret lives only in temp repos; the fake denylist names it so
// tests can assert the label is printed while the matched text never is.
const SENTINEL = 'SENTINELXYZ'
const SENTINEL_DENYLIST = JSON.stringify({ patterns: [{ pattern: SENTINEL, label: 'test-sentinel' }] })

function git(dir, args, env = {}) {
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-disclosure-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '--quiet'])
  git(dir, ['config', 'user.name', AUTHOR_NAME])
  git(dir, ['config', 'user.email', AUTHOR_EMAIL])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

function writeAndCommit(dir, relPath, content, message = 'add file', env = {}) {
  fs.mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true })
  fs.writeFileSync(path.join(dir, relPath), content)
  git(dir, ['add', relPath])
  git(dir, ['commit', '--quiet', '-m', message], env)
}

// Runs the checker with a deterministic denylist environment: the sentinel
// denylist by default, no fail-open acknowledgment. Pass env overrides (an
// empty string unsets, since the script treats blank env vars as absent).
function runChecker(dir, args = [], env = {}) {
  const result = spawnSync(process.execPath, [script, '--root', dir, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ATELIER_DENYLIST_JSON: SENTINEL_DENYLIST,
      ATELIER_ALLOW_MISSING_DENYLIST: '',
      ...env,
    },
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

test('a clean repo passes the content scan', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  const { status, output } = runChecker(dir)
  assert.equal(status, 0, output)
  assert.match(output, /\[repo:check\] clean/)
})

test('a planted denylist match reports label and location but never the matched text', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'src/leak.txt', `line one\nthe ${SENTINEL} marker\n`)
  const { status, output } = runChecker(dir)
  assert.equal(status, 1, output)
  assert.match(output, /test-sentinel/)
  assert.match(output, /src\/leak\.txt:2/)
  assert.ok(!output.includes(SENTINEL), 'log-safety: matched text must never be printed')
})

test('a missing denylist fails closed with a config error', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  const { status, output } = runChecker(dir, [], { ATELIER_DENYLIST_JSON: '' })
  assert.equal(status, 2, output)
  assert.match(output, /denylist unavailable/)
})

test('ATELIER_ALLOW_MISSING_DENYLIST=1 acknowledges a structural-only run', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  const { status, output } = runChecker(dir, [], {
    ATELIER_DENYLIST_JSON: '',
    ATELIER_ALLOW_MISSING_DENYLIST: '1',
  })
  assert.equal(status, 0, output)
  assert.match(output, /structural patterns only/)
})

test('--structural-only is the intentional no-denylist lane', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'src/leak.txt', `the ${SENTINEL} marker\n`)
  const { status, output } = runChecker(dir, ['--structural-only'], { ATELIER_DENYLIST_JSON: '' })
  assert.equal(status, 0, output)
})

test('structural patterns catch an absolute user path', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'see /Users/nobody/scratch for the trace\n')
  const { status, output } = runChecker(dir, ['--structural-only'])
  assert.equal(status, 1, output)
  assert.match(output, /absolute user path/)
  assert.match(output, /docs\/note\.md:1/)
})

test('the checker sources are structurally self-excluded, denylist patterns are not', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'scripts/check-repo-disclosure.mjs', 'const example = /\\/Users\\//\n')
  assert.equal(runChecker(dir, ['--structural-only']).status, 0, 'structural literal in the checker itself is excluded')
  writeAndCommit(dir, 'scripts/check-repo-disclosure.mjs', `const example = /\\/Users\\// // ${SENTINEL}\n`, 'plant')
  const { status, output } = runChecker(dir)
  assert.equal(status, 1, output)
  assert.match(output, /test-sentinel/)
})

test('--commits all rejects a commit authored outside the allowlist', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'imported work'], {
    GIT_AUTHOR_NAME: 'Mallory',
    GIT_AUTHOR_EMAIL: 'mallory@example.invalid',
  })
  const { status, output } = runChecker(dir, ['--commits', 'all'])
  assert.equal(status, 1, output)
  assert.match(output, /commit-identity \(author\): [0-9a-f]{40}/)
  assert.ok(!output.includes('mallory@example.invalid'), 'log-safety: the offending identity is not echoed')
})

test('--commits all allows the GitHub web-merge committer', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n', 'merge via web ui', {
    GIT_COMMITTER_NAME: 'GitHub',
    GIT_COMMITTER_EMAIL: 'noreply@github.com',
  })
  const { status, output } = runChecker(dir, ['--commits', 'all'])
  assert.equal(status, 0, output)
})

test('commit messages in range are scanned against the denylist', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', `mention ${SENTINEL} in a message`])
  const { status, output } = runChecker(dir, ['--commits', 'range', '--base', 'HEAD~1'])
  assert.equal(status, 1, output)
  assert.match(output, /test-sentinel: commit [0-9a-f]{40} message/)
  assert.ok(!output.includes(SENTINEL), 'log-safety: matched text must never be printed')
})

test('a clean range with allowed identities passes --commits range', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  writeAndCommit(dir, 'docs/more.md', 'still nothing\n', 'second commit')
  const { status, output } = runChecker(dir, ['--commits', 'range', '--base', 'HEAD~1'])
  assert.equal(status, 0, output)
})

test('--staged catches a plant that is staged but not committed', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  fs.writeFileSync(path.join(dir, 'staged.txt'), `safe line\n${SENTINEL} here\n`)
  git(dir, ['add', 'staged.txt'])
  const { status, output } = runChecker(dir, ['--staged'])
  assert.equal(status, 1, output)
  assert.match(output, /test-sentinel/)
  assert.match(output, /staged\.txt:2/)
  assert.ok(!output.includes(SENTINEL), 'log-safety: matched text must never be printed')
})

test('--staged bypass demo closed: an added "++ /dev/null" content line cannot null the scan', (t) => {
  // Reviewer demo: with the old diff-text parser this line rendered as
  // '+++ /dev/null', nulled relPath, and hid every later added line.
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  fs.writeFileSync(path.join(dir, 'attack.txt'), `++ /dev/null\n${SENTINEL} hidden after fake header\n`)
  git(dir, ['add', 'attack.txt'])
  const { status, output } = runChecker(dir, ['--staged'])
  assert.equal(status, 1, output)
  assert.match(output, /test-sentinel/)
  assert.match(output, /attack\.txt:2/)
  assert.ok(!output.includes(SENTINEL), 'log-safety: matched text must never be printed')
})

test('--staged bypass demo closed: an added "++ b/<self-excluded>" line cannot retarget the scan', (t) => {
  // Reviewer demo: the old parser retargeted relPath into the structural
  // self-exclusion list, exempting every later added line from structural scan.
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  fs.writeFileSync(
    path.join(dir, 'attack.txt'),
    '++ b/scripts/check-repo-disclosure.mjs\nsee /Users/nobody/scratch for the trace\n',
  )
  git(dir, ['add', 'attack.txt'])
  const { status, output } = runChecker(dir, ['--staged', '--structural-only'])
  assert.equal(status, 1, output)
  assert.match(output, /absolute user path/)
  assert.match(output, /attack\.txt:2/)
})

test('--staged scans the index blob, not the worktree copy', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  fs.writeFileSync(path.join(dir, 'staged.txt'), `${SENTINEL} staged\n`)
  git(dir, ['add', 'staged.txt'])
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'scrubbed after staging\n')
  const { status, output } = runChecker(dir, ['--staged'])
  assert.equal(status, 1, output)
  assert.match(output, /test-sentinel/)
  assert.match(output, /staged\.txt:1/)
})

test('--staged passes on a clean index', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  const { status, output } = runChecker(dir, ['--staged'])
  assert.equal(status, 0, output)
})

test('a tracked symlink pointing outside --root is skipped, never followed', (t) => {
  // Reviewer demo: readFileSync followed the link, so a tracked symlink let
  // an untrusted tree pull runner-local files into the scan (oracle input).
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'secret.txt'), `${SENTINEL} lives outside the root\n`)
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'escape'))
  git(dir, ['add', 'escape'])
  git(dir, ['commit', '--quiet', '-m', 'add symlink'])
  const { status, output } = runChecker(dir)
  assert.equal(status, 0, output)
  assert.match(output, /\[repo:check\] clean/)
  assert.ok(!output.includes(SENTINEL), 'the symlink target must never be read')
})

test('--untrusted suppresses every per-finding detail and prints only the count', (t) => {
  // Reviewer demo: per-finding label + file:line on an attacker-controlled
  // tree confirms which guessed line matched which category (oracle).
  const dir = makeRepo(t)
  writeAndCommit(dir, 'guess/dictionary.txt', `guess one\n${SENTINEL} guess two\n`)
  writeAndCommit(dir, 'docs/path.md', 'see /Users/nobody/scratch for the trace\n', 'structural plant')
  const { status, output } = runChecker(dir, ['--untrusted'])
  assert.equal(status, 1, output)
  assert.match(output, /\[repo:check\] 2 finding\(s\) \(details suppressed: untrusted tree\)/)
  assert.ok(!output.includes('test-sentinel'), 'denylist label suppressed')
  assert.ok(!output.includes('absolute user path'), 'structural label suppressed')
  assert.ok(!output.includes('dictionary.txt'), 'file locations suppressed')
  assert.ok(!output.includes('path.md'), 'file locations suppressed')
  assert.ok(!output.includes(SENTINEL), 'log-safety: matched text must never be printed')
})

test('--untrusted still reports clean on a clean tree', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  const { status, output } = runChecker(dir, ['--untrusted'])
  assert.equal(status, 0, output)
  assert.match(output, /\[repo:check\] clean/)
})

test('merge commits skip identity checks (synthetic PR merge refs) but keep message scanning', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  git(dir, ['checkout', '--quiet', '-b', 'feature'])
  writeAndCommit(dir, 'docs/feature.md', 'feature work\n', 'feature commit')
  git(dir, ['checkout', '--quiet', '-'])
  writeAndCommit(dir, 'docs/main.md', 'main work\n', 'main commit')
  const githubIdentity = {
    GIT_AUTHOR_NAME: 'GitHub',
    GIT_AUTHOR_EMAIL: 'noreply@github.com',
    GIT_COMMITTER_NAME: 'GitHub',
    GIT_COMMITTER_EMAIL: 'noreply@github.com',
  }
  git(dir, ['merge', '--quiet', '--no-ff', '-m', 'merge feature', 'feature'], githubIdentity)
  assert.equal(runChecker(dir, ['--commits', 'all']).status, 0, 'GitHub-authored merge commit passes')
  git(dir, ['checkout', '--quiet', '-b', 'feature-two'])
  writeAndCommit(dir, 'docs/two.md', 'more work\n', 'second feature commit')
  git(dir, ['checkout', '--quiet', '-'])
  git(dir, ['merge', '--quiet', '--no-ff', '-m', `merge mentioning ${SENTINEL}`, 'feature-two'], githubIdentity)
  const { status, output } = runChecker(dir, ['--commits', 'all'])
  assert.equal(status, 1, output)
  assert.match(output, /test-sentinel: commit [0-9a-f]{40} message/)
  assert.ok(!output.includes(SENTINEL), 'log-safety: matched text must never be printed')
})

test('--commits range without --base is a usage error', (t) => {
  const dir = makeRepo(t)
  writeAndCommit(dir, 'docs/note.md', 'nothing to see\n')
  const { status, output } = runChecker(dir, ['--commits', 'range'])
  assert.equal(status, 2, output)
  assert.match(output, /--commits range requires --base/)
})

test('a root that is not a git checkout is a config error', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-nogit-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const { status, output } = runChecker(dir)
  assert.equal(status, 2, output)
  assert.match(output, /not a git checkout/)
})
