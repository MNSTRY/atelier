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
import { createSemanticOperation, SemanticOperationError, plainAssertionEligibility, assertSemanticProjection, semanticRelationId, semanticDependencyWitnesses, assertSemanticOperationProfile, SEMANTIC_OPERATION_PROFILE } from '../src/knowledge/semantic-operation.mjs'

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
  assert.throws(() => reopened.complete({ operationId: 'first', output: output + 'different', expectedOutputDigest: intakeDigest(output + 'different'), candidates, usage: unknownUsage, at, confirm: first.head }), e => e.code === 'EEXIST' && e.syscall === 'link' && String(e.dest).endsWith(`${path.sep}output.txt`))
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
  assert.ok(s.runner.project({ activationId: 'all-active-v2', namespace: 'fixture' }).dependencyWitnesses.some(item => item.witnesses.some(witness => witness.dependency === 'identity-choice' && witness.purpose === 'ledger-dependency-only')))
  assert.deepEqual(s.runner.status({ operationId: 'first' }).attempt.completion, originalCapture)
  const reopened = createSemanticOperation(s.options)
  assert.equal(reopened.context({ query: 'funds' }).hits.some(hit => hit.reference.id === assertions[2].id), true)
  assert.equal(reopened.proposals({ operationId: 'first', query: 'funds' }).answerClass, 'pending-proposals')
  head = appendHarness({ ...s.options, profile: 'knowledge', record: make('relation', 'ordinary-support-like-text', { ...relation.record.data, rationale: relation.record.data.rationale }), confirm: head }).head
  // Only the exact generated relation identity and support digest permit consequential cleanup.
  decision(make('withdrawal', 'withdraw-funding', { target: harnessRef(assertions[2]), reason: 'Simulated receiver withdraws the funding interpretation.' }))
  assert.throws(() => reopened.project({ activationId: 'all-active-v2', namespace: 'fixture' }), e => e.code.startsWith('SEMANTIC_PROJECTION_'))
  const cleaned = reopened.cascade({ withdrawalId: 'withdraw-funding', at, confirm: head }); head = cleaned.head
  assert.deepEqual(cleaned.cleaned, [relation.record.id])
  assert.equal(readHarness({ ...s.options, profile: 'knowledge' }).records.some(record => record.kind === 'withdrawal' && record.data.target.id === 'ordinary-support-like-text'), false)
  assert.deepEqual(reopened.cascade({ withdrawalId: 'withdraw-funding', at, confirm: head }).cleaned, [])
  assert.equal(reopened.context({ query: 'funds' }).hits.some(hit => hit.reference.id === assertions[2].id), false)
  fs.writeFileSync(path.join(s.root, 'notes.txt'), fixture.sourceText.replace('June', 'July'))
  assert.equal(reopened.status({ operationId: 'first' }).freshness, 'stale')
  assert.equal(reopened.context({ query: 'Nora' }).hits.length, 0)
})

