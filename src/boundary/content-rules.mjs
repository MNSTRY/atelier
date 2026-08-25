import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { matchesPathPattern, normalizeRelPath } from '../project/path-match.mjs'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
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
      if (!['id', 'kind', 'severity', 'pattern', 'paths', 'description'].includes(key)) errors.push(`${at} must not include additional property ${key}`)
    }
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
      if (!['rule', 'repo', 'paths', 'reason'].includes(key)) errors.push(`${at} must not include additional property ${key}`)
    }
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
    const filePath = normalizeRelPath(file.path)
    for (const rule of rules) {
      const kind = rule.kind ?? 'content'
      const severity = rule.severity ?? 'error'
      const exception = findException({ exceptions, rule: rule.id, repo, path: filePath })
      if (kind === 'path') {
        if (!file.added || !new RegExp(rule.pattern, 'i').test(filePath)) continue
        if (exception) continue
        findings.push({ severity, code: 'content-rule-violation', rule: rule.id, repo, path: filePath, line: null, message: `${repo ?? ''}/${filePath}: ${rule.description ?? rule.id}`.replace(/^\//, '') })
        continue
      }
      if (!rulePathMatches(rule, filePath)) continue
      const re = new RegExp(rule.pattern)
      for (const line of file.addedLines ?? []) {
        if (!re.test(line.text)) continue
        if (exception) continue
        findings.push({
          severity,
          code: 'content-rule-violation',
          rule: rule.id,
          repo,
          path: filePath,
          line: line.number,
          message: `${repo ?? ''}/${filePath}:${line.number}: ${rule.description ?? rule.id}`.replace(/^\//, ''),
        })
      }
    }
  }
  return findings
}

/** Parse `git diff` output into added files and added lines with line numbers. */
export function parseAddedContent(diff) {
  const files = []
  let current = null
  let lineNumber = 0
  for (const raw of String(diff ?? '').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const header = raw.match(/^diff --git a\/(.*) b\/(.*)$/)
      current = { path: header ? normalizeRelPath(header[2]) : null, added: false, addedLines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith('new file mode ')) {
      current.added = true
      continue
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      lineNumber = Number(hunk[1])
      continue
    }
    if (/^\+(?!\+)/.test(raw)) {
      current.addedLines.push({ number: lineNumber, text: raw.slice(1) })
      lineNumber += 1
    } else if (/^-(?!-)/.test(raw)) {
      // removed lines do not advance the new-file line counter
    } else if (raw.startsWith(' ')) {
      lineNumber += 1
    }
  }
  return files.filter((file) => file.path)
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
  maxBuffer = DIFF_RESULT_MAX_BYTES,
  runner = spawnSync,
} = {}) {
  let result
  try {
    result = runner('git', ['-C', repoRoot, ...args], { encoding, maxBuffer })
  } catch (error) {
    return { ok: false, code: 'git-command-failed', error: error instanceof Error ? error.message : String(error), stdout: null }
  }
  if (result?.error?.code === 'ENOBUFS') {
    return { ok: false, code: 'git-output-limit-exceeded', error: `Git ${args[0] ?? 'command'} exceeded the ${maxBuffer}-byte evidence limit`, stdout: null }
  }
  if (result?.status !== 0) {
    return { ok: false, code: 'git-command-failed', error: `Git ${args[0] ?? 'command'} failed with status ${result?.status ?? 'unknown'}`, stdout: null }
  }
  const stdout = result.stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : '')
  const bytes = Buffer.isBuffer(stdout) ? stdout.length : Buffer.byteLength(stdout)
  if (bytes > maxBuffer) {
    return { ok: false, code: 'git-output-limit-exceeded', error: `Git ${args[0] ?? 'command'} exceeded the ${maxBuffer}-byte evidence limit`, stdout: null }
  }
  return { ok: true, stdout, bytes }
}

