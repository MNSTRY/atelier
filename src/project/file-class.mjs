import fs from 'node:fs'
import path from 'node:path'
import { basenameOf, matchesPathPattern, normalizeRelPath } from './path-match.mjs'

export const FILE_CLASS_SCHEMA = 'mnstry.atelier-file-classes@v1'

export const SOURCE = 'source'
export const GENERATED_PROJECTION = 'generated-projection'
export const DISTRIBUTED_RUNTIME_COPY = 'distributed-runtime-copy'

// Declarable classes for tracked files. The kit manifest schema closes this set.
export const FILE_CLASSES = Object.freeze([SOURCE, GENERATED_PROJECTION, DISTRIBUTED_RUNTIME_COPY])

// A machine-local file that git never tracks. It is not declarable: nothing
// tracked can be ignored-local, so it stays out of FILE_CLASSES.
export const IGNORED_LOCAL = 'ignored-local'

// What each class means for automated handling. Sync loops, merge policies, upgrade
// tooling, and CI guards all read this instead of each keeping a list of filenames
// that drifts out of step with the others.
export const FILE_CLASS_HANDLING = Object.freeze({
  [SOURCE]: Object.freeze({ rederivable: false, discardable: false, conflictsNeedHuman: true }),
  [GENERATED_PROJECTION]: Object.freeze({ rederivable: true, discardable: true, conflictsNeedHuman: false }),
  [DISTRIBUTED_RUNTIME_COPY]: Object.freeze({ rederivable: true, discardable: true, conflictsNeedHuman: false }),
  // Holds this machine's only reference to external editable state. Never
  // swept, never synced, never a merge conflict.
  [IGNORED_LOCAL]: Object.freeze({ rederivable: false, discardable: false, conflictsNeedHuman: false }),
})

// The one repo-local file the Obsidian view leaves in a repository or
// workspace: a pointer to the external data directory and its local settings.
// It lives under the existing ignored local-state directory.
export const OBSIDIAN_LOCAL_POINTER = '.atelier-local/obsidian.json'
export const IGNORED_LOCAL_PATTERNS = Object.freeze([`**/${OBSIDIAN_LOCAL_POINTER}`])

// The kit's own declaration — the single place these paths are classified. A
// distributed-runtime-copy is canonical in exactly one repo role and rederivable
// everywhere else; that is why the class carries `canonicalRepoRole` rather than
// being a bare list of names. Folding runtime copies into a plain "generated" list
// makes a sync loop discard canonical source in the repo that owns it.
export const KIT_FILE_CLASSES = Object.freeze([
  { pattern: '**/atelier.manifest.json', class: GENERATED_PROJECTION },
  { pattern: '**/atelier-ledger.html', class: GENERATED_PROJECTION },
  { pattern: '**/atelier-shell.js', class: GENERATED_PROJECTION },
  { pattern: '**/knowledge.graph.json', class: GENERATED_PROJECTION },
  { pattern: 'atelier-output/**', class: GENERATED_PROJECTION },
  { pattern: 'atelier-readers/**', class: GENERATED_PROJECTION },
  { pattern: 'atelier.lock.json', class: GENERATED_PROJECTION },
  { pattern: 'atelier-runtime.lock.json', class: GENERATED_PROJECTION },
].map(Object.freeze))

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value)