transactionTest('supplied existing identities require explicit review and work with ordinary accepted prose', async t => {
  const s = setup(t)
  let head = s.begin.confirm
  const make = (kind, id, data) => ({ schema: 'atelier-knowledge-record@v1', id, run: fixture.domain.run, at, by: 'simulated-receiver', kind, data })
  const add = record => { head = appendHarness({ ...s.options, profile: 'knowledge', record, confirm: head }).head; return record }
  function approve(record, basis = 'Simulated fixture acceptance, not real receiver acceptance.', suffix = '') {
    if (record.kind === 'contribution') add(make('evaluation', `${record.id}-eval${suffix}`, { contribution: harnessRef(record), judgment: 'supported', rationale: 'Invented fixture evaluation.', limitations: ['Simulated decisions'], scope: fixture.domain.data.scope }))
    const evaluations = readHarness({ ...s.options, profile: 'knowledge' }).records.filter(item => item.kind === 'evaluation' && item.data.contribution.id === record.id)
    return add(make('review', `${record.id}-review${suffix}`, { target: harnessRef(record), disposition: 'accepted', basis, evaluations: evaluations.map(harnessRef) }))
  }
  const canonical = add(make('contribution', 'nora-canonical', { domain: harnessRef(fixture.domain), category: 'concept', term: 'person', title: 'Nora', body: '\tNora\nA "quoted" participant with \\ literal punctuation.', audience: fixture.domain.data.audience, scope: fixture.domain.data.scope, origin: { method: 'authored', reason: 'Invented existing concept; its body does not repeat its record identifier.' }, basedOn: [] }))
  approve(canonical)
  const wrongType = add(make('contribution', 'nora-organization', { ...canonical.data, term: 'organization', body: 'An invented organization with a similar display name.' }))
  approve(wrongType)
  const nonSupplied = add(make('contribution', 'nora-not-supplied', { ...canonical.data, body: 'Another accepted person outside the supplied candidate set.' }))
  approve(nonSupplied)
  // A host-supplied candidate description does not establish the ledger type.
  const first = s.runner.begin({ ...s.begin, confirm: head, identityCandidates: [canonical, wrongType].map(record => ({ id: record.id, label: 'Nora', type: 'person' })) })
  const candidates = extractedCandidates(first.input)
  candidates.entities[0].identity = { status: 'existing-candidate', candidateIds: [canonical.id, wrongType.id] }
  const output = JSON.stringify(candidates)
  head = s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }).head
  const source = prepareIngestionContribution({ ...s.options, records: readHarness({ ...s.options, profile: 'knowledge' }).records, ...s.begin.plan, sourceId: 'notes', title: 'Invented identity source', term: 'material' })
  const sourceRecord = add({ ...make('contribution', 'identity-source', source.data), by: 'host-model:fixture-structural-extractor' })
  approve(sourceRecord)
  const sourceOptions = { source: harnessRef(sourceRecord), sourceBinding: source.sourceBinding }
  const entities = []
  for (const entity of candidates.entities) {
    const prepared = s.runner.prepareContribution({ operationId: 'first', id: `identity-${entity.id}`, kind: 'entity', candidateId: entity.id, term: entity.type, at, confirm: head, ...sourceOptions })
    head = prepared.head; entities.push(prepared.record); approve(prepared.record)
  }
  const claimRequest = () => ({ operationId: 'first', id: 'identity-management', kind: 'assertion', candidateId: 'management', term: 'assertion', at, confirm: head, ...sourceOptions })
  assert.throws(() => s.runner.prepareContribution(claimRequest()), e => e.code === 'SEMANTIC_IDENTITY_PENDING')
  const choice = resolution => JSON.stringify({ schema: 'atelier.semantic-identity-decision/v0', operationId: 'first', candidateId: 'nora', resolution })
  approve(entities[0], choice({ status: 'existing', contribution: harnessRef(entities[2]) }), '-wrong')
  assert.throws(() => s.runner.prepareContribution(claimRequest()), e => e.code === 'SEMANTIC_IDENTITY_PENDING')
  approve(entities[0], choice({ status: 'existing', contribution: harnessRef(nonSupplied) }), '-not-supplied')
  assert.throws(() => s.runner.prepareContribution(claimRequest()), e => e.code === 'SEMANTIC_IDENTITY_PENDING')
  const identityLedger = path.join(s.root, '.atelier-local/harnesses/knowledge', fixture.domain.run, 'ledger.json'), identitySnapshot = fs.readFileSync(identityLedger)
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  const sourceText = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const membershipGuard = 'entity.identity.candidateIds.includes(target.id)'
  assert.equal(sourceText.split(membershipGuard).length, 2)
  const identityMutant = await import(`data:text/javascript;base64,${Buffer.from(sourceText.replace(membershipGuard, 'true')).toString('base64')}`)
  try {
    assert.equal(identityMutant.createSemanticOperation(s.options).prepareContribution({ ...claimRequest(), id: 'identity-unsupplied-mutant' }).record.id, 'identity-unsupplied-mutant')
  } finally { fs.writeFileSync(identityLedger, identitySnapshot) }

  approve(entities[0], choice({ status: 'existing', contribution: harnessRef(wrongType) }), '-wrong-type')
  assert.throws(() => s.runner.prepareContribution(claimRequest()), e => e.code === 'SEMANTIC_IDENTITY_PENDING')
  approve(entities[0], choice({ status: 'existing', contribution: { id: canonical.id, digest: `sha256:${'0'.repeat(64)}` } }), '-wrong-digest')
  assert.throws(() => s.runner.prepareContribution(claimRequest()), e => e.code === 'SEMANTIC_IDENTITY_PENDING')
  approve(entities[0], choice({ status: 'source-local' }), '-local')
  const local = s.runner.prepareContribution({ ...claimRequest(), id: 'identity-management-local' }); head = local.head
  assert.deepEqual(JSON.parse(local.record.data.body).endpoints.subject, harnessRef(entities[0]))
  approve(entities[0], choice({ status: 'existing', contribution: harnessRef(canonical) }), '-explicit')
  const firstCompletion = s.runner.status({ operationId: 'first' }).attempt.completion
  const prepared = s.runner.prepareContribution({ ...claimRequest(), supersedes: harnessRef(local.record), revisionReason: 'Simulated receiver explicitly revises the source-local identity choice.' }); head = prepared.head
  assert.deepEqual(JSON.parse(prepared.record.data.body).endpoints.subject, harnessRef(canonical))
  assert.equal(prepared.record.data.basedOn.find(pin => pin.contribution.id === canonical.id).quote, 'Nora')
  approve(prepared.record)
  add(make('activation', 'identity-active', { reviews: [harnessRef(readHarness({ ...s.options, profile: 'knowledge' }).records.find(record => record.id === 'identity-management-review'))], purpose: 'Simulated existing identity readback.', destination: 'local-context', questions: ['component'] }))
  assert.equal(createSemanticOperation(s.options).context({ query: 'manages' }).hits.some(hit => hit.reference.id === prepared.record.id), true)
  assert.ok(prepared.record.data.basedOn.some(pin => pin.contribution.id === entities[0].id), 'The assertion depends on the reviewed identity interpretation as well as its selected target.')
  add(make('activation', 'identity-unaffected-active', { reviews: [harnessRef(readHarness({ ...s.options, profile: 'knowledge' }).records.find(record => record.id === `${entities[2].id}-review`))], purpose: 'Independent accepted identity readback.', destination: 'local-graph', questions: ['component'] }))
  const ledgerFile = path.join(s.root, '.atelier-local/harnesses/knowledge', fixture.domain.run, 'ledger.json')
  const savedLedger = fs.readFileSync(ledgerFile), savedHead = head
  for (const change of ['withdraw', 'evaluate', 'supersede', 're-decide', 'reaccept-local', 'reaccept-prose']) {
    fs.writeFileSync(ledgerFile, savedLedger); head = savedHead
    if (change === 'withdraw') add(make('withdrawal', 'withdraw-identity-choice', { target: harnessRef(entities[0]), reason: 'Simulated receiver withdraws the identity interpretation.' }))
    if (change === 'evaluate') add(make('evaluation', 'reevaluate-identity-choice', { contribution: harnessRef(entities[0]), judgment: 'uncertain', rationale: 'Simulated receiver reconsiders the identity choice.', limitations: ['Invented case'], scope: fixture.domain.data.scope }))
    if (change === 'supersede') {
      const next = s.runner.prepareContribution({ operationId: 'first', id: 'identity-nora-successor', kind: 'entity', candidateId: 'nora', term: 'person', at, confirm: head, ...sourceOptions, supersedes: harnessRef(entities[0]), revisionReason: 'Simulated receiver revises the identity interpretation.' })
      head = next.head; approve(next.record, choice({ status: 'existing', contribution: harnessRef(canonical) }))
    }
    if (change === 're-decide') approve(entities[0], choice({ status: 'source-local' }), '-changed-choice')
    if (change.startsWith('reaccept-')) {
      add(make('evaluation', 'reconsider-identity-before-reaccept', { contribution: harnessRef(entities[0]), judgment: 'uncertain', rationale: 'Invented correction before renewed review.', limitations: ['Invented case'], scope: fixture.domain.data.scope }))
      approve(entities[0], change === 'reaccept-local' ? choice({ status: 'source-local' }) : 'Prose acceptance without an identity choice.', '-renewed')
      approve(prepared.record, 'Receiver re-accepts the original immutable assertion.', '-renewed')
      add(make('activation', 'identity-renewed-active', { reviews: [harnessRef(readHarness({ ...s.options, profile: 'knowledge' }).records.find(record => record.id === 'identity-management-review-renewed'))], purpose: 'Invented re-acceptance readback.', destination: 'local-context', questions: ['component'] }))
      add(make('activation', 'identity-mixed-active', { reviews: ['identity-nora-review-renewed', 'identity-management-review-renewed'].map(id => harnessRef(readHarness({ ...s.options, profile: 'knowledge' }).records.find(record => record.id === id))), purpose: 'Invented mixed activation must be current as a whole.', destination: 'local-context', questions: ['component'] }))
    }
    const reopened = createSemanticOperation(s.options), view = reopened.context({ query: 'manages' })
    if (change.startsWith('reaccept-')) {
      assert.ok(view.diagnostics.some(item => item.id === prepared.record.id && ['SEMANTIC_OPERATION_INTEGRITY', 'SEMANTIC_IDENTITY_PENDING'].includes(item.code)), change)
      const failureMarker = "failures.push({ id: record.id, reason: 'semantic-record-requires-reconsideration', code: error.code })"
      const correctedSource = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
      assert.equal(correctedSource.split(failureMarker).length, 2)
      const unfiltered = await import(`data:text/javascript;base64,${Buffer.from(correctedSource.replace(failureMarker, 'void error')).toString('base64')}`)
      assert.ok(unfiltered.createSemanticOperation(s.options).context({ query: 'manages' }).hits.some(hit => hit.reference.id === prepared.record.id), 'Removing reconsideration exposes the incompatible accepted assertion.')
      assert.throws(() => reopened.project({ activationId: 'identity-renewed-active', namespace: 'fixture' }), e => e.code === 'SEMANTIC_PROJECTION_STALE')
      assert.ok(view.reconsider.some(item => item.id === 'identity-mixed-active'), change)
      assert.equal(reopened.context({ query: 'Nora' }).hits.some(hit => hit.reference.id === entities[0].id), false, 'A withheld mixed activation cannot activate its other members.')
      const activationMarker = 'active.has(hit.reference.id) && !reconsider.has(hit.reference.id)'
      assert.equal(correctedSource.split(activationMarker).length, 2)
      const staleActivation = await import(`data:text/javascript;base64,${Buffer.from(correctedSource.replace(activationMarker, '!reconsider.has(hit.reference.id)')).toString('base64')}`)
      assert.ok(staleActivation.createSemanticOperation(s.options).context({ query: 'Nora' }).hits.some(hit => hit.reference.id === entities[0].id), 'Removing merged activation membership exposes the other member.')
      assert.throws(() => reopened.project({ activationId: 'identity-mixed-active', namespace: 'fixture' }), e => e.code === 'SEMANTIC_PROJECTION_STALE')
      add(make('activation', 'identity-independent-renewed', { reviews: [harnessRef(readHarness({ ...s.options, profile: 'knowledge' }).records.find(record => record.id === 'identity-nora-review-renewed'))], purpose: 'Independent current activation of the compatible identity.', destination: 'local-graph', questions: ['component'] }))
      assert.ok(reopened.context({ query: 'Nora' }).hits.some(hit => hit.reference.id === entities[0].id))
      assert.ok(reopened.project({ activationId: 'identity-independent-renewed', namespace: 'fixture' }).semanticEntities.some(entity => entity.record.id === entities[0].id))
    }
    assert.equal(view.hits.some(hit => hit.reference.id === prepared.record.id), false, change)
    assert.ok(view.reconsider.some(item => item.id === prepared.record.id || item.id === 'identity-management-review'), change)
    assert.throws(() => reopened.project({ activationId: 'identity-active', namespace: 'fixture' }), e => e.code.startsWith('SEMANTIC_PROJECTION_'))
    assert.ok(reopened.project({ activationId: 'identity-unaffected-active', namespace: 'fixture' }).semanticEntities.some(entity => entity.record.id === entities[2].id), change)
    assert.deepEqual(reopened.status({ operationId: 'first' }).attempt.completion, firstCompletion)
  }
  fs.writeFileSync(ledgerFile, savedLedger); head = savedHead
  add(make('withdrawal', 'withdraw-canonical', { target: harnessRef(canonical), reason: 'Simulated withdrawal of the explicitly selected identity.' }))
  assert.equal(createSemanticOperation(s.options).context({ query: 'manages' }).hits.some(hit => hit.reference.id === prepared.record.id), false)
  assert.throws(() => s.runner.prepareContribution({ ...claimRequest(), id: 'identity-management-v3', supersedes: harnessRef(prepared.record), revisionReason: 'Simulated attempted reuse of a withdrawn identity.' }), e => e.code === 'SEMANTIC_IDENTITY_PENDING')
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
  assert.throws(() => support.assertSemanticProjection(selected), e => e.code === 'SEMANTIC_PROJECTION_STALE')
  const wrong = projectionFixture({ support: 'wrong-digest' }), selectedWrong = { records: wrong.records, activationId: wrong.activation.id }
  assert.throws(() => assertSemanticProjection(selectedWrong), e => e.code === 'SEMANTIC_PROJECTION_SUPPORT')
  const digest = await mutant('Relation assertion support digest differs')
  assert.ok(digest.assertSemanticProjection(selectedWrong).selected.includes(wrong.assertions[0].id))
  const sourceUnit = witnessSource(0, ['missing passage']); sourceUnit.record.data.body = 'Different content.'
  const selectedWitness = { citations: sourceUnit.citations, sources: [sourceUnit.record] }
  assert.throws(() => semanticDependencyWitnesses(selectedWitness), e => e.code === 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION')
  const witness = await mutant('The encoded dependency witness is absent from the stored contribution body')
  assert.equal(witness.semanticDependencyWitnesses(selectedWitness).basedOn[0].quote, 'missing passage')
  const negative = { id: 'negative', objectId: 'atlas', direction: 'subject-to-object', negated: true, modality: 'asserted', scope: fixture.domain.data.scope, time: { from: null, until: null, expression: null, unknowns: [] } }
  const marker = "if (assertion.negated !== false) reasons.push('negated')"
  assert.equal(source.split(marker).length, 2)
  const negation = await import(`data:text/javascript;base64,${Buffer.from(source.replace(marker, "if (false) reasons.push('negated')")).toString('base64')}`)
  assert.equal(plainAssertionEligibility(negative, fixture.domain).eligible, false)
  assert.equal(negation.plainAssertionEligibility(negative, fixture.domain).eligible, true)
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
  assert.throws(() => mutant.createSemanticOperation(s.options).begin(request), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED')
})

