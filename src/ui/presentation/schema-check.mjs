// Deliberately limited to the keywords in the presentation schemas.
// Unsupported schema vocabulary refuses rather than silently widening.
const known = new Set(['$schema', '$id', '$comment', 'title', 'type', 'additionalProperties', 'required', 'properties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'enum', 'const', 'oneOf'])
export function matchesPresentationSchema(schema, value) {
  if (Object.keys(schema).some(key => !known.has(key))) throw new TypeError('unsupported presentation schema keyword')
  if (schema.oneOf && schema.oneOf.filter(s => matchesPresentationSchema(s, value)).length !== 1) return false
  if (schema.enum && !schema.enum.includes(value)) return false
  if (Object.hasOwn(schema, 'const') && schema.const !== value) return false
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (schema.type && schema.type !== type) return false
  if (type === 'string') {
    const length = [...value].length
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) return false
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false
  }
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || (schema.items && !matchesPresentationSchema(schema.items, value[i]))) return false
  }
  if (type === 'object') {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) {
        if (!matchesPresentationSchema(schema.properties[key], value[key])) return false
      } else if (schema.additionalProperties === false) return false
    }
  }
  return true
}
