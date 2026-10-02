import { EVIDENCE_LIMITS, evidenceJson } from '../evidence-navigation/contracts.mjs'
import { validateDecisionRequest } from '../decisions/contracts.mjs'
import { contentDigest, harnessRef, validateHarnessDocument } from '../harnesses/contracts.mjs'
import { inspectKnowledge } from '../knowledge/ledger.mjs'

// Internal composition format. No schema, package export, CLI or separate store.
export const DECISION_PRACTICE_FORMAT = 'atelier.decision-practice/v0'
const flags = { executionAuthorized: false, authorityTransferred: false, semanticTruthVerified: false }
const refusal = reason => ({ status: 'refused', reason, ...flags })
const inputReason = (error, fallback) => Object.getOwnPropertyDescriptor(error ?? {}, 'message')?.value === 'evidence value exceeds bounds' ? 'practice-input-exceeds-bounds' : fallback
const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const ids = value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(id) && new Set(value).size === value.length

// The shared copier reports per-string/NUL exclusions as non-JSON. Only a
// bounded, descriptor-plain JSON graph can reclassify that as a profile limit.
// Continue past strings to avoid hiding an accessor, cycle or prototype before
// the bound. A bound reached first retains the shared copier's refusal order.
function hasExcludedJsonString(value) {
  const active = new Set()
  let remaining = EVIDENCE_LIMITS.members, excluded = false
  function inspect(item, depth) {
    if (--remaining < 0 || depth > EVIDENCE_LIMITS.depth) return 'bounded'
    if (item === null || typeof item === 'boolean') return 'plain'
    if (typeof item === 'string') {
      excluded ||= item.length > EVIDENCE_LIMITS.bytes || item.includes('\u0000')
      return 'plain'
    }
    if (typeof item === 'number') return Number.isFinite(item) ? 'plain' : 'malformed'
    if (typeof item !== 'object' || active.has(item)) return 'malformed'
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item)
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) return 'malformed'
    active.add(item)
    let count = 0, dense = true
    for (const key of Reflect.ownKeys(item)) {
      if (array && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return 'malformed'
      const status = inspect(descriptor.value, depth + 1)
      if (status !== 'plain') return status
      if (array && key !== String(count)) dense = false
      count++
    }
    active.delete(item)
    return (!array || (dense && count === Object.getOwnPropertyDescriptor(item, 'length')?.value)) ? 'plain' : 'malformed'
  }
  const status = inspect(value, 0)
  return status === 'bounded' || (status === 'plain' && excluded)
}

// Internal helpers shared only by the two allocated composition modules.
export function decisionPracticeJson(input) {
  try { return evidenceJson(input) } catch (error) {
    if (Object.getOwnPropertyDescriptor(error ?? {}, 'message')?.value === 'evidence value must be JSON' && hasExcludedJsonString(input)) throw new Error('evidence value exceeds bounds')
    throw error
  }
}

export function decisionPracticeDraftValid(data) {
  // Fixed envelope is for existing contribution shape validation only. It is
  // never returned, appended, or evidence of a native actor/review/activation.
  return validateHarnessDocument({ schema: 'atelier-knowledge-record@v1', id: 'decision-practice-draft',
    run: 'decision-practice-check', at: '2000-01-01T00:00:00Z', by: 'validation-only', kind: 'contribution', data }, 'knowledge', 'contribution').length === 0
}

function inspect(value) {
  const reasons = []
  if (!closed(value, ['format', 'id', 'revision', 'purpose', 'applicability', 'rightsBasis', 'evidenceRoles', 'prerequisites', 'rubric', 'limits', 'allowedProposals', 'outcomeMap'])) return ['invalid-definition']
  if (value.format !== DECISION_PRACTICE_FORMAT || !id(value.id) || !id(value.revision)) reasons.push('invalid-definition-identity')
  if (![value.purpose, value.applicability, value.rightsBasis].every(text)) reasons.push('missing-purpose-applicability-or-rights')
  if (!ids(value.evidenceRoles) || !ids(value.prerequisites)) reasons.push('invalid-evidence-roles-or-prerequisites')
  if (!validateDecisionRequest(value.rubric).ok) reasons.push('invalid-rubric-request')
  const question = value.rubric?.questions?.[value.outcomeMap?.question]
  if (!closed(value.outcomeMap, ['question', 'choices']) || question?.type !== 'choice' ||
      !closed(value.outcomeMap.choices, Object.keys(question?.criteria ?? {})) ||
      !Object.values(value.outcomeMap.choices).every(outcome => ['proceed', 'stop', 'escalate'].includes(outcome)) ||
      !Object.values(value.outcomeMap.choices).includes('proceed')) reasons.push('invalid-outcome-map')
  if (!closed(value.limits, ['stages', 'evidence', 'assessments', 'proposals']) ||
      !Object.values(value.limits).every(count => Number.isSafeInteger(count) && count >= 1 && count <= 256) ||
      value.limits.evidence < value.evidenceRoles.length) reasons.push('invalid-budget')
  if (!Array.isArray(value.allowedProposals) || value.allowedProposals.length !== 1 || value.allowedProposals[0] !== 'reconsideration') reasons.push('unsupported-proposal-type')
  return reasons
}

