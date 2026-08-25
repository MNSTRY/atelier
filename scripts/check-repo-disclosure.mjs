#!/usr/bin/env node

// Repo-wide disclosure checker. Scans tracked file content (or staged changes)
// and optionally newly reachable commit trees, identities, and messages for
// structural leaks and for the maintainer-held denylist patterns.
//
// Usage:
//   node scripts/check-repo-disclosure.mjs [--root <dir>] [--staged]
//     [--structural-only] [--commits none|range|all] [--base <ref>] [--untrusted]
//
// Denylist source precedence: ATELIER_DENYLIST_JSON env -> the scanned root's
// release-denylist.local.json -> fail closed (exit 2) unless --structural-only
// or ATELIER_ALLOW_MISSING_DENYLIST=1 acknowledges a structural-only run.
//
// Log-safety contract: findings print label + file:line (or commit SHA) only —
// never the pattern source and never the matched text; a pattern that fails to
// compile is reported by label alone. With --untrusted (attacker-controlled
// tree, e.g. a fork PR) even label + location is a confirmation oracle — an
// attacker commits a guess dictionary and reads back which line matched which
// category — so all per-finding detail is suppressed and only a count prints.
//
// Exit codes: 0 clean, 1 findings, 2 config or usage error.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STRUCTURAL_FORBIDDEN_CONTENT } from './structural-patterns.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const MAX_HISTORY_COMMITS = 10_000
const MAX_HISTORY_BLOBS = 100_000
const MAX_HISTORY_BLOB_BYTES = 16 * 1024 * 1024
const MAX_HISTORY_TOTAL_BYTES = 256 * 1024 * 1024

// Duplicated from scripts/check-release-tarball.mjs (that audit scans only the
// published tarball; this script scans the whole tracked tree). Drift risk:
// keep the two lists identical when either changes.
const structuralForbiddenContent = STRUCTURAL_FORBIDDEN_CONTENT

// These files carry structural pattern literals (or exercise this gate) and
// would self-match. Structural patterns only — denylist patterns get no
// exclusions anywhere.
const STRUCTURAL_SELF_EXCLUDED = [
  'scripts/check-repo-disclosure.mjs',
  'scripts/check-release-tarball.mjs',
  'scripts/structural-patterns.mjs',
  'test/readiness-protocols.test.mjs',
  'test/check-repo-disclosure.test.mjs',
]

// Hardcoded on purpose — the identity allowlist is not a secret. Authors must
// match exactly; committers additionally allow GitHub-UI merge commits.
//
// Dependabot is listed because it is an expected author for this repository:
// .github/dependabot.yml opens npm and actions update pull requests, whose
// commits GitHub authors as dependabot[bot] and commits as GitHub. Without it,
// every Dependabot branch fails the identity gate — and because --commits all
// walks every ref, those branches would fail the gate on unrelated pull
// requests too, leaving CI permanently red for reasons no contributor could
// act on. The address is GitHub's fixed no-reply identity for that app, so
// this widens the allowlist by exactly one bot, not by a pattern.
const ALLOWED_AUTHOR = { name: 'Erik Desrosiers', email: 'erik@mnstry.ai' }
const DEPENDABOT = {
  name: 'dependabot[bot]',
  email: '49699333+dependabot[bot]@users.noreply.github.com',
}
const GITHUB_COMMITTER = { name: 'GitHub', email: 'noreply@github.com' }
const ALLOWED_AUTHORS = [ALLOWED_AUTHOR, DEPENDABOT]
const ALLOWED_COMMITTERS = [ALLOWED_AUTHOR, DEPENDABOT, GITHUB_COMMITTER]

