// RFC 8785 (JSON Canonicalization Scheme) serializer.
//
// Numbers and strings delegate to JSON.stringify: RFC 8785 defines both
// serializations as exactly ECMAScript's (ES2019+ well-formed stringify
// escapes lone surrogates, and number formatting follows Number::toString).
// The module's own work is recursive descent, UTF-16 code-unit key sorting
// (plain Array.prototype.sort over strings IS code-unit order), and strict
// rejection of every value JSON cannot faithfully round-trip.
//
// Rejections throw TypeError with a `JCS:` prefix naming the offending path,
// so a non-canonicalizable document fails loudly instead of silently dropping
// members (undefined), collapsing to {} (class instances, Map), or invoking
// toJSON surprises (Date).

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function reject(path, detail) {
  throw new TypeError(`JCS: ${detail} at ${path}`)
}

function serialize(value, path) {
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'boolean') return value ? 'true' : 'false'
  if (kind === 'number') {
    if (!Number.isFinite(value)) reject(path, `non-finite number ${String(value)} is not representable in JSON`)
    return JSON.stringify(value)
  }
  if (kind === 'string') return JSON.stringify(value)
  if (kind === 'undefined') reject(path, 'undefined is not representable in JSON')
  if (kind === 'bigint') reject(path, 'BigInt is not representable in JSON')
  if (kind === 'function') reject(path, 'function is not representable in JSON')
  if (kind === 'symbol') reject(path, 'symbol is not representable in JSON')
  if (Array.isArray(value)) {
    // Holes must fail loudly: Array.prototype.map skips them, which would emit
    // invalid JSON like "[,]" instead of a faithful canonicalization.
    const items = []
    for (let index = 0; index < value.length; index += 1) {
      const itemPath = `${path}[${index}]`
      if (!(index in value)) reject(itemPath, 'sparse array hole is not representable in JSON')
      items.push(serialize(value[index], itemPath))
    }
    return `[${items.join(',')}]`
  }
  if (!isPlainObject(value)) {
    reject(path, 'non-plain object (Date, Map, class instance, ...) cannot be canonicalized')
  }
  const keys = Object.keys(value).sort()
  const members = keys.map((key) => {
    const memberPath = `${path}.${key}`
    if (value[key] === undefined) reject(memberPath, 'undefined property value is not representable in JSON')
    return `${JSON.stringify(key)}:${serialize(value[key], memberPath)}`
  })
  return `{${members.join(',')}}`
}

// Canonicalize a JSON-compatible value into its RFC 8785 string form.
export function canonicalize(value) {
  return serialize(value, '$')
}
