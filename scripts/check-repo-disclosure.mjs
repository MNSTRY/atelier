#!/usr/bin/env node

// Repo-wide disclosure checker. Scans tracked file content (or staged changes)
// and optionally commit identities and messages for structural leaks and for
// the maintainer-held denylist patterns.
//
// Usage:
//   node scripts/check-repo-disclosure.mjs [--root <dir>] [--staged]
//     [--structural-only] [--commits none|range|all] [--base <ref>]
//
// Denylist source precedence: ATELIER_DENYLIST_JSON env -> the scanned root's
// release-denylist.local.json -> fail closed (exit 2) unless --structural-only
// or ATELIER_ALLOW_MISSING_DENYLIST=1 acknowledges a structural-only run.
//
// Log-safety contract: findings print label + file:line (or commit SHA) only —
// never the pattern source and never the matched text; a pattern that fails to
// compile is reported by label alone.
//
// Exit codes: 0 clean, 1 findings, 2 config or usage error.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STRUCTURAL_FORBIDDEN_CONTENT } from './structural-patterns.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

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
const ALLOWED_AUTHOR = { name: 'Erik Desrosiers', email: 'erik@mnstry.ai' }
const ALLOWED_COMMITTERS = [ALLOWED_AUTHOR, { name: 'GitHub', email: 'noreply@github.com' }]

function usageError(message) {
  console.error(`[repo:check] ${message}`)
  process.exit(2)
}

const args = process.argv.slice(2)
let root = packageRoot
let staged = false
let structuralOnly = false
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
  console.error(`[repo:check] ${label}: ${location}`)
  findings += 1
}

function scanLine(line, relPath, lineNumber) {
  if (!STRUCTURAL_SELF_EXCLUDED.includes(relPath)) {
    for (const { pattern, label } of structuralForbiddenContent) {
      if (pattern.test(line)) report(label, `${relPath}:${lineNumber}`)
    }
  }
  for (const { pattern, label } of denylist) {
    if (pattern.test(line)) report(label, `${relPath}:${lineNumber}`)
  }
}

let scannedFiles = 0

function scanTrackedFiles() {
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean)
  for (const relPath of tracked) {
    let buffer
    try {
      buffer = readFileSync(join(root, relPath))
    } catch {
      continue // tracked but absent from the working tree (or a submodule)
    }
    if (buffer.subarray(0, 8192).includes(0)) continue // binary
    scannedFiles += 1
    const lines = buffer.toString('utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) scanLine(lines[i], relPath, i + 1)
  }
}

function scanStagedChanges() {
  const diff = git(['diff', '--cached', '-U0'])
  const seen = new Set()
  let relPath = null
  let lineNumber = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4)
      relPath = target.startsWith('b/') ? target.slice(2) : null // '+++ /dev/null' on deletion
      if (relPath) seen.add(relPath)
    } else if (line.startsWith('@@')) {
      const hunk = line.match(/\+(\d+)/)
      lineNumber = hunk ? Number(hunk[1]) : 0
    } else if (relPath && line.startsWith('+')) {
      scanLine(line.slice(1), relPath, lineNumber)
      lineNumber += 1
    } else if (relPath && line.startsWith(' ')) {
      lineNumber += 1
    }
  }
  scannedFiles = seen.size
}

function scanCommits() {
  const format = '%H%x01%an%x01%ae%x01%cn%x01%ce%x01%B%x02'
  const selector = commitsMode === 'all' ? ['--all'] : [`${base}..HEAD`]
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
    const [sha, authorName, authorEmail, committerName, committerEmail, message = ''] = record.split('\x01')
    if (!sha) continue
    if (authorName !== ALLOWED_AUTHOR.name || authorEmail !== ALLOWED_AUTHOR.email) {
      // Log-safety: the offending identity is not echoed, only the SHA.
      report('commit-identity (author)', sha)
    }
    if (!ALLOWED_COMMITTERS.some((id) => id.name === committerName && id.email === committerEmail)) {
      report('commit-identity (committer)', sha)
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

if (staged) scanStagedChanges()
else scanTrackedFiles()

let scannedCommits = 0
if (commitsMode !== 'none') scannedCommits = scanCommits()

if (findings > 0) {
  console.error(`[repo:check] ${findings} finding(s)`)
  process.exit(1)
}

const contentNote = staged ? `${scannedFiles} staged file(s)` : `${scannedFiles} tracked file(s)`
const commitNote = commitsMode === 'none' ? '' : `, ${scannedCommits} commit(s) [${commitsMode}]`
console.log(`[repo:check] clean: ${contentNote}${commitNote}`)