function usageError(message) {
  console.error(`[repo:check] ${message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
let root = packageRoot
let staged = false
let structuralOnly = false
let untrusted = false
let commitsMode = 'none'
let base = null
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--root') {
    i += 1
    if (!args[i]) usageError('--root requires a directory')
    root = args[i]
  } else if (arg === '--staged') {
    staged = true
  } else if (arg === '--structural-only') {
    structuralOnly = true
  } else if (arg === '--untrusted') {
    untrusted = true
  } else if (arg === '--commits') {
    i += 1
    if (!['none', 'range', 'all'].includes(args[i])) usageError('--commits must be none, range, or all')
    commitsMode = args[i]
  } else if (arg === '--base') {
    i += 1
    if (!args[i]) usageError('--base requires a ref')
    base = args[i]
  } else {
    usageError(`unknown argument: ${arg}`)
  }
}
if (commitsMode === 'range' && !base) usageError('--commits range requires --base <ref>')

function git(gitArgs) {
  return execFileSync('git', ['-C', root, ...gitArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

try {
  git(['rev-parse', '--git-dir'])
} catch {
  usageError(`--root ${root} is not a git checkout`)
}

function compileDenylist(doc) {
  if (!doc || !Array.isArray(doc.patterns)) usageError('denylist document must be {"patterns": [...]}')
  return doc.patterns.map(({ pattern, flags = '', label }) => {
    try {
      // g/y flags would make .test stateful across lines — strip them.
      return { pattern: new RegExp(pattern, flags.replace(/[gy]/g, '')), label }
    } catch {
      // Log-safety: a broken pattern is never echoed back.
      return usageError(`denylist pattern failed to compile: ${label}`)
    }
  })
}

let denylist = []
if (!structuralOnly) {
  const denylistPath = join(root, 'release-denylist.local.json')
  if (process.env.ATELIER_DENYLIST_JSON) {
    let doc
    try {
      doc = JSON.parse(process.env.ATELIER_DENYLIST_JSON)
    } catch {
      usageError('ATELIER_DENYLIST_JSON is not valid JSON')
    }
    denylist = compileDenylist(doc)
  } else if (existsSync(denylistPath)) {
    denylist = compileDenylist(JSON.parse(readFileSync(denylistPath, 'utf8')))
  } else if (process.env.ATELIER_ALLOW_MISSING_DENYLIST === '1') {
    console.warn('[repo:check] denylist unavailable — ATELIER_ALLOW_MISSING_DENYLIST=1 acknowledged; structural patterns only')
  } else {
    console.error(
      '[repo:check] release denylist unavailable: provide ATELIER_DENYLIST_JSON, restore release-denylist.local.json, pass --structural-only, or set ATELIER_ALLOW_MISSING_DENYLIST=1 to acknowledge a structural-only run',
    )
    process.exit(2)
  }
}

let findings = 0
function report(label, location) {
  // Log-safety: with --untrusted, per-finding label + location output is a
  // decryption oracle against an attacker-committed guess dictionary (the log
  // would confirm which guessed line matched which category). Count only.
  if (!untrusted) console.error(`[repo:check] ${label}: ${location}`)
  findings += 1
}

function scanLine(line, relPath, lineNumber, displayPath = relPath) {
  if (!STRUCTURAL_SELF_EXCLUDED.includes(relPath)) {
    for (const { pattern, label } of structuralForbiddenContent) {
      if (pattern.test(line)) report(label, `${displayPath}:${lineNumber}`)
    }
  }
  for (const { pattern, label } of denylist) {
    if (pattern.test(line)) report(label, `${displayPath}:${lineNumber}`)
  }
}

let scannedFiles = 0

function scanBuffer(buffer, relPath, displayPath = relPath, countFile = true) {
  if (buffer.subarray(0, 8192).includes(0)) return // binary
  if (countFile) scannedFiles += 1
  const lines = buffer.toString('utf8').split('\n')
  for (let i = 0; i < lines.length; i += 1) scanLine(lines[i], relPath, i + 1, displayPath)
}

function scanTrackedFiles() {
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean)
  for (const relPath of tracked) {
    let stat
    try {
      stat = lstatSync(join(root, relPath))
    } catch {
      continue // tracked but absent from the working tree (or a submodule)
    }
    // Only regular files: readFileSync would follow a tracked symlink and
    // scan content outside --root (an oracle against the runner's own files).
    if (!stat.isFile()) continue
    scanBuffer(readFileSync(join(root, relPath)), relPath)
  }
}

function scanStagedChanges() {
  // Never parse diff text: an added content line like '++ b/<path>' renders
  // as '+++ b/<path>' and can retarget or null the file header a text parser
  // keys on. Enumerate staged paths, then scan each staged blob in full —
  // the blob is read from the index (git show :<path>), not the worktree.
  const stagedPaths = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean)
  for (const relPath of stagedPaths) {
    const blob = execFileSync('git', ['-C', root, 'show', `:${relPath}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    scanBuffer(blob, relPath)
  }
}

function commitSelector() {
  return commitsMode === 'all' ? ['--all'] : [`${base}..HEAD`]
}

