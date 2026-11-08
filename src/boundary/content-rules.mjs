import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { matchesPathPattern, normalizeRelPath } from '../project/path-match.mjs'
import { sanitizedGitEnvironment } from '../runtime/git-adapter.mjs'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const EMPTY_TREES = Object.freeze({ sha1: EMPTY_TREE, sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' })
// Commits one push may carry before the per-commit scan refuses rather than run long.
export const PUSH_COMMIT_SCAN_MAX = 1000
export const ZERO_SHA_RE = /^0{40,}$/

export const RULE_KINDS = Object.freeze(['content', 'path'])
export const RULE_SEVERITIES = Object.freeze(['error', 'warning'])
export const DIFF_RESULT_MAX_BYTES = 16 * 1024 * 1024
export const CHECK_AGGREGATE_MAX_BYTES = 64 * 1024 * 1024
export const BINARY_FILE_MAX_BYTES = 8 * 1024 * 1024
export const BINARY_AGGREGATE_MAX_BYTES = 32 * 1024 * 1024

// A blanket exception is not an exception, it is switching the rule off. The
// contract requires a rule, a repo, real paths, and a reason a reviewer can act on.
const BLANKET_PATTERNS = new Set(['*', '**', '.', './', '**/*', '*/**'])
const MIN_REASON_LENGTH = 8

export const DEFAULT_CONTENT_RULES = Object.freeze(
  [
    {
      id: 'secret-material',
      kind: 'content',
      severity: 'error',
      pattern: '(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{36}|xox[baprs]-[0-9A-Za-z-]{10,})',
      description: 'A credential or private key is being pushed.',
    },
    {
      id: 'browser-persistence',
      kind: 'content',
      severity: 'error',
      pattern: '(^|[^A-Za-z0-9_])(localStorage|sessionStorage|indexedDB|IndexedDB)([^A-Za-z0-9_]|$)|document[.]cookie|caches[.]open',
      paths: ['*.html', '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx'],
      description: 'Artifact state must persist to Git-tracked repo files, not browser-only storage.',
    },
    {
      id: 'private-financial-filename',
      kind: 'path',
      severity: 'error',
      pattern:
        '((^|/)\\.env(?:$|[.-])|invoice|payroll|(^|[-_/])salar(y|ies)|bank[-_]?statement|tax[-_]?return|credential|(^|[-_/])password([-_.]|$)|(^|[-_/])secret([-_.]|$)|id_rsa)',
      description: 'Private or financial material does not belong in a source repo.',
    },
  ].map(Object.freeze),
)

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')

export function validateContentRules(rules, { label = 'contentRules' } = {}) {
  const errors = []
  if (!Array.isArray(rules)) return [`${label} must be an array`]
  if (rules.length === 0) errors.push(`${label} must contain at least one rule; omit the field to use the defaults`)
  const seen = new Set()
  for (const [index, rule] of rules.entries()) {
    const at = `${label}[${index}]`
    if (!isObject(rule)) {
      errors.push(`${at} must be an object`)
      continue
    }
    for (const key of Object.keys(rule)) {
      if (!['id', 'kind', 'severity', 'pattern', 'paths', 'description', 'ext'].includes(key)) errors.push(`${at} must not include additional property ${key}`)
    }
    if (rule.ext != null && !isObject(rule.ext)) errors.push(`${at}.ext must be an object`)
    const id = trimmed(rule.id)
    if (!id) errors.push(`${at}.id is required`)
    else if (seen.has(id)) errors.push(`${at}.id duplicates an earlier rule: ${id}`)
    else seen.add(id)
    if (rule.kind != null && !RULE_KINDS.includes(rule.kind)) errors.push(`${at}.kind must be one of ${RULE_KINDS.join(', ')}`)
    if (rule.severity != null && !RULE_SEVERITIES.includes(rule.severity)) errors.push(`${at}.severity must be one of ${RULE_SEVERITIES.join(', ')}`)
    if (!trimmed(rule.pattern)) errors.push(`${at}.pattern is required`)
    else {
      try {
        new RegExp(rule.pattern)
      } catch (error) {
        errors.push(`${at}.pattern is not a valid regular expression: ${error.message}`)
      }
    }
    if (rule.paths != null && (!Array.isArray(rule.paths) || rule.paths.some((item) => !trimmed(item)))) {
      errors.push(`${at}.paths must be a list of non-empty globs`)
    }
  }
  return errors
}

export function validateContentRuleExceptions(exceptions, rules = DEFAULT_CONTENT_RULES, { label = 'contentRuleExceptions' } = {}) {
  const errors = []
  if (!Array.isArray(exceptions)) return [`${label} must be an array`]
  const ruleIds = new Set(rules.map((rule) => trimmed(rule.id)).filter(Boolean))
  for (const [index, exception] of exceptions.entries()) {
    const at = `${label}[${index}]`
    if (!isObject(exception)) {
      errors.push(`${at} must be an object`)
      continue
    }
    for (const key of Object.keys(exception)) {
      if (!['rule', 'repo', 'paths', 'reason', 'ext'].includes(key)) errors.push(`${at} must not include additional property ${key}`)
    }
    if (exception.ext != null && !isObject(exception.ext)) errors.push(`${at}.ext must be an object`)
    const rule = trimmed(exception.rule)
    if (!rule) errors.push(`${at}.rule is required; an exception must name the rule it excepts`)
    else if (ruleIds.size && !ruleIds.has(rule)) errors.push(`${at}.rule "${rule}" is not a declared content rule`)
    if (!trimmed(exception.repo)) errors.push(`${at}.repo is required; exceptions are per repo, not fleet-wide`)
    if (!Array.isArray(exception.paths) || !exception.paths.length) {
      errors.push(`${at}.paths is required and must name the paths being excepted`)
    } else {
      for (const item of exception.paths) {
        if (!trimmed(item)) errors.push(`${at}.paths must contain non-empty globs`)
        else if (BLANKET_PATTERNS.has(normalizeRelPath(item))) {
          errors.push(`${at}.paths must not be a blanket "${item}"; a repo-wide skip is disabling the rule, not excepting it`)
        }
      }
    }
    if (trimmed(exception.reason).length < MIN_REASON_LENGTH) {
      errors.push(`${at}.reason is required and must explain why this usage is accepted`)
    }
  }
  return errors
}

export function resolveContentRules(policy) {
  const declared = Array.isArray(policy?.contentRules) ? policy.contentRules : null
  if (!declared?.length || validateContentRules(declared).length > 0) return DEFAULT_CONTENT_RULES
  return declared
}

export function findException({ exceptions = [], rule, repo, path: filePath }) {
  // Exception paths are slash-normalised patterns, so they cannot name a file whose
  // own name holds a backslash; such a file never inherits a sibling's exception.
  if (String(filePath ?? '').includes('\\')) return null
  const rel = normalizeRelPath(filePath)
  return (
    exceptions.find(
      (exception) =>
        trimmed(exception.rule) === rule &&
        trimmed(exception.repo) === repo &&
        (Array.isArray(exception.paths) ? exception.paths : []).some((pattern) => matchesPathPattern(pattern, rel)),
    ) ?? null
  )
}

function rulePathMatches(rule, filePath) {
  if (!Array.isArray(rule.paths) || !rule.paths.length) return true
  // Path scopes are slash-normalised too; a backslash name is treated as in scope.
  if (String(filePath ?? '').includes('\\')) return true
  return rule.paths.some((pattern) => matchesPathPattern(pattern, filePath))
}

/**
 * Judge added lines and added file paths, not the whole tree.
 *
 * A whole-tree scan cannot tell "you are about to push a new violation" from
 * "a known, accepted usage exists", so one legitimate use anywhere blocks every
 * push of everything in that repo, forever.
 */
export function scanAddedContent({ files, rules = DEFAULT_CONTENT_RULES, exceptions = [], repo = null }) {
  const findings = []
  for (const file of files) {
    // Paths from Git are exact repository paths and are reported as they are.
    const filePath = String(file.path ?? '')
    for (const rule of rules) {
      const kind = rule.kind ?? 'content'
      const severity = rule.severity ?? 'error'
      const exception = findException({ exceptions, rule: rule.id, repo, path: filePath })
      if (kind === 'path') {
        const pathRule = new RegExp(rule.pattern, 'i')
        if (!file.added || !(pathRule.test(filePath) || pathRule.test(normalizeRelPath(filePath)))) continue
        if (exception) continue
        findings.push({ severity, code: 'content-rule-violation', rule: rule.id, repo, path: filePath, line: null, message: `${repo ?? ''}/${filePath}: ${rule.description ?? rule.id}`.replace(/^\//, '') })
        continue
      }
      if (!rulePathMatches(rule, filePath)) continue
      const re = new RegExp(rule.pattern)
      for (const line of file.addedLines ?? []) {
        if (!re.test(line.text)) continue
        if (exception) continue
        const found = {
          severity,
          code: 'content-rule-violation',
          rule: rule.id,
          repo,
          path: filePath,
          line: line.number,
          message: `${repo ?? ''}/${filePath}:${line.number}: ${rule.description ?? rule.id}`.replace(/^\//, ''),
        }
        // A digest of the line identifies the same content across diffs; it is
        // not enumerable, so it never appears in a report.
        Object.defineProperty(found, 'lineDigest', { value: createHash('sha256').update(line.text).digest('hex') })
        findings.push(found)
      }
    }
  }
  return findings
}

// The diff commands below pin their own output format, so repository or user
// configuration (prefixes, colour, external diff drivers, textconv, relative
// paths, fused hunks, submodule summaries) cannot change what the parser reads.
// Anything it still cannot read is reported and blocks, so a key not pinned here
// can stop a commit but cannot hide content.
export const CANONICAL_DIFF_FLAGS = Object.freeze([
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--no-relative',
  '--inter-hunk-context=0',
  '--submodule=short',
  '--full-index',
])

const OCTAL_ESCAPE = /^[0-7]{3}$/
const SIMPLE_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/**
 * Read one C-quoted path token as Git writes it (core.quotePath), starting at the
 * opening quote. Returns the decoded path and the index after the closing quote,
 * or null when the token is malformed.
 */
function readQuotedToken(text, start) {
  if (text[start] !== '"') return null
  const bytes = []
  for (let index = start + 1; index < text.length; index += 1) {
    const char = String.fromCodePoint(text.codePointAt(index))
    if (char === '"') return { value: Buffer.from(bytes).toString('utf8'), end: index + 1 }
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'))
      index += char.length - 1
      continue
    }
    const next = text[index + 1]
    if (next === undefined) return null
    const octal = text.slice(index + 1, index + 4)
    if (OCTAL_ESCAPE.test(octal)) {
      const byte = Number.parseInt(octal, 8)
      if (byte > 255) return null
      bytes.push(byte)
      index += 3
    } else if (Object.hasOwn(SIMPLE_ESCAPES, next)) {
      bytes.push(SIMPLE_ESCAPES[next])
      index += 1
    } else {
      return null
    }
  }
  return null
}

/** A path as it appears after a fixed prefix in a header line, quoted or bare. */
function prefixedPath(token, prefix) {
  if (token.startsWith('"')) {
    const quoted = readQuotedToken(token, 0)
    if (!quoted || quoted.end !== token.length || !quoted.value.startsWith(prefix)) return null
    return quoted.value.slice(prefix.length)
  }
  return token.startsWith(prefix) ? token.slice(prefix.length) : null
}

/**
 * The destination path of a `diff --git` header. A bare header is ambiguous when
 * a path contains " b/", so it is resolved only when both sides name the same
 * path, which is every case except a rename or copy; those are resolved from the
 * `rename to` / `copy to` lines that follow.
 */
export function diffHeaderPath(line) {
  if (!line.startsWith('diff --git ')) return null
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) {
    const first = readQuotedToken(rest, 0)
    if (!first || rest[first.end] !== ' ') return null
    return prefixedPath(rest.slice(first.end + 1), 'b/')
  }
  if (rest.endsWith('"')) {
    const open = rest.lastIndexOf(' "')
    return open < 0 ? null : prefixedPath(rest.slice(open + 1), 'b/')
  }
  if (rest.length < 5 || (rest.length - 5) % 2 !== 0) return null
  const half = (rest.length - 5) / 2
  const candidate = rest.slice(2, 2 + half)
  return half > 0 && rest === `a/${candidate} b/${candidate}` ? candidate : null
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const INDEX_LINE = /^index ([0-9a-f]{40,64})\.\.([0-9a-f]{40,64})(?: \d+)?$/

/**
 * Split `git diff --unified=0` output into file sections. Lines are read as
 * content only inside a hunk, for exactly as many lines as its header counts, so
 * content can never be read as a header and a header can never hide content. A
 * section whose path or hunks cannot be read is returned with `incomplete` set,
 * so the caller fails closed instead of skipping it. Paths are the exact
 * repository paths Git reports; `newBlob` is the object id of the new content.
 * With `detail`, each section also keeps its hunks (added and removed text) and
 * the raw lines after its header.
 */
export function parseDiffSections(diff, { detail = false } = {}) {
  const sections = []
  let current = null
  let pendingAdded = 0
  let pendingRemoved = 0
  let lineNumber = 0
  for (const raw of String(diff ?? '').split('\n')) {
    if (detail && current && !raw.startsWith('diff --git ') && !raw.startsWith('* Unmerged path ')) current.lines.push(raw)
    if (pendingAdded > 0 || pendingRemoved > 0) {
      if (raw.startsWith('+') && pendingAdded > 0) {
        current.addedLines.push({ number: lineNumber, text: raw.slice(1) })
        if (detail) current.hunks.at(-1).added.push(raw.slice(1))
        lineNumber += 1
        pendingAdded -= 1
        continue
      }
      if (raw.startsWith('-') && pendingRemoved > 0) {
        if (detail) current.hunks.at(-1).removed.push(raw.slice(1))
        pendingRemoved -= 1
        continue
      }
      if (raw.startsWith(' ') && pendingAdded > 0 && pendingRemoved > 0) {
        // A context line counts on both sides; none is expected, but one is harmless.
        lineNumber += 1
        pendingAdded -= 1
        pendingRemoved -= 1
        continue
      }
      if (raw.startsWith('\\')) continue // "\ No newline at end of file"
      current.incomplete = 'hunk-shorter-than-its-header'
      pendingAdded = 0
      pendingRemoved = 0
    }
    if (raw.startsWith('diff --git ')) {
      const headerPath = diffHeaderPath(raw)
      current = {
        path: headerPath === null || headerPath === '' ? null : headerPath,
        added: false,
        deleted: false,
        binary: false,
        newBlob: null,
        oldPath: null,
        addedLines: [],
        incomplete: null,
        inHeader: true,
        ...(detail ? { hunks: [], lines: [] } : {}),
      }
      sections.push(current)
      continue
    }
    if (raw.startsWith('* Unmerged path ')) {
      // An unmerged entry has no patch to read; it stands as its own unreadable
      // section instead of being taken for a line of the file before it. Git
      // prints this name as it is, never quoted.
      const listed = raw.slice('* Unmerged path '.length)
      current = {
        path: listed !== '' ? listed : null,
        added: false,
        deleted: false,
        binary: false,
        newBlob: null,
        oldPath: null,
        addedLines: [],
        incomplete: 'unmerged-path',
        inHeader: false,
        ...(detail ? { hunks: [], lines: [] } : {}),
      }
      sections.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith('\\')) continue
    const hunk = raw.match(HUNK_HEADER)
    if (hunk) {
      current.inHeader = false
      if (detail) current.hunks.push({ added: [], removed: [] })
      pendingRemoved = hunk[1] === undefined ? 1 : Number(hunk[1])
      lineNumber = Number(hunk[2])
      pendingAdded = hunk[3] === undefined ? 1 : Number(hunk[3])
      continue
    }
    if (raw.startsWith('Binary files ') && raw.endsWith(' differ')) {
      current.inHeader = false
      current.binary = true
      continue
    }
    if (!current.inHeader) {
      if (raw !== '') current.incomplete ??= 'unexpected-line-outside-a-hunk'
      continue
    }
    const index = raw.match(INDEX_LINE)
    if (index) {
      current.newBlob = ZERO_SHA_RE.test(index[2]) ? null : index[2]
    } else if (raw.startsWith('new file mode ')) current.added = true
    else if (raw.startsWith('deleted file mode ')) current.deleted = true
    else if (raw.startsWith('rename from ') || raw.startsWith('copy from ')) {
      const source = raw.slice(raw.indexOf(' from ') + 6)
      const named = source.startsWith('"') ? readQuotedToken(source, 0) : { value: source, end: source.length }
      if (named && named.end === source.length && named.value !== '') current.oldPath = named.value
      else current.incomplete ??= 'unreadable-rename-source'
    } else if (raw.startsWith('rename to ') || raw.startsWith('copy to ')) {
      const target = raw.slice(raw.indexOf(' to ') + 4)
      const named = target.startsWith('"') ? readQuotedToken(target, 0) : { value: target, end: target.length }
      if (named && named.end === target.length && named.value !== '') current.path = named.value
      else current.incomplete ??= 'unreadable-rename-target'
    } else if (raw.startsWith('+++ ')) {
      const target = raw.slice(4)
      if (target !== '/dev/null' && current.path === null) {
        const named = prefixedPath(target, 'b/')
        if (named !== null && named !== '') current.path = named
      }
    }
  }
  if (pendingAdded > 0 || pendingRemoved > 0) current.incomplete = 'hunk-shorter-than-its-header'
  for (const section of sections) {
    delete section.inHeader
    if (section.path === null) section.incomplete ??= 'unreadable-file-path'
  }
  return sections
}

/** Parse `git diff` output into added files and added lines with line numbers. */
export function parseAddedContent(diff) {
  return addedFilesFrom(parseDiffSections(diff))
}

/** Ref updates arrive on the pre-push hook's stdin as `<localRef> <localSha> <remoteRef> <remoteSha>`. */
export function parsePushRefUpdates(text) {
  return parsePushRefInput(text).updates
}

export function parsePushRefInput(text) {
  const updates = []
  const issues = []
  const input = String(text ?? '')
  if (!input.trim()) return { ok: true, kind: 'empty', updates, issues }
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const parts = raw.trim().split(/\s+/).filter(Boolean)
    if (parts.length !== 4) {
      issues.push(`line ${index + 1}: expected four pre-push fields`)
      continue
    }
    const [localRef, localSha, remoteRef, remoteSha] = parts
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(localSha) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(remoteSha)) {
      issues.push(`line ${index + 1}: ref update contains an invalid object id`)
      continue
    }
    if (!localRef || !remoteRef) {
      issues.push(`line ${index + 1}: ref names are required`)
      continue
    }
    if (ZERO_SHA_RE.test(localSha)) continue // branch deletion pushes no content
    updates.push({ localRef, localSha, remoteRef, remoteSha })
  }
  return issues.length > 0
    ? { ok: false, kind: 'invalid', updates: [], issues }
    : { ok: true, kind: updates.length > 0 ? 'valid' : 'empty', updates, issues: [] }
}

export function gitOutputResult(repoRoot, args, {
  encoding = 'utf8',
  gitExecutable = 'git',
  indexFile = null,
  maxBuffer = DIFF_RESULT_MAX_BYTES,
  runner = spawnSync,
  timeout,
} = {}) {
  let result
  // A hook names the index being committed (`git commit -a` writes a temporary
  // one); every other variable from the caller's Git environment is dropped.
  const env = indexFile ? { ...sanitizedGitEnvironment(), GIT_INDEX_FILE: indexFile } : sanitizedGitEnvironment()
  try {
    result = runner(gitExecutable, ['-C', repoRoot, ...args], { encoding, maxBuffer, env, ...(timeout === undefined ? {} : { timeout, killSignal: 'SIGKILL' }) })
  } catch (error) {
    return { ok: false, code: 'git-command-failed', error: error instanceof Error ? error.message : String(error), stdout: null }
  }
  if (result?.error?.code === 'ENOBUFS') {
    return { ok: false, code: 'git-output-limit-exceeded', error: `Git ${args[0] ?? 'command'} exceeded the ${maxBuffer}-byte evidence limit`, stdout: null }
  }
  if (result?.error || result?.status !== 0) {
    return { ok: false, code: 'git-command-failed', error: `Git ${args[0] ?? 'command'} failed with status ${result?.status ?? 'unknown'}`, stdout: null }
  }
  const stdout = result.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : '')
  const bytes = Buffer.isBuffer(stdout) ? stdout.length : Buffer.byteLength(stdout)
  if (bytes > maxBuffer) {
    return { ok: false, code: 'git-output-limit-exceeded', error: `Git ${args[0] ?? 'command'} exceeded the ${maxBuffer}-byte evidence limit`, stdout: null }
  }
  return { ok: true, stdout, bytes }
}

/** The empty tree in this repository's object format (SHA-1 or SHA-256). */
export function emptyTreeFor(repoRoot, { runner = spawnSync } = {}) {
  const result = gitOutputResult(repoRoot, ['rev-parse', '--show-object-format'], { maxBuffer: 1024, runner })
  return (result.ok && EMPTY_TREES[result.stdout.trim()]) || EMPTY_TREE
}

export function pushRangeBase(repoRoot, remoteSha, { runner = spawnSync } = {}) {
  // A new branch has no remote counterpart, so everything it carries is new:
  // diff against the empty tree rather than silently scanning nothing.
  if (!remoteSha || ZERO_SHA_RE.test(remoteSha)) return emptyTreeFor(repoRoot, { runner })
  const result = gitOutputResult(repoRoot, ['rev-parse', '--verify', '--quiet', `${remoteSha}^{commit}`], { maxBuffer: 1024 * 1024, runner })
  return result.ok ? remoteSha : emptyTreeFor(repoRoot, { runner })
}

export const canonicalDiffArgs = (revisions, extra = []) => ['-c', 'core.quotePath=true', 'diff', ...CANONICAL_DIFF_FLAGS, '--unified=0', ...extra, ...revisions]
// The content scan judges added lines only, so a deleted file's removed lines
// would just spend the output limit. The semantic review reads removed lines
// and keeps the plain form above.
const contentDiffArgs = (revisions, extra = []) => canonicalDiffArgs(revisions, ['--irreversible-delete', ...extra])

export function diffForPushRange(repoRoot, { localSha, remoteSha }, options = {}) {
  const base = pushRangeBase(repoRoot, remoteSha, { runner: options.runner })
  const result = gitOutputResult(repoRoot, contentDiffArgs([base, localSha]), options)
  return result.ok ? { ...result, base, diff: result.stdout } : { ...result, base, diff: null }
}

export function stagedDiff(repoRoot, options = {}) {
  const result = gitOutputResult(repoRoot, contentDiffArgs(['--cached']), options)
  return result.ok ? { ...result, diff: result.stdout } : { ...result, diff: null }
}

function incompleteDiagnostic({ repo, path: filePath = null, message, details = {} }) {
  return {
    severity: 'error',
    code: 'content-scan-incomplete',
    repo,
    path: filePath,
    line: null,
    message: `${repo ?? 'repository'}${filePath ? `/${filePath}` : ''}: ${message}`,
    details,
  }
}

function unreadableSectionDiagnostics(sections, repo) {
  return sections
    .filter((section) => section.incomplete)
    .map((section) => incompleteDiagnostic({
      repo,
      path: section.path,
      message: 'a changed file could not be read from the diff, so its content was not scanned',
      details: { reason: section.incomplete },
    }))
}

const declaredArtifactPath = (context, repo, filePath) => context?.profile.artifacts.some(item => item.repo === repo && item.path === filePath)
const contentFilesFor = (sections, context, repo) => addedFilesFrom(sections).filter(file => !declaredArtifactPath(context, repo, file.path))

const addedFilesFrom = (sections) => sections
  .filter((section) => section.path !== null)
  .map(({ path: filePath, added, addedLines }) => ({ path: filePath, added, addedLines }))

function isBinaryBuffer(buffer) {
  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return false
  } catch {
    return true
  }
}

function scanBinaryBuffer({ buffer, filePath, rules, exceptions, repo }) {
  const text = buffer.toString('latin1')
  const findings = []
  for (const rule of rules) {
    if ((rule.kind ?? 'content') !== 'content' || !rulePathMatches(rule, filePath)) continue
    if (!new RegExp(rule.pattern).test(text)) continue
    if (findException({ exceptions, rule: rule.id, repo, path: filePath })) continue
    findings.push({
      severity: rule.severity ?? 'error',
      code: 'content-rule-violation',
      rule: rule.id,
      repo,
      path: filePath,
      line: null,
      binary: true,
      message: `${repo ?? ''}/${filePath}: ${rule.description ?? rule.id} (binary content)`.replace(/^\//, ''),
    })
  }
  return findings
}

const DECLARED_TEXT_BATCH = 200
// A new file's diff can be twice its size (a "+" before every short line), so a
// batch holds at most half the diff limit in blob bytes.
const DECLARED_TEXT_BATCH_BYTES = DIFF_RESULT_MAX_BYTES / 2

/**
 * Git reports a file as binary when its attributes say so, whatever it holds
 * (for example `*.cfg binary` in .gitattributes, which can arrive with the tree),
 * or when the content it replaces was binary.
 * Such text is judged like any other text: by its added lines, taken from a
 * `--text` diff of just those paths and their rename sources. Narrowing the
 * paths can change how Git pairs renames and copies, so a file's lines are used
 * only when it is paired exactly as in the main diff; otherwise, or when a batch
 * cannot be read, the file is read again on its own. Pathspecs are taken
 * literally: core.precomposeUnicode is off for this call, because it would
 * rewrite a decomposed name on the command line and match nothing. Returns, per
 * path, `{ addedLines }` or `{ cause }` naming why the text was not read.
 */
function declaredBinaryTextLines({ repoRoot, revisions, entries, changedPaths = [], gitExecutable, gitRunner, indexFile = null }) {
  const outcomes = new Map()
  const read = (group) => {
    const paths = [...new Set(group.flatMap(({ section }) => [section.path, section.oldPath].filter((value) => value && value !== '')))]
    // A literal pathspec also matches a directory of that name, so a file that
    // replaced a directory would bring the directory's changed files in as
    // rename candidates and as output. Only changed entries can appear in a
    // diff. Under a read path with nothing else read inside, one subtree
    // exclusion covers them all; under one that holds another read path, the
    // changed entries not read are excluded one by one. Usually there are none.
    const reading = new Set(paths)
    const excluded = new Set()
    for (const read of paths) {
      const under = changedPaths.filter((value) => value.startsWith(`${read}/`))
      if (under.length === 0) continue
      if (!paths.some((other) => other.startsWith(`${read}/`))) excluded.add(`${read}/`)
      else for (const value of under) if (!reading.has(value)) excluded.add(value)
    }
    const result = gitOutputResult(repoRoot, [
      '-c', 'core.precomposeUnicode=false',
      ...contentDiffArgs(revisions, ['--text']),
      '--',
      ...paths.map((value) => `:(literal)${value}`),
      ...[...excluded].map((value) => `:(exclude,literal)${value}`),
    ], { gitExecutable, indexFile, runner: gitRunner })
    const parsed = result.ok ? parseDiffSections(result.stdout) : []
    for (const { section } of group) {
      const matches = parsed.filter((candidate) => candidate.path === section.path && !candidate.deleted)
      let cause = null
      if (!result.ok) cause = result.code
      else if (matches.length === 0) cause = 'missing-from-text-diff'
      else if (matches.some((candidate) => candidate.oldPath !== section.oldPath)) cause = 'paired-differently-from-main-diff'
      else cause = matches.find((candidate) => candidate.incomplete)?.incomplete ?? (matches.some((candidate) => candidate.binary) ? 'binary-in-text-diff' : null)
      outcomes.set(section.path, cause ? { cause } : { addedLines: matches.flatMap((candidate) => candidate.addedLines) })
    }
  }
  const groups = []
  let group = []
  let bytes = 0
  for (const entry of entries) {
    if (group.length > 0 && (group.length >= DECLARED_TEXT_BATCH || bytes + entry.bytes > DECLARED_TEXT_BATCH_BYTES)) {
      groups.push(group)
      group = []
      bytes = 0
    }
    group.push(entry)
    bytes += entry.bytes
  }
  if (group.length > 0) groups.push(group)
  for (const batch of groups) {
    read(batch)
    if (batch.length === 1) continue
    for (const entry of batch) if (outcomes.get(entry.section.path).cause) read([entry])
  }
  return outcomes
}

function readBinaryChanges({ repoRoot, revisions, sections, rules, exceptions, repo, gitExecutable, gitRunner, indexFile = null, artifactContext = null }) {
  const findings = []
  const diagnostics = []
  let totalBytes = 0
  const blobs = []
  const seen = new Set()
  const declaredText = []
  // A deleted path is absent from the revision being scanned, so there is nothing
  // to read: the blob it had is already in history and is not being introduced.
  for (const section of sections) {
    if (section.deleted || section.path === null || seen.has(section.path)) continue
    const declared = declaredArtifactPath(artifactContext, repo, section.path)
    if (!section.binary && !declared) continue
    seen.add(section.path)
    const filePath = section.path
    if (!section.newBlob) {
      diagnostics.push(incompleteDiagnostic({ repo, path: filePath, message: 'binary content could not be identified in the diff', details: { reason: 'missing-blob-id' } }))
      continue
    }
    if (declared) {
      const scan = readArtifact({ context: artifactContext, section, repoRoot, repo, gitExecutable, gitRunner, exceptions })
      findings.push(...scan.findings); diagnostics.push(...scan.diagnostics)
      continue
    }
    // Read by object id: a path can be misread (":0:name" names an index stage).
    const result = gitOutputResult(repoRoot, ['cat-file', 'blob', section.newBlob], {
      encoding: 'buffer',
      gitExecutable,
      maxBuffer: BINARY_FILE_MAX_BYTES + 1,
      runner: gitRunner,
    })
    if (!result.ok) {
      diagnostics.push(incompleteDiagnostic({
        repo,
        path: filePath,
        message: `binary content could not be read within the ${BINARY_FILE_MAX_BYTES}-byte per-file limit`,
        details: { reason: result.code, limitBytes: BINARY_FILE_MAX_BYTES },
      }))
      continue
    }
    if (result.bytes > BINARY_FILE_MAX_BYTES) {
      diagnostics.push(incompleteDiagnostic({
        repo,
        path: filePath,
        message: `binary content exceeds the ${BINARY_FILE_MAX_BYTES}-byte per-file limit`,
        details: { limitBytes: BINARY_FILE_MAX_BYTES, observedBytes: result.bytes },
      }))
      continue
    }
    totalBytes += result.bytes
    blobs.push({ id: section.newBlob, bytes: result.bytes })
    if (totalBytes > BINARY_AGGREGATE_MAX_BYTES) {
      diagnostics.push(incompleteDiagnostic({
        repo,
        path: filePath,
        message: `binary content exceeds the ${BINARY_AGGREGATE_MAX_BYTES}-byte aggregate limit`,
        details: { limitBytes: BINARY_AGGREGATE_MAX_BYTES },
      }))
      break
    }
    if (isBinaryBuffer(result.stdout)) {
      findings.push(...scanBinaryBuffer({ buffer: result.stdout, filePath, rules, exceptions, repo }))
      continue
    }
    declaredText.push({ section, bytes: result.bytes })
  }
  if (declaredText.length > 0) {
    const changedPaths = [...new Set(sections.flatMap((section) => [section.path, section.oldPath]).filter((value) => value && value !== ''))]
    const outcomes = declaredBinaryTextLines({ repoRoot, revisions, entries: declaredText, changedPaths, gitExecutable, gitRunner, indexFile })
    const contentRules = rules.filter((rule) => (rule.kind ?? 'content') === 'content')
    for (const { section } of declaredText) {
      const { addedLines, cause } = outcomes.get(section.path)
      if (cause) {
        diagnostics.push(incompleteDiagnostic({
          repo,
          path: section.path,
          message: cause === 'git-output-limit-exceeded'
            ? `text that Git reports as binary has a diff over the ${DIFF_RESULT_MAX_BYTES}-byte limit, so its content was not scanned`
            : 'text that Git reports as binary could not be read as text, so its content was not scanned',
          details: { reason: 'declared-binary-text-unreadable', cause },
        }))
        continue
      }
      findings.push(...scanAddedContent({ files: [{ path: section.path, added: false, addedLines }], rules: contentRules, exceptions, repo }))
    }
  }
  return { findings, diagnostics, bytes: totalBytes, blobs }
}

export function scanStagedRepository({
  repoRoot,
  rules = DEFAULT_CONTENT_RULES,
  exceptions = [],
  repo = null,
  gitExecutable = 'git',
  gitRunner = spawnSync,
  indexFile = null,
  artifactContext = null,
} = {}) {
  const acquired = stagedDiff(repoRoot, { gitExecutable, indexFile, runner: gitRunner })
  if (!acquired.ok) {
    return {
      findings: [],
      diagnostics: [incompleteDiagnostic({ repo, message: 'staged evidence could not be acquired', details: { reason: acquired.code } })],
      bytes: 0,
    }
  }
  const sections = parseDiffSections(acquired.diff)
  const binary = readBinaryChanges({ repoRoot, revisions: ['--cached'], sections, rules, exceptions, repo, gitExecutable, gitRunner, indexFile, artifactContext })
  if (artifactContext && !artifactWork(artifactContext, acquired.bytes + binary.bytes)) binary.diagnostics.push(incompleteDiagnostic({ repo, message: 'artifact scan shared work budget exhausted', details: { reason: 'artifact-work-limit' } }))
  return {
    findings: [...scanAddedContent({ files: contentFilesFor(sections, artifactContext, repo), rules, exceptions, repo }), ...binary.findings],
    diagnostics: [...unreadableSectionDiagnostics(sections, repo), ...binary.diagnostics],
    bytes: acquired.bytes + binary.bytes,
  }
}

function scanRevisionRange({ repoRoot, base, tip, rules, exceptions, repo, gitRunner, artifactContext = null }) {
  const acquired = gitOutputResult(repoRoot, contentDiffArgs([base, tip]), { runner: gitRunner })
  if (!acquired.ok) return { acquired, keyed: [], diagnostics: [], bytes: 0, blobs: [] }
  const sections = parseDiffSections(acquired.stdout)
  const binary = readBinaryChanges({ repoRoot, revisions: [base, tip], sections, rules, exceptions, repo, gitRunner, artifactContext })
  if (artifactContext && !artifactWork(artifactContext, acquired.bytes + binary.bytes)) binary.diagnostics.push(incompleteDiagnostic({ repo, message: 'artifact scan shared work budget exhausted', details: { reason: 'artifact-work-limit' } }))
  const findings = [...scanAddedContent({ files: contentFilesFor(sections, artifactContext, repo), rules, exceptions, repo }), ...binary.findings]
  return {
    acquired,
    keyed: findings.map((item) => [findingKey(item), item]),
    diagnostics: [...unreadableSectionDiagnostics(sections, repo), ...binary.diagnostics],
    bytes: acquired.bytes + binary.bytes,
    blobs: binary.blobs,
  }
}

// What a finding reports: its rule, path and the digest of its line (binary
// content has no line), so the same content is recognised in any diff.
function findingKey(finding) {
  return [finding.rule, finding.path, finding.lineDigest ?? 'binary'].join('\0')
}

/**
 * What one commit adds. A merge adds only what is new against every parent:
 * a side parent's own commits are judged where they were made, and content the
 * remote already holds is not judged again. A finding is dropped only when a
 * fully read diff against another parent shows that parent already had it, and
 * one fully read parent diff covers everything new against all parents.
 */
function scanCommit({ repoRoot, commit, parents, empty, rules, exceptions, repo, gitRunner, artifactContext = null }) {
  if (parents.length <= 1) return scanRevisionRange({ repoRoot, base: parents[0] ?? empty, tip: commit, rules, exceptions, repo, gitRunner, artifactContext })
  const read = parents
    .map((parent) => scanRevisionRange({ repoRoot, base: parent, tip: commit, rules, exceptions, repo, gitRunner, artifactContext }))
    .filter((scan) => scan.acquired.ok)
  if (read.length === 0) return { acquired: { ok: false, code: 'merge-unreadable' }, keyed: [], diagnostics: [], bytes: 0, blobs: [] }
  const complete = read.filter((scan) => scan.diagnostics.length === 0)
  // Any complete parent diff yields the same findings; the smallest is the one
  // that does not re-read what the other parent already published.
  const reference = complete.length > 0 ? complete.reduce((small, scan) => (scan.bytes < small.bytes ? scan : small)) : read[0]
  const keyed = reference.keyed.filter(([key]) => complete.every((scan) => scan === reference || scan.keyed.some(([other]) => other === key)))
  const diagnostics = artifactContext?.failed || complete.length === 0 ? read.flatMap((scan) => scan.diagnostics) : []
  // Evidence counts once, as the diff the commit is judged by.
  return { acquired: reference.acquired, keyed, diagnostics, bytes: reference.bytes, blobs: reference.blobs }
}

const PLAIN_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * Which tracking refs already hold what this push carries. The installed hook
 * passes the remote Git names, which is a configured remote or a URL; a URL is
 * matched to the remote configured with it. Only that remote's tracking refs
 * exclude commits, so history held only by another remote is judged on its way
 * here. A URL no remote is configured with excludes nothing but the remote's
 * own commit. With no remote named (a hook installed before this), every
 * remote's tracking refs exclude, as before.
 */
function remoteScope(repoRoot, remote, runner) {
  if (typeof remote !== 'string' || remote === '') return { args: ['--remotes'], label: 'no remote holds' }
  const configured = gitOutputResult(repoRoot, ['config', '--get-regexp', '^remote\\..*\\.url$'], { maxBuffer: 1024 * 1024, runner })
  const remotes = configured.ok
    ? configured.stdout.split('\n').filter(Boolean).map((line) => {
      const space = line.indexOf(' ')
      return { name: line.slice('remote.'.length, space).replace(/\.url$/, ''), url: line.slice(space + 1) }
    })
    : []
  const named = remotes.find((item) => item.name === remote) ?? remotes.find((item) => item.url === remote)
  if (named && PLAIN_REMOTE_NAME.test(named.name)) {
    // `--remotes=origin` would also take a remote named `origin/x`; leave those out.
    const nested = remotes.filter((item) => item.name.startsWith(`${named.name}/`)).map((item) => `--exclude=${item.name}/*`)
    return { args: [...nested, `--remotes=${named.name}`], label: `${named.name} does not hold` }
  }
  return { args: [], label: `${remote} does not hold` }
}

export function scanPushUpdate({
  repoRoot,
  update,
  rules = DEFAULT_CONTENT_RULES,
  exceptions = [],
  repo = null,
  remote = null,
  gitRunner = spawnSync,
  maxCommits = PUSH_COMMIT_SCAN_MAX,
  maxBytes = CHECK_AGGREGATE_MAX_BYTES,
  aggregateLimitBytes = maxBytes,
  artifactContext = null,
} = {}) {
  const base = pushRangeBase(repoRoot, update.remoteSha, { runner: gitRunner })
  const net = scanRevisionRange({ repoRoot, base, tip: update.localSha, rules, exceptions, repo, gitRunner, artifactContext })
  if (!net.acquired.ok) {
    return {
      findings: [],
      diagnostics: [incompleteDiagnostic({ repo, message: 'push evidence could not be acquired', details: { reason: net.acquired.code } })],
      bytes: 0,
    }
  }
  const reported = new Map(net.keyed)
  const findings = net.keyed.map(([, item]) => item)
  const diagnostics = [...net.diagnostics]
  // Every path is judged wherever it appears, but each blob counts once toward
  // the evidence budget, however many diffs read it.
  const counted = new Set()
  const evidence = (scan) => scan.bytes - scan.blobs.reduce((repeat, blob) => {
    if (counted.has(blob.id)) return repeat + blob.bytes
    counted.add(blob.id)
    return repeat
  }, 0)
  let bytes = evidence(net)
  const scope = remoteScope(repoRoot, remote, gitRunner)
  // Parents before children, so a commit is judged before a merge that brings it in.
  const listed = gitOutputResult(repoRoot, ['rev-list', '--topo-order', '--reverse', '--parents', `--max-count=${maxCommits + 1}`, update.localSha, '--not', ...(base === update.remoteSha ? [base] : []), ...scope.args], { runner: gitRunner })
  if (!listed.ok) {
    diagnostics.push(incompleteDiagnostic({ repo, message: 'the commits in this push could not be listed', details: { reason: listed.code } }))
    return { findings, diagnostics, bytes }
  }
  const commits = listed.stdout.split('\n').filter(Boolean).map((line) => line.split(' '))
  if (commits.length > maxCommits) {
    diagnostics.push(incompleteDiagnostic({
      repo,
      message: `this push carries more than ${maxCommits} commits that ${scope.label}, more than are judged one by one; push it in smaller parts, an earlier commit first (git push <remote> <commit>:<ref>)`,
      details: { reason: 'push-range-too-long', limit: maxCommits },
    }))
    return { findings, diagnostics, bytes }
  }
  // One commit straight on the remote's tip is the endpoint change already judged.
  if (commits.length === 1 && commits[0].length === 2 && commits[0][1] === base) return { findings, diagnostics, bytes }
  const empty = emptyTreeFor(repoRoot, { runner: gitRunner })
  for (const [commit, ...parents] of commits) {
    const step = scanCommit({ repoRoot, commit, parents, empty, rules, exceptions, repo, gitRunner, artifactContext })
    const short = commit.slice(0, 12)
    if (!step.acquired.ok) {
      diagnostics.push(incompleteDiagnostic({ repo, message: `commit ${short} could not be read`, details: { reason: step.acquired.code, commit } }))
      continue
    }
    bytes += evidence(step)
    for (const [key, item] of step.keyed) {
      const retained = reported.get(key)
      if (retained) {
        // Already reported: record where else it was published.
        if (!retained.commit) retained.commits = [...(retained.commits ?? []), commit]
        continue
      }
      const placed = { ...item, commit, message: `${item.message} (in commit ${short})` }
      reported.set(key, placed)
      findings.push(placed)
    }
    diagnostics.push(...step.diagnostics.map((item) => ({ ...item, message: `${item.message} (in commit ${short})`, details: { ...item.details, commit } })))
    if (artifactContext?.failed) break
    if (!artifactContext && bytes > maxBytes) {
      diagnostics.push(incompleteDiagnostic({
        repo,
        message: `push evidence exceeds the ${aggregateLimitBytes}-byte aggregate limit; push it in smaller parts`,
        details: { reason: 'push-evidence-too-large', limitBytes: aggregateLimitBytes, commit },
      }))
      break
    }
  }
  return { findings, diagnostics, bytes }
}

/**
 * Whole-tree scan for the non-blocking audit. This is the view that reports every
 * accepted usage, so a repo can see what it has taken on without those findings
 * stopping unrelated work from being pushed.
 */
export function scanTree(repoRoot, {
  rules = DEFAULT_CONTENT_RULES,
  exceptions = [],
  repo = null,
  source = 'working-tree',
} = {}) {
  if (!['working-tree', 'head'].includes(source)) {
    return { findings: [], diagnostics: [incompleteDiagnostic({ repo, message: `unknown audit source ${source}` })], source }
  }
  const listed = source === 'head'
    ? gitOutputResult(repoRoot, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
    : gitOutputResult(repoRoot, ['ls-files', '-co', '--exclude-standard', '-z'])
  if (!listed.ok) {
    return { findings: [], diagnostics: [incompleteDiagnostic({ repo, message: `${source} audit paths could not be acquired`, details: { reason: listed.code } })], source }
  }
  const files = []
  const findings = []
  const diagnostics = []
  let totalBytes = 0
  for (const rel of listed.stdout.split('\0').filter(Boolean)) {
    let blob
    if (source === 'head') {
      const result = gitOutputResult(repoRoot, ['show', `HEAD:${rel}`], { encoding: 'buffer', maxBuffer: BINARY_FILE_MAX_BYTES + 1 })
      if (!result.ok) {
        diagnostics.push(incompleteDiagnostic({ repo, path: rel, message: 'HEAD blob could not be read', details: { reason: result.code } }))
        continue
      }
      blob = result.stdout
    } else {
      const abs = pathForAudit(repoRoot, rel)
      try {
        const stat = fs.lstatSync(abs)
        if (!stat.isFile() && !stat.isSymbolicLink()) continue
        blob = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs)) : fs.readFileSync(abs)
      } catch {
        diagnostics.push(incompleteDiagnostic({ repo, path: rel, message: 'working-tree file could not be read' }))
        continue
      }
    }
    if (blob.length > BINARY_FILE_MAX_BYTES) {
      diagnostics.push(incompleteDiagnostic({ repo, path: rel, message: `audit content exceeds the ${BINARY_FILE_MAX_BYTES}-byte per-file limit` }))
      continue
    }
    totalBytes += blob.length
    if (totalBytes > BINARY_AGGREGATE_MAX_BYTES) {
      diagnostics.push(incompleteDiagnostic({ repo, path: rel, message: `audit content exceeds the ${BINARY_AGGREGATE_MAX_BYTES}-byte aggregate limit` }))
      break
    }
    if (isBinaryBuffer(blob)) {
      findings.push(...scanBinaryBuffer({ buffer: blob, filePath: rel, rules, exceptions, repo }))
      continue
    }
    const text = blob.toString('utf8')
    files.push({
      path: rel,
      added: true,
      addedLines: text.split('\n').map((line, index) => ({ number: index + 1, text: line })),
    })
  }
  findings.push(...scanAddedContent({ files, rules, exceptions, repo }))
  return { findings, diagnostics, source, bytes: totalBytes }
}

function pathForAudit(repoRoot, rel) {
  return path.join(repoRoot, ...normalizeRelPath(rel).split('/'))
}

// V2 is an explicit resource/coverage profile, never an exception to a finding.
const MiB = 1024 * 1024
export const ARTIFACT_SCAN_LIMITS = Object.freeze({ artifactBytes: 128 * MiB, expandedBytes: 128 * MiB, entryBytes: 32 * MiB, entries: 1024, workBytes: 512 * MiB, timeoutMs: 30000 })
const artifactKeys = ['repo', 'path', 'blob', 'sha256', 'bytes', 'coverage']
const limitKeys = ['maxArtifactBytes', 'maxExpandedBytes', 'maxEntryBytes', 'maxEntries', 'maxWorkBytes', 'timeoutMs']
const maxima = [ARTIFACT_SCAN_LIMITS.artifactBytes, ARTIFACT_SCAN_LIMITS.expandedBytes, ARTIFACT_SCAN_LIMITS.entryBytes, ARTIFACT_SCAN_LIMITS.entries, ARTIFACT_SCAN_LIMITS.workBytes, ARTIFACT_SCAN_LIMITS.timeoutMs]
const portableArtifactPath = value => typeof value === 'string' && value.length <= 1024 && !/[\0-\x1f\x7f\\:]/.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')
const canonicalArtifactJson = value => Array.isArray(value) ? `[${value.map(canonicalArtifactJson).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalArtifactJson(value[key])}`).join(',')}}` : JSON.stringify(value)
const artifactDigest = value => createHash('sha256').update(canonicalArtifactJson(value)).digest('hex')

export function validateArtifactScan(profile, rules = DEFAULT_CONTENT_RULES) {
  const errors = []
  if (!isObject(profile) || Object.keys(profile).some(key => !['artifacts', 'limits'].includes(key))) return ['artifactScan must contain only artifacts and limits']
  const limits = profile.limits
  if (!isObject(limits) || Object.keys(limits).some(key => !limitKeys.includes(key)) || limitKeys.some((key, i) => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maxima[i])) errors.push('artifactScan limits must be explicit positive integers within supported maxima')
  if (!Array.isArray(profile.artifacts) || !profile.artifacts.length || profile.artifacts.length > 128) errors.push('artifactScan requires 1 through 128 exact artifact bindings')
  const seen = new Set()
  for (const item of Array.isArray(profile.artifacts) ? profile.artifacts : []) {
    if (!isObject(item) || Object.keys(item).some(key => !artifactKeys.includes(key)) || artifactKeys.some(key => !Object.hasOwn(item, key)) ||
        typeof item.repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item.repo) || !portableArtifactPath(item.path) ||
        typeof item.blob !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.blob) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > (limits?.maxArtifactBytes ?? 0) || !['raw-bytes', 'zip-flat-entries'].includes(item.coverage)) {
      errors.push('artifactScan binding has invalid identity, coverage or byte count'); continue
    }
    const key = `${item.repo}\0${item.path}\0${item.blob}`
    if (seen.has(key)) errors.push('artifactScan bindings must be unique by repo/path/blob')
    seen.add(key)
  }
  if (rules.length > 128 || validateContentRules(rules).length) errors.push('artifactScan requires at most 128 valid content rules')
  return errors
}

export function createArtifactScanContext(profile, rules = DEFAULT_CONTENT_RULES) {
  if (validateArtifactScan(profile, rules).length) throw new Error('invalid artifact scan profile')
  const snapshot = JSON.parse(JSON.stringify({ profile, rules }))
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) } }
  freeze(snapshot)
  return { ...snapshot, profileDigest: artifactDigest(snapshot), workBytes: 0, failed: false, coverage: [] }
}

function artifactWork(context, bytes) {
  if (context.failed || !Number.isSafeInteger(bytes) || bytes < 0 || context.workBytes + bytes > context.profile.limits.maxWorkBytes) {
    context.failed = true
    return false
  }
  context.workBytes += bytes
  return true
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n & 1) ? (0xedb88320 ^ (n >>> 1)) : n >>> 1
  return n >>> 0
})
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// Deliberately narrow ZIP profile: contiguous local entries, no comments/extras,
// descriptors, encryption, ZIP64, links or ambiguous filenames. Never extracts.
function zipArtifactEntries(bytes, limits, remainingWork) {
  const fail = () => { throw new Error('unsupported-or-invalid-zip') }
  const end = bytes.length - 22
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail()
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16)
  if (count !== bytes.readUInt16LE(end + 8) || !count || count === 0xffff || count > limits.maxEntries || start + size !== end) fail()
  const entries = [], names = new Map()
  let cursor = start, local = 0, expanded = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50 || bytes.readUInt16LE(cursor + 6) > 20) fail()
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), length = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28)
    const extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), disk = bytes.readUInt16LE(cursor + 34), mode = bytes.readUInt32LE(cursor + 38) >>> 16
    const offset = bytes.readUInt32LE(cursor + 42), centralEnd = cursor + 46 + nameLength
    if ((flags & ~0x800) || ![0, 8].includes(method) || extra || comment || disk || !nameLength || nameLength > 1024 || centralEnd > end || offset !== local || [compressed, length, offset].includes(0xffffffff) || (mode & 0xf000) === 0xa000 || ((mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000))) fail()
    const nameBytes = bytes.subarray(cursor + 46, centralEnd)
    if (!(flags & 0x800) && nameBytes.some(byte => byte > 127)) fail()
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    const directory = name.endsWith('/'), identity = directory ? name.slice(0, -1) : name
    if (!portableArtifactPath(identity) || identity.normalize('NFC') !== identity || names.has(identity.toLowerCase()) || [...names].some(([previous, isDirectory]) => (!isDirectory && identity.toLowerCase().startsWith(previous + '/')) || (!directory && previous.startsWith(identity.toLowerCase() + '/'))) || ((mode & 0xf000) === 0x4000 && !directory)) fail()
    names.set(identity.toLowerCase(), directory)
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) !== bytes.readUInt16LE(cursor + 6) || bytes.readUInt32LE(local + 10) !== bytes.readUInt32LE(cursor + 12) || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method || bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== length || bytes.readUInt16LE(local + 26) !== nameLength || bytes.readUInt16LE(local + 28) !== 0) fail()
    const dataStart = local + 30 + nameLength, dataEnd = dataStart + compressed
    if (dataEnd > start || !bytes.subarray(local + 30, dataStart).equals(nameBytes) || length > limits.maxEntryBytes || expanded + length > limits.maxExpandedBytes || expanded + length > remainingWork || (directory && (length || compressed))) fail()
    const payload = bytes.subarray(dataStart, dataEnd)
    let decoded
    if (method === 0) decoded = payload
    else {
      const inflated = inflateRawSync(payload, { maxOutputLength: Math.max(1, length), info: true })
      if (inflated.engine.bytesWritten !== compressed) fail()
      decoded = inflated.buffer
    }
    if (decoded.length !== length || crc32(decoded) !== crc) fail()
    // Nested content is not decoded by this flat profile. Recognized container
    // signatures/extensions refuse rather than silently claim recursive coverage.
    const hex = decoded.subarray(0, 8).toString('hex')
    if (/\.(zip|gz|tgz|tar|bz2|xz|7z|rar|zst)$/i.test(identity) || /^(504b0304|504b0506|504b0708|1f8b|425a68|fd377a585a00|377abcaf271c|52617221|28b52ffd)/.test(hex) || decoded.subarray(257, 262).toString() === 'ustar') fail()
    expanded += decoded.length
    entries.push({ name: identity, bytes: decoded, directory })
    cursor = centralEnd; local = dataEnd
  }
  if (cursor !== end || local !== start) fail()
  return { entries, expanded }
}

// Runs only in an isolated child on a complete finite unit. No filesystem or
// Git access occurs here. The caller owns the byte/profile identity checks.
export function executeArtifactScan(input, bytes) {
  const { binding, limits, rules, profileDigest, remainingWork, added } = input
  const matches = [], found = new Set()
  const scan = (unit, filePath, content, entry = null) => {
    for (const rule of rules) {
      const kind = rule.kind ?? 'content'
      if (kind === 'path' && !['entry-path', 'outer-path'].includes(unit)) continue
      if (kind !== 'path' && ['entry-path', 'outer-path'].includes(unit)) continue
      if (kind === 'content' && !rulePathMatches(rule, filePath)) continue
      if (!new RegExp(rule.pattern, kind === 'path' ? 'i' : '').test(content)) continue
      const key = `${rule.id}\0${entry}\0${unit}`
      if (!found.has(key)) { matches.push({ rule: rule.id, entry, unit }); found.add(key) }
      if (matches.length > 4096) throw new Error('artifact-result-limit')
    }
  }
  if (added) scan('outer-path', binding.path, binding.path)
  scan('raw-bytes', binding.path, bytes.toString('latin1'))
  let expanded = 0, entries = 0
  if (binding.coverage === 'zip-flat-entries') {
    const decoded = zipArtifactEntries(bytes, limits, remainingWork)
    expanded = decoded.expanded; entries = decoded.entries.length
    for (const [index, entry] of decoded.entries.entries()) {
      const virtual = `${binding.path}!/${entry.name}`
      scan('entry-path', virtual, entry.name, index)
      if (!entry.directory) scan('entry-bytes', virtual, entry.bytes.toString('latin1'), index)
    }
  }
  return { matches, expandedBytes: expanded, entries, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), profileDigest, coverage: binding.coverage }
}

function readArtifact({ context, section, repoRoot, repo, gitExecutable, gitRunner, exceptions }) {
  const profile = context.profile, limits = profile.limits
  const binding = profile.artifacts.find(item => item.repo === repo && item.path === section.path && item.blob === section.newBlob)
  const refuse = reason => {
    context.failed = true
    return { diagnostics: [incompleteDiagnostic({ repo, path: section.path, message: 'declared artifact scan did not complete', details: { reason } })], findings: [] }
  }
  if (!binding || context.failed) return refuse('artifact-binding-unavailable')
  const started = Date.now()
  const remaining = () => Math.max(1, limits.timeoutMs - (Date.now() - started))
  const type = gitOutputResult(repoRoot, ['cat-file', '-t', binding.blob], { gitExecutable, runner: gitRunner, timeout: remaining(), maxBuffer: 1024 })
  const size = gitOutputResult(repoRoot, ['cat-file', '-s', binding.blob], { gitExecutable, runner: gitRunner, timeout: remaining(), maxBuffer: 1024 })
  if (!type.ok || type.stdout.trim() !== 'blob' || !size.ok || !/^\d+\n?$/.test(size.stdout) || Number(size.stdout.trim()) !== binding.bytes || !artifactWork(context, binding.bytes)) return refuse('artifact-type-size-or-work-limit')
  const result = gitOutputResult(repoRoot, ['cat-file', 'blob', binding.blob], { gitExecutable, runner: gitRunner, encoding: 'buffer', timeout: remaining(), maxBuffer: binding.bytes + 1 })
  if (!result.ok || !Buffer.isBuffer(result.stdout) || result.bytes !== binding.bytes) return refuse('artifact-read-incomplete')
  const bytes = result.stdout
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const object = createHash(binding.blob.length === 40 ? 'sha1' : 'sha256').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  if (sha256 !== binding.sha256 || object !== binding.blob) return refuse('artifact-integrity-mismatch')
  const input = { binding, limits, rules: context.rules, added: section.added, profileDigest: context.profileDigest, remainingWork: limits.maxWorkBytes - context.workBytes }
  const header = Buffer.from(JSON.stringify(input)), length = Buffer.alloc(4); length.writeUInt32BE(header.length)
  if (header.length > 256 * 1024 || Date.now() - started >= limits.timeoutMs) return refuse('artifact-input-or-time-limit')
  const worker = `import fs from 'node:fs'; import { executeArtifactScan } from ${JSON.stringify(import.meta.url)}; try { const b=fs.readFileSync(0); const n=b.readUInt32BE(0); const result=executeArtifactScan(JSON.parse(b.subarray(4,4+n).toString()),b.subarray(4+n)); process.stdout.write(JSON.stringify(result)); } catch { process.exitCode=1; }`
  // No NODE_OPTIONS, preload, credentials, package hooks or caller Git settings.
  const child = spawnSync(process.execPath, ['--max-old-space-size=384', '--input-type=module', '-e', worker], {
    input: Buffer.concat([length, header, bytes]), encoding: 'utf8', timeout: remaining(), killSignal: 'SIGKILL', maxBuffer: MiB,
    env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '' } : {},
  })
  if (child.error || child.signal || child.status !== 0 || Date.now() - started >= limits.timeoutMs) return refuse('artifact-worker-incomplete')
  let output
  try { output = JSON.parse(child.stdout) } catch { return refuse('artifact-worker-output-invalid') }
  if (output.sha256 !== sha256 || output.bytes !== bytes.length || output.profileDigest !== context.profileDigest || output.coverage !== binding.coverage || !Array.isArray(output.matches) || !Number.isSafeInteger(output.entries) || output.entries < 0 || !artifactWork(context, output.expandedBytes)) return refuse('artifact-worker-binding-invalid')
  const findings = []
  for (const match of output.matches) {
    const rule = context.rules.find(rule => rule.id === match.rule)
    if (!rule || !['raw-bytes', 'entry-bytes', 'entry-path', 'outer-path'].includes(match.unit) || !(match.entry === null || (Number.isSafeInteger(match.entry) && match.entry >= 0 && match.entry < output.entries))) return refuse('artifact-worker-match-invalid')
    // Entry exceptions cannot silently inherit an outer-path carve-out.
    if (match.entry === null && findException({ exceptions, rule: rule.id, repo, path: section.path })) continue
    findings.push({ severity: rule.severity ?? 'error', code: 'content-rule-violation', rule: rule.id, repo, path: section.path, line: null, binary: true, message: `${repo ?? 'repository'}/${section.path}: artifact content rule matched`, details: { coverage: match.unit, entryIndex: match.entry } })
  }
  context.coverage.push({ repo, path: section.path, blob: binding.blob, sha256, bytes: bytes.length, profileDigest: context.profileDigest, coverage: binding.coverage, entries: output.entries, expandedBytes: output.expandedBytes })
  return { diagnostics: [], findings }
}
