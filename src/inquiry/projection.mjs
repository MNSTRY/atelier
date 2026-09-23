import { assertDocument } from '../capabilities/package.mjs'
import { inquiryDigest, inquiryRef } from './contracts.mjs'
import { inspectInquiry } from './ledger.mjs'

// Files are proposed source edits. No graph source, relation, or review status
// is written by this function. The receiver owns disclosure and promotion.
export function inquiryGraphProposal(records, { namespace }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace)) throw new Error('invalid inquiry graph namespace')
  const state = inspectInquiry(records), stale = new Set(state.reconsider.map(r => r.id))
  const byId = new Map(records.map(r => [r.id, r])), files = new Map(), claims = []
  const node = r => `${namespace}:inquiry-${state.campaign.id}-${r.id}`
  const literal = value => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)))
    return `${fence}text\n${text}\n${fence}`
  }
  function add(record, body) {
    const id = node(record)
    if (files.has(id)) return
    files.set(id, { path: `${record.id}.md`, content: [
      '---', `title: ${JSON.stringify(`Inquiry ${record.kind}: ${record.id}`)}`, 'kg:', `  id: ${JSON.stringify(id)}`, '  type: "document"',
      '  status: "draft"', `  audience: ${JSON.stringify(state.campaign.data.audience)}`, '  relations: {}', '---', '',
      `# Inquiry ${record.kind}: ${record.id}`, '', `Record digest: ${inquiryDigest(record)}`, '',
      'Proposed source. Review and admission belong to the receiving repository. Caller-reported evidence is not authenticated.', '', literal(body), '',
    ].join('\n') })
  }
  function edge(subject, predicate, object) {
    const claim = { schema: 'atelier-claim@v1', claimId: `claim:inquiry-${inquiryDigest([node(subject), predicate, node(object)]).slice(7)}`, subject: node(subject), predicate, object: node(object), provider: 'script', status: 'proposed', promoted: false, evidence: [inquiryDigest(subject), inquiryDigest(object)] }
    if (!claims.some(c => c.claimId === claim.claimId)) claims.push(claim)
  }
  for (const decision of records.filter(r => r.kind === 'decision' && r.data.disposition === 'accepted' && !stale.has(r.id))) {
    const assessment = byId.get(decision.data.assessment.id), hypothesis = byId.get(assessment.data.hypothesis.id)
    add(decision, { conclusion: decision.data.conclusion, reason: decision.data.reason, reviewerReport: { by: decision.by, at: decision.at, basis: decision.data.reviewBasis }, nextQuestions: decision.data.nextQuestions })
    add(assessment, { model: assessment.data.model, result: state.assessments[assessment.id], rationale: assessment.data.rationale,
      evidence: assessment.data.evidence.map(item => {
        const bundle = byId.get(item.bundle.id)
        return { bundle: item.bundle, request: bundle.data.request, provider: bundle.data.provider,
          assertion: bundle.data.assertions.find(a => a.id === item.assertion), conflicts: bundle.data.conflicts, gaps: bundle.data.gaps, newQuestions: bundle.data.newQuestions }
      }) })
    add(hypothesis, hypothesis.data)
    edge(decision, 'depends_on', assessment); edge(assessment, 'related', hypothesis)
    for (const item of assessment.data.evidence) {
      const bundle = byId.get(item.bundle.id), assertion = bundle.data.assertions.find(a => a.id === item.assertion), source = byId.get(assertion.source.id)
      // Preserve selected statements, provenance and conflicts, without copying
      // raw captures or unrelated assertions into accepted knowledge proposals.
      add(source, { locator: source.data.locator, digest: source.data.digest, family: source.data.family, scope: source.data.scope, method: source.data.method })
      edge(source, 'evidences', assessment)
      edge(source, assertion.stance === 'neutral' ? 'related' : assertion.stance, hypothesis)
    }
  }
  return { schema: 'atelier-inquiry-graph-proposal@v1', campaign: state.campaign?.id ?? null, historyDigest: state.head, audience: state.campaign?.data.audience ?? null, files: [...files.values()], claims, reconsider: state.reconsider, canonicalMutation: false, authority: 'none' }
}

export function inquiryStewardObservation(records, feedbackId) {
  inspectInquiry(records)
  const feedback = records.find(r => r.id === feedbackId && r.kind === 'feedback')
  if (!feedback) throw new Error('inquiry feedback missing')
  const request = records.find(r => r.id === feedback.data.request.id), binding = request.data.binding
  if (!binding) throw new Error('request has no capability binding provenance')
  const reportedCause = feedback.data.cause
  const cause = ['context', 'provider'].includes(reportedCause) ? 'unknown' : reportedCause
  const event = { schema: 'mnstry.atelier-capability-event@v1', id: feedback.id, kind: 'feedback', ...binding, observer: feedback.by, outcome: feedback.data.outcome, cause, evidenceDigest: feedback.data.evidenceDigest, at: feedback.at }
  assertDocument(event, 'event')
  return { event, inquiryRecord: inquiryRef(feedback), reportedCause, causeMapping: cause === reportedCause ? 'exact' : 'unsupported-steward-cause-preserved-in-inquiry', assurance: 'caller-reported; current binding must be checked by capability observe', recorded: false }
}