export function pushRangeBase(repoRoot, remoteSha) {
  // A new branch has no remote counterpart, so everything it carries is new:
  // diff against the empty tree rather than silently scanning nothing.
  if (!remoteSha || ZERO_SHA_RE.test(remoteSha)) return EMPTY_TREE
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${remoteSha}^{commit}`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  return result.status === 0 ? remoteSha : EMPTY_TREE
}

export function diffForPushRange(repoRoot, { localSha, remoteSha }, options = {}) {
  const base = pushRangeBase(repoRoot, remoteSha)
  const result = gitOutputResult(repoRoot, ['diff', '--unified=0', base, localSha], options)
  return result.ok ? { ...result, base, diff: result.stdout } : { ...result, base, diff: null }
}

export function stagedDiff(repoRoot, options = {}) {
  const result = gitOutputResult(repoRoot, ['diff', '--cached', '--unified=0'], options)
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

function binaryPathsFromDiff(diff) {
  const paths = new Set()
  let current = null
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = line.match(/^diff --git a\/(.*) b\/(.*)$/)
      current = header ? normalizeRelPath(header[2]) : null
      continue
    }
    if (current && (line.startsWith('Binary files ') || line === 'GIT binary patch')) paths.add(current)
  }
  return [...paths]
}

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
  if (!isBinaryBuffer(buffer)) return []
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

function readBinaryChanges({ repoRoot, revision, diff, rules, exceptions, repo }) {
  const findings = []
  const diagnostics = []
  let totalBytes = 0
  for (const filePath of binaryPathsFromDiff(diff)) {
    const spec = revision === ':' ? `:${filePath}` : `${revision}:${filePath}`
    const result = gitOutputResult(repoRoot, ['show', spec], {
      encoding: 'buffer',
      maxBuffer: BINARY_FILE_MAX_BYTES + 1,
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
    if (totalBytes > BINARY_AGGREGATE_MAX_BYTES) {
      diagnostics.push(incompleteDiagnostic({
        repo,
        path: filePath,
        message: `binary content exceeds the ${BINARY_AGGREGATE_MAX_BYTES}-byte aggregate limit`,
        details: { limitBytes: BINARY_AGGREGATE_MAX_BYTES },
      }))
      break
    }
    findings.push(...scanBinaryBuffer({ buffer: result.stdout, filePath, rules, exceptions, repo }))
  }
  return { findings, diagnostics, bytes: totalBytes }
}

export function scanStagedRepository({
  repoRoot,
  rules = DEFAULT_CONTENT_RULES,
  exceptions = [],
  repo = null,
  gitRunner = spawnSync,
} = {}) {
  const acquired = stagedDiff(repoRoot, { runner: gitRunner })
  if (!acquired.ok) {
    return {
      findings: [],
      diagnostics: [incompleteDiagnostic({ repo, message: 'staged evidence could not be acquired', details: { reason: acquired.code } })],
      bytes: 0,
    }
  }
  const files = parseAddedContent(acquired.diff)
  const binary = readBinaryChanges({ repoRoot, revision: ':', diff: acquired.diff, rules, exceptions, repo })
  return {
    findings: [...scanAddedContent({ files, rules, exceptions, repo }), ...binary.findings],
    diagnostics: binary.diagnostics,
    bytes: acquired.bytes + binary.bytes,
  }
}

export function scanPushUpdate({
  repoRoot,
  update,
  rules = DEFAULT_CONTENT_RULES,
  exceptions = [],
  repo = null,
  gitRunner = spawnSync,
} = {}) {
  const acquired = diffForPushRange(repoRoot, update, { runner: gitRunner })
  if (!acquired.ok) {
    return {
      findings: [],
      diagnostics: [incompleteDiagnostic({ repo, message: 'push evidence could not be acquired', details: { reason: acquired.code } })],
      bytes: 0,
    }
  }
  const files = parseAddedContent(acquired.diff)
  const binary = readBinaryChanges({ repoRoot, revision: update.localSha, diff: acquired.diff, rules, exceptions, repo })
  return {
    findings: [...scanAddedContent({ files, rules, exceptions, repo }), ...binary.findings],
    diagnostics: binary.diagnostics,
    bytes: acquired.bytes + binary.bytes,
  }
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
