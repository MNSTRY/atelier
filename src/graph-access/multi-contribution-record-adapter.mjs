// Recipient-scoped structural binding; the host supplies current grants and records.
import { canonicalize } from '../attestation/jcs.mjs'
import { edgeIdentity, immutable } from '../edge-policy/contract.mjs'
import { edgeEvidenceOccurrences } from '../edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../edge-policy/source-citation-adapter.mjs'
import { resolveLegacyNodeRef } from '../graph/repo-contribution.mjs'
import { adaptRepositoryContribution } from './source-adapter.mjs'

const invalid = 'Invalid multi-contribution edge record input'
const missing = 'Required edge record repository is not selected'
const oversized = 'Edge record exceeds graph access bounds'
const need = (value, message = invalid) => { if (!value) throw new TypeError(message) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const same = (a, b) => canonicalize(a) === canonicalize(b)
const key = ref => canonicalize([ref.repoId, ref.localId])
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

function observedCitation(contribution, citation, kind) {
  const matches = [...contribution.ordinaryLinks, ...contribution.declaredRelations].filter(observed => {
    const pin = observed.provenance, range = pin.locator?.range
    return (!kind || observed.origin === kind) && pin.repoId === citation.repoId && pin.path === citation.path &&
      pin.revision === citation.revision && pin.digest === citation.fileDigest &&
      range?.byteStart === citation.locator.byteStart && range?.byteEnd === citation.locator.byteEnd &&
      same(sourceCitationFromProvenance(contribution, pin), citation)
  })
  need(matches.length === 1)
  return matches[0]
}

/**
 * Normalize one supplied full policy record over an explicitly selected set of
 * native contributions and trusted ownerRefs. The caller must select permitted
 * records AFTER checking current recipient grants. This pure function never
 * authenticates a grant, accepts an assertion or verifies source bytes/custody.
 * A missing dependency refuses the whole binding before any candidate returns.
 * Rebuild the whole binding when grants change; never retain a partial slice of
 * a previously authorized bundle. Every candidate must be complete before the
 * host computes its contribution digest and invokes createGraphAccess.
 * Optional topology must cover exactly the selected contribution set. Without
 * it, unresolved cross-repository hyperlinks refuse rather than guess targets.
 */
export function adaptMultiContributionRecord(record, selected, options = {}) {
  try {
    need(plain(options) && Object.keys(options).every(name => name === 'topology'))
    need(Array.isArray(selected) && selected.length > 0)
    need(selected.length <= 64, oversized)
    const { edgeId } = edgeIdentity(record)
    const occurrences = edgeEvidenceOccurrences(record)
    need(occurrences.length <= 64 && record.predicate.length <= 128, oversized)
    const contributions = new Map(), candidates = new Map()
    for (const entry of selected) {
      need(plain(entry) && Object.keys(entry).sort().join(',') === 'contribution,ownerRef')
      const candidate = adaptRepositoryContribution(entry.contribution, { ownerRef: entry.ownerRef })
      const repoId = candidate.repository.repoId
      need(!contributions.has(repoId))
      contributions.set(repoId, entry.contribution)
      candidates.set(repoId, candidate)
    }
    need([record.home, record.subject, record.object, ...occurrences.map(value => value.source)]
      .every(value => contributions.has(value.repoId)), missing)
    if (options.topology !== undefined) {
      const topology = options.topology
      need(plain(topology) && Array.isArray(topology.nodes) && Array.isArray(topology.ordinaryLinks))
      need(topology.nodes.length === [...contributions.values()].reduce((total, value) => total + value.nodes.length, 0) &&
        topology.nodes.every(node => contributions.has(node?.ref?.repoId)) &&
        topology.ordinaryLinks.every(link => contributions.has(link?.source?.repoId)))
      for (const entry of selected) candidates.set(entry.contribution.repository.repoId,
        adaptRepositoryContribution(entry.contribution, { ownerRef: entry.ownerRef, topology }))
    }
    const nodeRefs = new Set([...contributions.values()].flatMap(value => value.nodes.map(node => key(node.ref))))
    need(nodeRefs.has(key(record.subject)) && nodeRefs.has(key(record.object)))
    const homeContribution = contributions.get(record.home.repoId)
    const home = homeContribution.snapshot.files.find(file => file.path === record.home.path)
    need(home)
    const originContribution = contributions.get(record.origin.repoId)
    const kind = record.family === 'hyperlink' ? 'ordinary-link' : record.family === 'source-declaration' ? 'declared' : undefined
    const origin = observedCitation(originContribution, record.origin, kind)
    if (record.family === 'hyperlink') {
      const resolved = candidates.get(record.origin.repoId).edges.filter(edge => same(edge.sourceRef, origin.provenance))
      need(record.predicate === 'links-to' && resolved.length === 1 &&
        same(resolved[0].source, record.subject) && same(resolved[0].target, record.object))
    }
    if (record.family === 'source-declaration') need(same(origin.source, record.subject) && origin.predicate === record.predicate &&
      same(resolveLegacyNodeRef(origin.target, [...contributions.values()]), record.object))
    const evidence = new Map([...contributions.keys()].map(repoId => [repoId, []]))
    for (const [index, occurrence] of occurrences.entries()) {
      const contribution = contributions.get(occurrence.source.repoId)
      const observed = index === 0 ? origin : observedCitation(contribution, occurrence.source)
      evidence.get(contribution.repository.repoId).push({ evidenceId: occurrence.id, sourceRef: observed.provenance })
    }
    const edge = { edgeId, source: record.subject, target: record.object, predicate: record.predicate, family: record.family,
      sourceRef: { repoId: record.home.repoId, path: home.path, revision: homeContribution.snapshot.digest, digest: home.rawDigest },
      supportRefs: occurrences.map(value => value.id) }
    return immutable([...candidates.values()].sort((a, b) => compare(a.repository.repoId, b.repository.repoId)).map(candidate =>
      structuredClone({ ...candidate, edges: candidate.repository.repoId === record.home.repoId ? [edge] : [],
        evidence: evidence.get(candidate.repository.repoId) })))
  } catch (error) {
    if (error instanceof TypeError && [invalid, missing, oversized].includes(error.message)) throw error
    throw new TypeError(invalid)
  }
}
