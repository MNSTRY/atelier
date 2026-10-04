// Pure classifiers for the two consumer-install failures that PR #89 showed
// with no typed diagnostic. Nothing here runs npm or touches the network:
// consumer-smoke.mjs passes in npm's stderr and lockfiles and turns a finding
// into an AtelierDiagnosticError.
//
// - consumer-closure-incomplete: an offline install asked for a package the
//   warmed cache does not hold (npm's ENOTCACHED).
// - override-not-inherited: a consumer's own lockfile holds a version, or a
//   second copy, of a package the publisher pins with `overrides`. npm applies
//   overrides only in the root project, so a consumer never receives them.

export const CONSUMER_CLOSURE_INCOMPLETE = 'consumer-closure-incomplete'
export const OVERRIDE_NOT_INHERITED = 'override-not-inherited'

const ENOTCACHED = /^npm (?:error|ERR!) code ENOTCACHED$/m
const REQUEST_URL = /^npm (?:error|ERR!) request to (\S+) failed/m
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// The package and version npm asked for, from a registry URL. A tarball URL
// (`<registry>/<name>/-/<basename>-<version>.tgz`) names both; a packument URL
// (`<registry>/<name>`) names only the package.
function requestedPackage(url) {
  let pathname
  try { pathname = decodeURIComponent(new URL(url).pathname) } catch { return { package: null, version: null } }
  const tarball = pathname.match(/^\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)\.tgz$/)
  if (tarball) {
    const [, name, file] = tarball
    const prefix = `${name.split('/').pop()}-`
    return { package: name, version: file.startsWith(prefix) ? file.slice(prefix.length) : null }
  }
  const packument = pathname.match(/^\/((?:@[^/]+\/)?[^/]+)\/?$/)
  return { package: packument ? packument[1] : null, version: null }
}

// A finding for npm stderr that reports ENOTCACHED, else null. Any other npm
// failure is not classified here and keeps its own error.
export function classifyNpmFailure(stderr) {
  const text = String(stderr ?? '')
  if (!ENOTCACHED.test(text)) return null
  const url = text.match(REQUEST_URL)?.[1] ?? null
  return { code: CONSUMER_CLOSURE_INCOMPLETE, ...(url ? requestedPackage(url) : { package: null, version: null }), url }
}

// Every installed copy of `name` in a v2/v3 lockfile, one per node_modules
// path, sorted by path. A copy's name is the entry's own `name` (set for an
// npm: alias) or else the path after its last node_modules/. The root entry
// ('') is the consumer itself, and links are not copies.
function installedCopies(lockfile, name) {
  return Object.entries(lockfile?.packages ?? {})
    .filter(([path, entry]) => path !== '' && !entry.link
      && (entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)) === name)
    .map(([path, entry]) => ({ path, version: entry.version ?? null }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

// One finding per publisher override the consumer's lockfile does not honour:
// a copy at another version, or more than one copy. Only exact-version
// overrides can be compared, so any other override shape is refused rather
// than skipped.
export function overrideFindings({ publisherOverrides, consumerLock }) {
  if (!consumerLock || typeof consumerLock.packages !== 'object' || consumerLock.packages === null) {
    throw new TypeError('consumer lockfile must be lockfileVersion 2 or 3 with a packages map')
  }
  const findings = []
  for (const [name, pinned] of Object.entries(publisherOverrides ?? {})) {
    if (typeof pinned !== 'string' || !EXACT_VERSION.test(pinned)) {
      throw new TypeError(`override for ${name} is not an exact version; the captured-closure check compares exact pins only`)
    }
    const found = installedCopies(consumerLock, name)
    if (found.length > 1 || found.some((copy) => copy.version !== pinned)) {
      findings.push({ code: OVERRIDE_NOT_INHERITED, package: name, pinned, found })
    }
  }
  return findings
}

// The registry tarballs an offline `npm ci` needs from the consumer's own
// lockfile: every entry with an http(s) `resolved` URL and an `integrity`.
// Local entries (the candidate's `file:` tarball, links) and bundled entries
// are not cached.
// `missing` lists registry-installed paths that lack either field, which an
// offline reinstall could not satisfy.
export function capturedClosure(consumerLock) {
  const tarballs = []
  const missing = []
  for (const [path, entry] of Object.entries(consumerLock?.packages ?? {})) {
    if (path === '' || entry.link || entry.inBundle) continue
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : null
    if (resolved && !/^https?:\/\//.test(resolved)) continue
    if (resolved && typeof entry.integrity === 'string') tarballs.push({ path, resolved, integrity: entry.integrity })
    else missing.push(path)
  }
  const byPath = (left, right) => (typeof left === 'string' ? left.localeCompare(right) : left.path.localeCompare(right.path))
  return { tarballs: tarballs.sort(byPath), missing: missing.sort(byPath) }
}

// The installed tree from `npm ls --all --json`, one sorted line per package
// with its ancestry, so two installs of the same project can be compared and
// the first difference named.
export function npmTreeLines(npmLsJson) {
  const lines = []
  const visit = (dependencies, ancestry) => {
    for (const [name, entry] of Object.entries(dependencies ?? {})) {
      const line = `${ancestry}${name}@${entry?.version ?? 'missing'}`
      lines.push(line)
      visit(entry?.dependencies, `${line} > `)
    }
  }
  visit(npmLsJson?.dependencies, '')
  return lines.sort()
}
