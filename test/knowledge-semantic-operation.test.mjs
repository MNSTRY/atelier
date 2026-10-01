import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createIngestionStore } from '../src/ingestion/store.mjs'
import { appendHarness, readHarness } from '../src/harnesses/store.mjs'
import { EMPTY_HARNESS_HEAD, harnessRef } from '../src/harnesses/contracts.mjs'
import { inspectKnowledge } from '../src/knowledge/ledger.mjs'
import { createIntakeStore, intakeDigest } from '../src/intake/store.mjs'
import { prepareIngestionContribution } from '../src/knowledge/ingestion.mjs'
import { createSemanticOperation, plainAssertionEligibility, assertSemanticProjection, semanticRelationId, semanticDependencyWitnesses, assertSemanticOperationProfile, SEMANTIC_OPERATION_PROFILE } from '../src/knowledge/semantic-operation.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/atelier-ingestion/semantic-operation.json', import.meta.url)))
const at = '2026-01-01T00:00:00Z'
const transactionTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'Durable intake uses the qualified POSIX reference profile.' : false }, fn)
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-semantic-operation-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  execFileSync('git', ['init', '-q', root], { env })
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'notes.txt'), fixture.sourceText)
  appendHarness({ workspaceRoot: root, profile: 'knowledge', record: fixture.domain, confirm: EMPTY_HARNESS_HEAD })
  const store = createIngestionStore({ workspaceRoot: root, workspaceId: 'operation-fixture' })
  const plan = store.plan({ sources: [{ id: 'notes', ref: 'notes.txt' }], scope: { project: 'invented-components', activity: 'research' }, purpose: 'Simulated semantic operation.', budget: { maxInputBytes: 65536, maxOutputBytes: 65536, maxAttempts: 1 } })
  store.run({ planId: plan.planId, planDigest: plan.planDigest })
  const item = store.status({ planId: plan.planId, planDigest: plan.planDigest }).items[0]
  const options = { workspaceRoot: root, workspaceId: 'operation-fixture', run: fixture.domain.run }
  const runner = createSemanticOperation(options)
  const begin = { operationId: 'first', attemptId: 'model-first', at, term: 'material', plan: { planId: plan.planId, planDigest: plan.planDigest },
    references: [1, 2, 3].map(line => ({ sourceId: 'notes', sourceDigest: item.sourceDigest, attemptId: item.attemptId, locator: { kind: 'line', value: String(line) } })), identityCandidates: [],
    extractor: { id: 'fixture-extractor', version: '1.0.0', route: 'authored', model: null, promptDigest: 'a'.repeat(64), parameters: {} },
    confirm: readHarness({ workspaceRoot: root, profile: 'knowledge', run: fixture.domain.run }).head }
  return { root, runner, begin, options }
}

transactionTest('operation begins before extraction and reopened unknown execution blocks a new attempt', t => {
  const s = setup(t), first = s.runner.begin(s.begin)
  assert.equal(first.execution, 'ready-for-host')
  assert.equal(first.attempt.status, 'begun')
  assert.equal(first.authority, 'none')
  const reopened = createSemanticOperation(s.options)
  assert.equal(reopened.status({ operationId: 'first' }).execution, 'unknown')
  assert.throws(() => reopened.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: first.head }), e => e.code === 'SEMANTIC_EXECUTION_UNKNOWN')
  assert.equal(reopened.status({ operationId: 'first' }).attempt.status, 'begun')
})

transactionTest('explicit host reconciliation permits a fresh attempt and preserves the abandoned history', t => {
  const s = setup(t), first = s.runner.begin(s.begin)
  const reconciled = s.runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Simulated host confirms extraction never started.', outcome: 'not-executed', confirm: first.head })
  const second = s.runner.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: reconciled.head })
  assert.equal(second.execution, 'ready-for-host')
  assert.equal(s.runner.status({ operationId: 'first' }).phase, 'reconciled')
  assert.equal(s.runner.status({ operationId: 'first' }).attempt.status, 'begun')
})

