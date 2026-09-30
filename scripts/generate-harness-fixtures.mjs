import fs from 'node:fs'
import { harnessRef as pin, harnessDigest, contentDigest, createHarnessHandoff, inspectHarness } from '../src/harnesses/index.mjs'
import { prepareKnowledgeImport } from '../src/knowledge/index.mjs'
const at = '2026-01-01T00:00:00Z', by = 'synthetic-owner'
const make = (profile, run) => (id, kind, data) => ({ schema: `atelier-${profile}-record@v1`, id, run, at, by, kind, data })
const k = make('knowledge', 'workshop-knowledge')
const domain = k('workshop-knowledge', 'domain', { repository: 'workshop-notes', purpose: 'Synthetic learning-cycle demonstration.', scope: 'Invented workshop visitors', owner: by, audience: 'private', questions: [{ id: 'return', question: 'What justifies a reversible reminder trial?', acceptance: 'A reviewed rationale traces to a source and its limitations.' }], vocabulary: { types: [{ id: 'material', meaning: 'A source or interpreted contribution.' }], relations: [{ id: 'justifies', meaning: 'A limited evidential relationship.', graphPredicate: 'supports' }] }, identityRules: 'Keep distinct observations distinct; propose matches for review.', sourcePolicy: 'Invented material only; retain original bytes and provenance.', acceptancePolicy: 'A simulated owner reviews each contribution after evaluation.' })
const body = 'Synthetic observation: three of five fictional visitors noticed the reminder.'
const source = k('observation', 'contribution', { domain: pin(domain), category: 'source', term: 'material', title: 'Invented observation', body, audience: 'private', scope: domain.data.scope, origin: { method: 'captured', locator: 'synthetic:observation', contentDigest: contentDigest(body), rightsBasis: 'Invented fixture.' }, basedOn: [] })
const evaluate = (record, id) => k(`${id}-evaluation`, 'evaluation', { contribution: pin(record), judgment: 'uncertain', rationale: 'Retained for this synthetic scenario only.', limitations: ['Invented evidence; no empirical or calibrated inference.'], scope: domain.data.scope })
const review = (record, evaluation, id) => k(`${id}-review`, 'review', { target: pin(record), disposition: 'accepted', basis: 'Simulated owner acceptance for a disposable example.', evaluations: evaluation ? [pin(evaluation)] : [] })
const sourceEvaluation = evaluate(source, 'source'), sourceReview = review(source, sourceEvaluation, 'source')
const claim = k('trial-rationale', 'contribution', { domain: pin(domain), category: 'decision-rationale', term: 'material', title: 'Reversible trial rationale', body: 'A small follow-up trial may test whether notice leads to return visits.', audience: 'private', scope: domain.data.scope, origin: { method: 'authored', reason: 'Synthetic interpretation of limited evidence.' }, basedOn: [{ contribution: pin(source), quote: body }] })
const claimEvaluation = evaluate(claim, 'claim'), claimReview = review(claim, claimEvaluation, 'claim')
const relation = k('justification', 'relation', { domain: pin(domain), subject: pin(source), predicate: 'justifies', object: pin(claim), rationale: 'The observation motivates a test; it does not prove the outcome.' })
const relationReview = review(relation, null, 'relation')
const activation = k('graph-use', 'activation', { reviews: [pin(claimReview), pin(relationReview)], purpose: 'Prepare a graph-backed trial decision.', destination: 'synthetic workspace', questions: ['return'] })
const knowledge = [domain, source, sourceEvaluation, sourceReview, claim, claimEvaluation, claimReview, relation, relationReview, activation]
const handoff = createHarnessHandoff({ profile: 'knowledge', repository: domain.data.repository, records: knowledge, subjectId: claim.id, target: { repository: 'workshop-product', profile: 'build', purpose: 'Implement a disposable reminder prototype.' } })
const b = make('build', 'reminder-build')
const objective = b('reminder-build', 'objective', { repository: 'workshop-product', owner: by, purpose: 'Build a synthetic reminder prototype.', scope: 'Disposable local example only.', audience: 'private', acceptance: ['The prototype is a retained file with explicit synthetic verification.'], gates: [{ id: 'tests', kind: 'source', required: true }, { id: 'review', kind: 'review', required: true }, { id: 'ci', kind: 'ci', required: true }], dependencies: [{ id: 'rationale', need: 'Current accepted trial rationale.', handoff }], allowedEffects: ['read-workspace', 'write-workspace', 'execute-local'], maxAttempts: 3, stoppingRule: 'Stop on stale evidence, unsettled execution or failed required gates.' })
const candidate = b('prototype', 'candidate', { objective: pin(objective), repository: objective.data.repository, commit: '1'.repeat(40), tree: '2'.repeat(40), artifactDigest: contentDigest('synthetic prototype bytes'), writer: { owner: by, reservation: 'disposable-writer', evidenceDigest: contentDigest('synthetic writer declaration') } })
const attempt = b('test-attempt', 'attempt', { candidate: pin(candidate), operation: 'test', requestDigest: contentDigest('synthetic test request'), effects: ['execute-local'] })
const uncertain = b('test-uncertain', 'progress', { attempt: pin(attempt), state: 'uncertain', evidenceDigest: contentDigest('synthetic interruption'), reason: 'Simulated uncertain transport; do not replay.' })
const completed = b('test-completion', 'progress', { attempt: pin(attempt), state: 'completed', evidenceDigest: contentDigest('synthetic completion'), reason: 'Simulated reconciliation against the same attempt.' })
const gates = objective.data.gates.map(g => b(`${g.id}-gate`, 'gate', { candidate: pin(candidate), gate: g.id, status: 'passed', evidence: { digest: contentDigest(`simulated ${g.id}`), locator: `synthetic:${g.id}`, verifier: 'synthetic-fixture' }, ...(g.id === 'tests' ? { attempt: pin(attempt) } : {}) }))
const decision = b('candidate-review', 'decision', { candidate: pin(candidate), disposition: 'accepted', reason: 'Simulated acceptance for contract testing only.', gates: gates.map(pin) })
const delivery = b('delivery-report', 'delivery', { decision: pin(decision), recipient: 'synthetic-recipient', evidenceDigest: contentDigest('synthetic delivery'), acceptance: 'Simulated recipient acceptance; no external delivery occurred.' })
const build = [objective, candidate, attempt, uncertain, completed, ...gates, decision, delivery]
const dependencySnapshots = [{ repository: domain.data.repository, profile: 'knowledge', records: knowledge }]
const buildHandoff = createHarnessHandoff({ profile: 'build', repository: objective.data.repository, records: build, subjectId: candidate.id, target: { repository: 'workshop-notes', profile: 'knowledge', purpose: 'Retain implementation learning with its original evidence.' }, dependencySnapshots })
const l = make('knowledge', 'workshop-lessons')
const lessonDomain = l('workshop-lessons', 'domain', structuredClone(domain.data))
const lessonData = prepareKnowledgeImport({ records: [lessonDomain], handoff: buildHandoff, sourceRecords: build, title: 'Synthetic build learning', term: 'material', category: 'observation', dependencySnapshots }).data
const lesson = l('build-observation', 'contribution', lessonData)
const lessonEvaluation = l('lesson-evaluation', 'evaluation', { contribution: pin(lesson), judgment: 'uncertain', rationale: 'Reported test success is distinct from usefulness.', limitations: ['Simulated evidence only.'], scope: lessonDomain.data.scope })
const lessonReview = l('lesson-review', 'review', { target: pin(lesson), disposition: 'accepted', basis: 'Simulated curation of a build observation.', evaluations: [pin(lessonEvaluation)] })
const lessonActivation = l('lesson-use', 'activation', { reviews: [pin(lessonReview)], purpose: 'Prepare a lesson for another inquiry.', destination: 'synthetic workspace', questions: ['return'] })
const lessons = [lessonDomain, lesson, lessonEvaluation, lessonReview, lessonActivation]
const withdrawal = k('source-withdrawal', 'withdrawal', { target: pin(source), reason: 'Synthetic correction: the observation cannot be relied on.' })
const domainRevision = k('domain-next', 'domain-revision', { ...structuredClone(domain.data), supersedes: pin(domain), migration: 'Synthetic vocabulary revision requires reevaluation of dependent knowledge.' })
const example = { warning: 'Invented fixtures and simulated approvals; no research, CI or delivery ran.', knowledge, build, lessons, withdrawal, domainRevision, handoff, buildHandoff }
fs.mkdirSync(new URL('../fixtures/harnesses/', import.meta.url), { recursive: true })
fs.writeFileSync(new URL('../fixtures/harnesses/learning-cycle.json', import.meta.url), JSON.stringify(example, null, 2) + '\n')
for (const [profile, records] of Object.entries({ knowledge: [...knowledge, withdrawal, domainRevision], build })) {
  const docs = new Map(records.map(r => [r.kind, r]))
  docs.set('ledger', { schema: 'atelier-harness-ledger@v1', profile, records, head: inspectHarness(profile, records).head })
  for (const [shape, value] of docs) write(profile, shape, value)
}
write('harness', 'handoff', handoff)
function write(profile, shape, value) {
  for (const valid of [true, false]) {
    const dir = new URL(`../fixtures/atelier-${profile}-contract/${shape}/${valid ? 'valid' : 'invalid'}/`, import.meta.url)
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(new URL('document.json', dir), JSON.stringify(valid ? value : { ...value, authorityGranted: true }, null, 2) + '\n')
  }
}
