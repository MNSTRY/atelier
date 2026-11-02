import crypto from 'node:crypto'
import { canonicalize } from '../attestation/jcs.mjs'

// Experimental adapter shapes, not an ontology or identity authority.
export const EDGE_RECORD_SCHEMA = 'atelier-edge-record@experimental-v1'
export const EDGE_DECISION_SCHEMA = 'atelier-edge-decision@experimental-v1'
export const EDGE_FAMILIES = Object.freeze(['hyperlink', 'source-declaration', 'reviewed-assertion'])
export const EDGE_ACTIONS = Object.freeze(['propose', 'approve', 'accept', 'reject', 'suspend', 'withdraw', 'supersede'])
const digestPattern = /^sha256:[a-f0-9]{64}$/
const text = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.trim() === v && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const closed = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k))
const relativePath = (v) => text(v, 2048) && !v.includes('\\') && !v.startsWith('/') && !/^[A-Za-z]:/.test(v) && v.split('/').every((p) => p && p !== '.' && p !== '..')
export const validNodeRef = (v) => closed(v, ['repoId', 'localId']) && text(v.repoId) && text(v.localId)
export const bytesDigest = (v) => `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`
export const edgeDigest = (v) => bytesDigest(canonicalize(v))
export function immutable(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}

export function validSourceRef(v) {
  return closed(v, ['repoId', 'path', 'revision', 'fileDigest', 'locator', 'citedDigest']) &&
    text(v.repoId) && relativePath(v.path) && text(v.revision) && digestPattern.test(v.fileDigest) && digestPattern.test(v.citedDigest) &&
    closed(v.locator, ['byteStart', 'byteEnd']) && Number.isSafeInteger(v.locator.byteStart) && v.locator.byteStart >= 0 &&
    Number.isSafeInteger(v.locator.byteEnd) && v.locator.byteEnd > v.locator.byteStart
}

export function validateEdgeRecord(v) {
  try {
    if (!closed(v, ['schema', 'family', 'subject', 'predicate', 'object', 'home', 'origin', 'supports', 'policyDigest', 'proposalRef', 'sourceChange', 'qualifications'])) return false
    if (v.schema !== EDGE_RECORD_SCHEMA || !EDGE_FAMILIES.includes(v.family) || !validNodeRef(v.subject) || !validNodeRef(v.object) || !text(v.predicate)) return false
    if (!closed(v.home, ['repoId', 'path', 'readership']) || !text(v.home.repoId) || !relativePath(v.home.path) || !text(v.home.readership)) return false
    if (!validSourceRef(v.origin) || !Array.isArray(v.supports) || v.supports.length > 256 ||
      v.supports.some((s) => !closed(s, ['id', 'source']) || !text(s.id) || !validSourceRef(s.source)) || new Set(v.supports.map((s) => s.id)).size !== v.supports.length) return false
    if (!digestPattern.test(v.policyDigest) || (v.proposalRef !== null && !text(v.proposalRef, 2048)) ||
      !Array.isArray(v.qualifications) || v.qualifications.length > 64 || v.qualifications.some((q) => !text(q, 2048))) return false
    if (v.family === 'hyperlink' && (v.predicate !== 'links-to' || v.sourceChange !== null)) return false
    if (v.sourceChange !== null && (!closed(v.sourceChange, ['repoId', 'path', 'baseRevision', 'diffDigest', 'reviewRef']) ||
      !text(v.sourceChange.repoId) || !relativePath(v.sourceChange.path) || !text(v.sourceChange.baseRevision) || !digestPattern.test(v.sourceChange.diffDigest) || !text(v.sourceChange.reviewRef, 2048))) return false
    edgeDigest(v)
    return true
  } catch { return false }
}

export function validateEdgeDecision(v) {
  try {
    if (!closed(v, ['schema', 'recordDigest', 'sequence', 'previousDigest', 'action', 'actorId', 'at', 'policyDigest', 'reason', 'roles', 'signature'])) return false
    if (v.schema !== EDGE_DECISION_SCHEMA || !digestPattern.test(v.recordDigest) || !Number.isSafeInteger(v.sequence) || v.sequence < 1 ||
      (v.previousDigest !== null && !digestPattern.test(v.previousDigest)) || !EDGE_ACTIONS.includes(v.action) || !text(v.actorId) ||
      !text(v.at) || !Number.isFinite(Date.parse(v.at)) || new Date(v.at).toISOString() !== v.at || !digestPattern.test(v.policyDigest) || !text(v.reason, 2048)) return false
    if (!Array.isArray(v.roles) || v.roles.length > 3 || v.roles.some((r) => !closed(r, ['repoId', 'role']) || !text(r.repoId) || !['home-owner', 'endpoint-steward'].includes(r.role)) ||
      new Set(v.roles.map((r) => canonicalize(r))).size !== v.roles.length) return false
    if (v.action !== 'approve' && v.roles.length !== 0) return false
    if (v.action === 'approve' && v.roles.length === 0) return false
    if (!closed(v.signature, ['algorithm', 'keyId', 'value']) || !['ed25519', 'es256'].includes(v.signature.algorithm) || !text(v.signature.keyId) || !text(v.signature.value, 512)) return false
    edgeDigest(v)
    return true
  } catch { return false }
}

export function edgeIdentity(record) {
  if (!validateEdgeRecord(record)) throw new TypeError('invalid edge record')
  const recordDigest = edgeDigest(record)
  return Object.freeze({ edgeId: `edge:${recordDigest.slice(7)}`, recordDigest })
}
