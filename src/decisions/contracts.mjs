import { createHash } from 'node:crypto'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])
const VERSION = /^1\.[0-9]+\.[0-9]+$/
const REASONS = new Set(['insufficient-evidence', 'ambiguous', 'no-match', 'budget-exhausted', 'provider-unavailable', 'timeout', 'invalid-response', 'unauthorized'])
const TOLERANCE = 1e-6

// Inspect descriptors before reading values. Invalid in-process inputs such as
// accessors, symbols, sparse arrays, cycles and custom prototypes are refused
// without calling their conversion methods or returning their content.
function jsonSnapshot(input) {
  const ancestors = new Set()
  let nodes = 0
  let bytes = 0
  function count(value) {
    bytes += value
    if (bytes > 16777216) throw new TypeError()
  }
  function copy(value, depth) {
    if (++nodes > 100000 || depth > 32) throw new TypeError()
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) {
      if (typeof value === 'string' && Buffer.byteLength(value) > 16777216) throw new TypeError()
      count(Buffer.byteLength(JSON.stringify(value)))
      return value
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new TypeError()
    const array = Array.isArray(value)
    const prototype = Object.getPrototypeOf(value)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string' || RESERVED.has(key))) throw new TypeError()
    count(2)
    ancestors.add(value)
    let result
    if (array) {
      const length = descriptors.length?.value
      if (!Number.isSafeInteger(length) || length < 0 || length > 100000 || keys.length !== length + 1) throw new TypeError()
      result = []
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError()
        if (index) count(1)
        result.push(copy(descriptor.value, depth + 1))
      }
    } else {
      result = Object.create(null)
      for (const [index, key] of keys.entries()) {
        const descriptor = descriptors[key]
        if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new TypeError()
        if (Buffer.byteLength(key) > 16777216) throw new TypeError()
        count(Buffer.byteLength(JSON.stringify(key)) + 1 + (index ? 1 : 0))
        result[key] = copy(descriptor.value, depth + 1)
      }
    }
    ancestors.delete(value)
    return result
  }
  return copy(input, 0)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value, maximum, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) return false
  let length = 0
  for (const character of value) {
    void character
    if (++length > maximum) return false
  }
  return true
}

function identifier(value) {
  return typeof value === 'string' && ID.test(value) && !RESERVED.has(value)
}

function report() {
  const errors = []
  return {
    errors,
    check(condition, label) {
      if (!condition && errors.length < 64) errors.push(label)
      return condition
    },
  }
}

function closed(value, required, optional, label, checks) {
  if (!checks.check(object(value), `${label}: expected object`)) return false
  const allowed = new Set([...required, ...optional, 'ext'])
  checks.check(required.every((key) => Object.hasOwn(value, key)), `${label}: required field missing`)
  checks.check(Object.keys(value).every((key) => allowed.has(key)), `${label}: unknown field`)
  if (Object.hasOwn(value, 'ext')) checks.check(object(value.ext), `${label}.ext: expected object`)
  return true
}

function record(value, minimum, maximum, label, checks) {
  if (!checks.check(object(value), `${label}: expected record`)) return false
  const keys = Object.keys(value)
  checks.check(keys.length >= minimum && keys.length <= maximum, `${label}: entry count outside limits`)
  checks.check(keys.every(identifier), `${label}: invalid identifier`)
  return keys.length <= maximum
}

function scope(value, label, checks) {
  if (closed(value, ['workspaceId', 'authorizationRef'], [], label, checks)) {
    checks.check(identifier(value.workspaceId), `${label}.workspaceId: invalid identifier`)
    checks.check(identifier(value.authorizationRef), `${label}.authorizationRef: invalid identifier`)
  }
}

function version(value, label, checks) {
  if (Object.hasOwn(value, 'contractVersion')) {
    checks.check(typeof value.contractVersion === 'string' && VERSION.test(value.contractVersion), `${label}.contractVersion: invalid version`)
  }
}

function inspectRequest(request, checks) {
  if (!closed(request, ['schema', 'id', 'task', 'rubricVersion', 'scope', 'state', 'evidence', 'questions'], ['contractVersion'], 'request', checks)) return
  checks.check(request.schema === 'atelier-decision-request@v1', 'request.schema: unsupported schema')
  version(request, 'request', checks)
  for (const key of ['id', 'task', 'rubricVersion']) checks.check(identifier(request[key]), `request.${key}: invalid identifier`)
  scope(request.scope, 'request.scope', checks)
  checks.check(text(request.state, 32000, true), 'request.state: expected string within limit')
  const evidenceIds = new Set()
  if (checks.check(Array.isArray(request.evidence) && request.evidence.length >= 1 && request.evidence.length <= 256, 'request.evidence: expected 1..256 entries')) {
    for (const evidence of request.evidence) {
      if (!closed(evidence, ['id', 'sourceRef'], [], 'request.evidence[]', checks)) continue
      checks.check(identifier(evidence.id), 'request.evidence[].id: invalid identifier')
      checks.check(!evidenceIds.has(evidence.id), 'request.evidence: duplicate identifier')
      evidenceIds.add(evidence.id)
      checks.check(text(evidence.sourceRef, 2048), 'request.evidence[].sourceRef: expected nonempty reference within limit')
    }
  }
  inspectQuestions(request.questions, checks, 'request.questions', evidenceIds)
}