transactionTest('a reservation already owns its attempt identity before intake publication', async t => {
  const s = setup(t), first = s.runner.begin(s.begin)
  fs.rmSync(path.join(s.root, '.atelier-local/intake/attempts/model-first'), { recursive: true })
  assert.equal(s.runner.status({ operationId: 'first' }).attempt.status, 'absent')
  const next = { ...s.begin, operationId: 'second', confirm: first.head, extractor: { ...s.begin.extractor, version: '2.0.0' } }
  assert.throws(() => s.runner.begin(next), e => e.code === 'SEMANTIC_OPERATION_EXISTS')
  const ledgerFile = path.join(s.root, '.atelier-local/harnesses/knowledge', fixture.domain.run, 'ledger.json'), snapshot = fs.readFileSync(ledgerFile)
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const marker = '!starts.some(prior => prior.value.attemptId === attemptId)'
  assert.equal(source.split(marker).length, 2)
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(marker, 'true')).toString('base64')}`)
  try { assert.equal(mutant.createSemanticOperation(s.options).begin(next).execution, 'ready-for-host') }
  finally { fs.writeFileSync(ledgerFile, snapshot); fs.rmSync(path.join(s.root, '.atelier-local/intake/attempts/model-first'), { recursive: true, force: true }) }

  assert.equal(s.runner.status({ operationId: 'first' }).attempt.status, 'absent')
  assert.equal(readHarness({ ...s.options, profile: 'knowledge' }).head, first.head)
  const reconciled = s.runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Invented crash before intake and before host execution.', outcome: 'not-executed', confirm: first.head })
  assert.equal(s.runner.begin({ ...next, attemptId: 'model-second', confirm: reconciled.head }).execution, 'ready-for-host')
})

transactionTest('stale source completion retains executed raw bytes before refusing interpretation', t => {
  const s = setup(t), first = s.runner.begin(s.begin), candidates = emptyCandidates(first.input), output = JSON.stringify(candidates)
  fs.appendFileSync(path.join(s.root, 'notes.txt'), 'Changed while the invented host was running.\n')
  const request = { operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }
  let failure
  try { s.runner.complete(request) } catch (error) { failure = error }
  assert.equal(failure?.code, 'SEMANTIC_OPERATION_STALE')
  const reopened = createSemanticOperation(s.options).status({ operationId: 'first' })
  assert.equal(reopened.attempt.status, 'complete'); assert.equal(reopened.attempt.output, output)
  assert.equal(reopened.execution, 'complete'); assert.equal(reopened.freshness, 'stale'); assert.equal(reopened.phase, 'reserved')
  assert.deepEqual(failure.captured.completion, reopened.attempt.completion)
  assert.equal(failure.captured.head, first.head)
  assert.throws(() => s.runner.complete(request), e => e.code === 'SEMANTIC_OPERATION_STALE' && e.captured.completion.outputDigest === intakeDigest(output))
  assert.throws(() => s.runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Cannot call actual completed output unexecuted.', outcome: 'not-executed', confirm: first.head }), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED')
})

transactionTest('begin refuses a reservation reconciled before intake publication with saved custody', async t => {
  const s = setup(t), moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  let source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const marker = '    intake.beginAttempt({ attemptId, blobId: source.digest'
  assert.equal(source.split(marker).length, 2)
  source = source.replace(marker, '    globalThis.__atelierSemanticReservationFixture();\n' + marker)
  let reservation
  globalThis.__atelierSemanticReservationFixture = () => {
    const current = readHarness({ ...s.options, profile: 'knowledge' })
    reservation = current
    s.runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Invented concurrent reconciliation before host execution.', outcome: 'not-executed', confirm: current.head })
  }
  t.after(() => { delete globalThis.__atelierSemanticReservationFixture })
  const ledgerFile = path.join(s.root, '.atelier-local/harnesses/knowledge', fixture.domain.run, 'ledger.json'), snapshot = fs.readFileSync(ledgerFile)
  const instrumented = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  let failure
  try { instrumented.createSemanticOperation(s.options).begin(s.begin) } catch (error) { failure = error }
  assert.equal(failure?.code, 'SEMANTIC_RECONCILE_REQUIRED')
  const status = s.runner.status({ operationId: 'first' })
  assert.equal(status.phase, 'reconciled'); assert.equal(status.execution, 'reconciled')
  assert.equal(failure.recorded.head, reservation.head)
  assert.notEqual(failure.recorded.head, status.head, 'Saved receipt head is diagnostic; reopen obtains the later current head.')
  assert.ok(readHarness({ ...s.options, profile: 'knowledge' }).records.some(record => record.id === failure.recorded.record.id))
  fs.writeFileSync(ledgerFile, snapshot); fs.rmSync(path.join(s.root, '.atelier-local/intake/attempts/model-first'), { recursive: true })
  const guard = "ready.phase === 'reserved' && ready.head === recorded.head"
  assert.equal(source.split(guard).length, 2)
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(guard, 'true')).toString('base64')}`)
  assert.equal(mutant.createSemanticOperation(s.options).begin(s.begin).execution, 'ready-for-host')

})

