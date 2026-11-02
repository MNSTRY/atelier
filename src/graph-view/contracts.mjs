import fs from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { canonicalize } from '../attestation/jcs.mjs'
import { createHash } from 'node:crypto'
import { refKey } from './refs.mjs'
import { refuse } from './errors.mjs'
export { refuse } from './errors.mjs'
export { refKey } from './refs.mjs'

export const GRAPH_VIEW_SCHEMA = 'atelier.graph-view@v1'
export const MAX_VIEW_BYTES = 2 * 1024 * 1024
const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-graph-view.v1.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv2020({ allErrors: false, strict: true })
addFormats(ajv)
ajv.addSchema(schema)
const validators = new Map()
export const canonicalJson = canonicalize
export const digestJson = value => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0
export const sortedUnique = values => [...new Set(values)].sort(compareText)

export function assertShape(name, value) {
  const key = name ? `${schema.$id}#/$defs/${name}` : schema.$id
  if (!validators.has(key)) validators.set(key, ajv.getSchema(key))
  if (!validators.get(key)?.(value)) refuse('contract_mismatch')
  return value
}

// Explicit schema properties are the only data boundary. No source body,
// relation map, host binding, error detail, or arbitrary ext object passes.
export function projectShape(name, value) {
  const visit = (shape, input) => {
    if (shape.$ref) return visit(schema.$defs[shape.$ref.split('/').at(-1)], input)
    if (shape.type === 'object' && input && typeof input === 'object' && !Array.isArray(input)) {
      const result = {}
      for (const [key, child] of Object.entries(shape.properties)) {
        if (Object.hasOwn(input, key)) result[key] = visit(child, input[key])
      }
      return result
    }
    if (shape.type === 'array' && Array.isArray(input)) return input.map(item => visit(shape.items, item))
    return input
  }
  return assertShape(name, visit(schema.$defs[name], value))
}

export function assertRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..') || /[\u0000-\u001f\u007f]/.test(value)) refuse('contract_mismatch')
}

export function serializeGraphView(view) {
  assertShape(null, view)
  const nodeIds = new Set(view.nodes.map(node => refKey(node.ref)))
  const edgeIds = new Set(view.edges.map(edge => edge.edgeId))
  const evidenceIds = new Set(view.evidence.map(item => item.evidenceId))
  if (nodeIds.size !== view.nodes.length || edgeIds.size !== view.edges.length || evidenceIds.size !== view.evidence.length) refuse('contract_mismatch')
  for (const edge of view.edges) {
    if (!nodeIds.has(refKey(edge.source)) || !nodeIds.has(refKey(edge.target)) || edge.supportRefs.length === 0 || !edge.supportRefs.includes(edge.sourceRef) || edge.supportRefs.some(id => !evidenceIds.has(id))) refuse('contract_mismatch')
  }
  for (const item of [...view.questions, ...view.diagnostics]) {
    if (item.nodeRefs.some(ref => !nodeIds.has(refKey(ref))) || [...item.evidenceRefs, ...(item.contradictingRefs ?? [])].some(id => !evidenceIds.has(id))) refuse('contract_mismatch')
  }
  for (const table of ['nodes', 'edges', 'evidence', 'questions', 'diagnostics']) if (view.page.returned[table] !== view[table].length) refuse('contract_mismatch')
  if (view.page.truncated !== Object.values(view.page.omitted).some(value => value > 0)) refuse('contract_mismatch')
  const { projectionDigest, ...payload } = view
  if (digestJson(payload) !== projectionDigest) refuse('digest_mismatch')
  const bytes = `${canonicalize(view)}\n`
  if (Buffer.byteLength(bytes) > MAX_VIEW_BYTES) refuse('budget_exceeded')
  return bytes
}

export function parseGraphView(bytes) {
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_VIEW_BYTES) refuse('budget_exceeded')
  let view
  try { view = JSON.parse(bytes) } catch { refuse('contract_mismatch') }
  serializeGraphView(view)
  return view
}
