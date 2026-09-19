import { createHash } from 'node:crypto'

// An object of the arbitration store is one source document of one repository
// of one workspace: (workspaceId, repoId, nodeId). The workspace is the state
// root; the repository and the node each become one directory name.
//
// An identifier may hold upper-case letters, '.', ':' and may spell a name a
// platform reserves, so it is never used as a name directly:
//
//   k-<escaped>            the whole identifier, reversible
//   h-<escaped head>-<32 hex of sha256(identifier)>   when the escaped form is long
//
// Escaping keeps [a-z0-9_-]; an upper-case letter becomes '~' and its lower
// case; any other character becomes '~' and two hex digits (every such code
// starts with a digit, so the two escapes cannot be confused). The result is
// lower case only, so two identifiers that differ by case never meet on a
// case-insensitive filesystem; the fixed prefix means no name is ever a
// reserved device name, and no name ends in a dot or a space. A hashed name is
// not reversible from the name alone: every event in the directory carries the
// identity, and the store checks that it encodes to the directory it is in.

export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
export const MAX_PLAIN_SEGMENT = 64
const HEAD_LENGTH = 24

const escapeCharacter = (character) => {
  if (/[a-z0-9_-]/.test(character)) return character
  if (/[A-Z]/.test(character)) return `~${character.toLowerCase()}`
  return `~${character.charCodeAt(0).toString(16).padStart(2, '0')}`
}

export const isIdentifier = (value) => typeof value === 'string' && IDENTIFIER_PATTERN.test(value)

export function encodeIdentitySegment(identifier) {
  if (!isIdentifier(identifier)) throw new TypeError('an identity segment is made from an identifier')
  const escaped = [...identifier].map(escapeCharacter).join('')
  if (escaped.length <= MAX_PLAIN_SEGMENT) return `k-${escaped}`
  const head = escaped.slice(0, HEAD_LENGTH).replace(/~[0-9a-f]?$/, '')
  return `h-${head}-${createHash('sha256').update(identifier).digest('hex').slice(0, 32)}`
}

// The identifier of a `k-` name; null for a hashed name or for a name this
// module would not have produced.
export function decodeIdentitySegment(segment) {
  if (typeof segment !== 'string' || !segment.startsWith('k-')) return null
  const escaped = segment.slice(2)
  let identifier = ''
  for (let at = 0; at < escaped.length; at += 1) {
    const character = escaped[at]
    if (character !== '~') { identifier += character; continue }
    const next = escaped[at + 1] ?? ''
    if (/[a-z]/.test(next)) { identifier += next.toUpperCase(); at += 1; continue }
    const code = escaped.slice(at + 1, at + 3)
    if (!/^[0-9][0-9a-f]$/.test(code)) return null
    identifier += String.fromCharCode(Number.parseInt(code, 16))
    at += 2
  }
  return isIdentifier(identifier) && encodeIdentitySegment(identifier) === segment ? identifier : null
}

export const isIdentitySegment = (segment) => typeof segment === 'string' && (decodeIdentitySegment(segment) !== null || /^h-[a-z0-9_~-]{0,24}-[0-9a-f]{32}$/.test(segment))
