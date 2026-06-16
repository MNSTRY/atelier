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
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
].join('; ')

export const DENIED_STATIC_STATE_FILES = new Set([
  '.atelier-nonce',
  '.atelier-current',
  '.atelier-presence.json',
  '.atelier-capability-grants.json',
  '.atelier-events.jsonl',
])

export const DENIED_STATIC_STATE_DIRS = new Set([
  '.atelier-proposals',
])

export const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
])

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
  if (!origin) return true
  if (!expectedOrigin) return false
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin
  } catch {
    return false
  }
}

export function trustedFetchSite(headers) {
  const value = requestHeader(headers, 'sec-fetch-site').toLowerCase()
  return value === '' || value === 'none' || value === 'same-origin' || value === 'same-site'
}

export function trustedHost(headers) {
  return isLoopbackHost(requestHeader(headers, 'host'))
}

export function trustedReadRequest(headers, { expectedOrigin = expectedOriginForRequest(headers) } = {}) {
  return trustedHost(headers) && sameOrigin(requestHeader(headers, 'origin'), expectedOrigin)
}

export function trustedMutationRequest(headers, { expectedOrigin = expectedOriginForRequest(headers) } = {}) {
  return trustedReadRequest(headers, { expectedOrigin }) && trustedFetchSite(headers)
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