const unknownUsage = { inputTokens: null, outputTokens: null, cost: null, currency: null, elapsedMs: null, retries: null }
const emptyCandidates = input => ({ schema: 'atelier.semantic-candidate/v0', inputDigest: input.digest, entities: [], assertions: [], unknowns: [] })
transactionTest('completed raw extraction reopens exactly and its cache preserves unknown usage', t => {
  const s = setup(t), first = s.runner.begin(s.begin), candidates = emptyCandidates(first.input)
  const output = JSON.stringify(candidates)
  const completed = s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head })
  assert.equal(completed.attempt.output, output)
  assert.deepEqual(completed.usage, unknownUsage)
  assert.equal(completed.proposals.semanticAcceptance, 'pending')
  const reopened = createSemanticOperation(s.options).status({ operationId: 'first' })
  assert.deepEqual(reopened.attempt.completion, completed.attempt.completion)
  const cached = s.runner.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: completed.head })
  assert.equal(cached.cacheReuse, true); assert.equal(cached.operationId, 'first')
  assert.equal(createIntakeStore(s.options).readAttempt('model-second').status, 'absent')
  fs.appendFileSync(path.join(s.root, 'notes.txt'), 'Changed after extraction.\n')
  assert.equal(s.runner.status({ operationId: 'first' }).freshness, 'stale')
})

transactionTest('refused interpretation preserves raw bytes and requires completion before another execution', t => {
  const s = setup(t), first = s.runner.begin(s.begin), candidates = emptyCandidates(first.input)
  const output = 'Invented raw host output with invalid proposed input binding.'
  assert.throws(() => s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates: { ...candidates, inputDigest: `sha256:${'f'.repeat(64)}` }, usage: unknownUsage, at, confirm: first.head }), e => e.code === 'SEMANTIC_BINDING')
  assert.equal(s.runner.status({ operationId: 'first' }).attempt.output, output)
  assert.throws(() => s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates: { ...candidates, extra: 'x'.repeat(262145) }, usage: unknownUsage, at, confirm: first.head }), e => e.code === 'SEMANTIC_OPERATION_LIMIT')
  let getterCalls = 0
  const malformed = { ...candidates }
  Object.defineProperty(malformed, 'extra', { enumerable: true, get() { getterCalls++; return 'invalid' } })
  assert.throws(() => s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates: malformed, usage: unknownUsage, at, confirm: first.head }), e => e.code === 'SEMANTIC_OPERATION_INVALID')
  assert.equal(getterCalls, 0)
  assert.equal(s.runner.status({ operationId: 'first' }).attempt.output, output)
  assert.throws(() => s.runner.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: first.head }), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED')
  assert.throws(() => s.runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Cannot pretend completion did not happen.', outcome: 'not-executed', confirm: first.head }), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED')
  const completed = s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head })
  assert.equal(completed.phase, 'completed')
})

transactionTest('partial raw output reopens without permission to retry and completes only with identical bytes', t => {
  const s = setup(t), first = s.runner.begin(s.begin), candidates = emptyCandidates(first.input), output = JSON.stringify(candidates)
  const intake = createIntakeStore(s.options)
  intake.completeAttempt({ attemptId: 'model-first', output, expectedOutputDigest: intakeDigest(output) })
  // Disposable fixture simulates a crash after output publication, before completion publication.
  fs.unlinkSync(path.join(s.root, '.atelier-local/intake/attempts/model-first/completion.json'))
  const reopened = createSemanticOperation(s.options)
  assert.equal(reopened.status({ operationId: 'first' }).attempt.status, 'partial')
  assert.throws(() => reopened.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: first.head }), e => e.code === 'SEMANTIC_EXECUTION_UNKNOWN')
  assert.throws(() => reopened.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Partial output cannot be abandoned.', outcome: 'failed-no-output', confirm: first.head }), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED')
  assert.throws(() => reopened.complete({ operationId: 'first', output: output + 'different', expectedOutputDigest: intakeDigest(output + 'different'), candidates, usage: unknownUsage, at, confirm: first.head }))
  assert.equal(intake.readAttempt('model-first').output, output)
  const completed = reopened.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head })
  assert.equal(completed.attempt.status, 'complete')
  assert.equal(completed.attempt.output, output)
})

