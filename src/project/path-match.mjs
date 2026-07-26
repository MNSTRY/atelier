import path from 'node:path'

export const normalizeRelPath = (value) =>
  String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Shared by the boundary policy and the file-class resolver. Both used to carry
// their own copy; two glob dialects in one kit is exactly the drift this file exists
// to prevent.
export function matchesPathPattern(pattern, rel) {
  const normalizedPattern = normalizeRelPath(pattern)
  const normalizedRel = normalizeRelPath(rel)
  if (normalizedPattern === normalizedRel) return true
  if (normalizedPattern.endsWith('/**')) {
    return normalizedRel === normalizedPattern.slice(0, -3) || normalizedRel.startsWith(normalizedPattern.slice(0, -2))
  }
  if (normalizedPattern.startsWith('**/')) {
    const tail = normalizedPattern.slice(3)
    return normalizedRel === tail || normalizedRel.endsWith(`/${tail}`) || matchesPathPattern(tail, normalizedRel)
  }
  if (normalizedPattern.includes('*')) {
    return new RegExp(`^${normalizedPattern.split('*').map(escapeRe).join('.*')}$`).test(normalizedRel)
  }
  return false
}

export const basenameOf = (pattern) => path.posix.basename(normalizeRelPath(pattern))
