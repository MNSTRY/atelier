// Pure projection from the source producer; ownership and access remain host-owned.
import { createHash } from 'node:crypto'
import { canonicalize } from '../attestation/jcs.mjs'
import { deepFreeze } from '../composition/wire.mjs'
import { validateRepositoryContribution } from '../graph/repo-contribution.mjs'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f]/u.test(value)
const ref = value => plain(value) && Object.keys(value).sort().join(',') === 'localId,repoId' && text(value.repoId) && text(value.localId)
const key = value => canonicalize([value.repoId, value.localId])
const equal = (a, b) => canonicalize(a) === canonicalize(b)
const hash = value => createHash('sha256').update(canonicalize(value)).digest('hex')
const need = value => { if (!value) throw new TypeError('Invalid graph access source input') }
// Resolution may change endpoints, never the observed occurrence or its pin.
const occurrence = link => canonicalize({ ...link, target: null, resolution: 'unresolved' })

function resolvedLinks(contribution, topology) {
  if (topology === undefined) return contribution.ordinaryLinks
  need(plain(topology) && Array.isArray(topology.nodes) && Array.isArray(topology.ordinaryLinks))
  const nodes = new Map()
  for (const node of topology.nodes) {
    need(ref(node?.ref) && !nodes.has(key(node.ref)))
    nodes.set(key(node.ref), node)
  }
  for (const node of contribution.nodes) need(equal(nodes.get(key(node.ref)), node))
  const links = new Map()
  for (const link of topology.ordinaryLinks) {
    if (link?.source?.repoId !== contribution.repository.repoId) continue
    need(plain(link))
    const id = occurrence(link)
    need(!links.has(id))
    need(link.target === null
      ? link.resolution === 'unresolved'
      : ref(link.target) && nodes.has(key(link.target)) && link.resolution === (link.target.repoId === link.source.repoId ? 'resolved-local' : 'resolved-cross-repository'))
    links.set(id, link)
  }
  need(links.size === contribution.ordinaryLinks.length)
  return contribution.ordinaryLinks.map(link => {
    const resolved = links.get(occurrence(link))
    need(resolved)
    return resolved
  })
}

/**
 * Normalize one buildRepositoryContribution result for createGraphAccess.
 * ownerRef is an explicit trusted-host binding, never derived from source data.
 * Optional topology comes from the host's explicitly supplied contribution set;
 * it binds endpoints only and supplies no recipient grant or edge acceptance.
 * Declared semantic relations stay with their assertion owner and are not
 * converted into hyperlinks or activated by this navigation-only adapter.
 * Structural integrity here does not verify raw bytes, ownership or freshness;
 * the host's verifyContribution and evaluateEdge ports remain required.
 */
export function adaptRepositoryContribution(contribution, options = {}) {
  need(plain(options) && Object.keys(options).every(k => ['ownerRef', 'topology'].includes(k)) && text(options.ownerRef))
  need(validateRepositoryContribution(contribution).ok)
  const links = resolvedLinks(contribution, options.topology).filter(link => link.target !== null)
  const evidence = [], edges = []
  const seen = new Set()
  for (const link of links) {
    const occurrenceDigest = hash({ source: link.source, sourceRef: link.provenance })
    need(!seen.has(occurrenceDigest)); seen.add(occurrenceDigest)
    const evidenceId = `ordinary-link-evidence:${occurrenceDigest}`
    evidence.push({ evidenceId, sourceRef: link.provenance })
    edges.push({ edgeId: `ordinary-link:${hash({ source: link.source, target: link.target, sourceRef: link.provenance })}`,
      source: link.source, target: link.target, predicate: 'links_to', family: 'hyperlink',
      sourceRef: link.provenance, supportRefs: [evidenceId] })
  }
  return deepFreeze(structuredClone({
    repository: { repoId: contribution.repository.repoId, ownerRef: options.ownerRef },
    snapshot: contribution.snapshot,
    inputs: contribution.inputs,
    nodes: contribution.nodes.map(node => ({
      ref: node.ref, sourceKind: node.kgType, title: node.title, summary: node.summary,
      classification: node.classification, lifecycle: node.lifecycle, tags: node.tags,
      sourceRef: node.source, displayEligible: true,
    })),
    edges, evidence,
  }))
}
