import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createIngestionStore } from '../src/ingestion/store.mjs'
import { appendHarness, readHarness } from '../src/harnesses/store.mjs'
import { EMPTY_HARNESS_HEAD, harnessRef } from '../src/harnesses/contracts.mjs'
import { intakeDigest } from '../src/intake/store.mjs'
import { prepareIngestionContribution } from '../src/knowledge/ingestion.mjs'
import { createSemanticOperation } from '../src/knowledge/semantic-operation.mjs'
import { SEMANTIC_COMMANDS, SEMANTIC_REQUEST_BYTES, semanticFailure } from '../src/commands/knowledge-semantic.mjs'

// The public `atelier knowledge semantic` adapter over the internal semantic
// operation runner, exercised as separate CLI processes on invented sources.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BIN = path.join(ROOT, 'bin/atelier.mjs')
const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/atelier-ingestion/semantic-operation.json', import.meta.url)))
const at = '2026-01-01T00:00:00Z'
const workspaceId = 'operation-fixture'
const run = fixture.domain.run
const unknownUsage = { inputTokens: null, outputTokens: null, cost: null, currency: null, elapsedMs: null, retries: null }
const posix = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'Durable intake uses the qualified POSIX reference profile.' : false }, fn)
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_') && key !== 'ATELIER_DEBUG'))

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-semantic-cli-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root], { env: cleanEnv })
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  fs.writeFileSync(path.join(root, 'notes.txt'), fixture.sourceText)
  appendHarness({ workspaceRoot: root, profile: 'knowledge', record: fixture.domain, confirm: EMPTY_HARNESS_HEAD })
  const store = createIngestionStore({ workspaceRoot: root, workspaceId })
  const plan = store.plan({ sources: [{ id: 'notes', ref: 'notes.txt' }], scope: { project: 'invented-components', activity: 'research' }, purpose: 'Simulated semantic CLI operation.', budget: { maxInputBytes: 65536, maxOutputBytes: 65536, maxAttempts: 1 } })
  store.run({ planId: plan.planId, planDigest: plan.planDigest })
  const item = store.status({ planId: plan.planId, planDigest: plan.planDigest }).items[0]
  const head = () => readHarness({ workspaceRoot: root, profile: 'knowledge', run }).head
  const begin = { operationId: 'first', attemptId: 'model-first', at, term: 'material', plan: { planId: plan.planId, planDigest: plan.planDigest },
    references: [1, 2, 3].map(line => ({ sourceId: 'notes', sourceDigest: item.sourceDigest, attemptId: item.attemptId, locator: { kind: 'line', value: String(line) } })), identityCandidates: [],
    extractor: { id: 'fixture-extractor', version: '1.0.0', route: 'authored', model: null, promptDigest: 'a'.repeat(64), parameters: {} },
    confirm: head() }
  return { root, begin, head, options: { workspaceRoot: root, workspaceId, run } }
}