export function validateFileClasses(entries, { label = 'fileClasses' } = {}) {
  const errors = []
  if (!Array.isArray(entries)) return [`${label} must be an array`]
  const seen = new Set()
  for (const [index, entry] of entries.entries()) {
    const at = `${label}[${index}]`
    if (!isObject(entry)) {
      errors.push(`${at} must be an object`)
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!['pattern', 'class', 'canonicalRepoRole', 'note'].includes(key)) errors.push(`${at} must not include additional property ${key}`)
    }
    const pattern = typeof entry.pattern === 'string' ? entry.pattern.trim() : ''
    if (!pattern) errors.push(`${at}.pattern must be a non-empty string`)
    else if (seen.has(pattern)) errors.push(`${at}.pattern duplicates an earlier entry: ${pattern}`)
    else seen.add(pattern)
    if (!FILE_CLASSES.includes(entry.class)) errors.push(`${at}.class must be one of ${FILE_CLASSES.join(', ')}`)
    if (entry.class === DISTRIBUTED_RUNTIME_COPY && !(typeof entry.canonicalRepoRole === 'string' && entry.canonicalRepoRole.trim())) {
      errors.push(`${at}.canonicalRepoRole is required for ${DISTRIBUTED_RUNTIME_COPY}; a copy must declare where it is canonical`)
    }
    if (entry.class !== DISTRIBUTED_RUNTIME_COPY && entry.canonicalRepoRole != null) {
      errors.push(`${at}.canonicalRepoRole is only meaningful for ${DISTRIBUTED_RUNTIME_COPY}`)
    }
  }
  return errors
}

/**
 * Resolve the class of a path for a given repo role.
 *
 * Later entries win, as in .gitignore, so an adopter can narrow a kit default by
 * appending a more specific pattern.
 *
 * A distributed-runtime-copy resolves to `source` in the repo role that owns it and
 * stays a copy everywhere else. That role-dependence is the whole point: the same
 * path is canonical in one repo and freely rederivable in its consumers.
 */
export function classifyPath(filePath, { repoRole = null, fileClasses = KIT_FILE_CLASSES } = {}) {
  const rel = normalizeRelPath(filePath)
  // Not overridable: a declaration cannot turn a local pointer into something
  // a sync loop may discard or commit.
  const localPattern = IGNORED_LOCAL_PATTERNS.find((pattern) => matchesPathPattern(pattern, rel))
  if (localPattern) {
    return { path: rel, class: IGNORED_LOCAL, pattern: localPattern, canonicalRepoRole: null, canonicalHere: true, declared: false, handling: FILE_CLASS_HANDLING[IGNORED_LOCAL] }
  }
  let matched = null
  for (const entry of fileClasses) {
    if (matchesPathPattern(entry.pattern, rel)) matched = entry
  }
  if (!matched) {
    return { path: rel, class: SOURCE, pattern: null, canonicalRepoRole: null, canonicalHere: true, declared: false, handling: FILE_CLASS_HANDLING[SOURCE] }
  }
  const canonicalHere = matched.class === DISTRIBUTED_RUNTIME_COPY ? repoRole === matched.canonicalRepoRole : matched.class === SOURCE
  const resolved = matched.class === DISTRIBUTED_RUNTIME_COPY && canonicalHere ? SOURCE : matched.class
  return {
    path: rel,
    class: resolved,
    declaredClass: matched.class,
    pattern: matched.pattern,
    canonicalRepoRole: matched.canonicalRepoRole ?? null,
    canonicalHere,
    declared: true,
    handling: FILE_CLASS_HANDLING[resolved],
  }
}

export function createPathClassifier({ repoRole = null, fileClasses = KIT_FILE_CLASSES } = {}) {
  return (filePath) => classifyPath(filePath, { repoRole, fileClasses })
}

// Basenames of projections a walker can skip outright, derived from the declaration
// rather than restated next to it.
export function generatedProjectionBasenames(fileClasses = KIT_FILE_CLASSES) {
  const names = new Set()
  for (const entry of fileClasses) {
    if (entry.class !== GENERATED_PROJECTION) continue
    const base = basenameOf(entry.pattern)
    if (base && !base.includes('*')) names.add(base)
  }
  return names
}

// Directory basenames whose complete subtree is generated. Graph walkers can
// prune these without restating output-root names beside the declaration.
export function generatedProjectionDirectoryBasenames(fileClasses = KIT_FILE_CLASSES) {
  const names = new Set()
  for (const entry of fileClasses) {
    if (entry.class !== GENERATED_PROJECTION) continue
    const normalized = normalizeRelPath(entry.pattern)
    if (!normalized.endsWith('/**')) continue
    const parent = normalized.slice(0, -3).split('/').at(-1)
    if (parent && !parent.includes('*')) names.add(parent)
  }
  return names
}

