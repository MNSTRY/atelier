import { refuse } from './errors.mjs'

// Helpers shared by this module's private documents. Each document is
// versioned by its `schema` string, closed (an unknown key refuses) and
// written in one canonical form, so equal state is equal bytes.

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
}

// Keys sorted at every depth, two-space indentation, one final newline.
export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`
}

export function closedObject(value, { required = [], optional = [] }, code, label) {
  if (!isPlainObject(value)) refuse(code, `${label} must be an object`)
  const allowed = new Set([...required, ...optional])
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) refuse(code, `${label} carries an unknown key`, { keys: unknown.sort() })
  const missing = required.filter((key) => !Object.hasOwn(value, key))
  if (missing.length > 0) refuse(code, `${label} lacks a required key`, { keys: missing })
  return value
}

export const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

export function isoTime(clock) {
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) refuse('missing-clock', 'the injected clock did not return a time')
  return date.toISOString()
}