// Instrument only the runner's direct store imports, retaining real canonical
// writes and readback. No fault hook is added to the shipped implementation.
async function receiptFaultRunner(t, options, inspectModule = () => {}) {
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  const asModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  const harness = asModule(`
    import * as native from ${JSON.stringify(new URL('../src/harnesses/store.mjs', import.meta.url).href)};
    export function appendHarness(request) {
      const fault = globalThis.__atelierSemanticReceiptFault;
      if (fault?.mode === 'append-failure') { fault.failureThrown = true; throw fault.primary; }
      const result = native.appendHarness(request);
      if (fault) { fault.recorded = true; fault.appendReceipt = result; fault.record = request.record; }
      return result;
    }
    export function readHarness(request) {
      const fault = globalThis.__atelierSemanticReceiptFault;
      if (fault) {
        fault.historyReads = (fault.historyReads ?? 0) + 1;
        if (fault.failureThrown) { fault.catchHistoryReads = (fault.catchHistoryReads ?? 0) + 1; throw fault.secondary; }
        if (fault.mode === 'begin-failure' && fault.recorded) throw fault.secondary;
        if (fault.mode === 'usage-failure' && fault.historyReads === 3) throw fault.secondary;
        if (['reconcile-failure', 'completed-status-failure', 'verified-result-failure'].includes(fault.mode) && fault.recorded) {
          if (fault.failedOnce) throw fault.secondary;
          fault.failedOnce = true; fault.failureThrown = true; throw fault.primary;
        }
      }
      return native.readHarness(request);
    }
  `)
  const intake = asModule(`
    import { createIntakeStore as native } from ${JSON.stringify(new URL('../src/intake/store.mjs', import.meta.url).href)};
    export { intakeDigest } from ${JSON.stringify(new URL('../src/intake/store.mjs', import.meta.url).href)};
    export function createIntakeStore(options) {
      const store = native(options);
      return Object.freeze({ ...store,
        beginAttempt(request) {
          const fault = globalThis.__atelierSemanticReceiptFault;
          if (fault?.mode === 'begin-failure') { fault.failureThrown = true; throw fault.primary; }
          return store.beginAttempt(request);
        },
        completeAttempt(request) {
          const result = store.completeAttempt(request);
          const fault = globalThis.__atelierSemanticReceiptFault;
          if (fault) { fault.captured = true; fault.completion = result; }
          return result;
        },
        readAttempt(attemptId) {
          const fault = globalThis.__atelierSemanticReceiptFault;
          if (fault?.mode === 'capture-read-failure' && fault.captured) { fault.failureThrown = true; throw fault.primary; }
          return store.readAttempt(attemptId);
        },
      });
    }
  `)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => {
    if (ref === '../harnesses/store.mjs') return `from ${JSON.stringify(harness)}`
    if (ref === '../intake/store.mjs') return `from ${JSON.stringify(intake)}`
    return ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original
  })
  t.after(() => { delete globalThis.__atelierSemanticReceiptFault })
  const module = await import(asModule(source))
  inspectModule(module)
  return module.createSemanticOperation(options)
}
function receiptFault(mode) {
  return globalThis.__atelierSemanticReceiptFault = { mode,
    primary: Object.assign(new Error('Invented primary store failure'), { code: 'E_PRIMARY' }),
    secondary: Object.assign(new Error('Invented catch-side read failure'), { code: 'E_SECONDARY' }),
  }
}
function completionRequest(first, overrides = {}) {
  const candidates = emptyCandidates(first.input), output = JSON.stringify(candidates)
  return { operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head, ...overrides }
}
function thrownReceiptError(fn) {
  let failure, caught = false
  try { fn() } catch (error) { failure = error; caught = true }
  assert.equal(caught, true, 'The injected store failure must be observed, including null or undefined.')
  return failure
}
function savedCapture(s, request, fault) {
  delete globalThis.__atelierSemanticReceiptFault
  const saved = createIntakeStore(s.options).readAttempt('model-first')
  assert.equal(saved.status, 'complete'); assert.equal(saved.output, request.output)
  assert.deepEqual(saved.completion, fault.completion)
  return saved
}

function arbitraryReceiptFailures(mode) {
  const error = () => Object.assign(new Error('Invented original storage failure'), { code: 'E_PRIMARY' })
  const accessCalls = { get: 0, set: 0 }
  const shapes = [
    { id: 'extensible-error', make: error, retainsIdentity: true },
    { id: 'frozen-error', make: () => Object.freeze(error()) },
    { id: 'nonextensible-error', make: () => Object.preventExtensions(error()) },
    { id: 'sealed-error', make: () => Object.seal(error()) },
    { id: 'readonly-receipts', make: () => Object.defineProperties(error(), {
      recorded: { value: 'original-recorded', writable: false }, captured: { value: 'original-captured', writable: false },
    }) },
    { id: 'accessor-receipts', make: () => Object.defineProperties(error(), Object.fromEntries(['recorded', 'captured'].map(key => [key, {
      get() { accessCalls.get++; return 'original-receipt' },
      set() { accessCalls.set++ },
    }]))), accessCalls },
    { id: 'writable-nonconfigurable-receipts', make: () => Object.defineProperties(error(), {
      recorded: { value: 'original-recorded', writable: true }, captured: { value: 'original-captured', writable: true },
    }), retainsIdentity: true },
    { id: 'frozen-semantic-error', make: () => Object.freeze(new SemanticOperationError('SEMANTIC_OPERATION_HEAD', 'Invented original head failure')) },
    { id: 'null', make: () => null }, { id: 'undefined', make: () => undefined },
    { id: 'string', make: () => 'Invented original failure' }, { id: 'zero', make: () => 0 },
    { id: 'false', make: () => false }, { id: 'symbol', make: () => Symbol('invented failure') },
    { id: 'bigint', make: () => 1n },
  ]
  if (mode === 'completed-status-failure') shapes.push(
    { id: 'mixed-captured-writable-recorded-readonly', make: () => Object.defineProperties(error(), {
      captured: { value: 'original-captured', writable: true }, recorded: { value: 'original-recorded', writable: false },
    }) },
    { id: 'mixed-captured-readonly-recorded-writable', make: () => Object.defineProperties(error(), {
      captured: { value: 'original-captured', writable: false }, recorded: { value: 'original-recorded', writable: true },
    }) },
  )
  return shapes
}