function inspectQuestions(questions, checks, label, evidenceIds = null) {
  if (!record(questions, 1, 64, label, checks)) return
  for (const question of Object.values(questions)) {
    if (!closed(question, ['type', 'instructions', 'evidenceIds', 'criteria'], [], `${label}[]`, checks)) continue
    checks.check(text(question.instructions, 4000), `${label}[].instructions: expected nonempty string within limit`)
    if (checks.check(Array.isArray(question.evidenceIds) && question.evidenceIds.length >= 1 && question.evidenceIds.length <= 256, `${label}[].evidenceIds: expected 1..256 references`)) {
      checks.check(new Set(question.evidenceIds).size === question.evidenceIds.length, `${label}[].evidenceIds: duplicate reference`)
      checks.check(question.evidenceIds.every(identifier), `${label}[].evidenceIds: invalid reference`)
      if (evidenceIds !== null) checks.check(question.evidenceIds.every((id) => evidenceIds.has(id)), `${label}[].evidenceIds: unknown reference`)
    }
    if (question.type === 'choice') {
      if (record(question.criteria, 2, 64, `${label}[].criteria`, checks)) {
        checks.check(Object.values(question.criteria).every((value) => text(value, 2000)), `${label}[].criteria: expected nonempty descriptions within limit`)
      }
    } else if (question.type === 'score') {
      checks.check(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10 && question.criteria.every((value) => text(value, 2000)), `${label}[].criteria: expected 2..10 nonempty ordered descriptions within limit`)
    } else if (question.type === 'boolean') {
      if (closed(question.criteria, ['true', 'false'], [], `${label}[].criteria`, checks)) {
        checks.check(text(question.criteria.true, 2000) && text(question.criteria.false, 2000), `${label}[].criteria: expected nonempty descriptions within limit`)
      }
    } else {
      checks.check(false, `${label}[].type: unsupported type`)
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function digest(request) {
  return createHash('sha256').update(canonical(request), 'utf8').digest('hex')
}

function inspected(input) {
  const checks = report()
  let request
  try {
    request = jsonSnapshot(input)
    inspectRequest(request, checks)
  } catch {
    checks.check(false, 'request: expected bounded plain JSON')
  }
  return { request, checks }
}

/** Validate structure and evidence references; this does not authorize egress. */
export function validateDecisionRequest(input) {
  const { checks } = inspected(input)
  return { ok: checks.errors.length === 0, errors: checks.errors }
}

/** Hash a valid request, including its scope, evidence, rubric and extensions. */
export function decisionRequestDigest(input) {
  const { request, checks } = inspected(input)
  if (checks.errors.length) throw new TypeError('Invalid decision request')
  return digest(request)
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function distribution(values, label, checks) {
  if (!checks.check(values.every(probability), `${label}: values must be probabilities`)) return false
  return checks.check(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= TOLERANCE, `${label}: probabilities must sum to one`)
}

function sameKeys(left, right) {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
}

function answer(question, value, checks, label) {
  if (question.type === 'choice') {
    if (!closed(value, ['type', 'choice', 'probabilities', 'confidence'], [], label, checks)) return
    checks.check(value.type === 'choice', `${label}.type: question type mismatch`)
    checks.check(probability(value.confidence), `${label}.confidence: expected probability`)
    checks.check(identifier(value.choice) && Object.hasOwn(question.criteria, value.choice), `${label}.choice: unknown choice`)
    if (record(value.probabilities, 2, 64, `${label}.probabilities`, checks)) {
      checks.check(sameKeys(value.probabilities, question.criteria), `${label}.probabilities: criteria keys mismatch`)
      const values = Object.values(value.probabilities)
      if (distribution(values, `${label}.probabilities`, checks) && Object.hasOwn(value.probabilities, value.choice)) {
        checks.check(value.probabilities[value.choice] === Math.max(...values), `${label}.choice: choice must have maximum probability`)
      }
    }
  } else if (question.type === 'score') {
    if (!closed(value, ['type', 'score', 'probabilities', 'confidence'], [], label, checks)) return
    checks.check(value.type === 'score', `${label}.type: question type mismatch`)
    checks.check(probability(value.confidence), `${label}.confidence: expected probability`)
    checks.check(typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= question.criteria.length - 1, `${label}.score: outside score range`)
    if (checks.check(Array.isArray(value.probabilities) && value.probabilities.length === question.criteria.length, `${label}.probabilities: criteria count mismatch`)) {
      if (distribution(value.probabilities, `${label}.probabilities`, checks)) {
        const expectation = value.probabilities.reduce((sum, value, index) => sum + value * index, 0)
        checks.check(Math.abs(value.score - expectation) <= TOLERANCE, `${label}.score: weighted expectation mismatch`)
      }
    }
  } else {
    if (!closed(value, ['type', 'probability'], [], label, checks)) return
    checks.check(value.type === 'boolean', `${label}.type: question type mismatch`)
    checks.check(probability(value.probability), `${label}.probability: expected probability`)
  }
}

function inspectAnswers(questions, answers, checks, label) {
  if (!record(answers, 0, 64, label, checks)) return
  checks.check(sameKeys(answers, questions), `${label}: question keys mismatch`)
  for (const [id, question] of Object.entries(questions)) {
    if (Object.hasOwn(answers, id)) answer(question, answers[id], checks, `${label}[]`)
  }
}

/**
 * Validate question/answer shape and distributions without state or hashing.
 * Evidence reference syntax is checked; membership and authority belong to
 * the host that holds the source snapshot and transient request binding.
 */
export function validateDecisionAnswers(inputQuestions, inputAnswers) {
  const checks = report()
  let questions
  try {
    questions = jsonSnapshot(inputQuestions)
    inspectQuestions(questions, checks, 'questions')
  } catch {
    checks.check(false, 'questions: expected bounded plain JSON')
  }
  if (checks.errors.length) return { ok: false, errors: checks.errors }
  try {
    inspectAnswers(questions, jsonSnapshot(inputAnswers), checks, 'answers')
  } catch {
    checks.check(false, 'answers: expected bounded plain JSON')
  }
  return { ok: checks.errors.length === 0, errors: checks.errors }
}

function inspectResult(request, result, checks) {
  if (!closed(result, ['schema', 'requestId', 'requestDigest', 'task', 'rubricVersion', 'scope', 'provider', 'authority', 'mode', 'status', 'answers', 'usage', 'elapsedMs'], ['reason', 'contractVersion'], 'result', checks)) return
  checks.check(result.schema === 'atelier-decision-result@v1', 'result.schema: unsupported schema')
  version(result, 'result', checks)
  checks.check(result.requestId === request.id, 'result.requestId: request binding mismatch')
  checks.check(result.requestDigest === digest(request), 'result.requestDigest: request binding mismatch')
  checks.check(result.task === request.task && result.rubricVersion === request.rubricVersion, 'result: task or rubric binding mismatch')
  scope(result.scope, 'result.scope', checks)
  checks.check(canonical(result.scope) === canonical(request.scope), 'result.scope: request binding mismatch')
  if (closed(result.provider, ['id', 'model'], [], 'result.provider', checks)) {
    checks.check(identifier(result.provider.id), 'result.provider.id: invalid identifier')
    checks.check(text(result.provider.model, 128), 'result.provider.model: expected nonempty model within limit')
  }
  checks.check(result.authority === 'proposal-only', 'result.authority: proposal-only required')
  checks.check(result.mode === 'shadow' || result.mode === 'advisory', 'result.mode: unsupported mode')
  checks.check(typeof result.elapsedMs === 'number' && Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0, 'result.elapsedMs: expected finite nonnegative number')
  if (result.usage !== null && closed(result.usage, ['inputTokens', 'outputTokens'], [], 'result.usage', checks)) {
    checks.check([result.usage.inputTokens, result.usage.outputTokens].every((value) => Number.isSafeInteger(value) && value >= 0), 'result.usage: expected nonnegative safe integers')
  }
  if (!record(result.answers, 0, 64, 'result.answers', checks)) return
  if (result.status === 'assessed') {
    checks.check(!Object.hasOwn(result, 'reason'), 'result.reason: not allowed for assessed result')
    inspectAnswers(request.questions, result.answers, checks, 'result.answers')
  } else if (result.status === 'abstained') {
    checks.check(Object.keys(result.answers).length === 0, 'result.answers: abstention must have no answers')
    checks.check(REASONS.has(result.reason), 'result.reason: unsupported abstention reason')
  } else {
    checks.check(false, 'result.status: unsupported status')
  }
}

/** Validate integrity and distributions; validity never establishes correctness. */
export function validateDecisionResult(input, output) {
  const { request, checks } = inspected(input)
  if (checks.errors.length) return { ok: false, errors: ['request: invalid decision request'] }
  try {
    inspectResult(request, jsonSnapshot(output), checks)
  } catch {
    checks.check(false, 'result: expected bounded plain JSON')
  }
  return { ok: checks.errors.length === 0, errors: checks.errors }
}
