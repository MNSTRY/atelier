import { presentationSchema, paneSchema } from './schema.generated.mjs'
import { matchesPresentationSchema } from './schema-check.mjs'
import { canonicalize } from '../../attestation/jcs.mjs'

export const PRESENTATION_VERSION = '1.0.0'
export const PRESENTATION_SCHEMA = 'atelier.presentation/v1'
export const PRESENTATION_BYTE_LIMIT = 1048576
const validateModel = value => matchesPresentationSchema(presentationSchema, value)
const validatePaneSchema = value => matchesPresentationSchema(paneSchema, value)

function jsonData(value) {
  const queue = [[value, 0]]
  let count = 0
  let stringBytes = 0
  const size = value => {
    if (value.length > PRESENTATION_BYTE_LIMIT) return false
    stringBytes += new TextEncoder().encode(JSON.stringify(value)).length
    return stringBytes <= PRESENTATION_BYTE_LIMIT
  }
  while (queue.length) {
    const [item, depth] = queue.pop()
    if (++count > 20000 || depth > 12) return false
    if (typeof item === 'string') { if (!size(item)) return false; continue }
    if (item === null || typeof item === 'boolean') continue
    if (typeof item === 'number' && Number.isFinite(item)) continue
    if (typeof item !== 'object') return false
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (!Object.hasOwn(d, 'value')) return false
      if (!Array.isArray(item) && !size(key)) return false
      queue.push([d.value, depth + 1])
    }
  }
  // Count punctuation, escaping and numeric encodings using the same canonical
  // representation emitted by serializePresentation. No getters remain here.
  try { return new TextEncoder().encode(canonicalize(value)).length <= PRESENTATION_BYTE_LIMIT }
  catch { return false }
}

export function safeReference(value, { asset = false } = {}) {
  if (typeof value !== 'string' || /[\u0000-\u0020\\<>]/u.test(value)) return false
  if (!value.startsWith('/') && !(value.startsWith('#') && !asset)) return false
  if (value.startsWith('//') || /%2f|%5c|%00/i.test(value)) return false
  return true
}

function widthErrors(pane) {
  return pane.width && (pane.width.min > pane.width.max || pane.width.value < pane.width.min || pane.width.value > pane.width.max)
    ? ['pane width must satisfy min <= value <= max'] : []
}

export function validatePanePresentation(value) {
  if (!jsonData(value)) return ['pane must be bounded plain JSON']
  if (!validatePaneSchema(value)) return ['invalid pane shape']
  return widthErrors(value)
}

export function validatePresentation(value) {
  if (!jsonData(value)) return ['presentation must be bounded plain JSON']
  if (!validateModel(value)) return ['invalid presentation shape or version']
  const errors = []
  const ids = new Set()
  for (const entry of [...value.panes, ...value.nodes, ...value.navigation]) {
    if (ids.has(entry.id)) errors.push('duplicate presentation identity')
    ids.add(entry.id)
  }
  const nodes = new Map(value.nodes.map(node => [node.id, node]))
  const panes = new Set(value.panes.map(pane => pane.id))
  const mounted = new Set()
  for (const pane of value.panes) {
    errors.push(...widthErrors(pane))
    for (const ref of pane.blocks) {
      if (!nodes.has(ref)) errors.push('unknown pane block')
      if (mounted.has(ref)) errors.push('block mounted more than once')
      mounted.add(ref)
    }
  }
  if (value.panes.filter(p => p.role === 'primary').length !== 1) errors.push('exactly one primary pane required')
  for (const nav of value.navigation) if (!panes.has(nav.target)) errors.push('unknown navigation target')
  for (const node of value.nodes) {
    if (node.type === 'action' && node.disabled && !node.reason) errors.push('disabled action needs visible reason')
    if (node.type === 'media' && !safeReference(node.src, { asset: true })) errors.push('media source must be a local path')
    if (node.items) {
      const localIds = new Set()
      for (const item of node.items) {
        if (localIds.has(item.id)) errors.push('duplicate item identity')
        localIds.add(item.id)
        if (item.href && !safeReference(item.href)) errors.push('link must be a local path or fragment')
      }
      for (const edge of node.edges ?? []) if (!localIds.has(edge.from) || !localIds.has(edge.to)) errors.push('unknown graph endpoint')
    }
    for (const ref of node.actions ?? []) {
      if (nodes.get(ref)?.type !== 'action') errors.push('unknown action reference')
      if (mounted.has(ref)) errors.push('action mounted more than once')
      mounted.add(ref)
    }
  }
  for (const id of nodes.keys()) if (!mounted.has(id)) errors.push('unmounted node')
  return errors
}

export function assertPresentation(value) {
  const errors = validatePresentation(value)
  if (errors.length) throw new TypeError(errors.join('; '))
  return value
}

export function serializePresentation(value) {
  assertPresentation(value)
  return canonicalize(value)
}

export function parsePresentation(serialized) {
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > PRESENTATION_BYTE_LIMIT) throw new TypeError('presentation byte limit')
  return assertPresentation(JSON.parse(serialized))
}
