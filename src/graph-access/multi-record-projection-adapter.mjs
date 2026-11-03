// Aggregate supplied policy records after the host selects current recipient scope.
import { canonicalize } from '../attestation/jcs.mjs'
import { immutable } from '../edge-policy/contract.mjs'
import { adaptMultiContributionRecord } from './multi-contribution-record-adapter.mjs'
import { adaptRepositoryContribution } from './source-adapter.mjs'

const invalid = 'Invalid multi-record projection input'
const duplicate = 'Duplicate graph edge or evidence identity'
const oversized = 'Graph projection exceeds graph access bounds'
const missing = 'Required edge record repository is not selected'
const need = (value, message = invalid) => { if (!value) throw new TypeError(message) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const sourceOnly = value => ({ ...value, edges: [], evidence: [] })

/**
 * Return complete per-repository candidates for explicitly selected records and
 * native contributions. The host owns grants, current permitted-record selection,
 * source verification and policy acceptance; this function creates none of them.
 * Empty records retain selected source nodes with no governed edges or evidence.
 * Rebuild all candidates when grants change; never slice an older recipient bundle.
 * Delegated source validation repeats per record (O(records × selected repos));
 * input limits are refusal bounds, not a demonstrated large-batch throughput claim.
 */
export function adaptMultiRecordProjection(records, selected, options = {}) {
  try {
    need(plain(options) && Object.keys(options).every(name => name === 'topology'))
    need(Array.isArray(records) && Array.isArray(selected))
    // Refuse oversized work before reading or validating any selected source.
    need(records.length <= 10000 && selected.length <= 64, oversized)
    need(records.length === 0 || selected.length > 0, missing)
    const candidates = new Map(), sourcePins = new Map()
    for (const entry of selected) {
      need(plain(entry) && Object.keys(entry).sort().join(',') === 'contribution,ownerRef')
      const candidate = sourceOnly(adaptRepositoryContribution(entry.contribution, { ownerRef: entry.ownerRef }))
      const repoId = candidate.repository.repoId
      need(!candidates.has(repoId))
      candidates.set(repoId, candidate)
      sourcePins.set(repoId, canonicalize(candidate))
    }
    const edgeIds = new Set(), evidenceIds = new Set()
    for (const record of records) {
      const bundle = adaptMultiContributionRecord(record, selected, options)
      for (const contribution of bundle) {
        const repoId = contribution.repository.repoId
        need(sourcePins.get(repoId) === canonicalize(sourceOnly(contribution)))
        const candidate = candidates.get(repoId)
        for (const edge of contribution.edges) {
          need(!edgeIds.has(edge.edgeId), duplicate)
          edgeIds.add(edge.edgeId)
          candidate.edges.push(edge)
        }
        for (const evidence of contribution.evidence) {
          need(!evidenceIds.has(evidence.evidenceId), duplicate)
          evidenceIds.add(evidence.evidenceId)
          candidate.evidence.push(evidence)
        }
        need(candidate.edges.length <= 10000 && candidate.evidence.length <= 10000, oversized)
      }
    }
    const complete = [...candidates.values()].sort((a, b) => compare(a.repository.repoId, b.repository.repoId)).map(candidate => ({
      ...candidate,
      edges: candidate.edges.sort((a, b) => compare(a.edgeId, b.edgeId)),
      evidence: candidate.evidence.sort((a, b) => compare(a.evidenceId, b.evidenceId)),
    }))
    for (const candidate of complete) need(candidate.nodes.length <= 10000 && candidate.snapshot.files.length <= 10000 &&
      Buffer.byteLength(canonicalize(candidate)) <= 8 * 1024 * 1024, oversized)
    return immutable(structuredClone(complete))
  } catch (error) {
    if (error instanceof TypeError && error.message === 'Edge record exceeds graph access bounds') throw new TypeError(oversized)
    if (error instanceof TypeError && [invalid, duplicate, oversized, missing].includes(error.message)) throw error
    throw new TypeError(invalid)
  }
}