transactionTest('independently planned sources reuse unaffected completed attempts after another source is corrected', t => {
  const s = setup(t), first = s.runner.begin(s.begin), candidates = emptyCandidates(first.input), output = JSON.stringify(candidates)
  let head = s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }).head
  fs.writeFileSync(path.join(s.root, 'second.txt'), 'The Atlas organization funds Nora.\n')
  const store = createIngestionStore({ workspaceRoot: s.root, workspaceId: s.options.workspaceId })
  const plan = store.plan({ sources: [{ id: 'second', ref: 'second.txt' }], scope: { project: 'invented-components', activity: 'research' }, purpose: 'Independent source correction unit.', budget: { maxInputBytes: 65536, maxOutputBytes: 65536, maxAttempts: 1 } })
  const pin = { planId: plan.planId, planDigest: plan.planDigest }; store.run(pin)
  const item = store.status(pin).items[0]
  const request = { ...s.begin, operationId: 'second', attemptId: 'model-second', plan: pin,
    references: [{ sourceId: 'second', sourceDigest: item.sourceDigest, attemptId: item.attemptId, locator: { kind: 'line', value: '1' } }], confirm: head }
  const second = s.runner.begin(request), secondCandidates = emptyCandidates(second.input), secondOutput = JSON.stringify(secondCandidates)
  head = s.runner.complete({ operationId: 'second', output: secondOutput, expectedOutputDigest: intakeDigest(secondOutput), candidates: secondCandidates, usage: unknownUsage, at, confirm: second.head }).head
  fs.writeFileSync(path.join(s.root, 'notes.txt'), fixture.sourceText.replace('June', 'July'))
  assert.equal(s.runner.status({ operationId: 'first' }).freshness, 'stale')
  assert.equal(s.runner.status({ operationId: 'second' }).freshness, 'current')
  const reused = s.runner.begin({ ...request, operationId: 'third', attemptId: 'model-third', confirm: head })
  assert.equal(reused.operationId, 'second'); assert.equal(reused.cacheReuse, true)
  assert.equal(createIntakeStore(s.options).readAttempt('model-third').status, 'absent')
})

test('plain-edge eligibility retains every qualification as an explicit omission', () => {
  const base = { id: 'claim', subjectId: 'nora', objectId: 'atlas', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: fixture.domain.data.scope, time: { from: null, until: null, expression: null, unknowns: [] } }
  assert.deepEqual(plainAssertionEligibility(base, fixture.domain), { eligible: true, reasons: [] })
  const cases = [
    [{ objectId: null, direction: 'subject-only' }, 'unary'],
    [{ negated: true }, 'negated'],
    ...['conditional', 'proposed', 'possible', 'uncertain', 'unknown'].map(modality => [{ modality }, 'modal']),
    ...[{ from: '2026-01-01' }, { until: '2026-01-01' }, { expression: 'Friday' }, { unknowns: ['calendar-date'] }].map(time => [{ time: { ...base.time, ...time } }, 'temporal']),
    [{ scope: 'another domain' }, 'scope'],
  ]
  for (const [change, reason] of cases) {
    const result = plainAssertionEligibility({ ...base, ...change }, fixture.domain)
    assert.equal(result.eligible, false)
    assert.ok(result.reasons.includes(reason), reason)
  }
})

test('rich forms outside the operation profile have named refusals instead of coercion', () => {
  assert.throws(() => assertSemanticOperationProfile({ references: [{ locator: { kind: 'utf8-byte-range', value: '1:20' } }] }), e => e.code === 'SEMANTIC_UNSUPPORTED_LOCATOR')
  for (const [assertion, code] of [
    [{ scope: { project: 'invented' } }, 'SEMANTIC_UNSUPPORTED_SCOPE'],
    [{ objectId: 12 }, 'SEMANTIC_UNSUPPORTED_LITERAL_OBJECT'],
    [{ literalObject: 'a literal' }, 'SEMANTIC_UNSUPPORTED_LITERAL_OBJECT'],
    [{ evidence: [{ quote: 'first\nsecond' }] }, 'SEMANTIC_UNSUPPORTED_LOCATOR'],
  ]) assert.throws(() => assertSemanticOperationProfile({ candidates: { assertions: [assertion] } }), e => e.code === code)
})

