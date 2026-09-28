import { EVIDENCE_LIMITS, evidenceJson, validateEvidenceDocument } from './contracts.mjs'

const result = (status, reasons = []) => ({ status, reasons: [...new Set(reasons)], executionAuthorized: false, authorityTransferred: false, semanticTruthVerified: false })
const valid = (shape, value) => validateEvidenceDocument(shape, value).valid
const logicalKey = ref => JSON.stringify([ref.owner, ref.objectId, ref.selector.type, ref.selector.version, ref.selector.value])
const exactRef = (a, b) => logicalKey(a) === logicalKey(b) && a.revision === b.revision && a.contentDigest === b.contentDigest
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && !Array.isArray(item) && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
})

/** Compare declared support. This assesses compatibility, never host qualification. */
export function assessEvidenceCompatibility(profile, host) {
  if (!valid('profile', profile) || !valid('hostCapabilities', host)) return result('unsupported', ['invalid-document'])
  const reasons = []
  if (!host.protocols.includes(profile.protocol)) reasons.push('unsupported-protocol')
  if (profile.operations.some(operation => !host.operations.includes(operation))) reasons.push('unsupported-operation')
  if (profile.requiredCapabilities.some(required => !host.capabilities.some(capability => capability.id === required.id && capability.version === required.version))) reasons.push('unsupported-capability')
  return result(reasons.length ? 'unsupported' : 'compatible', reasons)
}

/** Check exact supplied snapshots. Their authenticity and read permission stay with the host. */
export function assessEvidenceCurrency(reference, snapshots, { at, maxDepth = EVIDENCE_LIMITS.dependencyDepth, maxNodes = EVIDENCE_LIMITS.snapshots } = {}) {
  let input
  try { input = evidenceJson({ reference, snapshots, at, maxDepth, maxNodes }) } catch { return result('unknown', ['invalid-document']) }
  if (!valid('evidenceRef', input.reference) || !Array.isArray(input.snapshots) || input.snapshots.length > EVIDENCE_LIMITS.snapshots ||
      !input.snapshots.every(snapshot => valid('snapshot', snapshot)) || typeof at !== 'string' ||
      !valid('validInterval', { from: at, until: null }) || !Number.isFinite(Date.parse(at)) ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > EVIDENCE_LIMITS.dependencyDepth ||
      !Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > EVIDENCE_LIMITS.snapshots) return result('unknown', ['invalid-document'])
  const index = new Map()
  for (const snapshot of input.snapshots) {
    const key = logicalKey(snapshot.reference)
    index.set(key, [...(index.get(key) ?? []), snapshot])
  }
  let visited = 0
  const reasons = new Set()
  function visit(ref, path, depth) {
    if (++visited > maxNodes || depth > maxDepth) { reasons.add('verification-bound'); return false }
    const key = logicalKey(ref)
    if (path.has(key)) { reasons.add('cyclic-dependency'); return false }
    const matches = index.get(key) ?? []
    if (matches.length !== 1) { reasons.add(matches.length ? 'ambiguous-snapshot' : 'missing-snapshot'); return false }
    const snapshot = matches[0]
    if (snapshot.currency !== 'current') { reasons.add(snapshot.currency === 'withdrawn-from-use' ? 'withdrawn' : 'not-current'); return false }
    if (!exactRef(ref, snapshot.reference)) { reasons.add('changed-reference'); return false }
    if (snapshot.validUntil !== null && !Number.isFinite(Date.parse(snapshot.validUntil))) { reasons.add('unrepresentable-expiry'); return false }
    if (snapshot.validUntil !== null && Date.parse(at) >= Date.parse(snapshot.validUntil)) { reasons.add('expired'); return false }
    const next = new Set(path).add(key)
    return snapshot.dependencies.map(dependency => visit(dependency, next, depth + 1)).every(Boolean)
  }
  const current = visit(input.reference, new Set(), 0)
  return result(current ? 'current' : 'not-current', [...reasons])
}

/** A later acceptance cannot change what kind of claim was recorded. */
export function assessClaimContinuity(previous, next) {
  if (!valid('claim', previous) || !valid('claim', next)) return result('unsupported', ['invalid-document'])
  if (previous.claimId !== next.claimId || previous.ownerRecordRef.owner !== next.ownerRecordRef.owner || previous.ownerRecordRef.objectId !== next.ownerRecordRef.objectId) return result('unsupported', ['different-claim-identity'])
  if (previous.kind !== next.kind) return result('unsupported', ['immutable-claim-kind'])
  if (previous.revision === next.revision && canonical(evidenceJson(previous)) !== canonical(evidenceJson(next))) return result('unsupported', ['unchanged-claim-revision'])
  return result('compatible')
}