for (const mode of ['begin-failure', 'reconcile-failure', 'capture-read-failure', 'completed-status-failure', 'verified-result-failure']) {
  transactionTest(`arbitrary thrown values preserve saved receipts through ${mode}`, async t => {
    for (const shape of arbitraryReceiptFailures(mode)) await t.test(shape.id, async t => {
      const s = setup(t)
      let FailureClass
      const runner = await receiptFaultRunner(t, s.options, module => { FailureClass = module.SemanticOperationError })
      let first, request, preparedRequest
      if (mode !== 'begin-failure') first = runner.begin(s.begin)
      if (['capture-read-failure', 'completed-status-failure'].includes(mode)) request = completionRequest(first)
      if (mode === 'verified-result-failure') {
        const candidates = extractedCandidates(first.input), output = JSON.stringify(candidates)
        let head = runner.complete({ ...completionRequest(first), candidates, output, expectedOutputDigest: intakeDigest(output) }).head
        const source = prepareIngestionContribution({ ...s.options, records: readHarness({ ...s.options, profile: 'knowledge' }).records,
          ...s.begin.plan, sourceId: 'notes', title: 'Invented source', term: 'material' })
        const sourceRecord = { schema: 'atelier-knowledge-record@v1', id: 'arbitrary-source', run: fixture.domain.run, at,
          by: 'simulated-receiver', kind: 'contribution', data: source.data }
        head = appendHarness({ ...s.options, profile: 'knowledge', record: sourceRecord, confirm: head }).head
        preparedRequest = { operationId: 'first', id: 'arbitrary-entity', kind: 'entity', candidateId: 'nora', term: 'person', at,
          confirm: head, source: harnessRef(sourceRecord), sourceBinding: source.sourceBinding }
      }
      const fault = receiptFault(mode), original = shape.make()
      fault.primary = original
      const descriptors = original && typeof original === 'object' ? Object.getOwnPropertyDescriptors(original) : null
      const failure = thrownReceiptError(() => {
        if (mode === 'begin-failure') return runner.begin(s.begin)
        if (mode === 'reconcile-failure') return runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver',
          reason: 'Invented host did not execute.', outcome: 'not-executed', confirm: first.head })
        if (mode === 'verified-result-failure') return runner.prepareContribution(preparedRequest)
        return runner.complete(request)
      })
      assert.equal(fault.failureThrown, true, 'The intended original failure point was reached.')
      assert.equal(fault.catchHistoryReads ?? 0, 0, 'No catch-side history read may replace the original failure.')
      if (shape.accessCalls) assert.deepEqual(shape.accessCalls, { get: 0, set: 0 }, 'Accessor calls must be observed outside the recovery helper.')
      if (shape.retainsIdentity) assert.equal(failure, original)
      else {
        assert.ok(failure instanceof FailureClass)
        assert.equal(failure.cause, original); assert.equal(Object.hasOwn(failure, 'cause'), true)
        assert.equal(Object.getOwnPropertyDescriptor(failure, 'cause').enumerable, false)
        assert.equal(failure.code, shape.id === 'frozen-semantic-error' ? 'SEMANTIC_OPERATION_HEAD' : 'SEMANTIC_OPERATION_INTERRUPTED')
        assert.doesNotThrow(() => JSON.stringify(failure), 'Primitive causes must not break existing JSON error reporting.')
        if (descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(original), descriptors)
      }
      delete globalThis.__atelierSemanticReceiptFault
      const history = readHarness({ ...s.options, profile: 'knowledge' })
      const reopened = createSemanticOperation(s.options).status({ operationId: 'first' })
      assert.equal(reopened.head, history.head)
      const captured = ['capture-read-failure', 'completed-status-failure'].includes(mode)
      const recorded = mode !== 'capture-read-failure'
      if (recorded) {
        const savedRecord = history.records.find(record => record.id === fault.record.id)
        assert.ok(savedRecord); assert.deepEqual(failure.recorded.record, harnessRef(savedRecord))
        assert.equal(failure.recorded.head, history.head); assert.equal(failure.recorded.nextAction, 'reopen-recorded-write')
      }
      if (captured) {
        const saved = createIntakeStore(s.options).readAttempt('model-first')
        assert.equal(saved.status, 'complete'); assert.equal(saved.output, request.output)
        assert.deepEqual(failure.captured.completion, saved.completion)
        assert.equal(failure.captured.attemptId, 'model-first'); assert.equal(failure.captured.head, history.head)
        assert.equal(saved.completion.outputDigest, intakeDigest(request.output))
        if (!recorded) assert.equal(createSemanticOperation(s.options).complete({ ...request, confirm: reopened.head }).phase, 'completed')
      }
      const serialized = JSON.parse(JSON.stringify(failure))
      for (const [key, saved] of [['recorded', recorded], ['captured', captured]]) if (saved) {
        if (Object.getOwnPropertyDescriptor(failure, key).enumerable) assert.deepEqual(serialized[key], failure[key])
        else assert.equal(Object.hasOwn(serialized, key), false, 'Existing non-enumerable receipt attributes must remain intact.')
      }
      if (!shape.retainsIdentity) {
        assert.equal(serialized.code, failure.code); assert.equal(serialized.name, 'SemanticOperationError')
        assert.equal(Object.hasOwn(serialized, 'cause'), false, 'Existing JSON reporting excludes the original thrown value.')
      }
      if (mode === 'begin-failure') {
        assert.equal(reopened.attempt.status, 'absent'); assert.equal(reopened.phase, 'reserved')
        assert.equal(createSemanticOperation(s.options).reconcile({ operationId: 'first', at, by: 'simulated-receiver',
          reason: 'Invented storage refused before execution.', outcome: 'not-executed', confirm: reopened.head }).phase, 'reconciled')
      } else if (mode === 'reconcile-failure') assert.equal(reopened.phase, 'reconciled')
      else {
        const current = createSemanticOperation(s.options).status({ operationId: 'first' })
        const cached = createSemanticOperation(s.options).begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: current.head })
        assert.equal(cached.cacheReuse, true); assert.equal(cached.operationId, 'first')
        assert.equal(createIntakeStore(s.options).readAttempt('model-second').status, 'absent')
        if (mode === 'verified-result-failure') {
          const saved = createIntakeStore(s.options).readAttempt('model-first')
          const body = JSON.parse(history.records.find(record => record.id === preparedRequest.id).data.body)
          assert.equal(body.raw.completionDigest, intakeDigest(JSON.stringify(saved.completion)))
        }
      }
      if (shape.id === 'writable-nonconfigurable-receipts') for (const key of ['recorded', 'captured']) {
        const actual = Object.getOwnPropertyDescriptor(original, key)
        assert.equal(actual.configurable, descriptors[key].configurable); assert.equal(actual.enumerable, descriptors[key].enumerable)
        assert.equal(actual.writable, descriptors[key].writable)
      }
    })
  })
}

