import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { decisionRequestDigest, validateDecisionAnswers, validateDecisionRequest, validateDecisionResult } from '../src/decisions/contracts.mjs'

const read = (relative) => JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8'))
const requestFixture = read('../fixtures/decisions/request/valid/triage.v1.json')
const resultFixture = read('../fixtures/decisions/result/valid/assessed.v1.json')
const abstainedFixture = read('../fixtures/decisions/result/valid/abstained.v1.json')
const ajv = new Ajv2020({ allErrors: true, strict: false })
const requestSchema = ajv.compile(read('../contracts/atelier-decision-request.v1.schema.json'))
const resultSchema = ajv.compile(read('../contracts/atelier-decision-result.v1.schema.json'))
const clone = (value) => structuredClone(value)

function mutated(value, edit) {
  const next = clone(value)
  edit(next)
  return next
}

function valid(verdict) {
  assert.deepEqual(verdict, { ok: true, errors: [] })
}

function refused(verdict, pattern) {
  assert.equal(verdict.ok, false)
  assert.ok(verdict.errors.length > 0)
  if (pattern) assert.match(verdict.errors.join('\n'), pattern)
}

test('invented request and both result fixtures satisfy static and semantic validation', () => {
  assert.equal(requestSchema(requestFixture), true, JSON.stringify(requestSchema.errors))
  valid(validateDecisionRequest(requestFixture))
  for (const result of [resultFixture, abstainedFixture]) {
    assert.equal(resultSchema(result), true, JSON.stringify(resultSchema.errors))
    valid(validateDecisionResult(requestFixture, result))
  }
  assert.equal(decisionRequestDigest(requestFixture), 'e08ba4b1c7253986b908aed74c8dcee5e4b47a569c28e233f78b6704151af778')
})

test('static-invalid authority fixtures are refused at both layers', () => {
  const request = read('../fixtures/decisions/request/invalid/unknown-authority.v1.json')
  const result = read('../fixtures/decisions/result/invalid/execution-authority.v1.json')
  assert.equal(requestSchema(request), false)
  refused(validateDecisionRequest(request), /unknown field/)
  assert.equal(resultSchema(result), false)
  refused(validateDecisionResult(requestFixture, result), /proposal-only/)
})

test('request digest is independent of object insertion order and preserves exact content', () => {
  function reorder(value) {
    if (Array.isArray(value)) return value.map(reorder)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reorder(value[key])]))
    return value
  }
  assert.equal(decisionRequestDigest(reorder(requestFixture)), decisionRequestDigest(requestFixture))
  const mutations = [
    (request) => { request.state += '\nAn additional invented sentence.' },
    (request) => { request.evidence.reverse() },
    (request) => { request.evidence[0].sourceRef = 'fictional-notes:other-passage' },
    (request) => { request.scope.authorizationRef = 'synthetic-consent-2' },
    (request) => { request.scope.workspaceId = 'another-synthetic-workspace' },
    (request) => { request.rubricVersion = 'fictional-notes.v2' },
    (request) => { request.ext = { 'example.note': 'inert metadata' } },
    (request) => { delete request.contractVersion },
  ]
  for (const edit of mutations) assert.notEqual(decisionRequestDigest(mutated(requestFixture, edit)), decisionRequestDigest(requestFixture))
  const composed = mutated(requestFixture, (request) => { request.state = 'caf\u00e9' })
  const decomposed = mutated(requestFixture, (request) => { request.state = 'cafe\u0301' })
  assert.notEqual(decisionRequestDigest(composed), decisionRequestDigest(decomposed))
})

test('an assessment cannot be reused for a different state, rubric, evidence or authorization snapshot', () => {
  for (const edit of [
    (request) => { request.state = 'A different invented passage.' },
    (request) => { request.rubricVersion = 'fictional-notes.v2' },
    (request) => { request.evidence[0].sourceRef = 'fictional-notes:replacement' },
    (request) => { request.scope.authorizationRef = 'synthetic-consent-2' },
  ]) refused(validateDecisionResult(mutated(requestFixture, edit), resultFixture), /binding mismatch/)
  const wrongScope = mutated(resultFixture, (result) => { result.scope.authorizationRef = 'synthetic-consent-2' })
  refused(validateDecisionResult(requestFixture, wrongScope), /result.scope: request binding mismatch/)
  refused(validateDecisionResult(requestFixture, mutated(resultFixture, (result) => { result.requestId = 'other-request' })), /requestId/)
  refused(validateDecisionResult(requestFixture, mutated(resultFixture, (result) => { result.task = 'other-task' })), /task or rubric/)
})

