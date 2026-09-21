import { inspectKnowledge } from './ledger.mjs'
import { harnessDigest, harnessRef, restrictiveAudience } from '../harnesses/contracts.mjs'
import { reconcileKnowledge } from '../harnesses/exchange.mjs'
export function knowledgeGraphProposal(records, { namespace, activationId, dependencySnapshots = [] }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace ?? '')) throw new Error('invalid graph namespace')
  const state = inspectKnowledge(records), byId = new Map(records.map(r => [r.id, r]))
  const activation = byId.get(activationId)
  const reconciliation = reconcileKnowledge(records, { dependencySnapshots })
  if (activation?.kind !== 'activation' || reconciliation.reconsider.some(r => r.id === activationId)) throw new Error('graph proposal requires a current activation record and input snapshots')
  const accepted = new Set(state.accepted), selected = new Map(), claims = []
  function include(id) {
    if (selected.has(id)) return
    if (!accepted.has(id)) throw new Error('graph dependency lacks current acceptance')
    const r = byId.get(id); selected.set(id, r)
    if (r.kind === 'relation') { include(r.data.subject.id); include(r.data.object.id) }
    else for (const pin of r.data.basedOn) include(pin.contribution.id)
  }
  for (const pin of activation.data.reviews) include(byId.get(pin.id).data.target.id)
  const node = id => `${namespace}:knowledge-${state.establishment.id}-${id}`
  function edge(subject, predicate, object, supportingRecords = []) {
    const claim = { schema: 'atelier-claim@v1', claimId: `claim:knowledge-${harnessDigest([node(subject), predicate, node(object)]).slice(7)}`, subject: node(subject), predicate, object: node(object), provider: 'script', status: 'proposed', promoted: false, evidence: [harnessDigest(byId.get(subject)), harnessDigest(byId.get(object))] }
    const existing = claims.find(c => c.claimId === claim.claimId)
    if (!existing) claims.push(claim)
    const selectedClaim = existing ?? claim
    selectedClaim.evidence = [...new Set([...selectedClaim.evidence, ...supportingRecords.map(harnessDigest)])]
    return selectedClaim.claimId
  }
  const files = []
  for (const record of selected.values()) {
    const d = record.data, domain = byId.get(d.domain.id)
    const review = records.findLast(r => r.kind === 'review' && r.data.target.id === record.id)
    let title = d.title, audience = record.kind === 'contribution' ? restrictiveAudience(d.audience, domain.data.audience) : domain.data.audience, evidence = { contribution: record }
    if (record.kind === 'relation') {
      const claimId = edge(d.subject.id, domain.data.vocabulary.relations.find(r => r.id === d.predicate).graphPredicate, d.object.id, [record, review])
      title = `Relation: ${d.predicate}`; audience = domain.data.audience
      evidence = { relation: record, claimId }
    } else for (const pin of d.basedOn) edge(pin.contribution.id, 'evidences', record.id)
    const text = JSON.stringify({ ...evidence, domain, record: harnessRef(record), review, evaluations: review.data.evaluations.map(pin => byId.get(pin.id)), activation: harnessRef(activation), semanticTruthVerified: false }, null, 2)
    const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)))
    files.push({ path: `${record.id}.md`, content: ['---', `title: ${JSON.stringify(title)}`, 'kg:', `  id: ${JSON.stringify(node(record.id))}`, '  type: "document"', '  status: "draft"', `  audience: ${JSON.stringify(audience)}`, '  relations: {}', '---', '', 'Proposed knowledge source. Review the destination and admission before applying.', '', `${fence}text`, text, fence, ''].join('\n') })
  }
  return { schema: 'atelier-knowledge-graph-proposal@v1', historyDigest: state.head, activation: harnessRef(activation), purpose: activation.data.purpose, questions: activation.data.questions, files, claims, reconsider: reconciliation.reconsider, canonicalMutation: false, authority: 'none' }
}