transactionTest('arbitrary thrown values remain unchanged when no reservation was saved', async t => {
  for (const shape of arbitraryReceiptFailures()) await t.test(shape.id, async t => {
    const s = setup(t), runner = await receiptFaultRunner(t, s.options), fault = receiptFault('append-failure')
    const original = shape.make(); fault.primary = original
    const descriptors = original && typeof original === 'object' ? Object.getOwnPropertyDescriptors(original) : null
    assert.equal(thrownReceiptError(() => runner.begin(s.begin)), original)
    if (shape.accessCalls) assert.deepEqual(shape.accessCalls, { get: 0, set: 0 })
    if (descriptors) assert.deepEqual(Object.getOwnPropertyDescriptors(original), descriptors)
    delete globalThis.__atelierSemanticReceiptFault
    assert.equal(readHarness({ ...s.options, profile: 'knowledge' }).head, s.begin.confirm)
    assert.equal(createIntakeStore(s.options).readAttempt('model-first').status, 'absent')
  })
})

transactionTest('saved receipts preserve the original post-capture inspection error and recover identical output', async t => {
  const s = setup(t), runner = await receiptFaultRunner(t, s.options), first = runner.begin(s.begin)
  const request = completionRequest(first), fault = receiptFault('capture-read-failure')
  const failure = thrownReceiptError(() => runner.complete(request))
  assert.equal(failure, fault.primary); assert.equal(failure.code, 'E_PRIMARY')
  assert.deepEqual(failure.captured.completion, fault.completion)
  assert.equal(failure.captured.attemptId, 'model-first'); assert.equal(failure.captured.head, first.head)
  assert.equal(failure.recorded, undefined)
  savedCapture(s, request, fault)
  const completed = createSemanticOperation(s.options).complete(request)
  assert.equal(completed.phase, 'completed'); assert.equal(completed.attempt.output, request.output)
  assert.deepEqual(completed.attempt.completion, fault.completion)
  const cached = createSemanticOperation(s.options).begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: completed.head })
  assert.equal(cached.cacheReuse, true); assert.equal(cached.operationId, 'first')
  assert.equal(createIntakeStore(s.options).readAttempt('model-second').status, 'absent')
})

transactionTest('saved receipts retain usage refusal without any catch-side history read', async t => {
  const s = setup(t), runner = await receiptFaultRunner(t, s.options), first = runner.begin(s.begin)
  const request = completionRequest(first, { usage: { ...unknownUsage, inputTokens: -1 } }), fault = receiptFault('usage-failure')
  const failure = thrownReceiptError(() => runner.complete(request))
  assert.equal(failure.code, 'SEMANTIC_OPERATION_INVALID'); assert.match(failure.message, /Usage counts/)
  assert.equal(fault.historyReads, 2, 'A third history read would replace the original refusal.')
  assert.deepEqual(failure.captured.completion, fault.completion); assert.equal(failure.captured.head, first.head)
  assert.equal(failure.recorded, undefined)
  savedCapture(s, request, fault)
  assert.equal(createSemanticOperation(s.options).complete({ ...request, usage: unknownUsage }).phase, 'completed')
})

transactionTest('saved receipts retain the original begin failure and committed reservation before explicit recovery', async t => {
  const s = setup(t), runner = await receiptFaultRunner(t, s.options), fault = receiptFault('begin-failure')
  const failure = thrownReceiptError(() => runner.begin(s.begin))
  assert.equal(failure, fault.primary); assert.equal(failure.code, 'E_PRIMARY')
  assert.deepEqual(failure.recorded.record, harnessRef(fault.record)); assert.equal(failure.recorded.head, fault.appendReceipt.head)
  assert.equal(failure.recorded.nextAction, 'reopen-recorded-write'); assert.equal(failure.captured, undefined)
  delete globalThis.__atelierSemanticReceiptFault
  const reopened = createSemanticOperation(s.options).status({ operationId: 'first' })
  assert.equal(reopened.phase, 'reserved'); assert.equal(reopened.attempt.status, 'absent'); assert.equal(reopened.head, fault.appendReceipt.head)
  const reconciled = createSemanticOperation(s.options).reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Invented store failure before host execution.', outcome: 'not-executed', confirm: reopened.head })
  assert.equal(reconciled.phase, 'reconciled')
  assert.equal(createSemanticOperation(s.options).begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: reconciled.head }).execution, 'ready-for-host')
})

transactionTest('saved receipts retain the original reconciliation status failure and committed record', async t => {
  const s = setup(t), runner = await receiptFaultRunner(t, s.options), first = runner.begin(s.begin), fault = receiptFault('reconcile-failure')
  const failure = thrownReceiptError(() => runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Invented host did not execute.', outcome: 'not-executed', confirm: first.head }))
  assert.equal(failure, fault.primary); assert.deepEqual(failure.recorded.record, harnessRef(fault.record))
  assert.equal(failure.recorded.head, fault.appendReceipt.head); assert.equal(failure.captured, undefined)
  delete globalThis.__atelierSemanticReceiptFault
  const reopened = createSemanticOperation(s.options).status({ operationId: 'first' })
  assert.equal(reopened.phase, 'reconciled'); assert.equal(reopened.head, fault.appendReceipt.head)
})

transactionTest('saved receipts retain original post-completion status failure with capture and committed record', async t => {
  const s = setup(t), runner = await receiptFaultRunner(t, s.options), first = runner.begin(s.begin)
  const request = completionRequest(first), fault = receiptFault('completed-status-failure')
  const failure = thrownReceiptError(() => runner.complete(request))
  assert.equal(failure, fault.primary); assert.deepEqual(failure.recorded.record, harnessRef(fault.record))
  assert.equal(failure.recorded.head, fault.appendReceipt.head); assert.equal(failure.captured.head, fault.appendReceipt.head)
  assert.deepEqual(failure.captured.completion, fault.completion)
  savedCapture(s, request, fault)
  const reopened = createSemanticOperation(s.options).status({ operationId: 'first' })
  assert.equal(reopened.phase, 'completed'); assert.equal(reopened.head, fault.appendReceipt.head)
  assert.deepEqual(reopened.attempt.completion, fault.completion)
})

transactionTest('saved receipts never claim a reservation when append failed before publication', async t => {
  const s = setup(t), runner = await receiptFaultRunner(t, s.options), fault = receiptFault('append-failure')
  const failure = thrownReceiptError(() => runner.begin(s.begin))
  assert.equal(failure, fault.primary); assert.equal(failure.recorded, undefined); assert.equal(failure.captured, undefined)
  delete globalThis.__atelierSemanticReceiptFault
  assert.equal(createIntakeStore(s.options).readAttempt('model-first').status, 'absent')
  assert.equal(readHarness({ ...s.options, profile: 'knowledge' }).head, s.begin.confirm)
})

transactionTest('saved receipts never claim raw capture when completion refuses before publication', t => {
  const s = setup(t), first = s.runner.begin(s.begin), request = completionRequest(first, { expectedOutputDigest: 'f'.repeat(64) })
  const failure = thrownReceiptError(() => s.runner.complete(request))
  assert.match(failure.message, /output digest mismatch/); assert.equal(failure.captured, undefined); assert.equal(failure.recorded, undefined)
  const reopened = createSemanticOperation(s.options).status({ operationId: 'first' })
  assert.equal(reopened.attempt.status, 'begun'); assert.equal(reopened.attempt.output, null); assert.equal(reopened.head, first.head)
})

transactionTest('saved receipts leave successful begin complete cache and public record responses unchanged', async t => {
  const s = setup(t), runner = await receiptFaultRunner(t, s.options), first = runner.begin(s.begin), request = completionRequest(first)
  const completed = runner.complete(request)
  assert.equal(completed.phase, 'completed'); assert.deepEqual(completed.usage, unknownUsage)
  const cached = runner.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: completed.head })
  assert.equal(cached.cacheReuse, true); assert.equal(createIntakeStore(s.options).readAttempt('model-second').status, 'absent')
  const contribution = { schema: 'atelier-knowledge-record@v1', id: 'receipt-material', run: fixture.domain.run, at, by: 'simulated-receiver', kind: 'contribution', data: {
    domain: harnessRef(fixture.domain), category: 'interpretation', term: 'material', title: 'Invented receipt control', body: 'Invented observation only.', audience: fixture.domain.data.audience, scope: fixture.domain.data.scope,
    origin: { method: 'authored', reason: 'Simulated control fixture only.' }, basedOn: [],
  } }
  const contributed = appendHarness({ ...s.options, profile: 'knowledge', record: contribution, confirm: completed.head })
  const record = { schema: 'atelier-knowledge-record@v1', id: 'receipt-control', run: fixture.domain.run, at, by: 'simulated-receiver', kind: 'evaluation', data: {
    contribution: harnessRef(contribution), judgment: 'supported', rationale: 'Simulated receiver evaluation only.', limitations: ['Not a human acceptance result'], scope: fixture.domain.data.scope,
  } }
  const result = runner.record({ record, confirm: contributed.head })
  assert.deepEqual(Object.keys(result).sort(), ['authority', 'head', 'reconsider', 'recorded'])
  assert.equal(result.recorded, record.id); assert.equal(result.authority, 'none')
})

