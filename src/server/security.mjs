import fs from 'node:fs'
import path from 'node:path'

export const ATELIER_HTML_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
].join('; ')

export const DENIED_STATIC_STATE_FILES = new Set([
  '.atelier-nonce',
  '.atelier-current',
  'atelier.local.json',
  'atelier.workspace.local.json',
  '.atelier-presence.json',
  '.atelier-capability-grants.json',
  '.atelier-events.jsonl',
])

export const DENIED_STATIC_STATE_DIRS = new Set([
  '.atelier-local',
  '.mnstry-local',
  '.atelier-proposals',
])

export const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
])

export const ATELIER_MANIFEST_SCHEMA = 'mnstry.atelier-manifest@v1'
export const PUBLISHED_STATIC_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp'])

export function parseHostHeader(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return ''
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1)
  return raw.split(':')[0]
}

export function isLoopbackHost(value) {
  const host = parseHostHeader(value)
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host)
}

export function requestHeader(headers, name) {
  if (!headers) return ''
  if (typeof headers.get === 'function') return headers.get(name) || ''
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return Array.isArray(value) ? value.join(', ') : String(value || '')
  }
  return ''
}

export function expectedOriginForRequest(headers, fallbackPort = null) {
  const host = requestHeader(headers, 'host')
  if (!host) return fallbackPort ? `http://127.0.0.1:${fallbackPort}` : ''
  return `http://${host}`
}

export function sameOrigin(origin, expectedOrigin) {
  if (!origin) return false
  if (!expectedOrigin) return false
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin
  } catch {
    return false
  }
}

export function trustedFetchSite(headers) {
  const value = requestHeader(headers, 'sec-fetch-site').toLowerCase()
  return value === 'none' || value === 'same-origin'
}

export function trustedHost(headers) {
  return isLoopbackHost(requestHeader(headers, 'host'))
}

export function trustedReadRequest(headers, { expectedOrigin = expectedOriginForRequest(headers) } = {}) {
  const origin = requestHeader(headers, 'origin')
  return trustedHost(headers) && trustedFetchSite(headers) && (!origin || sameOrigin(origin, expectedOrigin))
}

export function trustedMutationRequest(headers, { expectedOrigin = expectedOriginForRequest(headers) } = {}) {
  const origin = requestHeader(headers, 'origin')
  return Boolean(origin) && trustedReadRequest(headers, { expectedOrigin }) && sameOrigin(origin, expectedOrigin)
}

function manifestPathValue(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  return value.path || value.output || value.href || ''
}

function secretShapedPath(value) {
  return /(?:^|[._-])(?:secret|credential|token|password|nonce|private[._-]?key)(?:$|[._-])/i.test(value)
    || /(?:^|\/)\.env(?:\.|$)/i.test(value)
}

function addManifestPath(paths, value, label) {
  const candidate = manifestPathValue(value)
  const normalized = normalizeWorkspacePath(candidate, { defaultFile: '' })
  if (!candidate || !normalized.ok || /^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    throw new Error(`atelier.manifest.json ${label} must be a workspace-relative path`)
  }
  if (deniedStaticStatePath(normalized.path) || normalized.path.split('/').some((segment) => segment.startsWith('.')) || secretShapedPath(normalized.path)) {
    throw new Error(`atelier.manifest.json ${label} enrolls a hidden, state, or secret-shaped path`)
  }
  if (!PUBLISHED_STATIC_EXTENSIONS.has(path.extname(normalized.path).toLowerCase())) {
    throw new Error(`atelier.manifest.json ${label} enrolls an unsupported static file type`)
  }
  paths.add(normalized.path)
}

export function loadPublishedWorkspaceManifest(workspaceRoot) {
  const root = path.resolve(workspaceRoot)
  const rootReal = fs.realpathSync(root)
  const manifestPath = path.join(root, 'atelier.manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error('served workspace must contain generated atelier.manifest.json')
  const manifestReal = fs.realpathSync(manifestPath)
  if (!pathContainedBy(rootReal, manifestReal)) throw new Error('atelier.manifest.json realpath escapes served workspace')
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestReal, 'utf8'))
  } catch (error) {
    throw new Error(`atelier.manifest.json must be valid JSON: ${error.message}`)
  }
  if (manifest?.schema !== ATELIER_MANIFEST_SCHEMA) {
    throw new Error(`atelier.manifest.json schema must be ${ATELIER_MANIFEST_SCHEMA}`)
  }
  const paths = new Set()
  if (typeof manifest.entry !== 'string') throw new Error('atelier.manifest.json entry must be a workspace-relative HTML path')
  addManifestPath(paths, manifest.entry, 'entry')
  if (path.extname(manifest.entry).toLowerCase() !== '.html') throw new Error('atelier.manifest.json entry must be an HTML file')
  for (const key of ['files', 'assets']) {
    if (manifest[key] == null) continue
    if (!Array.isArray(manifest[key])) throw new Error(`atelier.manifest.json ${key} must be an array`)
    for (const [index, value] of manifest[key].entries()) addManifestPath(paths, value, `${key}[${index}]`)
  }
  for (const rel of paths) {
    const resolved = resolveWorkspacePath({ workspaceRoot: root, workspaceRootReal: rootReal, rel, requireFile: true })
    if (!resolved.ok) throw new Error(`atelier.manifest.json enrolled path is unavailable: ${rel}`)
    const realRel = path.relative(rootReal, resolved.real).replaceAll('\\', '/')
    if (realRel !== rel) throw new Error(`atelier.manifest.json enrolled path must not be a symlink: ${rel}`)
  }
  return Object.freeze({ manifest, manifestPath: manifestReal, paths })
}