test('every question names existing evidence and each evidence identity is unique', () => {
  for (const edit of [
    (request) => { request.questions.priority.evidenceIds = [] },
    (request) => { request.questions.priority.evidenceIds = ['missing-passage'] },
    (request) => { request.questions.priority.evidenceIds = ['passage-1', 'passage-1'] },
    (request) => { request.evidence[1].id = request.evidence[0].id },
    (request) => { request.evidence = [] },
  ]) refused(validateDecisionRequest(mutated(requestFixture, edit)), /evidence/)
})

test('unknown fields and malformed question kinds are refused throughout the request', () => {
  for (const edit of [
    (request) => { request.endpoint = 'unexpected value' },
    (request) => { request.scope.canExecute = true },
    (request) => { request.evidence[0].accepted = true },
    (request) => { request.questions.priority.type = 'generated-text' },
    (request) => { request.questions.priority.confidence = 1 },
    (request) => { request.questions.priority.instructions = '  ' },
    (request) => { request.questions.evidence_score.criteria = ['Only one level.'] },
    (request) => { request.questions.saturday_open.criteria.maybe = 'Undecided.' },
    (request) => { request.contractVersion = '2.0.0' },
  ]) refused(validateDecisionRequest(mutated(requestFixture, edit)))
})

test('identifier and Unicode limits are explicit, including safe special characters', () => {
  const request = clone(requestFixture)
  request.id = '9-pilot_v1:sample.test'
  request.state = 'An invented note: ma\u00f1ana, \u660e\u65e5, \ud83e\ude81.'
  request.questions['safe.question-1_v2:score'] = request.questions.evidence_score
  delete request.questions.evidence_score
  valid(validateDecisionRequest(request))
  assert.equal(requestSchema(request), true)
  for (const id of ['', ' leading-space', 'contains/slash', '\u00e9tude', 'a'.repeat(129), 'constructor', 'prototype', '__proto__']) {
    refused(validateDecisionRequest(mutated(requestFixture, (next) => { next.id = id })))
  }
  for (const name of ['constructor', 'prototype', '__proto__']) {
    const next = clone(requestFixture)
    Object.defineProperty(next.questions, name, { value: next.questions.priority, enumerable: true })
    assert.equal(requestSchema(next), false)
    refused(validateDecisionRequest(next))
  }
})

test('string, question, criterion and evidence counts cannot exceed their bounds', () => {
  const maximum = mutated(requestFixture, (request) => { request.state = '\ud83e\ude81'.repeat(32000) })
  valid(validateDecisionRequest(maximum))
  assert.equal(requestSchema(maximum), true)
  for (const edit of [
    (request) => { request.state = 'x'.repeat(32001) },
    (request) => { request.questions.priority.instructions = 'x'.repeat(4001) },
    (request) => { request.questions.priority.criteria.maintenance = 'x'.repeat(2001) },
    (request) => { request.questions.priority.criteria = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`option-${index}`, 'An invented option.'])) },
    (request) => { request.questions.evidence_score.criteria = Array(11).fill('An invented level.') },
    (request) => { request.questions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`question-${index}`, request.questions.priority])) },
    (request) => { request.evidence = Array.from({ length: 257 }, (_, index) => ({ id: `passage-${index}`, sourceRef: `fictional-notes:${index}` })) },
  ]) {
    const request = mutated(requestFixture, edit)
    assert.equal(requestSchema(request), false)
    refused(validateDecisionRequest(request))
  }
})