transactionTest('cascade skips a generated relation whose assertion support digest differs', t => {
  const s = setup(t), graph = projectionFixture({ support: 'wrong-digest' })
  let head = s.begin.confirm
  for (const record of graph.records.slice(1)) head = appendHarness({ ...s.options, profile: 'knowledge', record, confirm: head }).head
  head = s.runner.record({ record: graph.make('withdrawal', 'wrong-pin-withdrawal', { target: harnessRef(graph.assertions[0]), reason: 'Simulated withdrawal cannot authorize cleanup under a different support digest.' }), confirm: head }).head
  assert.deepEqual(s.runner.cascade({ withdrawalId: 'wrong-pin-withdrawal', at, confirm: head }).cleaned, [])
  assert.equal(readHarness({ ...s.options, profile: 'knowledge' }).records.some(record => record.kind === 'withdrawal' && record.data.target.id === graph.relations[0].id), false)
})

transactionTest('a reconciled reservation permits a new attempt when another run took its absent intake ID', t => {
  const s = setup(t), first = s.runner.begin(s.begin)
  fs.rmSync(path.join(s.root, '.atelier-local/intake/attempts/model-first'), { recursive: true })
  const reconciled = s.runner.reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Invented host confirms no execution before intake publication.', outcome: 'not-executed', confirm: first.head })
  const otherDomain = { ...structuredClone(fixture.domain), id: 'other-run', run: 'other-run' }
  const otherHead = appendHarness({ ...s.options, profile: 'knowledge', record: otherDomain, confirm: EMPTY_HARNESS_HEAD }).head
  const other = createSemanticOperation({ ...s.options, run: 'other-run' })
  assert.equal(other.begin({ ...s.begin, confirm: otherHead }).execution, 'ready-for-host')
  assert.throws(() => s.runner.status({ operationId: 'first' }), e => e.code === 'SEMANTIC_OPERATION_INTEGRITY')
  assert.equal(s.runner.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: reconciled.head }).execution, 'ready-for-host')
  assert.equal(other.status({ operationId: 'first' }).execution, 'unknown')
})

transactionTest('an unreconciled reservation can recover a foreign immutable intake manifest without claiming its bytes', async t => {
  const s = setup(t), first = s.runner.begin(s.begin)
  fs.rmSync(path.join(s.root, '.atelier-local/intake/attempts/model-first'), { recursive: true })
  const otherDomain = { ...structuredClone(fixture.domain), id: 'collision-run', run: 'collision-run' }
  const otherHead = appendHarness({ ...s.options, profile: 'knowledge', record: otherDomain, confirm: EMPTY_HARNESS_HEAD }).head
  const other = createSemanticOperation({ ...s.options, run: 'collision-run' }), otherFirst = other.begin({ ...s.begin, confirm: otherHead })
  const otherCandidates = emptyCandidates(otherFirst.input), otherOutput = JSON.stringify(otherCandidates)
  const otherCompletion = other.complete({ operationId: 'first', output: otherOutput, expectedOutputDigest: intakeDigest(otherOutput), candidates: otherCandidates, usage: unknownUsage, at, confirm: otherFirst.head })
  assert.throws(() => s.runner.status({ operationId: 'first' }), e => e.code === 'SEMANTIC_OPERATION_INTEGRITY')
  const request = { operationId: 'first', at, by: 'simulated-receiver', reason: 'Foreign immutable manifest proves the interrupted reservation never published its own attempt.', outcome: 'not-executed', confirm: first.head }
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const marker = 'const foreign = foreignAttempt(initial, attempt)'
  assert.equal(source.split(marker).length, 2)
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(marker, 'const foreign = false')).toString('base64')}`)
  assert.throws(() => mutant.createSemanticOperation(s.options).reconcile(request), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED')
  assert.throws(() => s.runner.reconcile({ ...request, outcome: 'failed-no-output' }), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED')
  const recovered = s.runner.reconcile(request)
  assert.equal(recovered.phase, 'reconciled'); assert.equal(recovered.execution, 'reconciled')
  assert.equal(recovered.attempt.status, 'foreign-manifest'); assert.equal(recovered.attempt.output, undefined)
  assert.deepEqual(other.status({ operationId: 'first' }).attempt.completion, otherCompletion.attempt.completion)
  assert.equal(s.runner.begin({ ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: recovered.head }).execution, 'ready-for-host')
})

transactionTest('completion refuses a foreign begun manifest before publishing any raw output', async t => {
  const s = setup(t), first = s.runner.begin(s.begin)
  fs.rmSync(path.join(s.root, '.atelier-local/intake/attempts/model-first'), { recursive: true })
  const otherDomain = { ...structuredClone(fixture.domain), id: 'capture-collision', run: 'capture-collision' }
  const otherHead = appendHarness({ ...s.options, profile: 'knowledge', record: otherDomain, confirm: EMPTY_HARNESS_HEAD }).head
  const other = createSemanticOperation({ ...s.options, run: 'capture-collision' })
  other.begin({ ...s.begin, confirm: otherHead })
  const candidates = emptyCandidates(first.input), output = JSON.stringify(candidates)
  assert.throws(() => s.runner.complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }), e => e.code === 'SEMANTIC_OPERATION_INTEGRITY')
  const foreign = other.status({ operationId: 'first' })
  assert.equal(foreign.attempt.status, 'begun'); assert.equal(foreign.attempt.output, null)
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  const source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const marker = 'const before = inspected(initial)'
  assert.equal(source.split(marker).length, 2)
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(marker, "const before = { status: 'begun' }")).toString('base64')}`)
  assert.throws(() => mutant.createSemanticOperation(s.options).complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }), e => e.code === 'SEMANTIC_OPERATION_INTEGRITY')
  assert.equal(other.status({ operationId: 'first' }).attempt.output, output, 'Removing pre-publication custody writes into the foreign attempt.')
})