function scanCommits(selector) {
  const format = '%H%x01%P%x01%an%x01%ae%x01%cn%x01%ce%x01%B%x02'
  let out
  try {
    out = git(['log', `--format=${format}`, ...selector])
  } catch {
    usageError(
      commitsMode === 'range' ? `unable to resolve commit range ${base}..HEAD` : 'unable to read commit history',
    )
  }
  const records = out
    .split('\x02')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.length > 0)
  for (const record of records) {
    const [sha, parents = '', authorName, authorEmail, committerName, committerEmail, message = ''] = record.split('\x01')
    if (!sha) continue
    // Merge commits (>1 parent) skip identity checks: on pull_request events
    // GitHub's synthetic merge ref commit is authored by
    // 'GitHub <noreply@github.com>', which would fail the author gate on
    // every PR. Their messages are still scanned below.
    const isMergeCommit = parents.trim().split(/\s+/).filter(Boolean).length > 1
    if (!isMergeCommit) {
      if (!ALLOWED_AUTHORS.some((id) => id.name === authorName && id.email === authorEmail)) {
        // Log-safety: the offending identity is not echoed, only the SHA.
        report('commit-identity (author)', sha)
      }
      if (!ALLOWED_COMMITTERS.some((id) => id.name === committerName && id.email === committerEmail)) {
        report('commit-identity (committer)', sha)
      }
    }
    for (const { pattern, label } of structuralForbiddenContent) {
      if (pattern.test(message)) report(label, `commit ${sha} message`)
    }
    for (const { pattern, label } of denylist) {
      if (pattern.test(message)) report(label, `commit ${sha} message`)
    }
  }
  return records.length
}

function scanCommitTrees(selector) {
  let shas
  try {
    shas = git(['rev-list', ...selector]).split('\n').filter(Boolean)
  } catch {
    report('commit-tree-read-incomplete', 'history')
    return 0
  }
  if (shas.length > MAX_HISTORY_COMMITS) {
    report('commit-count-limit', 'history')
    return 0
  }

  const scanned = new Set()
  let totalBytes = 0
  let scannedBlobs = 0
  for (const sha of shas) {
    let changedPaths
    try {
      changedPaths = new Set(
        git([
          'diff-tree', '--root', '-r', '-m', '--no-commit-id', '--name-only',
          '--diff-filter=ACMR', '-z', sha,
        ]).split('\0').filter(Boolean),
      )
    } catch {
      report('commit-tree-read-incomplete', `commit ${sha}`)
      continue
    }
    if (changedPaths.size === 0) continue
    let entries
    try {
      entries = git(['ls-tree', '-r', '-z', '--full-tree', sha]).split('\0').filter(Boolean)
    } catch {
      report('commit-tree-read-incomplete', `commit ${sha}`)
      continue
    }
    for (const entry of entries) {
      const tab = entry.indexOf('\t')
      if (tab < 0) {
        report('commit-tree-entry-invalid', `commit ${sha}`)
        continue
      }
      const [mode, type, objectId] = entry.slice(0, tab).split(' ')
      const relPath = entry.slice(tab + 1)
      if (!changedPaths.has(relPath) || type !== 'blob' || mode === '160000') continue
      const scanKey = `${objectId}\0${relPath}`
      if (scanned.has(scanKey)) continue
      scanned.add(scanKey)
      if (scanned.size > MAX_HISTORY_BLOBS) {
        report('commit-blob-count-limit', 'history')
        return scannedBlobs
      }
      let size
      try {
        size = Number(git(['cat-file', '-s', objectId]).trim())
      } catch {
        report('commit-blob-read-incomplete', `commit ${sha}:${relPath}`)
        continue
      }
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_HISTORY_BLOB_BYTES) {
        report('commit-blob-size-limit', `commit ${sha}:${relPath}`)
        continue
      }
      if (totalBytes + size > MAX_HISTORY_TOTAL_BYTES) {
        report('commit-history-byte-limit', 'history')
        return scannedBlobs
      }
      let blob
      try {
        blob = execFileSync('git', ['-C', root, 'cat-file', 'blob', objectId], {
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: MAX_HISTORY_BLOB_BYTES + 1024,
        })
      } catch {
        report('commit-blob-read-incomplete', `commit ${sha}:${relPath}`)
        continue
      }
      totalBytes += blob.length
      scannedBlobs += 1
      scanBuffer(blob, relPath, `commit ${sha}:${relPath}`, false)
    }
  }
  return scannedBlobs
}

if (staged) scanStagedChanges()
else scanTrackedFiles()

let scannedCommits = 0
let scannedHistoryBlobs = 0
if (commitsMode !== 'none') {
  const selector = commitSelector()
  scannedCommits = scanCommits(selector)
  scannedHistoryBlobs = scanCommitTrees(selector)
}

if (findings > 0) {
  // Even the count is a 1-bit-per-dispatch oracle on an attacker-controlled
  // tree; the exit code carries the only signal.
  if (untrusted) console.error('[repo:check] findings present (details suppressed: untrusted tree)')
  else console.error(`[repo:check] ${findings} finding(s)`)
  process.exit(1)
}

const contentNote = staged ? `${scannedFiles} staged file(s)` : `${scannedFiles} tracked file(s)`
const commitNote = commitsMode === 'none' ? '' : `, ${scannedCommits} commit(s) and ${scannedHistoryBlobs} historical blob(s) [${commitsMode}]`
console.log(`[repo:check] clean: ${contentNote}${commitNote}`)
