import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ingestionDigest } from '../src/ingestion/contracts.mjs'
import { createIngestionStore } from '../src/ingestion/store.mjs'
import { SEMANTIC_CANDIDATE_VERSION, SemanticProposalError, prepareSemanticInput, prepareSemanticProposals, readSemanticProposals } from '../src/ingestion/semantic.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/atelier-ingestion/semantic-baseline.json', import.meta.url)))
const clone = value => structuredClone(value)
function reference(line) { return { sourceId: 'notes', sourceDigest: 'a'.repeat(64), attemptId: 'lines-attempt', locator: { kind: 'line', value: String(line) } } }
function sample() {
  const plan = { planId: 'plan-synthetic', planDigest: `sha256:${'b'.repeat(64)}` }
  const lines = fixture.sourceText.trimEnd().split('\n')
  const store = { getEvidence: request => ({ schema: 'mnstry.atelier-ingestion-evidence@v1', ...clone(request), ref: 'notes.txt', text: lines[Number(request.locator.value) - 1], freshness: 'current', integrity: 'verified', readScope: 'all-plan', semanticAcceptance: 'pending', synthesized: false }) }
  const input = prepareSemanticInput({ store, plan, domain: clone(fixture.domain), references: [1, 2, 3, 4].map(reference), identityCandidates: [] })
  const e = line => `span-${line}`
  const candidates = { schema: SEMANTIC_CANDIDATE_VERSION, inputDigest: input.digest,
    entities: [
      { id: 'nora', label: 'Nora', type: 'person', identity: { status: 'source-local', candidateIds: [] }, evidence: [e(1)] },
      { id: 'atlas-project', label: 'Atlas', type: 'project', identity: { status: 'source-local', candidateIds: [] }, evidence: [e(1)] },
      { id: 'atlas-organization', label: 'Atlas', type: 'organization', identity: { status: 'source-local', candidateIds: [] }, evidence: [e(3)] },
    ], assertions: [
      { id: 'management', subjectId: 'nora', predicate: 'manages', objectId: 'atlas-project', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: fixture.domain.data.scope,
        time: { from: null, until: null, expression: 'through June', unknowns: ['year'] }, evidence: [{ id: e(1), quote: lines[0] }] },
      { id: 'nonownership', subjectId: 'nora', predicate: 'owns', objectId: 'atlas-project', direction: 'subject-to-object', negated: true, modality: 'asserted', scope: fixture.domain.data.scope,
        time: { from: null, until: null, expression: null, unknowns: [] }, evidence: [{ id: e(2), quote: lines[1] }] },
      { id: 'funding', subjectId: 'atlas-organization', predicate: 'funds', objectId: 'nora', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: fixture.domain.data.scope,
        time: { from: null, until: null, expression: null, unknowns: [] }, evidence: [{ id: e(3), quote: lines[2] }] },
    ], unknowns: [{ id: 'unknown-role', relatedCandidateId: null, reason: 'Role meaning is not supplied.', evidence: [e(4)] }] }
  return { store, plan, input, candidates }
}
function refuses(change, code) {
  const s = sample(); change(s)
  assert.throws(() => prepareSemanticProposals(s), error => error instanceof SemanticProposalError && error.code === code && error.refusalCount === 1)
}
test('semantic proposals retain duplicate labels, directed parallel assertions, polarity, scope, partial time, and unknowns', () => {
  const s = sample(), before = clone(s.candidates)
  const p = prepareSemanticProposals(s)
  assert.equal(p.entities.filter(e => e.label === 'Atlas').length, 2)
  assert.equal(p.assertions[1].negated, true)
  assert.equal(p.assertions[2].subjectId, 'atlas-organization')
  assert.deepEqual(p.assertions[0].time.unknowns, ['year'])
  assert.equal(p.unknowns.length, 1); assert.equal(p.counts.abstentions, 1); assert.equal(p.counts.refusals, 0)
  assert.equal(p.authority, 'none'); assert.equal(p.semanticAcceptance, 'pending')
  assert.deepEqual(s.candidates, before)
  assert.equal(p.assertions[0].evidence[0].sourceDigest, 'a'.repeat(64))
})
const failures = [
  ['unique identity', s => { s.candidates.entities[1].id = 'nora' }, 'SEMANTIC_IDENTITY'],
  ['identity candidate mapping', s => { s.candidates.entities[0].identity = { status: 'existing-candidate', candidateIds: ['unsupplied'] } }, 'SEMANTIC_IDENTITY'],
  ['type mapping', s => { s.candidates.entities[0].type = 'unmodeled' }, 'SEMANTIC_TYPE'],
  ['predicate mapping', s => { s.candidates.assertions[0].predicate = 'unmodeled' }, 'SEMANTIC_PREDICATE'],
  ['endpoint identity', s => { s.candidates.assertions[0].subjectId = 'missing' }, 'SEMANTIC_IDENTITY'],
  ['direction', s => { s.candidates.assertions[0].direction = 'object-to-subject' }, 'SEMANTIC_DIRECTION'],
  ['negation', s => { s.candidates.assertions[1].negated = 'false' }, 'SEMANTIC_NEGATION'],
  ['modality', s => { s.candidates.assertions[0].modality = 'definite' }, 'SEMANTIC_MODALITY'],
  ['scope', s => { s.candidates.assertions[0].scope = 'Another project' }, 'SEMANTIC_SCOPE'],
  ['calendar date', s => { s.candidates.assertions[0].time.from = '2026-02-30' }, 'SEMANTIC_TIME'],
  ['interval order', s => { s.candidates.assertions[0].time = { from: '2026-07-01', until: '2026-06-01', expression: null, unknowns: [] } }, 'SEMANTIC_TIME'],
  ['unstated temporal interpretation', s => { s.candidates.assertions[0].time.unknowns = [] }, 'SEMANTIC_TIME'],
  ['explicit unknown', s => { s.candidates.unknowns[0].reason = '' }, 'SEMANTIC_UNKNOWN'],
  ['request binding', s => { s.candidates.inputDigest = `sha256:${'c'.repeat(64)}` }, 'SEMANTIC_BINDING'],
  ['missing evidence', s => { s.candidates.assertions[0].evidence[0].id = 'span-absent' }, 'SEMANTIC_EVIDENCE'],
  ['unsupported quote', s => { s.candidates.assertions[0].evidence[0].quote = 'Unsupported invented text.' }, 'SEMANTIC_EVIDENCE'],
  ['unary direction', s => { s.candidates.assertions[0].direction = 'subject-only' }, 'SEMANTIC_DIRECTION'],
]
for (const [rule, mutation, code] of failures) test(`semantic refusal checks ${rule}`, () => refuses(mutation, code))
test('mutation controls prove each candidate refusal oracle detects a disabled rule', async () => {
  const source = fs.readFileSync(new URL('../src/ingestion/semantic.mjs', import.meta.url), 'utf8')
    .replace("'./contracts.mjs'", JSON.stringify(new URL('../src/ingestion/contracts.mjs', import.meta.url).href))
    .replace("'../harnesses/contracts.mjs'", JSON.stringify(new URL('../src/harnesses/contracts.mjs', import.meta.url).href))
  const guard = 'if (!condition) throw new SemanticProposalError(code, message)'
  assert.ok(source.includes(guard), 'Mutation must target the actual refusal guard')
  for (const [rule, change, code] of failures) {
    const modified = source.replace(guard, `if (!condition && code !== '${code}') throw new SemanticProposalError(code, message)`)
    const mutant = await import(`data:text/javascript;base64,${Buffer.from(modified).toString('base64')}`)
    const s = sample(); change(s)
    const oracle = () => assert.throws(() => mutant.prepareSemanticProposals(s), e => e instanceof mutant.SemanticProposalError && e.code === code)
    assert.throws(oracle, e => e.code === 'ERR_ASSERTION', `Refusal oracle must fail when ${rule} is disabled`)
  }
})
test('semantic input refuses a narrower read scope and foreign evidence bindings', () => {
  const s = sample(), native = s.store.getEvidence
  s.store.getEvidence = request => ({ ...native(request), readScope: 'subset' })
  assert.throws(() => prepareSemanticInput({ ...s, domain: fixture.domain, references: [reference(1)] }), e => e.code === 'SEMANTIC_READ_SCOPE')
  s.store.getEvidence = request => ({ ...native(request), sourceDigest: 'd'.repeat(64) })
  assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_BINDING')
})
test('semantic input refuses ambiguous vocabulary IDs and unqualified evidence receipts', () => {
  const s = sample(), domain = clone(fixture.domain)
  domain.data.vocabulary.types.push(clone(domain.data.vocabulary.types[0]))
  assert.throws(() => prepareSemanticInput({ ...s, domain, references: [reference(1)] }), e => e.code === 'SEMANTIC_PROFILE')
  const relations = clone(fixture.domain)
  relations.data.vocabulary.relations.push(clone(relations.data.vocabulary.relations[0]))
  assert.throws(() => prepareSemanticInput({ ...s, domain: relations, references: [reference(1)] }), e => e.code === 'SEMANTIC_PROFILE')
  const native = s.store.getEvidence
  for (const change of [{ ref: '' }, { semanticAcceptance: 'accepted' }]) {
    s.store.getEvidence = request => ({ ...native(request), ...change })
    assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_EVIDENCE')
  }
})
test('semantic proposals preserve a negative unary assertion and possible modality without fabricating an object', () => {
  const s = sample(), candidates = s.candidates
  s.input = prepareSemanticInput({ ...s, domain: fixture.domain, references: [1, 2, 3, 4, 5, 6].map(reference) })
  candidates.inputDigest = s.input.digest
  candidates.assertions[1].predicate = 'available'; candidates.assertions[1].objectId = null; candidates.assertions[1].direction = 'subject-only'
  candidates.assertions[1].evidence = [{ id: 'span-5', quote: 'Nora is not available on Friday.' }]
  candidates.assertions[1].time = { from: null, until: null, expression: 'Friday', unknowns: ['calendar-date'] }
  candidates.assertions[2].modality = 'possible'; candidates.assertions[2].evidence = [{ id: 'span-6', quote: 'The Atlas organization may fund Nora.' }]
  const proposals = prepareSemanticProposals(s)
  assert.equal(proposals.assertions[1].objectId, null)
  assert.equal(proposals.assertions[1].negated, true)
  assert.deepEqual(proposals.assertions[1].time.unknowns, ['calendar-date'])
  assert.equal(proposals.assertions[2].modality, 'possible')
  assert.equal(readSemanticProposals({ ...s, proposals, query: 'Nora' }).assertions.length, 3)
})
test('semantic input refuses accessors and stale input rather than admitting partial output', () => {
  const s = sample(), bad = {}; let calls = 0
  Object.defineProperty(bad, 'schema', { enumerable: true, get() { calls++; return SEMANTIC_CANDIDATE_VERSION } })
  assert.throws(() => prepareSemanticProposals({ ...s, candidates: bad }), e => e.code === 'SEMANTIC_INVALID')
  assert.equal(calls, 0)
  s.store.getEvidence = () => { throw Object.assign(new Error('Changed source'), { code: 'INGESTION_STALE' }) }
  assert.throws(() => prepareSemanticProposals(s), e => e.code === 'SEMANTIC_STALE')
})
test('semantic read model keeps qualifications and rechecks current source before returning a view', () => {
  const s = sample(), proposals = prepareSemanticProposals(s)
  const view = readSemanticProposals({ ...s, proposals, query: 'Nora Atlas', limit: 2 })
  assert.equal(view.assertions.length, 2); assert.equal(view.totalMatched, 3); assert.equal(view.omitted, 1)
  assert.equal(view.synthesized, false); assert.equal(view.authority, 'none')
  s.store.getEvidence = () => { throw Object.assign(new Error('Changed source'), { code: 'INGESTION_STALE' }) }
  assert.throws(() => readSemanticProposals({ ...s, proposals, query: 'Atlas' }), e => e.code === 'SEMANTIC_STALE')
})
test('semantic input and proposals consume real all-plan getEvidence and refuse an edited original', { skip: process.platform === 'win32' ? 'Durable intake uses the qualified POSIX reference profile.' : false }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-semantic-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n'); fs.writeFileSync(path.join(root, 'notes.txt'), fixture.sourceText)
  const store = createIngestionStore({ workspaceRoot: root, workspaceId: 'components' })
  const plan = store.plan({ sources: [{ id: 'notes', ref: 'notes.txt' }], scope: { project: 'components', activity: 'research' }, purpose: 'Inspect invented component support.', budget: { maxInputBytes: 10000, maxOutputBytes: 20000, maxAttempts: 1 } })
  store.run({ planId: plan.planId, planDigest: plan.planDigest })
  const item = store.status({ planId: plan.planId, planDigest: plan.planDigest }).items[0]
  const references = [1, 2, 3, 4].map(line => ({ sourceId: item.id, sourceDigest: item.sourceDigest, attemptId: item.attemptId, locator: { kind: 'line', value: String(line) } }))
  const input = prepareSemanticInput({ store, plan: { planId: plan.planId, planDigest: plan.planDigest }, domain: fixture.domain, references })
  const candidates = sample().candidates; candidates.inputDigest = input.digest
  assert.equal(prepareSemanticProposals({ store, input, candidates }).assertions.length, 3)
  fs.writeFileSync(path.join(root, 'notes.txt'), fixture.sourceText.replace('June', 'July'))
  assert.throws(() => prepareSemanticProposals({ store, input, candidates }), e => e.code === 'SEMANTIC_STALE')
})