test('non-JSON values, custom prototypes and accessors are refused without invoking them', () => {
  let getterCalls = 0
  const accessor = clone(requestFixture)
  Object.defineProperty(accessor, 'state', { enumerable: true, get() { getterCalls++; throw new Error('unread source value') } })
  const cyclic = clone(requestFixture)
  cyclic.ext = { cycle: cyclic }
  const sparse = clone(requestFixture)
  sparse.evidence = Array(2)
  const symbol = clone(requestFixture)
  symbol[Symbol('hidden')] = 'hidden value'
  const inherited = Object.assign(Object.create({ inherited: 'value' }), requestFixture)
  for (const request of [accessor, cyclic, sparse, symbol, inherited, new Date(), null, undefined]) {
    refused(validateDecisionRequest(request))
    assert.throws(() => decisionRequestDigest(request), { name: 'TypeError', message: 'Invalid decision request' })
  }
  for (const value of [NaN, Infinity, undefined, 1n, () => 'value']) {
    const request = clone(requestFixture)
    request.ext = { value }
    refused(validateDecisionRequest(request))
  }
  assert.equal(getterCalls, 0)
  const nullPrototype = clone(requestFixture)
  Object.setPrototypeOf(nullPrototype, null)
  valid(validateDecisionRequest(nullPrototype))
})

test('extension data is inert, digest-bound, bounded and still subject to plain-JSON checks', () => {
  const request = mutated(requestFixture, (next) => {
    next.ext = { 'example.metadata': { authority: 'execute', explanation: 'Ignored extension assertion.' } }
    next.scope.ext = { 'example.source': 'synthetic scope annotation' }
    next.questions.saturday_open.criteria.ext = { 'example.note': 'Synthetic annotation.' }
  })
  const result = clone(resultFixture)
  result.requestDigest = decisionRequestDigest(request)
  result.scope = clone(request.scope)
  valid(validateDecisionResult(request, result))
  result.authority = 'execute'
  refused(validateDecisionResult(request, result), /proposal-only/)
  for (const value of [null, [], 'not an object']) refused(validateDecisionRequest(mutated(requestFixture, (next) => { next.ext = value })))
  const tooDeep = clone(requestFixture)
  let cursor = tooDeep.ext = {}
  for (let index = 0; index < 33; index++) cursor = cursor.nested = {}
  refused(validateDecisionRequest(tooDeep), /bounded plain JSON/)
  refused(validateDecisionRequest(mutated(requestFixture, (next) => { next.ext = { values: Array(100001).fill(null) } })), /bounded plain JSON/)
  refused(validateDecisionRequest(mutated(requestFixture, (next) => { next.ext = { large: 'x'.repeat(16777216) } })), /bounded plain JSON/)
  const specialKey = clone(requestFixture)
  specialKey.ext = JSON.parse('{"__proto__":{"value":"inert"}}')
  refused(validateDecisionRequest(specialKey), /bounded plain JSON/)
})

test('result answers match all question keys and types exactly', () => {
  for (const edit of [
    (result) => { delete result.answers.priority },
    (result) => { result.answers.extra = result.answers.priority },
    (result) => { result.answers.priority.type = 'score' },
    (result) => { result.answers.saturday_open.confidence = 0.9 },
    (result) => { result.answers.priority.probabilities.extra = 0 },
    (result) => { delete result.answers.priority.probabilities.unmatched },
    (result) => { result.answers.evidence_score.probabilities = [0.1, 0.9] },
  ]) refused(validateDecisionResult(requestFixture, mutated(resultFixture, edit)))
})

test('choice distributions sum to one and the selected option has maximum probability', () => {
  const tied = mutated(resultFixture, (result) => { result.answers.priority.probabilities = { maintenance: 0.5, hours: 0.5, unmatched: 0 } })
  valid(validateDecisionResult(requestFixture, tied))
  tied.answers.priority.choice = 'hours'
  valid(validateDecisionResult(requestFixture, tied))
  for (const edit of [
    (result) => { result.answers.priority.probabilities.maintenance = 0.2 },
    (result) => { result.answers.priority.probabilities = { maintenance: -0.1, hours: 1.1, unmatched: 0 } },
    (result) => { result.answers.priority.choice = 'hours' },
    (result) => { result.answers.priority.choice = 'unknown-option' },
    (result) => { result.answers.priority.probabilities = { maintenance: 0.49999999, hours: 0.50000001, unmatched: 0 } },
  ]) refused(validateDecisionResult(requestFixture, mutated(resultFixture, edit)))
  // The schemas cannot express a distribution sum; the production validator can.
  const nonNormalized = mutated(resultFixture, (result) => { result.answers.priority.probabilities.maintenance = 0.4 })
  assert.equal(resultSchema(nonNormalized), true)
  refused(validateDecisionResult(requestFixture, nonNormalized), /sum to one/)
})