function projectionFixture({ support = 'valid' } = {}) {
  const records = [structuredClone(fixture.domain)], domain = records[0]
  const make = (kind, id, data) => ({ schema: 'atelier-knowledge-record@v1', id, run: domain.run, at, by: 'simulated-receiver', kind, data })
  function add(record) { inspectKnowledge([...records, record]); records.push(record); return record }
  function contribution(id, term, body, basedOn = []) {
    return add(make('contribution', id, { domain: harnessRef(domain), category: 'interpretation', term, title: id, body, audience: domain.data.audience, scope: domain.data.scope,
      origin: { method: 'authored', reason: 'Invented fixture with simulated receiver decisions only.' }, basedOn }))
  }
  function review(record) {
    const evaluations = record.kind === 'contribution' ? [add(make('evaluation', `${record.id}-eval`, { contribution: harnessRef(record), judgment: 'supported', rationale: 'Simulated fixture evaluation.', limitations: ['Not real acceptance'], scope: domain.data.scope }))] : []
    return add(make('review', `${record.id}-review`, { target: harnessRef(record), disposition: 'accepted', basis: 'Simulated receiver only.', evaluations: evaluations.map(harnessRef) }))
  }
  const subject = contribution('subject', 'person', 'Nora'), object = contribution('object', 'project', 'Atlas')
  review(subject); review(object)
  const assertions = [], relations = [], reviews = []
  for (let i = 0; i < 2; i++) {
    const id = `assertion-${i}`, candidate = { id, subjectId: 'nora', predicate: 'funds', objectId: 'atlas', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: domain.data.scope, time: { from: null, until: null, expression: null, unknowns: [] } }
    const assertion = contribution(id, 'assertion', JSON.stringify({ schema: SEMANTIC_OPERATION_PROFILE, kind: 'assertion', candidate, endpoints: { subject: harnessRef(subject), object: harnessRef(object) } }),
      [{ contribution: harnessRef(subject), quote: 'Nora' }, { contribution: harnessRef(object), quote: 'Atlas' }])
    assertions.push(assertion)
    const approval = review(assertion)
    add(make('activation', `assertion-active-${i}`, { reviews: [harnessRef(approval)], purpose: 'Simulated assertion readback.', destination: 'local-context', questions: ['component'] }))
    const pin = support === 'missing' ? '' : `\nsemantic-support: ${id} ${support === 'wrong-digest' ? `sha256:${'a'.repeat(64)}` : harnessRef(assertion).digest}`
    const relation = add(make('relation', semanticRelationId(id), { domain: harnessRef(domain), subject: harnessRef(subject), object: harnessRef(object), predicate: 'funds', rationale: `Simulated supported relation.${pin}` }))
    relations.push(relation); reviews.push(review(relation))
  }
  const activation = add(make('activation', 'edge-activation', { reviews: reviews.map(harnessRef), purpose: 'Simulated graph view.', destination: 'local-graph', questions: ['component'] }))
  return { records, assertions, relations, activation, add, make, contribution }
}

test('semantic projection refuses withdrawn assertion support with zero, some and all cleanup writes', () => {
  const s = projectionFixture()
  assert.equal(assertSemanticProjection({ records: s.records, activationId: s.activation.id }).selected.includes(s.assertions[0].id), true)
  for (let i = 0; i < 2; i++) s.add(s.make('withdrawal', `withdraw-assertion-${i}`, { target: harnessRef(s.assertions[i]), reason: 'Simulated receiver withdraws source assertion.' }))
  for (let cleaned = 0; cleaned <= 2; cleaned++) {
    assert.throws(() => assertSemanticProjection({ records: s.records, activationId: s.activation.id }), e => e.code === (cleaned === 0 ? 'SEMANTIC_PROJECTION_SUPPORT' : 'SEMANTIC_PROJECTION_STALE'))
    if (cleaned < 2) s.add(s.make('withdrawal', `withdraw-relation-${cleaned}`, { target: harnessRef(s.relations[cleaned]), reason: 'Resume simulated assertion-withdrawal cleanup.' }))
  }
  const accepted = s.records.find(record => record.id === 'subject-review')
  s.add(s.make('activation', 'replacement-activation', { reviews: [harnessRef(accepted)], purpose: 'Simulated receiver selects only current knowledge.', destination: 'local-context', questions: ['component'] }))
  assert.deepEqual(assertSemanticProjection({ records: s.records, activationId: 'replacement-activation' }).selected, ['subject'])
})

