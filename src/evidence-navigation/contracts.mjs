import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { evidenceSchema } from './schema.generated.mjs'

const ajv = new Ajv({ strict: true, allErrors: true, ownProperties: true,
  coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true })
addFormats(ajv, { mode: 'full' })
ajv.addSchema(evidenceSchema)
const validators = Object.fromEntries(Object.keys(evidenceSchema.$defs).map(name =>
  [name, ajv.getSchema(`${evidenceSchema.$id}#/$defs/${name}`)]))

export const EVIDENCE_PROTOCOL = 'atelier-evidence-navigation@v1'
export const EVIDENCE_LIMITS = Object.freeze({ bytes: 262144, depth: 24, members: 8192, snapshots: 256, dependencyDepth: 12 })

// Public functions consume JSON, never getters, cyclic graphs, or custom objects.
// Copy before validation so no validator can mutate the caller's input.
export function evidenceJson(value) {
  const active = new Set()
  let remaining = EVIDENCE_LIMITS.members
  function copy(item, depth) {
    if (--remaining < 0 || depth > EVIDENCE_LIMITS.depth) throw new Error('evidence value exceeds bounds')
    if (item === null || typeof item === 'boolean') return item
    if (typeof item === 'string' && item.length <= EVIDENCE_LIMITS.bytes && !item.includes('\u0000')) return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || active.has(item)) throw new Error('evidence value must be JSON')
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) throw new Error('evidence value must be JSON')
    active.add(item)
    const entries = []
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('evidence value must be JSON')
      entries.push([key, copy(descriptor.value, depth + 1)])
    }
    let result
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, 'length')?.value
      if (entries.length !== length || entries.some(([key], index) => key !== String(index))) throw new Error('evidence array must be dense')
      result = entries.map(([, value]) => value)
    } else result = Object.fromEntries(entries)
    active.delete(item)
    return result
  }
  const result = copy(value, 0)
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > EVIDENCE_LIMITS.bytes) throw new Error('evidence value exceeds bounds')
  return result
}

export function validateEvidenceDocument(shape, value) {
  if (!Object.hasOwn(validators, shape) || typeof validators[shape] !== 'function') return { valid: false, reason: 'unsupported-shape' }
  try {
    return validators[shape](evidenceJson(value))
      ? { valid: true, reason: null }
      : { valid: false, reason: 'invalid-document' }
  } catch { return { valid: false, reason: 'invalid-document' } }
}