// ---------------------------------------------------------------------------
// External managed data root: <data>/obsidian/<workspace-id>/
// ---------------------------------------------------------------------------

export const EDITABLE_VAULT = 'editable-vault'
export const TRUSTED_STATE = 'trusted-state'
export const RECOVERY_RECORD = 'recovery-record'
export const DISPOSABLE_STAGING = 'disposable-staging'
export const UNKNOWN_MANAGED = 'unknown-managed'

// Only staging is discardable. A vault holds a person's edits and recovery
// holds the only other copy of them, so neither is ever generated output, and
// anything unrecognized is kept.
export const MANAGED_AREA_HANDLING = Object.freeze({
  [EDITABLE_VAULT]: Object.freeze({ rederivable: false, discardable: false, conflictsNeedHuman: true }),
  [TRUSTED_STATE]: Object.freeze({ rederivable: false, discardable: false, conflictsNeedHuman: true }),
  [RECOVERY_RECORD]: Object.freeze({ rederivable: false, discardable: false, conflictsNeedHuman: true }),
  [DISPOSABLE_STAGING]: Object.freeze({ rederivable: true, discardable: true, conflictsNeedHuman: false }),
  [UNKNOWN_MANAGED]: Object.freeze({ rederivable: false, discardable: false, conflictsNeedHuman: true }),
})

const MANAGED_AREAS = Object.freeze({ vaults: EDITABLE_VAULT, state: TRUSTED_STATE, recovery: RECOVERY_RECORD, staging: DISPOSABLE_STAGING })

// Classify a path relative to one workspace's managed data root. Matching is
// exact and case-sensitive, and a path that climbs, is absolute or names only
// the area directory itself is never discardable.
export function classifyManagedPath(relativePath) {
  const rel = normalizeRelPath(relativePath).replace(/\/+$/, '')
  const segments = rel.split('/')
  const contained = rel !== '' && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel) && !segments.some((part) => part === '..' || part === '.' || part === '')
  const area = contained && segments.length > 1 && Object.hasOwn(MANAGED_AREAS, segments[0]) ? segments[0] : null
  const resolved = area ? MANAGED_AREAS[area] : UNKNOWN_MANAGED
  return { path: rel, area, class: resolved, handling: MANAGED_AREA_HANDLING[resolved] }
}