test('semantic projection refuses missing or mismatched pins and superseded assertion support', () => {
  for (const support of ['missing', 'wrong-digest']) {
    const s = projectionFixture({ support })
    assert.throws(() => assertSemanticProjection({ records: s.records, activationId: s.activation.id }), e => e.code === 'SEMANTIC_PROJECTION_SUPPORT')
  }
  const s = projectionFixture(), old = s.assertions[0]
  const successor = structuredClone(old); successor.id = 'assertion-successor'
  successor.data.supersedes = harnessRef(old); successor.data.revisionReason = 'Simulated receiver corrects the assertion.'
  s.add(successor)
  assert.throws(() => assertSemanticProjection({ records: s.records, activationId: s.activation.id }), e => e.code === 'SEMANTIC_PROJECTION_SUPPORT')
})

function extractedCandidates(input) {
  const lines = fixture.sourceText.trimEnd().split('\n')
  return { schema: 'atelier.semantic-candidate/v0', inputDigest: input.digest, entities: [
    { id: 'nora', label: 'Nora', type: 'person', identity: { status: 'source-local', candidateIds: [] }, evidence: ['span-1'] },
    { id: 'atlas-project', label: 'Atlas', type: 'project', identity: { status: 'source-local', candidateIds: [] }, evidence: ['span-1'] },
    { id: 'atlas-organization', label: 'Atlas', type: 'organization', identity: { status: 'source-local', candidateIds: [] }, evidence: ['span-3'] },
  ], assertions: [
    { id: 'management', subjectId: 'nora', predicate: 'manages', objectId: 'atlas-project', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: fixture.domain.data.scope,
      time: { from: null, until: null, expression: 'through June', unknowns: ['year'] }, evidence: [{ id: 'span-1', quote: lines[0] }] },
    { id: 'nonownership', subjectId: 'nora', predicate: 'owns', objectId: 'atlas-project', direction: 'subject-to-object', negated: true, modality: 'asserted', scope: fixture.domain.data.scope,
      time: { from: null, until: null, expression: null, unknowns: [] }, evidence: [{ id: 'span-2', quote: lines[1] }] },
    { id: 'funding', subjectId: 'atlas-organization', predicate: 'funds', objectId: 'nora', direction: 'subject-to-object', negated: false, modality: 'asserted', scope: fixture.domain.data.scope,
      time: { from: null, until: null, expression: null, unknowns: [] }, evidence: [{ id: 'span-3', quote: lines[2] }] },
  ], unknowns: [] }
}

