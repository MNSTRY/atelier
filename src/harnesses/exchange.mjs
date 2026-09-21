import { inspectInquiry } from '../inquiry/index.mjs'
import { inspectKnowledge } from '../knowledge/ledger.mjs'
import { inspectBuild } from '../build/ledger.mjs'
import { assertHandoff, contentDigest, harnessDigest, harnessRef, restrictiveAudience, HARNESS_LIMITS } from './contracts.mjs'
import { canonical } from '../capabilities/files.mjs'
import { createHash } from 'node:crypto'

export function inspectHarness(profile, records) {
  if (profile === 'inquiry') return inspectInquiry(records)
  if (profile === 'knowledge') return inspectKnowledge(records)
  if (profile === 'build') return inspectBuild(records)
  throw new Error('unknown harness profile')
}
function context(dependencySnapshots = [], verificationLimit = HARNESS_LIMITS.dependencyVerifications) {
  if (!Array.isArray(dependencySnapshots) || dependencySnapshots.length > 64) throw new Error('dependency snapshot ceiling exceeded')
  if (!Number.isSafeInteger(verificationLimit) || verificationLimit < 1 || verificationLimit > HARNESS_LIMITS.dependencyVerifications) throw new Error('invalid dependency verification limit')
  return { snapshots: dependencySnapshots, inspections: new Map(), verified: new Map(), verificationLimit, verificationCalls: 0, historyReplays: 0, exhausted: false }
}
function inspect(profile, records, ctx) {
  if (!ctx.inspections.has(profile)) ctx.inspections.set(profile, new Map())
  const cache = ctx.inspections.get(profile)
  if (!cache.has(records)) { cache.set(records, inspectHarness(profile, records)); ctx.historyReplays++ }
  return cache.get(records)
}
const work = ctx => ({ verificationCalls: ctx.verificationCalls, historyReplays: ctx.historyReplays, verificationLimit: ctx.verificationLimit, exhausted: ctx.exhausted })
const bounded = depth => { if (depth > HARNESS_LIMITS.dependencyDepth) throw new Error('harness dependency depth exceeded') }
function artifact(profile, records, subjectId, ctx, depth) {
  bounded(depth)
  const state = inspect(profile, records, ctx), subject = records.find(r => r.id === subjectId)
  if (!subject || state.reconsider.some(r => r.id === subjectId)) throw new Error('handoff subject is missing or requires reconsideration')
  let audience, context
  if (profile === 'knowledge') {
    if (subject.kind !== 'contribution' || !state.accepted.includes(subject.id)) throw new Error('knowledge handoff requires an accepted contribution')
    if (knowledgeFreshness(records, ctx, depth, [subject.id]).reconsider.some(r => r.id === subject.id)) throw new Error('knowledge import requires current source snapshots')
    const review = records.findLast(r => r.kind === 'review' && r.data.target.id === subject.id)
    context = [state.domain, review, ...review.data.evaluations.map(pin => records.find(r => r.id === pin.id))]
    audience = restrictiveAudience(subject.data.audience, state.domain.data.audience)
  } else if (profile === 'inquiry') {
    if (subject.kind !== 'decision' || subject.data.disposition !== 'accepted') throw new Error('inquiry handoff requires an accepted decision')
    const assessment = records.find(r => r.id === subject.data.assessment.id)
    context = [records.find(r => r.id === assessment.data.hypothesis.id), assessment]
    audience = state.campaign.data.audience
  } else {
    if (subject.kind !== 'candidate' || state.candidate?.id !== subject.id || !readiness(records, ctx, depth).readyReported) throw new Error('build handoff requires current accepted candidate and fresh dependencies')
    context = [state.establishment, state.decision, ...state.gates]
    audience = state.establishment.data.audience
  }
  return { state, audience, subject, payload: JSON.stringify({ subject, context, assurance: 'caller-reported; acceptance-is-not-truth-or-authority' }) }
}
function create({ profile, repository, records, subjectId, target }, ctx, depth) {
  const { state, audience, subject, payload } = artifact(profile, records, subjectId, ctx, depth)
  if (profile !== 'inquiry' && state.establishment.data.repository !== repository) throw new Error('handoff repository differs from establishment')
  const repositoryBinding = profile === 'inquiry' ? 'caller-declared' : 'establishment-record'
  return assertHandoff({ schema: 'atelier-harness-handoff@v1', source: { repository, repositoryBinding, profile, run: records[0].id, historyDigest: state.head, subject: harnessRef(subject) }, target, audience, payload, payloadDigest: contentDigest(payload), assurance: 'caller-reported', authority: 'none' })
}
function verify({ handoff, records }, ctx, depth) {
  bounded(depth)
  if (ctx.verificationCalls >= ctx.verificationLimit) { ctx.exhausted = true; throw new Error('harness dependency verification budget exhausted') }
  ctx.verificationCalls++
  assertHandoff(handoff)
  if (!ctx.verified.has(records)) ctx.verified.set(records, new Map())
  const cache = ctx.verified.get(records), key = harnessDigest(handoff), prior = cache.get(key)
  if (prior?.active) throw new Error('harness dependency cycle detected')
  if (prior?.result) return prior.result
  cache.set(key, { active: true })
  try {
    inspect(handoff.source.profile, records, ctx)
    const hash = createHash('sha256').update('[')
    let extendsIssuedHistory = false
    for (let i = 0; i < records.length; i++) {
      if (i) hash.update(',')
      hash.update(canonical(records[i]))
      if (`sha256:${hash.copy().update(']').digest('hex')}` === handoff.source.historyDigest) extendsIssuedHistory = true
    }
    if (!extendsIssuedHistory) throw new Error('handoff source history changed or diverged')
    const current = create({ ...handoff.source, records, subjectId: handoff.source.subject.id, target: handoff.target }, ctx, depth)
    const observedHead = current.source.historyDigest
    current.source.historyDigest = handoff.source.historyDigest
    if (harnessDigest(current) !== harnessDigest(handoff)) throw new Error('handoff is stale or differs from its source history')
    const result = { current: true, historyDigest: observedHead, issuedHistoryDigest: handoff.source.historyDigest, sourceRepositoryBinding: current.source.repositoryBinding, sourceAuthenticity: 'unverified', authority: 'none' }
    cache.set(key, { result })
    return result
  } finally {
    if (cache.get(key)?.active) cache.delete(key)
  }
}
function matching(h, snapshots) {
  return snapshots.filter(s => s.repository === h.source.repository && s.profile === h.source.profile && s.records?.[0]?.id === h.source.run)
}
function knowledgeFreshness(records, ctx, depth, subjects = null) {
  bounded(depth)
  const state = inspect('knowledge', records, ctx), stale = new Map(state.reconsider.map(r => [r.id, r.reasons]))
  const needed = subjects ? new Set(subjects) : null
  if (needed) for (const record of [...records].reverse()) if (needed.has(record.id) && record.kind === 'contribution') for (const item of record.data.basedOn) needed.add(item.contribution.id)
  for (const record of records) {
    if (record.kind !== 'contribution' || record.data.origin.method !== 'exchange' || (needed && !needed.has(record.id))) continue
    const h = record.data.origin.handoff, snapshots = matching(h, ctx.snapshots)
    let reason
    if (snapshots.length !== 1) reason = 'import-source-missing-or-ambiguous'
    else try { verify({ handoff: h, records: snapshots[0].records }, ctx, depth + 1) } catch { reason = ctx.exhausted ? 'import-source-verification-budget-exhausted' : 'import-source-requires-reconsideration' }
    if (reason) stale.set(record.id, [...(stale.get(record.id) ?? []), reason])
  }
  // References always point backwards, so one history-order pass propagates
  // changes discovered in external inputs through local meaning and activation.
  for (const record of records) {
    const d = record.data
    const refs = record.kind === 'contribution' ? [d.domain, ...d.basedOn.map(e => e.contribution)]
      : record.kind === 'evaluation' ? [d.contribution]
      : record.kind === 'relation' ? [d.domain, d.subject, d.object]
      : record.kind === 'review' ? [d.target, ...d.evaluations]
      : record.kind === 'activation' ? d.reviews : []
    const reasons = refs.flatMap(pin => stale.get(pin.id) ?? [])
    if (reasons.length) stale.set(record.id, [...new Set([...(stale.get(record.id) ?? []), ...reasons])])
  }
  return { historyDigest: state.head, reconsider: [...stale].map(([id, reasons]) => ({ id, reasons })), freshness: 'relative-to-explicit-snapshots', canonicalMutation: false }
}
function readiness(records, ctx, depth) {
  bounded(depth)
  const state = inspect('build', records, ctx), blockers = []
  if (!state.candidate) blockers.push('candidate-missing')
  if (!state.reportedAccepted) blockers.push('current-accepted-decision-missing')
  for (const [id, a] of Object.entries(state.attempts)) if (a.candidate === state.candidate?.id && !['completed', 'failed', 'cancelled'].includes(a.state)) blockers.push(`attempt-unsettled:${id}`)
  for (const dependency of state.establishment?.data.dependencies ?? []) {
    const h = dependency.handoff
    const snapshots = matching(h, ctx.snapshots)
    if (snapshots.length !== 1) { blockers.push(`dependency-missing-or-ambiguous:${dependency.id}`); continue }
    try { verify({ handoff: h, records: snapshots[0].records }, ctx, depth + 1) } catch { blockers.push(`${ctx.exhausted ? 'dependency-verification-budget-exhausted' : 'dependency-requires-reconsideration'}:${dependency.id}`) }
  }
  return { candidate: state.candidate, readyReported: blockers.length === 0, blockers, historyDigest: state.head,
    dependencyFreshness: 'relative-to-explicit-snapshots; no-live-observation', authenticatedAcceptance: false, executionAuthorized: false }
}
export function createHarnessHandoff(options) { return create(options, context(options.dependencySnapshots, options.verificationLimit), 0) }
export function verifyHarnessHandoff(options) {
  const ctx = context(options.dependencySnapshots, options.verificationLimit)
  return { ...verify(options, ctx, 0), dependencyWork: work(ctx) }
}
export function buildReadiness(records, { dependencySnapshots, verificationLimit } = {}) {
  const ctx = context(dependencySnapshots, verificationLimit)
  return { ...readiness(records, ctx, 0), dependencyWork: work(ctx) }
}
export function reconcileKnowledge(records, { dependencySnapshots, verificationLimit } = {}) {
  const ctx = context(dependencySnapshots, verificationLimit)
  return { ...knowledgeFreshness(records, ctx, 0), dependencyWork: work(ctx) }
}

// A read-only projection that a Fabric adapter or another coordinator can read.
// It imports no private registry, creates no tasks and grants no dispatch power.
export function buildCoordinationProposal(records, options = {}) {
  const state = inspectBuild(records), readiness = buildReadiness(records, options)
  return { schema: 'atelier-build-coordination-proposal@v1', outcome: state.establishment?.data.purpose ?? null,
    owner: state.establishment?.data.owner ?? null, candidate: state.candidate?.data ?? null,
    dependencies: state.establishment?.data.dependencies ?? [], gates: state.gates.map(r => ({ id: r.data.gate, status: r.data.status, evidence: r.data.evidence, record: harnessRef(r) })),
    ...readiness, reconsider: state.reconsider, acceptedByCoordinator: false }
}
