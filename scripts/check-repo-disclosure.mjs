#!/usr/bin/env node

// Repo-wide disclosure checker. Scans tracked file content (or staged changes)
// and optionally newly reachable commit trees, identities, and messages for
// structural leaks and for the maintainer-held denylist patterns.
//
// Usage:
//   node scripts/check-repo-disclosure.mjs [--root <dir>] [--staged]
//     [--structural-only] [--commits none|range|all] [--base <ref>] [--untrusted]
//     [--external-contributor-range]
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
const MAX_HISTORY_COMMIT_BYTES = 4 * 1024 * 1024
const MAX_HISTORY_COMMIT_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_HISTORY_OBJECTS = 300_000
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
let externalContributorRange = false
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
  } else if (arg === '--external-contributor-range') {
    externalContributorRange = true
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
if (externalContributorRange && commitsMode !== 'range') {
  usageError('--external-contributor-range requires --commits range')
}

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
  let shas
  try {
    shas = git(['rev-list', ...selector]).split('\n').filter(Boolean)
  } catch {
    usageError(
      commitsMode === 'range' ? `unable to resolve commit range ${base}..HEAD` : 'unable to read commit history',
    )
  }
  if (shas.some((sha) => !/^[0-9a-f]{40,64}$/.test(sha))) {
    report('commit-object-inventory-invalid', 'history')
    return 0
  }
  if (shas.length > MAX_HISTORY_COMMITS) {
    report('commit-count-limit', 'history')
    shas = shas.slice(0, MAX_HISTORY_COMMITS)
  }
  if (shas.length === 0) return 0

  let checks
  try {
    checks = execFileSync(
      'git',
      ['-C', root, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      {
        input: `${shas.join('\n')}\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      },
    ).trim().split('\n').filter(Boolean)
  } catch {
    report('commit-object-inventory-incomplete', 'history')
    return 0
  }
  if (checks.length !== shas.length) report('commit-object-inventory-incomplete', 'history')

  const commits = []
  let totalBytes = 0
  for (let index = 0; index < shas.length; index += 1) {
    const expectedSha = shas[index]
    const [sha, type, sizeText] = (checks[index] ?? '').split(' ')
    const size = Number(sizeText)
    if (
      sha !== expectedSha || type !== 'commit' || !Number.isSafeInteger(size) ||
      size < 0 || size > MAX_HISTORY_COMMIT_BYTES
    ) {
      report('commit-object-inventory-incomplete', `commit ${expectedSha}`)
      continue
    }
    if (totalBytes + size > MAX_HISTORY_COMMIT_TOTAL_BYTES) {
      report('commit-history-byte-limit', 'commit history')
      break
    }
    commits.push({ sha, size })
    totalBytes += size
  }
  if (commits.length === 0) return shas.length

  let batch
  try {
    batch = execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
      input: `${commits.map(({ sha }) => sha).join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: totalBytes + commits.length * 128 + 1024,
    })
  } catch {
    report('commit-object-read-incomplete', 'history')
    return shas.length
  }

  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = 0
  for (const expected of commits) {
    const newline = batch.indexOf(0x0a, offset)
    const header = newline < 0 ? [] : batch.subarray(offset, newline).toString('utf8').split(' ')
    const [sha, type, sizeText] = header
    const size = Number(sizeText)
    const contentStart = newline + 1
    const contentEnd = contentStart + size
    if (
      newline < 0 || sha !== expected.sha || type !== 'commit' || size !== expected.size ||
      contentEnd >= batch.length || batch[contentEnd] !== 0x0a
    ) {
      report('commit-object-read-incomplete', `commit ${expected.sha}`)
      break
    }
    const raw = batch.subarray(contentStart, contentEnd)
    offset = contentEnd + 1
    if (raw.includes(0)) {
      report('commit-object-binary-uninspectable', `commit ${sha}`)
      continue
    }
    let text
    try {
      text = decoder.decode(raw)
    } catch {
      report('commit-object-text-invalid', `commit ${sha}`)
      continue
    }
    const separator = text.indexOf('\n\n')
    const headerLines = separator < 0 ? [] : text.slice(0, separator).split('\n')
    const treeLines = headerLines.filter((line) => line.startsWith('tree '))
    const parentLines = headerLines.filter((line) => line.startsWith('parent '))
    const authorLines = headerLines.filter((line) => line.startsWith('author '))
    const committerLines = headerLines.filter((line) => line.startsWith('committer '))
    const objectFormatValid = (
      separator >= 0 && treeLines.length === 1 && authorLines.length === 1 && committerLines.length === 1 &&
      /^tree [0-9a-f]{40,64}$/.test(treeLines[0]) &&
      parentLines.every((line) => /^parent [0-9a-f]{40,64}$/.test(line))
    )
    const parseIdentity = (line, label) => {
      const match = line.match(new RegExp(`^${label} (.*) <([^<>\\n]+)> -?\\d+ [+-]\\d{4}$`))
      return match ? { name: match[1], email: match[2] } : null
    }
    const author = objectFormatValid ? parseIdentity(authorLines[0], 'author') : null
    const committer = objectFormatValid ? parseIdentity(committerLines[0], 'committer') : null
    if (!objectFormatValid || !author || !committer) {
      report('commit-object-format-invalid', `commit ${sha}`)
      continue
    }
    // Every byte of the raw public commit object is disclosure-scanned,
    // including identity and extra headers, before repository identity policy.
    for (const [index, line] of text.split('\n').entries()) {
      scanLine(line, '__commit_object__', index + 1, `commit ${sha} object`)
    }
    // Merge commits skip repository identity checks because GitHub synthetic
    // merge commits use GitHub identity. Raw content remains scanned above.
    const isMergeCommit = parentLines.length > 1
    if (!isMergeCommit && !externalContributorRange) {
      if (!ALLOWED_AUTHORS.some((id) => id.name === author.name && id.email === author.email)) {
        report('commit-identity (author)', sha)
      }
      if (!ALLOWED_COMMITTERS.some((id) => id.name === committer.name && id.email === committer.email)) {
        report('commit-identity (committer)', sha)
      }
    }
  }
  return shas.length
}

function scanCommitTrees(selector) {
  let inventory
  try {
    inventory = git([
      'log', '--raw', '--root', '-m', '--no-renames', '--no-abbrev', '-z',
      '--format=tformat:', ...selector,
    ]).split('\0').filter(Boolean)
  } catch {
    report('commit-tree-read-incomplete', 'history')
    return 0
  }
  if (inventory.length > MAX_HISTORY_OBJECTS) {
    report('commit-object-count-limit', 'history')
    return 0
  }

  const objectPaths = new Map()
  for (let index = 0; index < inventory.length; index += 2) {
    const metadata = inventory[index]
    const relPath = inventory[index + 1]
    if (!metadata?.startsWith(':') || relPath === undefined) {
      report('commit-object-inventory-invalid', 'history')
      continue
    }
    const [oldMode, newMode, oldObjectId, newObjectId, status] = metadata.slice(1).split(' ')
    if (
      !/^[0-7]{6}$/.test(oldMode) || !/^[0-7]{6}$/.test(newMode) ||
      !/^[0-9a-f]{40,64}$/.test(oldObjectId) || !/^[0-9a-f]{40,64}$/.test(newObjectId) ||
      !/^[ACDMRTUXB]$/.test(status)
    ) {
      report('commit-object-inventory-invalid', 'history')
      continue
    }
    // A deletion introduces no new reachable object. Gitlinks name commit
    // objects in another repository, never content blobs in this repository.
    if (/^0+$/.test(newObjectId) || newMode === '160000') continue
    const paths = objectPaths.get(newObjectId) ?? new Set()
    paths.add(relPath)
    objectPaths.set(newObjectId, paths)
  }
  const objectIds = [...objectPaths.keys()]
  if (objectIds.length === 0) return 0
  let checks
  try {
    checks = execFileSync(
      'git',
      ['-C', root, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
      {
        input: `${objectIds.join('\n')}\n`,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      },
    ).trim().split('\n').filter(Boolean)
  } catch {
    report('commit-object-inventory-incomplete', 'history')
    return 0
  }

  const blobs = []
  let totalBytes = 0
  if (checks.length !== objectIds.length) {
    report('commit-object-inventory-incomplete', 'history')
  }
  for (let index = 0; index < objectIds.length; index += 1) {
    const expectedObjectId = objectIds[index]
    const [objectId, type, sizeText] = (checks[index] ?? '').split(' ')
    if (objectId !== expectedObjectId || type !== 'blob' || sizeText === undefined) {
      report('commit-object-inventory-incomplete', `historical object ${expectedObjectId}`)
      continue
    }
    if (blobs.length >= MAX_HISTORY_BLOBS) {
      report('commit-blob-count-limit', 'history')
      break
    }
    const size = Number(sizeText)
    const relPath = [...objectPaths.get(objectId)][0]
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_HISTORY_BLOB_BYTES) {
      report('commit-blob-size-limit', `historical blob ${objectId}:${relPath}`)
      continue
    }
    if (totalBytes + size > MAX_HISTORY_TOTAL_BYTES) {
      report('commit-history-byte-limit', 'history')
      break
    }
    blobs.push({ objectId, paths: [...objectPaths.get(objectId)], size })
    totalBytes += size
  }

  if (blobs.length === 0) return 0
  let batch
  try {
    batch = execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
      input: `${blobs.map(({ objectId }) => objectId).join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: totalBytes + blobs.length * 128 + 1024,
    })
  } catch {
    report('commit-blob-read-incomplete', 'history')
    return 0
  }

  let offset = 0
  let scannedBlobs = 0
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (const expected of blobs) {
    const newline = batch.indexOf(0x0a, offset)
    if (newline < 0) {
      report('commit-blob-read-incomplete', 'history')
      break
    }
    const [objectId, type, sizeText] = batch.subarray(offset, newline).toString('utf8').split(' ')
    const size = Number(sizeText)
    const contentStart = newline + 1
    const contentEnd = contentStart + size
    if (
      objectId !== expected.objectId || type !== 'blob' || size !== expected.size ||
      contentEnd >= batch.length || batch[contentEnd] !== 0x0a
    ) {
      report('commit-blob-read-incomplete', `historical blob ${expected.objectId}`)
      break
    }
    const blob = batch.subarray(contentStart, contentEnd)
    const primaryPath = expected.paths[0]
    const displayPath = `historical blob ${objectId}:${primaryPath}`
    if (blob.includes(0)) {
      report('commit-binary-blob-uninspectable', displayPath)
    } else {
      let text
      try {
        text = decoder.decode(blob)
      } catch {
        report('commit-text-encoding-invalid', displayPath)
      }
      if (text !== undefined) {
        const lines = text.split('\n')
        for (const relPath of expected.paths) {
          const pathDisplay = `historical blob ${objectId}:${relPath}`
          for (let index = 0; index < lines.length; index += 1) {
            scanLine(lines[index], relPath, index + 1, pathDisplay)
          }
        }
        scannedBlobs += 1
      }
    }
    offset = contentEnd + 1
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