test('score answers preserve the fractional expectation and never invent Boolean confidence', () => {
  const result = clone(resultFixture)
  result.answers.evidence_score = { type: 'score', score: 0.75, probabilities: [0.5, 0.25, 0.25], confidence: 0.2 }
  valid(validateDecisionResult(requestFixture, result))
  result.answers.evidence_score.score = 1
  assert.equal(resultSchema(result), true)
  refused(validateDecisionResult(requestFixture, result), /weighted expectation/)
  for (const value of [-0.1, 1.1, NaN, Infinity, '0.5']) {
    refused(validateDecisionResult(requestFixture, mutated(resultFixture, (next) => { next.answers.saturday_open.probability = value })))
    refused(validateDecisionResult(requestFixture, mutated(resultFixture, (next) => { next.answers.priority.confidence = value })))
  }
})

test('every explicit abstention reason preserves an empty answer set and unknown usage', () => {
  for (const reason of ['insufficient-evidence', 'ambiguous', 'no-match', 'budget-exhausted', 'provider-unavailable', 'timeout', 'invalid-response', 'unauthorized']) {
    const result = { ...clone(abstainedFixture), reason }
    valid(validateDecisionResult(requestFixture, result))
    assert.equal(resultSchema(result), true)
  }
  for (const edit of [
    (result) => { delete result.reason },
    (result) => { result.reason = 'something-went-wrong' },
    (result) => { result.answers = clone(resultFixture.answers) },
  ]) refused(validateDecisionResult(requestFixture, mutated(abstainedFixture, edit)))
  refused(validateDecisionResult(requestFixture, mutated(resultFixture, (result) => { result.reason = 'ambiguous' })))
})

test('provider provenance, mode, usage and timing are recorded with finite bounded types', () => {
  for (const edit of [
    (result) => { delete result.provider.model },
    (result) => { result.provider.model = '  ' },
    (result) => { result.provider.id = 'constructor' },
    (result) => { result.provider.extraResponse = 'unrecognized text' },
    (result) => { result.mode = 'automatic' },
    (result) => { result.usage.inputTokens = -1 },
    (result) => { result.usage.outputTokens = 0.5 },
    (result) => { result.usage.inputTokens = Number.MAX_SAFE_INTEGER + 1 },
    (result) => { result.elapsedMs = -1 },
    (result) => { result.elapsedMs = Infinity },
  ]) refused(validateDecisionResult(requestFixture, mutated(resultFixture, edit)))
  const unknownUsage = { ...clone(resultFixture), usage: null }
  valid(validateDecisionResult(requestFixture, unknownUsage))
  const recordedModel = mutated(resultFixture, (result) => { result.provider.model = 'fictional-provider/model.v2' })
  valid(validateDecisionResult(requestFixture, recordedModel))
  // A consuming host must compare this recorded model with its concrete model pin.
  assert.notEqual(recordedModel.provider.model, resultFixture.provider.model)
})

test('validation and errors neither mutate nor disclose caller content', () => {
  const request = clone(requestFixture)
  const result = clone(resultFixture)
  const before = clone({ request, result })
  valid(validateDecisionRequest(request))
  valid(validateDecisionResult(request, result))
  assert.deepEqual({ request, result }, before)
  const marker = 'untrusted passage content must remain undisclosed'
  request.state = marker.repeat(2000)
  request[marker] = marker
  result.provider.model = marker.repeat(5)
  for (const verdict of [validateDecisionRequest(request), validateDecisionResult(requestFixture, result), validateDecisionResult(request, result)]) {
    refused(verdict)
    assert.equal(verdict.errors.join('\n').includes(marker), false)
  }
})

test('standalone answer validation needs no state or hash operation', () => {
  const originalCreateHash = crypto.createHash
  let hashCalls = 0
  crypto.createHash = () => { hashCalls++; throw new Error('Hashing is unavailable in this host') }
  syncBuiltinESMExports()
  try {
    const questions = clone(requestFixture.questions)
    const answers = clone(resultFixture.answers)
    const before = clone({ questions, answers })
    valid(validateDecisionAnswers(questions, answers))
    assert.deepEqual({ questions, answers }, before)
    assert.equal(hashCalls, 0)
  } finally {
    crypto.createHash = originalCreateHash
    syncBuiltinESMExports()
  }
})

