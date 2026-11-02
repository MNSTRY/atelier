import { verifyDocument } from '../attestation/sign.mjs'
import { bytesDigest, edgeDigest, edgeIdentity, immutable, validateEdgeDecision, validateEdgeRecord } from './contract.mjs'

const roleKey = (role) => `${role.role}\0${role.repoId}`
const same = (a, b) => edgeDigest(a) === edgeDigest(b)
const fail = (state, reason) => ({ state, eligible: false, reason })
const decisions = new WeakSet()
const seal = (value) => { const result = immutable(value); decisions.add(result); return result }
function demand(value, reason) { if (!value) throw new Error(reason) }

function validPolicy(p) {
  return p && Object.keys(p).sort().join(',') === 'allowProposerReview,allowSharedSteward,version' &&
    typeof p.version === 'string' && p.version.length > 0 && typeof p.allowProposerReview === 'boolean' && typeof p.allowSharedSteward === 'boolean'
}

// Host functions are trusted integration ports. No record-supplied identity,
// eligible flag, audience or local asserted review substitutes for these ports.
// The host must hold one coherent current snapshot across an evaluation.
export async function evaluateEdge(input, host) {
  let record, events
  try {
    record = structuredClone(input.record)
    events = structuredClone(input.events)
    if (!validateEdgeRecord(record) || !Array.isArray(events) || events.length > 1024 || events.some((e) => !validateEdgeDecision(e))) return immutable(fail('suspended', 'invalid-input'))
    immutable(record); immutable(events)
    const identity = edgeIdentity(record)
    const policy = immutable(structuredClone(host.policy))
    demand(validPolicy(policy), 'policy-unavailable')
    const policyDigest = edgeDigest(policy)
    demand(typeof host.bindingId === 'string' && host.bindingId.length > 0, 'snapshot-binding-unavailable')
    const occurrence = (id, source) => ({ id: `evidence:${edgeDigest({ edgeId: identity.edgeId, occurrenceId: id, source }).slice(7)}`, occurrenceId: id, source })
    const base = { ...identity, family: record.family, policyDigest, verification: { checkedAt: host.now, bindingId: host.bindingId }, reviewRefs: [], triple: { subject: record.subject, predicate: record.predicate, object: record.object },
      supportRefs: [occurrence('origin', record.origin), ...record.supports.map((s) => occurrence(`support:${s.id}`, s.source))], qualifications: record.qualifications,
      sourceChange: record.sourceChange, history: events }
    const result = (value) => seal({ ...base, ...value })
    if (record.policyDigest !== policyDigest) return result(fail('suspended', 'policy-changed'))
    const now = Date.parse(host.now)
    demand(Number.isFinite(now), 'clock-unavailable')
    const head = await host.readRecordHead(identity)
    if (!head || head.recordDigest !== identity.recordDigest || head.eventCount !== events.length || head.eventDigest !== (events.length ? edgeDigest(events.at(-1)) : null)) return result(fail('suspended', 'history-head-mismatch'))
    const origin = await host.verifyOrigin({ record, ...identity, policyDigest })
    if (!origin || origin.recordDigest !== identity.recordDigest || origin.bindingId !== host.bindingId || origin.matches !== true) return result(fail('suspended', 'origin-mismatch'))
    // Safe placement considers the home's entire intended readership, not only
    // this reader. The host checks endpoints, all evidence and record metadata.
    const placement = await host.checkSourceHome({ record, ...identity, policyDigest })
    if (!placement || placement.recordDigest !== identity.recordDigest || placement.policyDigest !== policyDigest || placement.bindingId !== host.bindingId || placement.allowed !== true) return result(fail('suspended', 'unsafe-source-home'))
    const endpoints = await Promise.all([record.subject, record.object].map((ref) => host.resolveEndpoint(ref)))
    if (endpoints.some((e, i) => !e || !same(e.ref, [record.subject, record.object][i]) || e.current !== true || typeof e.stewardId !== 'string' || !e.stewardId)) return result(fail('suspended', 'endpoint-unavailable'))
    const home = await host.resolveHomeOwner(record.home.repoId)
    if (!home || typeof home.actorId !== 'string' || !home.actorId) return result(fail('suspended', 'home-owner-unavailable'))
    for (const { source } of base.supportRefs) {
      const observed = await host.readSource(source)
      if (!observed || observed.revision !== source.revision || !(observed.bytes instanceof Uint8Array)) return result(fail('stale', 'source-changed'))
      const bytes = Buffer.from(observed.bytes)
      if (bytesDigest(bytes) !== source.fileDigest || source.locator.byteEnd > bytes.length ||
        bytesDigest(bytes.subarray(source.locator.byteStart, source.locator.byteEnd)) !== source.citedDigest) return result(fail('stale', 'citation-changed'))
    }
    const semantic = record.family !== 'hyperlink'
    const crossRepo = record.subject.repoId !== record.object.repoId
    const governed = semantic && (crossRepo || record.family === 'reviewed-assertion' || events.length > 0)
    if (!semantic) return result(events.length ? fail('suspended', 'navigation-has-decisions') : { state: 'active', eligible: true, assurance: 'navigation' })
    if (!governed) return result({ state: 'active', eligible: true, assurance: 'source-declaration' })
    if (!record.proposalRef || !record.sourceChange || record.sourceChange.repoId !== record.home.repoId || record.sourceChange.path !== record.home.path) return result(fail('suspended', 'source-owner-handoff-missing'))
    const required = [{ repoId: record.home.repoId, role: 'home-owner', actorId: home.actorId },
      ...[...new Map(endpoints.map((e) => [e.ref.repoId, { repoId: e.ref.repoId, role: 'endpoint-steward', actorId: e.stewardId }])).values()]]
    if (crossRepo && endpoints[0].stewardId === endpoints[1].stewardId && !policy.allowSharedSteward) return result(fail('suspended', 'shared-steward-not-delegated'))
    let previous = null, state = 'draft', proposer = null, lastTime = -Infinity
    const approvals = new Map()
    for (const [index, event] of events.entries()) {
      if (event.sequence !== index + 1 || event.previousDigest !== previous || event.recordDigest !== identity.recordDigest || event.policyDigest !== policyDigest || Date.parse(event.at) < lastTime || Date.parse(event.at) > now) return result(fail('suspended', 'decision-chain-invalid'))
      if (['withdrawn', 'rejected', 'superseded', 'suspended'].includes(state)) return result(fail('suspended', 'terminal-history-continued'))
      const binding = await host.resolveActorKey({ actorId: event.actorId, keyId: event.signature.keyId, at: host.now })
      if (!binding || binding.actorId !== event.actorId || binding.revoked !== false || !Number.isFinite(Date.parse(binding.notBefore)) || !Number.isFinite(Date.parse(binding.expiresAt)) ||
        Date.parse(binding.notBefore) > Date.parse(event.at) || Date.parse(binding.expiresAt) <= now || !verifyDocument(event, { publicKey: binding.publicKey }).valid) return result(fail('suspended', 'actor-key-unavailable'))
      const grant = await host.authorizeDecision({ event, record, required, policyDigest })
      if (!grant || grant.eventDigest !== edgeDigest(event) || grant.policyDigest !== policyDigest || grant.bindingId !== host.bindingId || grant.allowed !== true || grant.revoked !== false ||
        !Number.isFinite(Date.parse(grant.notBefore)) || Date.parse(grant.notBefore) > Date.parse(event.at) || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now) return result(fail('suspended', 'decision-grant-unavailable'))
      if (event.action === 'propose') {
        if (state !== 'draft') return result(fail('suspended', 'invalid-transition'))
        proposer = event.actorId; state = 'awaiting-endpoint-review'
      } else if (event.action === 'approve') {
        if (state !== 'awaiting-endpoint-review' || (!policy.allowProposerReview && event.actorId === proposer)) return result(fail('suspended', 'invalid-reviewer'))
        for (const role of event.roles) {
          const match = required.find((r) => roleKey(r) === roleKey(role) && r.actorId === event.actorId)
          if (!match) return result(fail('suspended', 'invalid-reviewer'))
          approvals.set(roleKey(role), edgeDigest(event))
        }
      } else if (event.action === 'accept') {
        if (state !== 'awaiting-endpoint-review' || event.actorId !== home.actorId || required.some((r) => !approvals.has(roleKey(r)))) return result(fail('suspended', 'missing-reviewer'))
        state = 'active'
      } else {
        if (state === 'draft' || ![home.actorId, proposer, ...endpoints.map((e) => e.stewardId)].includes(event.actorId)) return result(fail('suspended', 'invalid-transition'))
        state = { reject: 'rejected', suspend: 'suspended', withdraw: 'withdrawn', supersede: 'superseded' }[event.action]
      }
      previous = edgeDigest(event); lastTime = Date.parse(event.at)
    }
    return result({ state, eligible: state === 'active', assurance: state === 'active' ? 'reviewed-assertion' : 'pending', reviewRefs: [...new Set(approvals.values())].sort() })
  } catch {
    // Port errors must not disclose hidden paths, actor details or source bytes.
    return immutable(fail('suspended', 'verification-unavailable'))
  }
}

