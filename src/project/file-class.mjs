import { basenameOf, matchesPathPattern, normalizeRelPath } from './path-match.mjs'

export const FILE_CLASS_SCHEMA = 'mnstry.atelier-file-classes@v1'

export const SOURCE = 'source'
export const GENERATED_PROJECTION = 'generated-projection'
export const DISTRIBUTED_RUNTIME_COPY = 'distributed-runtime-copy'

export const FILE_CLASSES = Object.freeze([SOURCE, GENERATED_PROJECTION, DISTRIBUTED_RUNTIME_COPY])

// What each class means for automated handling. Sync loops, merge policies, upgrade
// tooling, and CI guards all read this instead of each keeping a list of filenames
// that drifts out of step with the others.
export const FILE_CLASS_HANDLING = Object.freeze({
  [SOURCE]: Object.freeze({ rederivable: false, discardable: false, conflictsNeedHuman: true }),
  [GENERATED_PROJECTION]: Object.freeze({ rederivable: true, discardable: true, conflictsNeedHuman: false }),
  [DISTRIBUTED_RUNTIME_COPY]: Object.freeze({ rederivable: true, discardable: true, conflictsNeedHuman: false }),
})

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