test('standalone validation preserves answer key, type and distribution refusals', () => {
  for (const edit of [
    (answers) => { delete answers.priority },
    (answers) => { answers.extra = answers.priority },
    (answers) => { answers.priority.type = 'score' },
    (answers) => { answers.priority.probabilities.maintenance = 0.2 },
    (answers) => { answers.priority.probabilities.extra = 0 },
    (answers) => { answers.priority.choice = 'hours' },
    (answers) => { answers.evidence_score.score = 2 },
    (answers) => { answers.evidence_score.probabilities = [0.1, 0.9] },
    (answers) => { answers.saturday_open.confidence = 0.9 },
    (answers) => { answers.saturday_open.probability = NaN },
  ]) refused(validateDecisionAnswers(requestFixture.questions, mutated(resultFixture.answers, edit)))
  refused(validateDecisionAnswers(requestFixture.questions, {}), /question keys/)
  refused(validateDecisionAnswers({}, {}), /entry count/)
})

test('standalone questions enforce syntax without claiming external evidence membership', () => {
  const request = mutated(requestFixture, (next) => { next.questions.priority.evidenceIds = ['another-host-evidence-ref'] })
  valid(validateDecisionAnswers(request.questions, resultFixture.answers))
  refused(validateDecisionRequest(request), /unknown reference/)
  for (const edit of [
    (questions) => { questions.priority.evidenceIds = [] },
    (questions) => { questions.priority.evidenceIds = ['passage-1', 'passage-1'] },
    (questions) => { questions.priority.evidenceIds = ['constructor'] },
    (questions) => { questions.priority.evidenceIds = Array.from({ length: 257 }, (_, index) => `evidence-${index}`) },
    (questions) => { questions.priority.criteria = { only: 'One option is insufficient.' } },
    (questions) => { questions.evidence_score.criteria = ['Only one score level.'] },
    (questions) => { questions.saturday_open.criteria.maybe = 'Unknown.' },
    (questions) => { questions.priority.type = 'generated-text' },
    (questions) => { questions.priority.state = 'State does not belong to this API.' },
    (questions) => { questions.priority.instructions = 'x'.repeat(4001) },
  ]) refused(validateDecisionAnswers(mutated(requestFixture.questions, edit), resultFixture.answers))
})

test('standalone bounded JSON validation refuses getters, cycles and unsafe keys without disclosing them', () => {
  let getterCalls = 0
  const questions = clone(requestFixture.questions)
  Object.defineProperty(questions.priority, 'instructions', { enumerable: true, get() { getterCalls++; return 'unread text' } })
  refused(validateDecisionAnswers(questions, resultFixture.answers), /questions: expected bounded plain JSON/)
  const cyclic = clone(resultFixture.answers)
  cyclic.priority.ext = { cyclic }
  refused(validateDecisionAnswers(requestFixture.questions, cyclic), /answers: expected bounded plain JSON/)
  const accessor = clone(resultFixture.answers)
  Object.defineProperty(accessor.priority, 'choice', { enumerable: true, get() { getterCalls++; return 'maintenance' } })
  refused(validateDecisionAnswers(requestFixture.questions, accessor), /answers: expected bounded plain JSON/)
  assert.equal(getterCalls, 0)
  const unsafe = clone(resultFixture.answers)
  unsafe.priority.ext = JSON.parse('{"constructor":"untrusted response content"}')
  refused(validateDecisionAnswers(requestFixture.questions, unsafe))
  const tooDeep = clone(requestFixture.questions)
  let cursor = tooDeep.priority.ext = {}
  for (let index = 0; index < 33; index++) cursor = cursor.nested = {}
  refused(validateDecisionAnswers(tooDeep, resultFixture.answers), /bounded plain JSON/)
  const marker = 'untrusted response content must remain undisclosed'
  const malformed = mutated(resultFixture.answers, (answers) => { answers.priority[marker] = marker })
  const verdict = validateDecisionAnswers(requestFixture.questions, malformed)
  refused(verdict)
  assert.equal(verdict.errors.join('\n').includes(marker), false)
})