export function publishedStaticPathVerdict({ resolved, publication } = {}) {
  if (!resolved?.ok) return resolved
  const realRel = path.relative(resolved.workspaceRootReal, resolved.real).replaceAll('\\', '/')
  const segments = realRel.split('/')
  if (segments.some((segment) => segment.startsWith('.')) || deniedStaticStatePath(realRel)) {
    return { ok: false, status: 403, error: 'hidden or local state path is not published', path: resolved.path }
  }
  if (realRel === 'atelier.manifest.json' || secretShapedPath(realRel)) {
    return { ok: false, status: 403, error: 'secret-shaped path is not published', path: resolved.path }
  }
  if (!PUBLISHED_STATIC_EXTENSIONS.has(path.extname(realRel).toLowerCase())) {
    return { ok: false, status: 403, error: 'static file type is not published', path: resolved.path }
  }
  if (!publication?.paths?.has(realRel)) {
    return { ok: false, status: 404, error: 'path is not enrolled by atelier.manifest.json', path: resolved.path }
  }
  return resolved
}

export function pathContainedBy(root, candidate) {
  const resolvedRoot = path.resolve(root)
  const resolvedCandidate = path.resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
}

export function realpathMaybe(abs) {
  try {
    return fs.realpathSync(abs)
  } catch {
    return null
  }
}

export function realpathContainedBy(rootReal, abs) {
  const candidateReal = realpathMaybe(abs)
  if (!candidateReal) return false
  return pathContainedBy(rootReal, candidateReal)
}

export function deniedStaticStatePath(rel) {
  const clean = String(rel || '')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
  if (!clean || clean.includes('\0')) return true
  if (DENIED_STATIC_STATE_FILES.has(clean)) return true
  const firstSegment = clean.split('/')[0]
  return DENIED_STATIC_STATE_DIRS.has(firstSegment)
}

export function normalizeWorkspacePath(value, { defaultFile = 'index.html' } = {}) {
  const raw = String(value || '').trim()
  const withoutQuery = raw.split(/[?#]/)[0]
  let decoded = ''
  try {
    decoded = decodeURIComponent(withoutQuery || defaultFile)
  } catch {
    return { ok: false, error: 'path is not valid URI encoding' }
  }
  const normalized = decoded.replaceAll('\\', '/').replace(/^\/+/, '') || defaultFile
  if (normalized.includes('\0')) {
    return { ok: false, error: 'path contains NUL byte' }
  }
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    return { ok: false, error: 'path escapes workspace' }
  }
  return { ok: true, path: normalized }
}

export function resolveWorkspacePath({
  workspaceRoot,
  workspaceRootReal = fs.realpathSync(workspaceRoot),
  rel,
  requireFile = false,
  requireHtml = false,
  denyState = true,
} = {}) {
  const normalized = normalizeWorkspacePath(rel)
  if (!normalized.ok) return normalized
  if (denyState && deniedStaticStatePath(normalized.path)) {
    return { ok: false, status: 403, error: 'local Atelier state is not static content', path: normalized.path }
  }

  const abs = path.join(workspaceRoot, normalized.path)
  if (!pathContainedBy(workspaceRoot, abs)) {
    return { ok: false, status: 403, error: 'path escapes workspace', path: normalized.path }
  }

  let stat = null
  try {
    stat = fs.statSync(abs)
  } catch {
    return { ok: false, status: 404, error: 'workspace file not found', path: normalized.path }
  }

  const real = fs.realpathSync(abs)
  if (!pathContainedBy(workspaceRootReal, real)) {
    return { ok: false, status: 403, error: 'realpath escapes workspace', path: normalized.path }
  }

  const realRel = path.relative(workspaceRootReal, real).replaceAll('\\', '/')
  if (denyState && deniedStaticStatePath(realRel)) {
    return { ok: false, status: 403, error: 'local Atelier state is not static content', path: normalized.path }
  }

  if (requireFile && !stat.isFile()) {
    return { ok: false, status: 404, error: 'workspace file not found', path: normalized.path }
  }
  if (requireHtml && (!stat.isFile() || path.extname(real).toLowerCase() !== '.html')) {
    return { ok: false, status: 404, error: 'workspace html file not found', path: normalized.path }
  }

  return {
    ok: true,
    path: normalized.path,
    abs,
    real,
    stat,
    workspaceContained: true,
    workspaceRootReal,
  }
}

export function staticHeaders(abs, stat) {
  const ext = path.extname(abs).toLowerCase()
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[ext] || 'application/octet-stream'

  return {
    'Content-Type': contentType,
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
}

export function htmlDocumentHeaders(byteLength) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(byteLength),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': ATELIER_HTML_CSP,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
}