// The real path of a target that may not exist yet: the deepest existing
// ancestor is resolved and the missing tail is appended. Only "does not exist"
// moves up a level. Any other failure (a directory that cannot be searched,
// a link loop) is thrown: a lexical path standing in for a real one would
// weaken the alias check exactly where it matters.
export function realLocation(target, realpath = fs.realpathSync.native) {
  const missing = []
  let current = path.resolve(target)
  for (;;) {
    try {
      return path.join(realpath(current), ...missing.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(target)
      missing.push(path.basename(current))
      current = parent
    }
  }
}

const containsPath = (outer, inner) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`)

function isSymbolicLink(target, lstat) {
  try {
    return lstat(target).isSymbolicLink()
  } catch {
    return false
  }
}

// True when the path or any of its ancestors is a symbolic link.
function crossesSymbolicLink(target, lstat) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    if (isSymbolicLink(current, lstat)) return true
    if (path.dirname(current) === current) return false
  }
}

// Refuse a managed root that overlaps an enrolled repository in either
// direction, under lexical or real paths. `realpath` and `lstat` are the only
// filesystem reads, and both can be supplied; nothing is created or changed.
// A real path that cannot be established refuses; it is never replaced by the
// lexical path.
export function checkManagedRoots({ managedRoots = [], repositoryRoots = [], realpath = fs.realpathSync.native, lstat = fs.lstatSync } = {}) {
  const refusals = []
  const refuse = (code, managedRoot, repositoryRoot, message) => refusals.push({ code, managedRoot, repositoryRoot, message })
  const locate = (root) => {
    try {
      return { given: root, lexical: path.resolve(root), real: realLocation(root, realpath) }
    } catch (error) {
      return { given: root, lexical: path.resolve(root), real: null, errorCode: error?.code ?? 'unknown' }
    }
  }
  const repositories = repositoryRoots.map(locate)

  for (const managedRoot of managedRoots) {
    if (typeof managedRoot !== 'string' || !path.isAbsolute(managedRoot)) {
      refuse('managed-root-not-absolute', managedRoot, null, 'a managed root must be an absolute path')
      continue
    }
    const managed = locate(managedRoot)
    if (managed.real === null) {
      refuse('managed-root-realpath-failed', managedRoot, null, `the real path of a managed root cannot be established (${managed.errorCode})`)
      continue
    }
    if (isSymbolicLink(managed.lexical, lstat)) {
      refuse('managed-root-symlink-alias', managedRoot, null, 'a managed root must not be a symbolic link')
    }
    for (const repository of repositories) {
      const inside = (kind) => containsPath(repository[kind], managed[kind])
      const around = (kind) => containsPath(managed[kind], repository[kind])
      if (inside('lexical')) refuse('managed-root-inside-repository', managedRoot, repository.given, 'a managed root must sit outside every enrolled repository')
      else if (around('lexical')) refuse('repository-inside-managed-root', managedRoot, repository.given, 'an enrolled repository must not sit inside a managed root')
      else if (repository.real === null) {
        refuse('managed-root-realpath-failed', managedRoot, repository.given, `the real path of an enrolled repository cannot be established (${repository.errorCode})`)
      } else if (inside('real') || around('real')) {
        // Name the cause that is actually there. Folding letter case and
        // Unicode normalization alone may explain the overlap; otherwise a
        // symbolic link on either path does; otherwise something else presents
        // one location under two names (a mount, for example).
        const folded = (value) => value.normalize('NFC').toLowerCase()
        const byFolding = containsPath(folded(repository.lexical), folded(managed.lexical)) || containsPath(folded(managed.lexical), folded(repository.lexical))
        if (!byFolding && (crossesSymbolicLink(managed.lexical, lstat) || crossesSymbolicLink(repository.lexical, lstat))) {
          refuse('managed-root-symlink-alias', managedRoot, repository.given, 'a symbolic link makes the managed root and an enrolled repository overlap')
        } else {
          refuse('managed-root-realpath-overlap', managedRoot, repository.given,
            'the managed root and an enrolled repository are written differently but name overlapping locations, and no symbolic link explains it: look for a difference in letter case or Unicode normalization on a filesystem that folds them, or a mount that presents one location under two names')
        }
      }
    }
  }
  return { ok: refusals.length === 0, refusals }
}

// The same guard at enrolment time: a repository that would contain, sit
// inside or alias an existing managed root cannot be enrolled.
export function checkRepositoryEnrollment({ repositoryRoot, managedRoots = [], realpath, lstat } = {}) {
  const { refusals } = checkManagedRoots({ managedRoots, repositoryRoots: [repositoryRoot], ...(realpath ? { realpath } : {}), ...(lstat ? { lstat } : {}) })
  const codes = {
    'managed-root-inside-repository': 'enrollment-contains-managed-root',
    'repository-inside-managed-root': 'enrollment-inside-managed-root',
    'managed-root-symlink-alias': 'enrollment-aliases-managed-root',
    'managed-root-realpath-overlap': 'enrollment-realpath-overlaps-managed-root',
  }
  const blocking = refusals.filter((item) => item.repositoryRoot !== null).map((item) => ({ ...item, code: codes[item.code] ?? item.code }))
  return { ok: blocking.length === 0, refusals: blocking }
}
