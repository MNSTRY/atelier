import { canonicalize } from '../attestation/jcs.mjs'
import { immutable } from '../edge-policy/contract.mjs'
import { displayEligibleEdge } from '../edge-policy/policy.mjs'

const refused = Object.freeze({ eligible: false })
const same = (a, b) => canonicalize(a) === canonicalize(b)
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
const boundedList = (value, max, itemMax) => Array.isArray(value) && value.length <= max && value.every(item => text(item, itemMax))

/**
 * Convert an original in-process policy decision into the graph-access edge port
 * result. The host still owns recipient access, snapshot binding and freshness.
 * A display projection or serialized decision cannot stand in for its original.
 */
export function adaptEdgeDecision(candidate, decision) {
  try {
    // This call is the policy owner's WeakSet provenance and active-state check.
    // Do not clone the decision or trust a candidate's eligible/accepted fields.
    const display = displayEligibleEdge(decision)
    if (!display || !candidate || candidate.edgeId !== display.edgeId ||
      !same(candidate.source, display.source) || !same(candidate.target, display.target) ||
      !same(candidate.supportRefs, display.supportRefs)) return refused

    // Keep complete qualifications and ordered evidence occurrences. Refuse a
    // policy result outside the receiving port's bounds rather than clipping it.
    if (!text(display.predicate, 128) || !boundedList(display.supportRefs, 64, 512) ||
      display.supportRefs.length === 0 || new Set(display.supportRefs).size !== display.supportRefs.length ||
      !display.supportRefs.includes(display.sourceRef) || !boundedList(display.qualifications, 64, 2048) ||
      !boundedList(display.reviewRefs, 64, 2048)) return refused

    return immutable({ edgeId: display.edgeId, source: display.source, target: display.target,
      predicate: display.family === 'hyperlink' && display.predicate === 'links-to' ? 'links_to' : display.predicate,
      family: display.family, acceptanceState: display.acceptanceState, supportRefs: [...display.supportRefs],
      sourceRef: display.sourceRef, assurance: display.assurance, qualifications: [...display.qualifications],
      reviewRefs: [...display.reviewRefs], recordDigest: display.recordDigest, policyDigest: display.policyDigest,
      eligible: true })
  } catch {
    // Refusals disclose no candidate, audit history, source paths or port errors.
    return refused
  }
}