function cli(root, args, input) {
  const result = spawnSync(process.execPath, [BIN, 'knowledge', 'semantic', ...args], { cwd: root, input, env: cleanEnv, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const call = (root, operation, request, envelope = {}) => cli(root, [operation], JSON.stringify({ workspaceId, run, request, ...envelope }))
function ok(result) {
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}
function refused(result, code) {
  assert.equal(result.status, 1, result.stdout)
  assert.equal(result.stdout, '')
  const failure = JSON.parse(result.stderr)
  assert.equal(failure.ok, false)
  assert.equal(failure.code, code, result.stderr)
  return failure
}
// Every byte of private state, so a refusal can be shown to have written nothing.
function snapshot(root) {
  const base = path.join(root, '.atelier-local')
  const out = {}
  const walk = dir => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) { out[path.relative(base, file) + '/'] = 'dir'; walk(file) }
      else out[path.relative(base, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    }
  }
  walk(base)
  return out
}
const HOST_PATH = /\/(?:Users|home|private|var|tmp|Volumes)\//

// A valid request for each command, built from one workspace's live state.
function validRequests(s) {
  const head = s.head()
  return {
    begin: s.begin,
    status: { operationId: 'first' },
    reconcile: { operationId: 'first', at, by: 'simulated-receiver', reason: 'Simulated host confirms extraction never started.', outcome: 'not-executed', confirm: head },
    complete: { operationId: 'first', output: 'raw', expectedOutputDigest: intakeDigest('raw'), candidates: {}, usage: unknownUsage, at, confirm: head },
    proposals: { operationId: 'first', query: 'Nora', limit: 8 },
    contribution: { operationId: 'first', id: 'entity-nora', kind: 'entity', candidateId: 'nora', source: { id: 'x', digest: 'y' }, sourceBinding: {}, term: 'person', at, confirm: head },
    relation: { assertion: { id: 'x', digest: 'y' }, at, confirm: head },
    record: { record: { schema: 'atelier-knowledge-record@v1', id: 'r', run, at, by: 'simulated-receiver', kind: 'evaluation', data: {} }, confirm: head },
    cascade: { withdrawalId: 'withdraw-none', at, confirm: head },
    context: { query: 'Nora' },
    project: { activationId: 'none', namespace: 'fixture' },
  }
}

test('dispatch refuses a missing or unknown operation, extra positionals and every option', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-semantic-cli-usage-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const args of [[], ['execute'], ['status', 'extra'], ['status', '--project', 'atelier.project.json'], ['status', '--workspace', root]]) {
    const failure = refused(cli(root, args, '{}'), 'SEMANTIC_OPERATION_INVALID')
    assert.match(failure.error, /knowledge semantic/)
  }
  assert.deepEqual(Object.keys(SEMANTIC_COMMANDS), ['begin', 'status', 'reconcile', 'complete', 'proposals', 'contribution', 'relation', 'record', 'cascade', 'context', 'project'])
})

posix('stdin is capped at exactly 256 KiB before parsing, and the cap refuses with no write', t => {
  const s = setup(t)
  assert.equal(SEMANTIC_REQUEST_BYTES, 262144)
  const body = JSON.stringify({ workspaceId, run, request: { operationId: 'absent' } })
  const atCap = body + ' '.repeat(SEMANTIC_REQUEST_BYTES - Buffer.byteLength(body))
  assert.equal(Buffer.byteLength(atCap), 262144)
  // Exactly at the cap reaches the runner, which answers for the missing operation.
  refused(cli(s.root, ['status'], atCap), 'SEMANTIC_OPERATION_MISSING')
  const before = snapshot(s.root)
  const over = refused(cli(s.root, ['status'], atCap + ' '), 'SEMANTIC_OPERATION_LIMIT')
  assert.match(over.error, /256 KiB/)
  assert.deepEqual(snapshot(s.root), before)
})

posix('malformed bytes and envelopes refuse with SEMANTIC_OPERATION_INVALID and write nothing', t => {
  const s = setup(t)
  const before = snapshot(s.root)
  const cases = [
    Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
    '{not json',
    '[]',
    JSON.stringify({ workspaceId, request: { operationId: 'first' } }),
    JSON.stringify({ workspaceId, run, request: { operationId: 'first' }, extra: true }),
    JSON.stringify({ workspaceId, run, request: [] }),
    JSON.stringify({ workspaceId, run, request: null }),
    JSON.stringify({ workspaceId: 7, run, request: { operationId: 'first' } }),
    JSON.stringify({ workspaceId, run: 'Not An Identifier', request: { operationId: 'first' } }),
  ]
  for (const input of cases) refused(cli(s.root, ['status'], input), 'SEMANTIC_OPERATION_INVALID')
  assert.deepEqual(snapshot(s.root), before)
})

posix('every command refuses an unknown or a missing field before the runner exists, and writes nothing', t => {
  const s = setup(t)
  const valid = validRequests(s)
  const before = snapshot(s.root)
  for (const [command, spec] of Object.entries(SEMANTIC_COMMANDS)) {
    const extra = refused(call(s.root, command, { ...valid[command], unexpected: true }), 'SEMANTIC_OPERATION_INVALID')
    assert.match(extra.error, new RegExp(`unknown or missing ${command} request field`))
    for (const field of spec.required) {
      const missing = { ...valid[command] }
      delete missing[field]
      const failure = refused(call(s.root, command, missing), 'SEMANTIC_OPERATION_INVALID')
      assert.match(failure.error, new RegExp(`unknown or missing ${command} request field`), `${command} without ${field}`)
    }
    assert.deepEqual(snapshot(s.root), before, `${command} wrote state while refusing`)
  }
})

