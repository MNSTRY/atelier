import { inspectInquiry } from '../inquiry/index.mjs'
import { inspectKnowledge } from '../knowledge/ledger.mjs'
import { inspectBuild } from '../build/ledger.mjs'
import { assertHandoff, contentDigest, harnessDigest, harnessRef } from './contracts.mjs'
import { canonical } from '../capabilities/files.mjs'
import { createHash } from 'node:crypto'

export function inspectHarness(profile, records) {
  if (profile === 'inquiry') return inspectInquiry(records)
  if (profile === 'knowledge') return inspectKnowledge(records)
  if (profile === 'build') return inspectBuild(records)
  throw new Error('unknown harness profile')
}
function artifact(profile, records, subjectId, dependencySnapshots, depth) {
  if (depth > 12) throw new Error('harness dependency depth exceeded')
  const state = inspectHarness(profile, records), subject = records.find(r => r.id === subjectId)
  if (!subject || state.reconsider.some(r => r.id === subjectId)) throw new Error('handoff subject is missing or requires reconsideration')
  let audience, context
  if (profile === 'knowledge') {
    if (subject.kind !== 'contribution' || !state.accepted.includes(subject.id)) throw new Error('knowledge handoff requires an accepted contribution')
    if (knowledgeFreshness(records, dependencySnapshots, depth, [subject.id]).reconsider.some(r => r.id === subject.id)) throw new Error('knowledge import requires current source snapshots')
    const review = records.findLast(r => r.kind === 'review' && r.data.target.id === subject.id)
    context = [state.domain, review, ...review.data.evaluations.map(pin => records.find(r => r.id === pin.id))]
    audience = subject.data.audience
  } else if (profile === 'inquiry') {
    if (subject.kind !== 'decision' || subject.data.disposition !== 'accepted') throw new Error('inquiry handoff requires an accepted decision')
    const assessment = records.find(r => r.id === subject.data.assessment.id)
    context = [records.find(r => r.id === assessment.data.hypothesis.id), assessment]
    audience = state.campaign.data.audience
  } else {
    if (subject.kind !== 'candidate' || state.candidate?.id !== subject.id || !readiness(records, dependencySnapshots, depth).readyReported) throw new Error('build handoff requires current accepted candidate and fresh dependencies')
    context = [state.establishment, state.decision, ...state.gates]
    audience = state.establishment.data.audience
  }
  return { state, audience, subject, payload: JSON.stringify({ subject, context, assurance: 'caller-reported; acceptance-is-not-truth-or-authority' }) }
}
function create({ profile, repository, records, subjectId, target, dependencySnapshots = [] }, depth) {
  const { state, audience, subject, payload } = artifact(profile, records, subjectId, dependencySnapshots, depth)
  if (profile !== 'inquiry' && state.establishment.data.repository !== repository) throw new Error('handoff repository differs from establishment')
  return assertHandoff({ schema: 'atelier-harness-handoff@v1', source: { repository, profile, run: records[0].id, historyDigest: state.head, subject: harnessRef(subject) }, target, audience, payload, payloadDigest: contentDigest(payload), assurance: 'caller-reported', authority: 'none' })
}
function verify({ handoff, records, dependencySnapshots = [] }, depth) {
  assertHandoff(handoff)
  inspectHarness(handoff.source.profile, records)
  const hash = createHash('sha256').update('[')
  let extendsIssuedHistory = false
  for (let i = 0; i < records.length; i++) {
    if (i) hash.update(',')
    hash.update(canonical(records[i]))
    if (`sha256:${hash.copy().update(']').digest('hex')}` === handoff.source.historyDigest) extendsIssuedHistory = true
  }
  if (!extendsIssuedHistory) throw new Error('handoff source history changed or diverged')
  const current = create({ ...handoff.source, records, subjectId: handoff.source.subject.id, target: handoff.target, dependencySnapshots }, depth + 1)
  const observedHead = current.source.historyDigest
  current.source.historyDigest = handoff.source.historyDigest
  if (harnessDigest(current) !== harnessDigest(handoff)) throw new Error('handoff is stale or differs from its source history')
  return { current: true, historyDigest: observedHead, issuedHistoryDigest: handoff.source.historyDigest, sourceAuthenticity: 'unverified', authority: 'none' }
}
function matching(h, snapshots) {
  return snapshots.filter(s => s.repository === h.source.repository && s.profile === h.source.profile && s.records?.[0]?.id === h.source.run)
}
function knowledgeFreshness(records, dependencySnapshots, depth, subjects = null) {
  if (depth > 12 || !Array.isArray(dependencySnapshots) || dependencySnapshots.length > 64) throw new Error('harness dependency bounds exceeded')
  const state = inspectKnowledge(records), stale = new Map(state.reconsider.map(r => [r.id, r.reasons]))
  const needed = subjects ? new Set(subjects) : null
  if (needed) for (const record of [...records].reverse()) if (needed.has(record.id) && record.kind === 'contribution') for (const item of record.data.basedOn) needed.add(item.contribution.id)
  for (const record of records) {
    if (record.kind !== 'contribution' || record.data.origin.method !== 'exchange' || (needed && !needed.has(record.id))) continue
    const h = record.data.origin.handoff, snapshots = matching(h, dependencySnapshots)
    let reason
    if (snapshots.length !== 1) reason = 'import-source-missing-or-ambiguous'
    else try { verify({ handoff: h, records: snapshots[0].records, dependencySnapshots }, depth + 1) } catch { reason = 'import-source-requires-reconsideration' }
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
function readiness(records, dependencySnapshots, depth) {
  if (depth > 12) throw new Error('harness dependency depth exceeded')
  if (!Array.isArray(dependencySnapshots) || dependencySnapshots.length > 64) throw new Error('dependency snapshot ceiling exceeded')
  const state = inspectBuild(records), blockers = []
  if (!state.candidate) blockers.push('candidate-missing')
  if (!state.reportedAccepted) blockers.push('current-accepted-decision-missing')
  for (const [id, a] of Object.entries(state.attempts)) if (a.candidate === state.candidate?.id && !['completed', 'failed', 'cancelled'].includes(a.state)) blockers.push(`attempt-unsettled:${id}`)
  for (const dependency of state.establishment?.data.dependencies ?? []) {
    const h = dependency.handoff
    const snapshots = matching(h, dependencySnapshots)
    if (snapshots.length !== 1) { blockers.push(`dependency-missing-or-ambiguous:${dependency.id}`); continue }
    try { verify({ handoff: h, records: snapshots[0].records, dependencySnapshots }, depth + 1) } catch { blockers.push(`dependency-requires-reconsideration:${dependency.id}`) }
  }
  return { candidate: state.candidate, readyReported: blockers.length === 0, blockers, historyDigest: state.head,
    dependencyFreshness: 'relative-to-explicit-snapshots; no-live-observation', authenticatedAcceptance: false, executionAuthorized: false }
}
export const createHarnessHandoff = options => create(options, 0)
export const verifyHarnessHandoff = options => verify(options, 0)
export const buildReadiness = (records, { dependencySnapshots = [] } = {}) => readiness(records, dependencySnapshots, 0)
export const reconcileKnowledge = (records, { dependencySnapshots = [] } = {}) => knowledgeFreshness(records, dependencySnapshots, 0)

// A read-only projection that a Fabric adapter or another coordinator can read.
// It imports no private registry, creates no tasks and grants no dispatch power.
export function buildCoordinationProposal(records, options = {}) {
  const state = inspectBuild(records), readiness = buildReadiness(records, options)
  return { schema: 'atelier-build-coordination-proposal@v1', outcome: state.establishment?.data.purpose ?? null,
    owner: state.establishment?.data.owner ?? null, candidate: state.candidate?.data ?? null,
    dependencies: state.establishment?.data.dependencies ?? [], gates: state.gates.map(r => ({ id: r.data.gate, status: r.data.status, evidence: r.data.evidence, record: harnessRef(r) })),
    ...readiness, reconsider: state.reconsider, acceptedByCoordinator: false }
}
