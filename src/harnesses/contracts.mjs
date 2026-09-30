import fs from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { objectDigest, digest } from '../capabilities/files.mjs'
export const HARNESS_LIMITS = Object.freeze({ records: 256, bytes: 8 * 1024 * 1024, dependencyVerifications: 256, dependencyDepth: 12 })
export const harnessDigest = objectDigest
export const contentDigest = digest
export const harnessRef = record => ({ id: record.id, digest: objectDigest(record) })
export const EMPTY_HARNESS_HEAD = objectDigest([])
const ajv = new Ajv({ allErrors: true, strict: true }); addFormats(ajv)
const schemas = new Map(['harness', 'knowledge', 'build'].map(name => [name, JSON.parse(fs.readFileSync(new URL(`../../contracts/atelier-${name}.v1.schema.json`, import.meta.url)))]))
const validators = new Map()
export function validateHarnessDocument(value, profile, shape = 'record') {
  const schema = schemas.get(profile), key = `${profile}/${shape}`
  if (!schema || !Object.hasOwn(schema.$defs, shape)) return ['unknown harness profile or shape']
  if (!validators.has(key)) validators.set(key, ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${shape}` }))
  const validate = validators.get(key)
  return validate(value) ? [] : validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
}
export function assertHarness(value, profile, shape = 'record') {
  const errors = validateHarnessDocument(value, profile, shape)
  if (errors.length) throw new Error(`invalid ${profile} ${shape}: ${errors.slice(0, 5).join('; ')}`)
  return value
}
// A private container may receive a public source. An export that includes that
// container's metadata must retain the more restrictive combined audience.
export function restrictiveAudience(...values) {
  if (!values.length || values.some(v => !['public', 'team', 'operator', 'staff', 'private', 'sensitive'].includes(v))) throw new Error('unknown audience')
  const restricted = [...new Set(values.filter(v => v !== 'public'))]
  if (restricted.includes('sensitive')) return 'sensitive'
  if (restricted.includes('private') || restricted.length > 1) return 'private'
  return restricted[0] ?? 'public'
}
export function assertAudience(receiver, source) {
  if (restrictiveAudience(receiver, source) !== receiver) throw new Error('audience exceeds receiving scope')
}
export function assertHandoff(value) {
  assertHarness(value, 'harness', 'handoff')
  if (contentDigest(value.payload) !== value.payloadDigest) throw new Error('handoff payload digest mismatch')
  return value
}