posix('optional fields are accepted and omitted alike; the adapter never answers for the runner', t => {
  const s = setup(t)
  for (const request of [{ operationId: 'absent', query: 'Nora' }, { operationId: 'absent', query: 'Nora', limit: 4 }]) {
    const failure = refused(call(s.root, 'proposals', request), 'SEMANTIC_OPERATION_MISSING')
    assert.doesNotMatch(failure.error, /request field/)
  }
  const valid = validRequests(s).contribution
  for (const request of [valid, { ...valid, supersedes: null, revisionReason: null }]) {
    const failure = JSON.parse(call(s.root, 'contribution', { ...request, operationId: 'absent' }).stderr)
    assert.doesNotMatch(failure.error, /request field/)
  }
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

posix('typed runner refusals keep their codes through the CLI and never print a host path', t => {
  const s = setup(t)
  refused(call(s.root, 'status', { operationId: 'absent' }), 'SEMANTIC_OPERATION_MISSING')
  refused(call(s.root, 'begin', { ...s.begin, confirm: EMPTY_HARNESS_HEAD }), 'SEMANTIC_OPERATION_HEAD')
  const first = ok(call(s.root, 'begin', s.begin))
  assert.equal(first.execution, 'ready-for-host')
  assert.equal(first.authority, 'none')
  refused(call(s.root, 'begin', { ...s.begin, confirm: first.head }), 'SEMANTIC_OPERATION_EXISTS')
  refused(call(s.root, 'begin', { ...s.begin, operationId: 'second', attemptId: 'model-second', confirm: first.head }), 'SEMANTIC_EXECUTION_UNKNOWN')
  // A bad candidate binding is refused after the raw bytes are captured.
  const output = 'Invented raw host output with an invalid proposed input binding.'
  const captured = refused(call(s.root, 'complete', { operationId: 'first', output, expectedOutputDigest: intakeDigest(output),
    candidates: { ...extractedCandidates(first.input), inputDigest: `sha256:${'f'.repeat(64)}` }, usage: unknownUsage, at, confirm: first.head }), 'SEMANTIC_BINDING')
  assert.equal(captured.captured.nextAction, 'reopen-captured-output')
  assert.equal(captured.captured.attemptId, 'model-first')
  assert.ok(captured.captured.completion)
  for (const text of [JSON.stringify(captured)]) {
    assert.doesNotMatch(text, HOST_PATH)
    assert.equal(text.includes(s.root), false)
  }
  // The same status, read in another process, equals the library's own answer.
  const fromCli = ok(call(s.root, 'status', { operationId: 'first' }))
  assert.deepEqual(fromCli, JSON.parse(JSON.stringify(createSemanticOperation(s.options).status({ operationId: 'first' }))))
  assert.equal(fromCli.attempt.status, 'complete')
})

posix('a source changed before completion keeps the captured raw output for reopening', t => {
  const s = setup(t)
  const first = ok(call(s.root, 'begin', s.begin))
  const candidates = extractedCandidates(first.input), output = JSON.stringify(candidates)
  // The source changes after begin: the raw bytes are captured, then the completion is refused as stale
  // before anything is recorded in the ledger.
  fs.writeFileSync(path.join(s.root, 'notes.txt'), fixture.sourceText.replace('June', 'July'))
  const failure = refused(call(s.root, 'complete', { operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }), 'SEMANTIC_OPERATION_STALE')
  assert.equal(failure.recorded, undefined)
  assert.equal(failure.captured.nextAction, 'reopen-captured-output')
  assert.equal(failure.captured.attemptId, 'model-first')
  assert.doesNotMatch(JSON.stringify(failure), HOST_PATH)
})

posix('an uncoded failure after raw capture still returns the captured detail, as SEMANTIC_OPERATION_INTERRUPTED', t => {
  const s = setup(t)
  const first = ok(call(s.root, 'begin', s.begin))
  const candidates = extractedCandidates(first.input), output = JSON.stringify(candidates)
  // An invalid timestamp is only refused by the knowledge ledger, after intake has captured the raw bytes.
  const failure = refused(call(s.root, 'complete', { operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at: 'not-a-time', confirm: first.head }), 'SEMANTIC_OPERATION_INTERRUPTED')
  assert.equal(failure.captured.nextAction, 'reopen-captured-output')
  assert.equal(failure.captured.attemptId, 'model-first')
  assert.doesNotMatch(JSON.stringify(failure), HOST_PATH)
  // The captured attempt is complete: reopening finds the same raw output, so the host does not run again.
  assert.equal(ok(call(s.root, 'status', { operationId: 'first' })).attempt.status, 'complete')
  // Completing again with the identical bytes and a valid timestamp records the same capture.
  const recompleted = ok(call(s.root, 'complete', { operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }))
  assert.equal(recompleted.phase, 'completed')
  assert.equal(recompleted.attempt.status, 'complete')
  assert.deepEqual(recompleted.attempt.completion, failure.captured.completion)
})

posix('Atelier\'s own uncoded refusals are typed SEMANTIC_OPERATION_REFUSED; null and wrongly typed fields never reach the runner', t => {
  const s = setup(t)
  const first = ok(call(s.root, 'begin', s.begin))
  const bad = refused(call(s.root, 'complete', { operationId: 'first', output: 'raw', expectedOutputDigest: 'not-a-digest', candidates: {}, usage: unknownUsage, at, confirm: first.head }), 'SEMANTIC_OPERATION_REFUSED')
  assert.equal(bad.captured, undefined)
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-semantic-cli-outside-')))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const placed = refused(call(outside, 'status', { operationId: 'first' }), 'SEMANTIC_OPERATION_REFUSED')
  assert.match(placed.error, /Git workspace/)
  assert.doesNotMatch(JSON.stringify(placed), HOST_PATH)
  // A numeric timestamp, as Date.now() gives, is refused before intake captures anything.
  const beforeComplete = snapshot(s.root)
  refused(call(s.root, 'complete', { operationId: 'first', output: 'raw', expectedOutputDigest: intakeDigest('raw'), candidates: {}, usage: unknownUsage, at: 0, confirm: first.head }), 'SEMANTIC_OPERATION_INVALID')
  assert.deepEqual(snapshot(s.root), beforeComplete)
  const valid = validRequests(s)
  const before = snapshot(s.root)
  for (const [command, spec] of Object.entries(SEMANTIC_COMMANDS)) {
    for (const field of spec.required) {
      const failure = refused(call(s.root, command, { ...valid[command], [field]: null }), 'SEMANTIC_OPERATION_INVALID')
      assert.match(failure.error, new RegExp(`invalid ${command} request field type: ${field}`))
    }
    // One value of the wrong kind for every field, required or optional.
    const wrongFor = { string: 0, object: 'text', array: {}, integer: '8', 'object-or-null': 'text', 'string-or-null': 0, 'interpretation-kind': 'constructor' }
    for (const [field, type] of Object.entries(spec.types)) {
      const failure = refused(call(s.root, command, { ...valid[command], [field]: wrongFor[type] }), 'SEMANTIC_OPERATION_INVALID')
      assert.match(failure.error, new RegExp(`invalid ${command} request field type: ${field}`))
    }
  }
  assert.deepEqual(snapshot(s.root), before)
})

test('the failure formatter keeps saved detail for every error and leaves only unsafe, unsaved errors to redaction', () => {
  const recorded = { record: { id: 'r', digest: 'd' }, head: 'h', nextAction: 'reopen-recorded-write' }
  const coded = Object.assign(new Error('Knowledge history changed during the operation'), { code: 'SEMANTIC_OPERATION_HEAD', recorded })
  assert.deepEqual(semanticFailure(coded), { ok: false, code: 'SEMANTIC_OPERATION_HEAD', error: 'Knowledge history changed during the operation', recorded })
  const uncoded = Object.assign(new Error('lock busy'), { recorded })
  assert.deepEqual(semanticFailure(uncoded), { ok: false, code: 'SEMANTIC_OPERATION_INTERRUPTED', error: 'lock busy', recorded })
  // A Node error naming a host path keeps the saved detail but not its text.
  const host = Object.assign(new Error(`EACCES: permission denied, open '${path.join(os.homedir(), 'x')}'`), { code: 'EACCES', errno: -13, syscall: 'open', recorded })
  assert.deepEqual(semanticFailure(host), { ok: false, code: 'SEMANTIC_OPERATION_INTERRUPTED', error: '[internal-error]', recorded })
  assert.deepEqual(semanticFailure(new Error('invalid content digest')), { ok: false, code: 'SEMANTIC_OPERATION_REFUSED', error: 'invalid content digest' })
  assert.equal(semanticFailure(Object.assign(new Error(`ENOENT: open '${path.join(os.homedir(), 'x')}'`), { code: 'ENOENT', errno: -2, syscall: 'open' })), null)
  assert.equal(semanticFailure(new SyntaxError('Unexpected token')), null)
})

posix('the whole receiver journey runs as separate processes: capture, admit, project, reopen, correct and withdraw', t => {
  const s = setup(t)
  const first = ok(call(s.root, 'begin', s.begin))
  // The host runs its own extractor; Atelier only receives its raw bytes and candidates.
  const candidates = extractedCandidates(first.input), output = JSON.stringify(candidates)
  const completed = ok(call(s.root, 'complete', { operationId: 'first', output, expectedOutputDigest: intakeDigest(output), candidates, usage: unknownUsage, at, confirm: first.head }))
  assert.deepEqual(completed.usage, unknownUsage)
  let head = completed.head
  const make = (kind, id, data) => ({ schema: 'atelier-knowledge-record@v1', id, run, at, by: 'simulated-receiver', kind, data })
  const decision = record => { head = ok(call(s.root, 'record', { record, confirm: head })).head; return record }
  function approve(record) {
    const evaluations = record.kind === 'contribution' ? [decision(make('evaluation', `${record.id}-eval`, { contribution: harnessRef(record), judgment: 'supported', rationale: 'Simulated fixture evaluation, not a model-quality result.', limitations: ['Invented inputs and simulated receiver'], scope: fixture.domain.data.scope }))] : []
    return decision(make('review', `${record.id}-review`, { target: harnessRef(record), disposition: 'accepted', basis: 'Simulated receiver accepts only for the fixture journey.', evaluations: evaluations.map(harnessRef) }))
  }
  // The structural source contribution comes from the existing ingestion owner.
  const source = prepareIngestionContribution({ ...s.options, records: readHarness({ ...s.options, profile: 'knowledge' }).records, ...s.begin.plan, sourceId: 'notes', title: 'Invented source', term: 'material' })
  const sourceRecord = { ...make('contribution', 'structural-source', source.data), by: 'host-model:fixture-structural-extractor' }
  head = appendHarness({ ...s.options, profile: 'knowledge', record: sourceRecord, confirm: head }).head
  approve(sourceRecord)
  const sourceOptions = { source: harnessRef(sourceRecord), sourceBinding: source.sourceBinding }
  for (const entity of candidates.entities) {
    const prepared = ok(call(s.root, 'contribution', { operationId: 'first', id: `entity-${entity.id}`, kind: 'entity', candidateId: entity.id, term: entity.type, at, confirm: head, ...sourceOptions }))
    head = prepared.head
    assert.equal(prepared.semanticAcceptance, 'pending')
    assert.equal(prepared.record.data.origin.method, 'authored')
    approve(prepared.record)
  }
  const assertions = [], reviews = []
  for (const assertion of candidates.assertions) {
    const prepared = ok(call(s.root, 'contribution', { operationId: 'first', id: `claim-${assertion.id}`, kind: 'assertion', candidateId: assertion.id, term: 'assertion', at, confirm: head, ...sourceOptions }))
    head = prepared.head; assertions.push(prepared.record); reviews.push(approve(prepared.record))
  }
  decision(make('activation', 'assertions-active', { reviews: reviews.map(harnessRef), purpose: 'Simulated qualified assertion retrieval.', destination: 'local-context', questions: ['component'] }))
  const qualified = ok(call(s.root, 'relation', { assertion: harnessRef(assertions[0]), at, confirm: head }))
  assert.equal(qualified.record, null)
  assert.equal(qualified.projectionOmission.reasons.includes('temporal'), true)
  const relation = ok(call(s.root, 'relation', { assertion: harnessRef(assertions[2]), at, confirm: head })); head = relation.head
  assert.equal(relation.semanticAcceptance, 'pending')
  const relationReview = approve(relation.record)
  decision(make('activation', 'all-active', { reviews: [...reviews, relationReview].map(harnessRef), purpose: 'Simulated graph proposal.', destination: 'local-graph', questions: ['component'] }))
  const projected = ok(call(s.root, 'project', { activationId: 'all-active', namespace: 'fixture' }))
  assert.equal(projected.semanticEntities.length, 3)
  assert.equal(projected.semanticAssertions.length, 3)
  assert.equal(projected.projectionOmissions.length, 2)
  // Reopened reads in new processes.
  assert.equal(ok(call(s.root, 'proposals', { operationId: 'first', query: 'funds' })).answerClass, 'pending-proposals')
  assert.equal(ok(call(s.root, 'context', { query: 'funds' })).hits.some(hit => hit.reference.id === assertions[2].id), true)
  // An explicit source-bound correction supersedes the exact prior interpretation.
  const priorEntity = readHarness({ ...s.options, profile: 'knowledge' }).records.find(record => record.id === 'entity-nora')
  const revised = ok(call(s.root, 'contribution', { operationId: 'first', id: 'entity-nora-v2', kind: 'entity', candidateId: 'nora', term: 'person', at, confirm: head, ...sourceOptions,
    supersedes: harnessRef(priorEntity), revisionReason: 'Simulated receiver explicitly revises the identity contribution.' }))
  head = revised.head
  assert.deepEqual(revised.record.data.supersedes, harnessRef(priorEntity))
  approve(revised.record)
  refused(call(s.root, 'project', { activationId: 'all-active', namespace: 'fixture' }), 'SEMANTIC_PROJECTION_STALE')
  // Withdrawal, then idempotent cleanup of the generated relation.
  decision(make('withdrawal', 'withdraw-funding', { target: harnessRef(assertions[2]), reason: 'Simulated receiver withdraws the funding interpretation.' }))
  const cleaned = ok(call(s.root, 'cascade', { withdrawalId: 'withdraw-funding', at, confirm: head })); head = cleaned.head
  assert.deepEqual(cleaned.cleaned, [relation.record.id])
  assert.equal(cleaned.authority, 'none')
  assert.deepEqual(ok(call(s.root, 'cascade', { withdrawalId: 'withdraw-funding', at, confirm: head })).cleaned, [])
  assert.equal(ok(call(s.root, 'context', { query: 'funds' })).hits.some(hit => hit.reference.id === assertions[2].id), false)
})

test('the field sets equal the runner methods\' own parameters, so drift fails here', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/knowledge/semantic-operation.mjs'), 'utf8')
  const names = text => text.split(',').map(part => part.trim().split(/\s*=/)[0]).filter(Boolean)
  for (const [command, spec] of Object.entries(SEMANTIC_COMMANDS)) {
    const declared = [...spec.required, ...spec.optional].sort()
    assert.deepEqual(Object.keys(spec.types).sort(), declared, `${command} types every field`)
    if (spec.method === 'begin') {
      const closedList = source.match(/function begin\(request\) \{[\s\S]*?closed\(selected, \[([^\]]+)\]\)/)[1]
      assert.deepEqual(declared, closedList.split(',').map(item => item.trim().replace(/'/g, '')).sort(), command)
      continue
    }
    const signature = source.match(new RegExp(`function ${spec.method}\\(\\{([^}]*)\\}\\)`))
    assert.ok(signature, `${spec.method} destructures its request`)
    assert.deepEqual(declared, names(signature[1]).sort(), command)
    const defaulted = signature[1].split(',').filter(part => part.includes('=')).map(part => part.trim().split(/\s*=/)[0]).sort()
    assert.deepEqual([...spec.optional].sort(), defaulted, `${command} optional fields are exactly the defaulted parameters`)
  }
})

test('help lists the eleven operations and the 256 KiB request limit', () => {
  const result = spawnSync(process.execPath, [BIN, 'knowledge', '--help'], { env: cleanEnv, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /knowledge semantic begin\|status\|reconcile\|complete\|proposals\|contribution\|relation\|record\|cascade\|context\|project/)
  assert.match(result.stdout, /256 KiB/)
})
