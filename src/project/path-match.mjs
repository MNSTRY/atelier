import path from 'node:path'

export const normalizeRelPath = (value) =>
  String(value ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function globSource(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char !== '*') {
      source += escapeRe(char)
      continue
    }

    const globstar = pattern[index + 1] === '*'
    if (!globstar) {
      source += '[^/]*'
      continue
    }

    index += 1
    if (pattern[index + 1] === '/') {
      index += 1
      source += '(?:.*/)?'
    } else if (source.endsWith('/')) {
      source = source.slice(0, -1)
      source += '(?:/.*)?'
    } else {
      source += '.*'
    }
  }
  return source
}

// Shared by the boundary policy and the file-class resolver. The dialect is
// intentionally portable: case does not depend on the host filesystem, `*`
// stays inside one segment, and `**` crosses segments. Slashless patterns keep
// their historical match-base behavior, so `*.md` applies at any depth without
// making `private/*.md` consume nested directories.
export function matchesPathPattern(pattern, rel) {
  const normalizedPattern = normalizeRelPath(pattern)
  const normalizedRel = normalizeRelPath(rel)
  if (!normalizedPattern || !normalizedRel) return false
  const candidate = normalizedPattern.includes('/') ? normalizedRel : path.posix.basename(normalizedRel)
  return new RegExp(`^${globSource(normalizedPattern)}$`, 'i').test(candidate)
}

export const basenameOf = (pattern) => path.posix.basename(normalizeRelPath(pattern))