/** Pure shape validation; purpose and rights text are declarations, not proof. */
export function validateDecisionPractice(input) {
  try {
    const reasons = inspect(decisionPracticeJson(input))
    return { valid: reasons.length === 0, reasons }
  } catch (error) { return { valid: false, reasons: [inputReason(error, 'invalid-definition')] } }
}

/** Prepare an ordinary Knowledge contribution draft; never append or adopt it. */
export function prepareDecisionPracticeContribution(input) {
  try {
    const value = decisionPracticeJson(input)
    if (!closed(value, ['records', 'definition', 'title', 'term']) || !text(value.title) || !id(value.term) || inspect(value.definition).length) return refusal('invalid-definition')
    let domain
    try { domain = inspectKnowledge(value.records).domain } catch { return refusal('invalid-definition-history') }
    if (!domain || !domain.data.vocabulary.types.some(term => term.id === value.term)) return refusal('unknown-domain-or-term')
    const body = JSON.stringify(value.definition, null, 2)
    const data = { domain: harnessRef(domain), category: 'decision-rationale', title: value.title, term: value.term,
      body, audience: domain.data.audience, scope: domain.data.scope,
      origin: { method: 'captured', locator: `decision-practice:${value.definition.id}`, contentDigest: contentDigest(body), rightsBasis: value.definition.rightsBasis }, basedOn: [] }
    if (!decisionPracticeDraftValid(data)) return refusal('practice-output-exceeds-bounds')
    // The adopted body and full rubric both travel in an operating instance.
    // Bound that core with the supplied history and reserve 8 KiB for additional
    // adoption/instance metadata. This is a size check, never a native record.
    try {
      const core = decisionPracticeJson({ records: [...value.records, { data }], instance: { request: value.definition.rubric } })
      if (new TextEncoder().encode(JSON.stringify(core)).byteLength > EVIDENCE_LIMITS.bytes - 8192) return refusal('practice-output-exceeds-bounds')
    } catch { return refusal('practice-output-exceeds-bounds') }
    return { status: 'prepared', data, semanticAcceptance: 'pending', ...flags }
  } catch (error) { return refusal(inputReason(error, 'invalid-definition')) }
}

/** Resolve exact reviewed/current activation from the caller's Knowledge history. */
export function readAdoptedDecisionPractice(input) {
  try {
    const value = decisionPracticeJson(input)
    if (!closed(value, ['records', 'definitionRef']) || !closed(value.definitionRef, ['id', 'digest'])) return refusal('invalid-definition-reference')
    const state = inspectKnowledge(value.records)
    const contribution = state.records.find(record => record.id === value.definitionRef.id)
    if (!contribution || contribution.kind !== 'contribution') return refusal('unadopted-definition')
    if (harnessRef(contribution).digest !== value.definitionRef.digest) return refusal('changed-definition')
    if (!state.accepted.includes(contribution.id)) return refusal('unadopted-definition')
    const stale = new Set(state.reconsider.map(item => item.id))
    const activation = state.records.findLast(record => record.kind === 'activation' && !stale.has(record.id) && record.data.reviews.some(pin => {
      const review = state.records.find(item => item.id === pin.id)
      return review?.data.target.id === contribution.id
    }))
    if (!activation) return refusal('unadopted-definition')
    let definition
    try {
      definition = decisionPracticeJson(JSON.parse(contribution.data.body))
      if (inspect(definition).length || contribution.data.body !== JSON.stringify(definition, null, 2) ||
          contribution.data.category !== 'decision-rationale' || contribution.data.origin.method !== 'captured' ||
          contribution.data.origin.locator !== `decision-practice:${definition.id}`) return refusal('invalid-definition')
    } catch (error) { return refusal(inputReason(error, 'invalid-definition')) }
    return { status: 'resolved', definition, definitionRef: harnessRef(contribution), activationRef: harnessRef(activation), historyDigest: state.head, ...flags }
  } catch (error) { return refusal(inputReason(error, 'invalid-definition-history')) }
}
