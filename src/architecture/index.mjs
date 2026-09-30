import { catalogDocument } from './catalog.mjs'
import fs from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { boundedLearningValue, learningDigest } from '../learning/contracts.mjs'

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-architecture.v1.schema.json', import.meta.url)))
const ajv = new Ajv({ strict: true, allErrors: true })
const validators = new Map()
const relationKinds = {
  composes: [['harness'], ['responsibility']],
  participates: [['role'], ['responsibility']],
  realizes: [['resource'], ['capability']],
  supports: [['capability'], ['responsibility']],
  applies: [['harness'], ['method']],
  handles: [['harness'], ['record']],
  executes: [['host'], ['resource']],
}
export function validateArchitecture(value, shape = 'catalog') {
  try { boundedLearningValue(value) } catch (error) { return [error.message] }
  if (!['catalog', 'binding'].includes(shape)) return ['unknown architecture shape']
  if (!validators.has(shape)) validators.set(shape, ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${shape}` }))
  const validate = validators.get(shape)
  if (!validate(value)) return validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
  const errors = []
  if (shape === 'catalog') {
    const entries = new Map(), labels = new Map(), relations = new Set()
    for (const entry of value.entries) {
      if (entries.has(entry.id)) errors.push(`duplicate identity: ${entry.id}`)
      entries.set(entry.id, entry)
      for (const label of [entry.id, entry.label, ...entry.aliases]) {
        const key = label.toLowerCase()
        if (labels.has(key) && labels.get(key) !== entry.id) errors.push(`ambiguous alias: ${label}`)
        labels.set(key, entry.id)
      }
    }
    for (const [index, relation] of value.relations.entries()) {
      const [from, to] = relationKinds[relation.type]
      if (!from.includes(entries.get(relation.from)?.kind) || !to.includes(entries.get(relation.to)?.kind)) errors.push(`/relations/${index}: incompatible kinds or missing identity`)
      const key = JSON.stringify(relation)
      if (relations.has(key)) errors.push(`/relations/${index}: duplicate relationship`)
      relations.add(key)
    }
  } else {
    const pointers = new Set()
    for (const field of value.fields) {
      if (pointers.has(field.pointer)) errors.push(`duplicate authored field: ${field.pointer}`)
      pointers.add(field.pointer)
      if (field.classification === 'enforced' && field.consumer === null) errors.push(`${field.pointer}: enforcement requires a named consumer`)
    }
  }
  return errors
}
function assert(value, shape) {
  const errors = validateArchitecture(value, shape)
  if (errors.length) throw new Error(`invalid architecture ${shape}: ${errors.join('; ')}`)
  return value
}
export function responsibilityCatalog() {
  return assert(catalogDocument(), 'catalog')
}
export function architectureEntry(name, catalog = responsibilityCatalog()) {
  assert(catalog, 'catalog')
  if (typeof name !== 'string') throw new Error('architecture name required')
  const key = name.toLowerCase()
  return catalog.entries.find(entry => [entry.id, entry.label, ...entry.aliases].some(label => label.toLowerCase() === key)) ?? null
}
// Diagnostic resolution never installs a definition or grants operation authority.
// A consumer declares its exact supported profile/revision/classifications. Missing
// coverage is visible even for optional behavior; required gaps prevent resolution.
export function resolveBehaviorBinding({ binding, consumers }) {
  assert(binding, 'binding')
  boundedLearningValue(consumers)
  if (!Array.isArray(consumers) || consumers.length > 128) throw new Error('bounded consumer declarations required')
  const seen = new Set()
  for (const consumer of consumers) {
    if (!consumer || Object.keys(consumer).sort().join(',') !== 'classifications,id,profile,revision' ||
      ![consumer.id, consumer.profile, consumer.revision].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) ||
      !Array.isArray(consumer.classifications) || !consumer.classifications.length ||
      consumer.classifications.some(v => !['enforced', 'guidance', 'presentation', 'rationale'].includes(v))) throw new Error('invalid consumer declaration')
    const key = `${consumer.id}/${consumer.profile}`
    if (seen.has(key)) throw new Error('duplicate consumer profile')
    seen.add(key)
  }
  const diagnostics = []
  for (const field of binding.fields) {
    const c = field.consumer
    if (field.classification === 'rationale' && c === null) continue
    const supported = consumers.some(item => c && item.id === c.id && item.profile === c.profile && item.revision === c.revision && item.classifications.includes(field.classification))
    if (!supported) diagnostics.push({ pointer: field.pointer, code: 'unsupported-consumer', required: field.required, classification: field.classification, consumer: c })
  }
  return { schema: 'atelier-behavior-resolution@v1', definition: structuredClone(binding.definition), bindingDigest: learningDigest(binding),
    resolved: !diagnostics.some(d => d.required), diagnostics, adoption: 'not-established', executionAuthorized: false }
}
