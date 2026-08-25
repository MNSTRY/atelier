import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const STRUCTURAL_DISCLOSURE_PATTERNS = Object.freeze([
  { pattern: new RegExp('\\/Users\\/'), label: 'absolute user path' },
  { pattern: new RegExp('\\/var\\/folders\\/'), label: 'machine-local temp path' },
  { pattern: new RegExp('\\.' + 'codex'), label: 'agent-local state path' },
  {
    pattern: new RegExp([
      'BEGIN ',
      '(?:[A-Z0-9]+ ){0,4}',
      'PRIVATE KEY(?: BLOCK)?',
      '|BEGIN (?:RSA|OPENSSH) KEY',
    ].join('')),
    label: 'private key material',
  },
  { pattern: /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/, label: 'JWK private key material' },
  {
    pattern: /\b(api[_-]?key|secret|password|(?<!id-)token)\b\s*[:=]/i,
    label: 'secret-like assignment',
  },
])

export function compileDisclosurePatterns(patternDocs = []) {
  if (!Array.isArray(patternDocs)) throw new Error('denylist document must contain a patterns array')
  return patternDocs.map(({ pattern, flags = '', label }) => {
    if (typeof label !== 'string' || label.length === 0) throw new Error('denylist pattern label must be non-empty')
    if (typeof pattern !== 'string' || pattern.length === 0) throw new Error(`denylist pattern failed to compile: ${label}`)
    try {
      return { pattern: new RegExp(pattern, String(flags).replace(/[gy]/g, '')), label }
    } catch {
      throw new Error(`denylist pattern failed to compile: ${label}`)
    }
  })
}

export function scanDisclosureContent({
  root = process.cwd(),
  staged = false,
  denylistPatterns = [],
  failOnBinary = false,
} = {}) {
  const resolvedRoot = path.resolve(root)
  assertGitCheckout(resolvedRoot)
  const patterns = [...STRUCTURAL_DISCLOSURE_PATTERNS, ...denylistPatterns]
  const findings = []
  const skippedBinary = []
  let scannedFiles = 0

  for (const entry of stagedEntries(resolvedRoot, staged)) {
    const buffer = entry.buffer ?? readTrackedFile(resolvedRoot, entry.path)
    if (buffer === null) continue
    const text = decodeText(buffer)
    if (text === null) {
      skippedBinary.push(entry.path)
      if (failOnBinary) findings.push({ label: 'binary content cannot be disclosure-scanned', path: entry.path, line: null })
      continue
    }

    scannedFiles += 1
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      for (const { pattern, label } of patterns) {
        if (pattern.test(lines[index])) findings.push({ label, path: entry.path, line: index + 1 })
      }
    }
  }

  return {
    ok: findings.length === 0,
    staged,
    scannedFiles,
    skippedBinary,
    findings,
  }
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    return null
  }
}

export function isPathTracked(root, candidatePath) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidatePath)
  const relative = path.relative(resolvedRoot, resolvedCandidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const gitRelative = relative.split(path.sep).join('/')
  const result = execFileSync('git', ['-C', resolvedRoot, 'ls-files', '-z', '--', gitRelative], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.split('\0').filter(Boolean).includes(gitRelative)) return true

  // Git pathspec matching is case-sensitive even when the checkout filesystem
  // is not. Compare filesystem identities so alternate-cased callers cannot
  // make a tracked file appear local and untracked.
  return execFileSync('git', [
    '-C',
    resolvedRoot,
    'ls-files',
    '-z',
    '--',
    `:(icase,literal)${gitRelative}`,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean)
    .some((trackedPath) => sameExistingFile(resolvedCandidate, path.join(resolvedRoot, trackedPath)))
}

function sameExistingFile(left, right) {
  try {
    if (fs.realpathSync.native(left) === fs.realpathSync.native(right)) return true
    const leftStat = fs.statSync(left)
    const rightStat = fs.statSync(right)
    return leftStat.ino !== 0 && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino
  } catch {
    return false
  }
}

export function isPathIgnored(root, candidatePath) {
  const resolvedRoot = path.resolve(root)
  const relative = path.relative(resolvedRoot, path.resolve(candidatePath))
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  const gitRelative = relative.split(path.sep).join('/')
  try {
    execFileSync('git', ['-C', resolvedRoot, 'check-ignore', '--quiet', '--', gitRelative], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function assertGitCheckout(root) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    throw new Error(`disclosure root is not a Git checkout`)
  }
}

function stagedEntries(root, staged) {
  if (!staged) {
    return git(root, ['ls-files', '-z'])
      .split('\0')
      .filter(Boolean)
      .map((filePath) => ({ path: filePath }))
  }

  return git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((filePath) => ({
      path: filePath,
      buffer: execFileSync('git', ['-C', root, 'show', `:${filePath}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      }),
    }))
}

function readTrackedFile(root, relativePath) {
  const absolutePath = path.join(root, relativePath)
  let stat
  try {
    stat = fs.lstatSync(absolutePath)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  return fs.readFileSync(absolutePath)
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}