transactionTest('vanilla runner captures, admits, projects, reopens and corrects through the existing owners', t => {
  const s = setup(t), first = s.runner.begin(s.begin), candidates = extractedCandidates(first.input), output = JSON.stringify(candidates)
  let head = s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }).head
  const make = (kind, id, data) => ({ schema: 'atelier-knowledge-record@v1', id, run: fixture.domain.run, at, by: 'simulated-receiver', kind, data })
  const decision = record => { head = s.runner.record({ record, confirm: head }).head; return record }
  function approve(record) {
    const evaluations = record.kind === 'contribution' ? [decision(make('evaluation', `${record.id}-eval`, { contribution: harnessRef(record), judgment: 'supported', rationale: 'Simulated fixture evaluation, not a model-quality result.', limitations: ['Invented inputs and simulated receiver'], scope: fixture.domain.data.scope }))] : []
    return decision(make('review', `${record.id}-review`, { target: harnessRef(record), disposition: 'accepted', basis: 'Simulated receiver accepts only for the fixture journey.', evaluations: evaluations.map(harnessRef) }))
  }
  const source = prepareIngestionContribution({ ...s.options, records: readHarness({ ...s.options, profile: 'knowledge' }).records, ...s.begin.plan, sourceId: 'notes', title: 'Invented source', term: 'material' })
  const sourceRecord = { ...make('contribution', 'structural-source', source.data), by: 'host-model:fixture-structural-extractor' }
  head = appendHarness({ ...s.options, profile: 'knowledge', record: sourceRecord, confirm: head }).head
  approve(sourceRecord)
  const sourceOptions = { source: harnessRef(sourceRecord), sourceBinding: source.sourceBinding }
  for (const entity of candidates.entities) {
    const prepared = s.runner.prepareContribution({ operationId: 'first', id: `entity-${entity.id}`, kind: 'entity', candidateId: entity.id, term: entity.type, at, confirm: head, ...sourceOptions })
    head = prepared.head
    assert.match(prepared.record.by, /^host-model:/)
    assert.equal(prepared.record.data.origin.method, 'authored')
    approve(prepared.record)
  }
  const assertions = [], reviews = []
  for (const assertion of candidates.assertions) {
    const prepared = s.runner.prepareContribution({ operationId: 'first', id: `claim-${assertion.id}`, kind: 'assertion', candidateId: assertion.id, term: 'assertion', at, confirm: head, ...sourceOptions })
    head = prepared.head; assertions.push(prepared.record); reviews.push(approve(prepared.record))
  }
  decision(make('activation', 'assertions-active', { reviews: reviews.map(harnessRef), purpose: 'Simulated qualified assertion retrieval.', destination: 'local-context', questions: ['component'] }))
  assert.equal(s.runner.prepareRelation({ assertion: harnessRef(assertions[0]), at, confirm: head }).projectionOmission.reasons.includes('temporal'), true)
  assert.equal(s.runner.prepareRelation({ assertion: harnessRef(assertions[1]), at, confirm: head }).projectionOmission.reasons.includes('negated'), true)
  let relation = s.runner.prepareRelation({ assertion: harnessRef(assertions[2]), at, confirm: head }); head = relation.head
  const relationReview = approve(relation.record)
  decision(make('activation', 'all-active', { reviews: [...reviews, relationReview].map(harnessRef), purpose: 'Simulated graph proposal.', destination: 'local-graph', questions: ['component'] }))
  const projected = s.runner.project({ activationId: 'all-active', namespace: 'fixture' })
  assert.equal(projected.semanticEntities.length, 3)
  assert.equal(projected.semanticAssertions.length, 3)
  assert.equal(projected.projectionOmissions.length, 2)
  assert.equal(projected.semanticAssertions.find(item => item.candidate.id === 'nonownership').candidate.negated, true)
  const originalCapture = s.runner.status({ operationId: 'first' }).attempt.completion
  const priorEntity = readHarness({ ...s.options, profile: 'knowledge' }).records.find(record => record.id === 'entity-nora')
  const revisedEntity = s.runner.prepareContribution({ operationId: 'first', id: 'entity-nora-v2', kind: 'entity', candidateId: 'nora', term: 'person', at, confirm: head, ...sourceOptions,
    supersedes: harnessRef(priorEntity), revisionReason: 'Simulated receiver explicitly revises the identity contribution.' })
  head = revisedEntity.head; approve(revisedEntity.record)
  assert.throws(() => s.runner.project({ activationId: 'all-active', namespace: 'fixture' }), e => e.code.startsWith('SEMANTIC_PROJECTION_'))
  const revisedAssertion = s.runner.prepareContribution({ operationId: 'first', id: 'claim-funding-v2', kind: 'assertion', candidateId: 'funding', term: 'assertion', at, confirm: head, ...sourceOptions,
    supersedes: harnessRef(assertions[2]), revisionReason: 'Simulated receiver binds this assertion to the revised identity.' })
  head = revisedAssertion.head; assertions[2] = revisedAssertion.record
  const revisedReview = approve(revisedAssertion.record)
  decision(make('activation', 'revised-assertion-active', { reviews: [harnessRef(revisedReview)], purpose: 'Simulated revised identity retrieval.', destination: 'local-context', questions: ['component'] }))
  relation = s.runner.prepareRelation({ assertion: harnessRef(assertions[2]), at, confirm: head }); head = relation.head
  const revisedRelationReview = approve(relation.record)
  decision(make('activation', 'all-active-v2', { reviews: [revisedReview, revisedRelationReview].map(harnessRef), purpose: 'Simulated revised identity projection.', destination: 'local-graph', questions: ['component'] }))
  assert.equal(s.runner.project({ activationId: 'all-active-v2', namespace: 'fixture' }).semanticAssertions.length, 1)
  assert.deepEqual(s.runner.status({ operationId: 'first' }).attempt.completion, originalCapture)
  const reopened = createSemanticOperation(s.options)
  assert.equal(reopened.context({ query: 'funds' }).hits.some(hit => hit.reference.id === assertions[2].id), true)
  assert.equal(reopened.proposals({ operationId: 'first', query: 'funds' }).answerClass, 'pending-proposals')
  decision(make('withdrawal', 'withdraw-funding', { target: harnessRef(assertions[2]), reason: 'Simulated receiver withdraws the funding interpretation.' }))
  assert.throws(() => reopened.project({ activationId: 'all-active-v2', namespace: 'fixture' }), e => e.code.startsWith('SEMANTIC_PROJECTION_'))
  const cleaned = reopened.cascade({ withdrawalId: 'withdraw-funding', at, confirm: head }); head = cleaned.head
  assert.deepEqual(cleaned.cleaned, [relation.record.id])
  assert.deepEqual(reopened.cascade({ withdrawalId: 'withdraw-funding', at, confirm: head }).cleaned, [])
  assert.equal(reopened.context({ query: 'funds' }).hits.some(hit => hit.reference.id === assertions[2].id), false)
  fs.writeFileSync(path.join(s.root, 'notes.txt'), fixture.sourceText.replace('June', 'July'))
  assert.equal(reopened.status({ operationId: 'first' }).freshness, 'stale')
  assert.equal(reopened.context({ query: 'Nora' }).hits.length, 0)
})

