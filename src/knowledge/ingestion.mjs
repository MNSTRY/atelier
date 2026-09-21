import { createIngestionStore } from '../ingestion/store.mjs'
import { createIntakeStore } from '../intake/store.mjs'
import { boundedLearningValue, learningDigest } from '../learning/contracts.mjs'
import { harnessRef } from '../harnesses/contracts.mjs'
import { prepareIntakeContribution } from './intake.mjs'
import { inspectKnowledge } from './ledger.mjs'
import { reconcileKnowledge } from '../harnesses/exchange.mjs'
import { knowledgeGraphProposal } from './projection.mjs'

function selectedSource({ workspaceRoot, workspaceId, planId, planDigest, sourceId }) {
  const status = createIngestionStore({ workspaceRoot, workspaceId }).status({ planId, planDigest })
  const item = status.items.find(item => item.id === sourceId)
  if (!item || item.status !== 'complete' || item.integrity !== 'verified') throw new Error('completed verified ingestion source required')
  createIntakeStore({ workspaceRoot }).readSource({ ref: item.ref, expectedDigest: item.sourceDigest })
  return { item, scope: status.plan.scope }
}
export function prepareIngestionContribution(options) {
  const { item, scope } = selectedSource(options)
  const prepared = prepareIntakeContribution({ ...options, attemptId: item.attemptId })
  return { ...prepared, sourceBinding: { schema: 'atelier-ingestion-knowledge-binding@v1', workspaceId: options.workspaceId,
    planId: options.planId, planDigest: options.planDigest, sourceId: options.sourceId, scope,
    ref: item.ref, sourceDigest: item.sourceDigest, attemptId: item.attemptId, contributionDataDigest: learningDigest(prepared.data) } }
}
// This read model adds live local-source checks to the existing domain reducer.
// It does not mutate history, adopt graph sources or silently recapture a file.
export function localKnowledgeContext({ workspaceRoot, workspaceId, records, sourceBindings = [], query, dependencySnapshots = [] }) {
  boundedLearningValue(sourceBindings)
  if (!Array.isArray(sourceBindings) || sourceBindings.length > 256 || typeof query !== 'string' || !query.trim() || query.length > 512) throw new Error('bounded source bindings and query required')
  const state = inspectKnowledge(records), current = reconcileKnowledge(records, { dependencySnapshots })
  const stale = new Map(current.reconsider.map(item => [item.id, [...item.reasons]]))
  const diagnostics = []
  for (const record of records) {
    if (record.kind !== 'contribution' || record.data.origin.method !== 'extracted') continue
    const matches = sourceBindings.filter(binding => binding.contributionDataDigest === learningDigest(record.data))
    let reason = null
    if (matches.length !== 1) reason = 'source-binding-missing-or-ambiguous'
    else {
      const binding = matches[0]
      try {
        const fields = ['schema', 'workspaceId', 'planId', 'planDigest', 'sourceId', 'scope', 'ref', 'sourceDigest', 'attemptId', 'contributionDataDigest']
        if (Object.keys(binding).sort().join() !== fields.sort().join() || binding.schema !== 'atelier-ingestion-knowledge-binding@v1' || binding.workspaceId !== workspaceId) throw new Error('wrong source binding')
        const { item, scope } = selectedSource({ workspaceRoot, workspaceId, planId: binding.planId, planDigest: binding.planDigest, sourceId: binding.sourceId })
        if (item.ref !== binding.ref || item.sourceDigest !== binding.sourceDigest || item.attemptId !== binding.attemptId ||
          item.attemptId !== record.data.origin.attemptId || learningDigest(scope) !== learningDigest(binding.scope)) throw new Error('source binding differs')
        const prepared = prepareIntakeContribution({ workspaceRoot, records, attemptId: item.attemptId, title: record.data.title, term: record.data.term })
        // A revised contribution may have history metadata, but its captured
        // content and extractor provenance must still match the actual receipt.
        if (learningDigest(prepared.data.origin) !== learningDigest(record.data.origin) || prepared.data.body !== record.data.body) throw new Error('captured evidence differs')
      } catch { reason = 'local-source-stale-or-unverified' }
    }
    if (reason) { stale.set(record.id, [...(stale.get(record.id) ?? []), reason]); diagnostics.push({ id: record.id, reason }) }
  }
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
  const terms = query.toLowerCase().trim().split(/\s+/u)
  const accepted = new Set(state.accepted), active = new Set()
  for (const record of records) if (record.kind === 'activation' && !stale.has(record.id)) {
    for (const review of record.data.reviews) active.add(records.find(r => r.id === review.id).data.target.id)
  }
  const hits = records.filter(record => record.kind === 'contribution' && accepted.has(record.id) && active.has(record.id) && !stale.has(record.id) &&
    terms.every(term => `${record.data.title}\n${record.data.body}`.toLowerCase().includes(term)))
    .map(record => ({ reference: harnessRef(record), title: record.data.title, body: record.data.body, origin: structuredClone(record.data.origin), audience: record.data.audience }))
  return { schema: 'atelier-local-knowledge-context@v1', historyDigest: state.head, hits,
    reconsider: [...stale].map(([id, reasons]) => ({ id, reasons })), diagnostics,
    freshness: 'local-sources-and-explicit-dependency-snapshots', synthesized: false, canonicalMutation: false }
}
export function localKnowledgeGraphProposal(options) {
  const context = localKnowledgeContext({ ...options, query: options.query ?? 'graph' })
  if (context.reconsider.some(item => item.id === options.activationId)) throw new Error('graph activation requires current local sources')
  return knowledgeGraphProposal(options.records, options)
}
