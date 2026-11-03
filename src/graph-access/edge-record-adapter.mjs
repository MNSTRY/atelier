// Bind a supplied policy record to source pins before a host digests its candidate.
import { canonicalize } from '../attestation/jcs.mjs'
import { edgeIdentity, immutable } from '../edge-policy/contract.mjs'
import { edgeEvidenceOccurrences } from '../edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../edge-policy/source-citation-adapter.mjs'
import { resolveLegacyNodeRef } from '../graph/repo-contribution.mjs'
import { adaptRepositoryContribution } from './source-adapter.mjs'

const invalid = 'Invalid graph access edge record input'
const external = 'Cross-repository edge record binding is unsupported'
const oversized = 'Edge record exceeds graph access bounds'
const need = (value, message = invalid) => { if (!value) throw new TypeError(message) }
const same = (a, b) => canonicalize(a) === canonicalize(b)
const key = ref => canonicalize([ref.repoId, ref.localId])

function bindCitation(contribution, citation, kind) {
  const matches = [...contribution.ordinaryLinks, ...contribution.declaredRelations].filter(observed => {
    const pin = observed.provenance
    const range = pin.locator?.range
    return (!kind || observed.origin === kind) && pin.repoId === citation.repoId && pin.path === citation.path &&
      pin.revision === citation.revision && pin.digest === citation.fileDigest &&
      range?.byteStart === citation.locator.byteStart && range?.byteEnd === citation.locator.byteEnd &&
      same(sourceCitationFromProvenance(contribution, pin), citation)
  })
  need(matches.length === 1)
  return matches[0]
}

/**
 * Return one complete, digestable graph-access candidate containing exactly the
 * supplied policy record. No record, approval, grant or verification is created.
 * ownerRef must come from the trusted host. Home pin presence is structural;
 * current placement, custody, bytes, origin and acceptance remain host checks.
 * This bounded adapter accepts one contribution only. All endpoints and source
 * evidence must bind to it; cross-repository assertions await an explicit
 * multi-contribution binding and evidence-distribution contract.
 */
export function adaptEdgeRecord(record, contribution, options = {}) {
  try {
    need(options && typeof options === 'object' && Object.keys(options).every(name => name === 'ownerRef'))
    const candidate = adaptRepositoryContribution(contribution, options)
    // Derive the owner's exact identities before the host hashes any candidate.
    const { edgeId } = edgeIdentity(record)
    const occurrences = edgeEvidenceOccurrences(record)
    const repoId = contribution.repository.repoId
    need([record.home, record.subject, record.object, ...occurrences.map(value => value.source)]
      .every(value => value.repoId === repoId), external)
    need(occurrences.length <= 64 && record.predicate.length <= 128, oversized)
    const nodes = new Set(contribution.nodes.map(node => key(node.ref)))
    need(nodes.has(key(record.subject)) && nodes.has(key(record.object)))
    const home = contribution.snapshot.files.find(file => file.path === record.home.path)
    need(home)
    const originKind = record.family === 'hyperlink' ? 'ordinary-link' : record.family === 'source-declaration' ? 'declared' : undefined
    const origin = bindCitation(contribution, record.origin, originKind)
    if (record.family === 'hyperlink') need(record.predicate === 'links-to' &&
      same(origin.source, record.subject) && origin.target !== null && same(origin.target, record.object))
    if (record.family === 'source-declaration') need(same(origin.source, record.subject) && origin.predicate === record.predicate &&
      same(resolveLegacyNodeRef(origin.target, [contribution]), record.object))
    const evidence = occurrences.map((occurrence, index) => ({
      evidenceId: occurrence.id,
      sourceRef: (index === 0 ? origin : bindCitation(contribution, occurrence.source)).provenance,
    }))
    const sourceRef = { repoId, path: home.path, revision: contribution.snapshot.digest, digest: home.rawDigest }
    return immutable(structuredClone({ ...candidate,
      edges: [{ edgeId, source: record.subject, target: record.object, predicate: record.predicate,
        family: record.family, sourceRef, supportRefs: occurrences.map(value => value.id) }],
      evidence,
    }))
  } catch (error) {
    if (error instanceof TypeError && [invalid, external, oversized].includes(error.message)) throw error
    throw new TypeError(invalid)
  }
}