function witnessSource(index, quotes) {
  const sourceDigest = intakeDigest(`invented-source-${index}`), attemptId = `source-attempt-${index}`
  const record = { schema: 'atelier-knowledge-record@v1', id: `source-${index}`, run: fixture.domain.run, at, by: 'invented-structural-extractor', kind: 'contribution', data: {
    domain: harnessRef(fixture.domain), category: 'source', term: 'material', title: 'Invented witness unit', body: JSON.stringify({ evidence: quotes }), audience: 'private', scope: fixture.domain.data.scope,
    origin: { method: 'extracted', attemptId, blobDigest: `sha256:${sourceDigest}` }, basedOn: [],
  } }
  return { record, citations: quotes.map(quote => ({ quote, sourceDigest, attemptId })) }
}
test('dependency witnesses preserve original special-character citations and cut only complete encoded code points', () => {
  const quotes = ['He said "hello".', 'folder\\file', 'Control: \u0001\n\t', 'Non-BMP: 💡', 'Line\u2028separator\u2029']
  const s = witnessSource(0, quotes), result = semanticDependencyWitnesses({ citations: s.citations, sources: [s.record] })
  assert.equal(result.basedOn.length, 1)
  assert.equal(result.basedOn[0].quote, JSON.stringify(quotes[0]).slice(1, -1))
  assert.equal(result.sourceWitness[0].purpose, 'ledger-dependency-only')
  for (const quote of quotes) {
    const one = witnessSource(1, [quote]), witness = semanticDependencyWitnesses({ citations: one.citations, sources: [one.record] }).basedOn[0].quote
    assert.equal(witness, JSON.stringify(quote).slice(1, -1))
  }
  for (const suffix of ['💡', '"', '\\', '\u0001']) {
    const one = witnessSource(2, ['a'.repeat(8191) + suffix]), witness = semanticDependencyWitnesses({ citations: one.citations, sources: [one.record] }).basedOn[0].quote
    assert.equal(witness, 'a'.repeat(8191))
    assert.equal(JSON.parse(`"${witness}"`), 'a'.repeat(8191))
  }
})
test('dependency witnesses bind each source, deduplicate citations, and refuse missing sources or 64-entry overflow', () => {
  const first = witnessSource(0, ['first', 'second']), second = witnessSource(1, ['third'])
  const result = semanticDependencyWitnesses({ citations: [...first.citations, ...second.citations], sources: [first.record, second.record] })
  assert.deepEqual(result.basedOn.map(item => item.contribution.id), ['source-0', 'source-1'])
  for (const changed of [{ attemptId: 'wrong-attempt' }, { sourceDigest: 'f'.repeat(64) }]) {
    assert.throws(() => semanticDependencyWitnesses({ citations: [{ ...first.citations[0], ...changed }], sources: [first.record] }), e => e.code === 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION')
  }
  const tooMany = Array.from({ length: 65 }, (_, i) => witnessSource(i, [`quote-${i}`]))
  assert.throws(() => semanticDependencyWitnesses({ citations: tooMany.flatMap(item => item.citations), sources: tooMany.map(item => item.record) }), e => e.code === 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION')
  const tampered = structuredClone(first.record); tampered.data.body = 'No quoted source here.'
  assert.throws(() => semanticDependencyWitnesses({ citations: first.citations, sources: [tampered] }), e => e.code === 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION')
})

test('rule-specific mutation controls discriminate support, digest, witness and negation guards', async () => {
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const guard = 'if (!condition) throw new SemanticOperationError(code, message)'
  async function mutant(message) {
    assert.equal(source.split(`'${message}'`).length, 2)
    return import(`data:text/javascript;base64,${Buffer.from(source.replace(guard, `if (!condition && message !== ${JSON.stringify(message)}) throw new SemanticOperationError(code, message)`)).toString('base64')}`)
  }
  const withdrawn = projectionFixture()
  withdrawn.add(withdrawn.make('withdrawal', 'support-withdrawal', { target: harnessRef(withdrawn.assertions[0]), reason: 'Simulated receiver withdraws the support.' }))
  const selected = { records: withdrawn.records, activationId: withdrawn.activation.id }
  assert.throws(() => assertSemanticProjection(selected), e => e.code === 'SEMANTIC_PROJECTION_SUPPORT')
  const support = await mutant('Relation support must be currently accepted, active and not withdrawn or superseded')
  assert.throws(() => assert.throws(() => support.assertSemanticProjection(selected), e => e.code === 'SEMANTIC_PROJECTION_SUPPORT'), e => e.code === 'ERR_ASSERTION')
  const wrong = projectionFixture({ support: 'wrong-digest' }), selectedWrong = { records: wrong.records, activationId: wrong.activation.id }
  assert.throws(() => assertSemanticProjection(selectedWrong), e => e.code === 'SEMANTIC_PROJECTION_SUPPORT')
  const digest = await mutant('Relation assertion support digest differs')
  assert.throws(() => assert.throws(() => digest.assertSemanticProjection(selectedWrong), e => e.code === 'SEMANTIC_PROJECTION_SUPPORT'), e => e.code === 'ERR_ASSERTION')
  const sourceUnit = witnessSource(0, ['missing passage']); sourceUnit.record.data.body = 'Different content.'
  const selectedWitness = { citations: sourceUnit.citations, sources: [sourceUnit.record] }
  assert.throws(() => semanticDependencyWitnesses(selectedWitness), e => e.code === 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION')
  const witness = await mutant('The encoded dependency witness is absent from the stored contribution body')
  assert.throws(() => assert.throws(() => witness.semanticDependencyWitnesses(selectedWitness), e => e.code === 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION'), e => e.code === 'ERR_ASSERTION')
  const negative = { id: 'negative', objectId: 'atlas', direction: 'subject-to-object', negated: true, modality: 'asserted', scope: fixture.domain.data.scope, time: { from: null, until: null, expression: null, unknowns: [] } }
  const marker = "if (assertion.negated !== false) reasons.push('negated')"
  assert.equal(source.split(marker).length, 2)
  const negation = await import(`data:text/javascript;base64,${Buffer.from(source.replace(marker, "if (false) reasons.push('negated')")).toString('base64')}`)
  assert.equal(plainAssertionEligibility(negative, fixture.domain).eligible, false)
  assert.throws(() => assert.equal(negation.plainAssertionEligibility(negative, fixture.domain).eligible, false), e => e.code === 'ERR_ASSERTION')
})

transactionTest('unknown-execution guard has a discriminating mutation control', async t => {
  const s = setup(t), first = s.runner.begin(s.begin), request = { ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: first.head }
  assert.throws(() => s.runner.begin(request), e => e.code === 'SEMANTIC_EXECUTION_UNKNOWN')
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const guard = 'if (!condition) throw new SemanticOperationError(code, message)'
  const message = 'Reconcile the prior source/configuration execution before a new attempt'
  assert.equal(source.split(`'${message}'`).length, 2)
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(guard, `if (!condition && message !== ${JSON.stringify(message)}) throw new SemanticOperationError(code, message)`)).toString('base64')}`)
  assert.throws(() => assert.throws(() => mutant.createSemanticOperation(s.options).begin(request), e => e.code === 'SEMANTIC_EXECUTION_UNKNOWN'), e => e.code === 'ERR_ASSERTION')
})