transactionTest('completion requires a present own manifest across the pre-publication interval', async t => {
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  let source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const inspectedStart = source.indexOf('  function inspected(')
  const inspectedEnd = source.indexOf('\n  function ', inspectedStart + 1)
  const returnAt = source.indexOf('    return result\n  }', inspectedStart)
  assert.ok(inspectedStart >= 0 && returnAt > inspectedStart && returnAt < inspectedEnd)
  source = source.slice(0, returnAt) + '    globalThis.__atelierSemanticAbsentCompleteFixture?.(result)\n' + source.slice(returnAt)
  t.after(() => { delete globalThis.__atelierSemanticAbsentCompleteFixture })
  async function scenario(text, expectedCode) {
    const s = setup(t), first = s.runner.begin(s.begin)
    fs.rmSync(path.join(s.root, '.atelier-local/intake/attempts/model-first'), { recursive: true })
    const domain = { ...structuredClone(fixture.domain), id: 'interval-collision', run: 'interval-collision' }
    const head = appendHarness({ ...s.options, profile: 'knowledge', record: domain, confirm: EMPTY_HARNESS_HEAD }).head
    const other = createSemanticOperation({ ...s.options, run: domain.run })
    globalThis.__atelierSemanticAbsentCompleteFixture = result => {
      if (result.status === 'absent') other.begin({ ...s.begin, confirm: head })
    }
    const instrumented = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
    const candidates = emptyCandidates(first.input), output = JSON.stringify(candidates)
    assert.throws(() => instrumented.createSemanticOperation(s.options).complete({ operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }), e => e.code === expectedCode)
    return { attempt: other.status({ operationId: 'first' }).attempt, output }
  }
  const safe = await scenario(source, 'SEMANTIC_RECONCILE_REQUIRED')
  assert.equal(safe.attempt.status, 'begun'); assert.equal(safe.attempt.output, null)
  const guard = "before.status !== 'absent'"
  assert.equal(source.split(guard).length, 2)
  const unsafe = await scenario(source.replace(guard, 'true'), 'SEMANTIC_OPERATION_INTEGRITY')
  assert.equal(unsafe.attempt.status, 'complete'); assert.equal(unsafe.attempt.output, unsafe.output)
})

transactionTest('begin refuses completed intake before declaring readiness and retains reservation custody', async t => {
  const moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  let source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const marker = '      const ready = status({ operationId })\n      check(ready.phase'
  assert.equal(source.split(marker).length, 2)
  source = source.replace(marker, '      globalThis.__atelierSemanticBeginCaptureFixture()\n' + marker)
  t.after(() => { delete globalThis.__atelierSemanticBeginCaptureFixture })
  const output = 'Invented premature host capture.'
  function configure(s) {
    globalThis.__atelierSemanticBeginCaptureFixture = () => createIntakeStore(s.options).completeAttempt({ attemptId: s.begin.attemptId, output, expectedOutputDigest: intakeDigest(output) })
  }
  const s = setup(t); configure(s)
  const instrumented = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  let failure
  try { instrumented.createSemanticOperation(s.options).begin(s.begin) } catch (error) { failure = error }
  assert.equal(failure?.code, 'SEMANTIC_RECONCILE_REQUIRED')
  assert.equal(failure.recorded.head, readHarness({ ...s.options, profile: 'knowledge' }).head)
  assert.equal(createIntakeStore(s.options).readAttempt(s.begin.attemptId).output, output)
  const guard = " && ready.attempt.status === 'begun'"
  assert.equal(source.split(guard).length, 2)
  const unsafe = setup(t); configure(unsafe)
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(guard, '')).toString('base64')}`)
  const ready = mutant.createSemanticOperation(unsafe.options).begin(unsafe.begin)
  assert.equal(ready.execution, 'ready-for-host'); assert.equal(ready.attempt.status, 'complete')
})

transactionTest('capture during reconciliation refuses with saved custody and blocks another execution', async t => {
  const s = setup(t), first = s.runner.begin(s.begin), moduleUrl = new URL('../src/knowledge/semantic-operation.mjs', import.meta.url)
  let source = fs.readFileSync(moduleUrl, 'utf8').replace(/from '([^']+)'/g, (original, ref) => ref.startsWith('.') ? `from ${JSON.stringify(new URL(ref, moduleUrl).href)}` : original)
  const marker = '    try { return { ...status({ operationId }), head: recorded.head } }'
  assert.equal(source.split(marker).length, 2)
  source = source.replace(marker, '    try { globalThis.__atelierSemanticReconcileCaptureFixture(); return { ...status({ operationId }), head: recorded.head } }')
  const output = 'Invented capture contradicting a concurrent host reconciliation.'
  globalThis.__atelierSemanticReconcileCaptureFixture = () => createIntakeStore(s.options).completeAttempt({ attemptId: s.begin.attemptId, output, expectedOutputDigest: intakeDigest(output) })
  t.after(() => { delete globalThis.__atelierSemanticReconcileCaptureFixture })
  const instrumented = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  let failure
  try { instrumented.createSemanticOperation(s.options).reconcile({ operationId: 'first', at, by: 'simulated-receiver', reason: 'Invented contradictory concurrent host declaration.', outcome: 'not-executed', confirm: first.head }) } catch (error) { failure = error }
  assert.equal(failure?.code, 'SEMANTIC_RECONCILE_REQUIRED')
  const saved = readHarness({ ...s.options, profile: 'knowledge' })
  assert.equal(failure.recorded.head, saved.head)
  assert.equal(failure.captured.completion.outputDigest, intakeDigest(output))
  assert.equal(createIntakeStore(s.options).readAttempt(s.begin.attemptId).output, output)
  assert.throws(() => s.runner.status({ operationId: 'first' }), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED' && e.captured.head === saved.head)
  const next = { ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: saved.head }
  assert.throws(() => s.runner.begin(next), e => e.code === 'SEMANTIC_RECONCILE_REQUIRED' && e.captured.head === saved.head)
  const statusGuard = "if (latest.value.phase === 'reconciled') assertNoReconciledCapture(initial, attempt, state)"
  assert.equal(source.split(statusGuard).length, 2)
  const statusMutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(statusGuard, 'void state')).toString('base64')}`)
  const incorrect = statusMutant.createSemanticOperation(s.options).status({ operationId: 'first' })
  assert.equal(incorrect.execution, 'reconciled'); assert.equal(incorrect.attempt.status, 'complete')
  const beginGuard = 'assertNoReconciledCapture(known.initial, intake.readAttempt(prior.value.attemptId), state)'
  assert.equal(source.split(beginGuard).length, 2)
  const beginMutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(beginGuard, 'void state')).toString('base64')}`)
  assert.equal(beginMutant.createSemanticOperation(s.options).begin(next).execution, 'ready-for-host')
})