// Input results must already be authorized for one recipient and evaluated in
// the same host snapshot. Preserve each complete assertion and its supports.
export function groupEligibleEdges(results) {
  const groups = new Map()
  for (const result of results) {
    if (!decisions.has(result)) throw new Error('unverified edge decision')
    if (!result.eligible || result.state !== 'active') continue
    const key = edgeDigest({ family: result.family, triple: result.triple, qualifications: result.qualifications })
    const group = groups.get(key) ?? { groupId: `edge-group:${key.slice(7)}`, family: result.family, triple: result.triple, assertions: [] }
    if (group.assertions.some((a) => a.edgeId === result.edgeId && edgeDigest(a) !== edgeDigest(result))) throw new Error('conflicting edge decisions')
    if (!group.assertions.some((a) => a.edgeId === result.edgeId)) group.assertions.push(structuredClone(result))
    groups.set(key, group)
  }
  return immutable([...groups.values()].map((g) => ({ ...g, assertions: g.assertions.sort((a, b) => a.edgeId.localeCompare(b.edgeId, 'en')) })).sort((a, b) => a.groupId.localeCompare(b.groupId, 'en')))
}

// Only evaluated decisions may enter this seam; a deserialized eligible flag is
// never authority. The access host revalidates bindingId/current grants at use.
export function displayEligibleEdge(result) {
  if (!decisions.has(result) || !result.eligible || result.state !== 'active') return null
  return immutable({ edgeId: result.edgeId, source: result.triple.subject, target: result.triple.object,
    predicate: result.triple.predicate, family: result.family, acceptanceState: result.state, assurance: result.assurance,
    supportRefs: result.supportRefs.map((s) => s.id), sourceRef: result.supportRefs[0].id, reviewRefs: result.reviewRefs,
    qualifications: result.qualifications, recordDigest: result.recordDigest, policyDigest: result.policyDigest, verification: result.verification })
}
