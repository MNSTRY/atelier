import { spawnSync } from 'node:child_process'
import { matchesPathPattern, normalizeRelPath } from '../project/path-match.mjs'

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const ZERO_SHA_RE = /^0{40,}$/

export const RULE_KINDS = Object.freeze(['content', 'path'])
export const RULE_SEVERITIES = Object.freeze(['error', 'warning'])

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
      pattern: '(\\.env($|\\.)|invoice|payroll|(^|[-_/])salar(y|ies)|bank[-_]?statement|tax[-_]?return|credential|(^|[-_/])password([-_.]|$)|(^|[-_/])secret([-_.]|$)|id_rsa)',
      description: 'Private or financial material does not belong in a source repo.',
    },
  ].map(Object.freeze),
)

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '')

export function validateContentRules(rules, { label = 'contentRules' } = {}) {
  const errors = []
  if (!Array.isArray(rules)) return [`${label} must be an array`]
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
  return declared ?? DEFAULT_CONTENT_RULES
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
  const updates = []
  for (const raw of String(text ?? '').split('\n')) {
    const parts = raw.trim().split(/\s+/).filter(Boolean)
    if (parts.length < 4) continue
    const [localRef, localSha, remoteRef, remoteSha] = parts
    if (ZERO_SHA_RE.test(localSha)) continue // branch deletion pushes no content
    updates.push({ localRef, localSha, remoteRef, remoteSha })
  }
  return updates
}

function gitOutput(repoRoot, args) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : null
}

export function pushRangeBase(repoRoot, remoteSha) {
  // A new branch has no remote counterpart, so everything it carries is new:
  // diff against the empty tree rather than silently scanning nothing.
  if (!remoteSha || ZERO_SHA_RE.test(remoteSha)) return EMPTY_TREE
  return gitOutput(repoRoot, ['rev-parse', '--verify', '--quiet', `${remoteSha}^{commit}`]) ? remoteSha : EMPTY_TREE
}

export function diffForPushRange(repoRoot, { localSha, remoteSha }) {
  const base = pushRangeBase(repoRoot, remoteSha)
  return gitOutput(repoRoot, ['diff', '--unified=0', base, localSha]) ?? ''
}

export function stagedDiff(repoRoot) {
  return gitOutput(repoRoot, ['diff', '--cached', '--unified=0']) ?? ''
}

/**
 * Whole-tree scan for the non-blocking audit. This is the view that reports every
 * accepted usage, so a repo can see what it has taken on without those findings
 * stopping unrelated work from being pushed.
 */
export function scanTree(repoRoot, { rules = DEFAULT_CONTENT_RULES, exceptions = [], repo = null } = {}) {
  const listed = gitOutput(repoRoot, ['ls-files', '-z']) ?? ''
  const files = []
  for (const rel of listed.split('\0').filter(Boolean)) {
    const blob = gitOutput(repoRoot, ['show', `HEAD:${rel}`])
    if (blob == null) continue
    files.push({
      path: rel,
      added: true,
      addedLines: blob.split('\n').map((text, index) => ({ number: index + 1, text })),
    })
  }
  return scanAddedContent({ files, rules, exceptions, repo })
}
