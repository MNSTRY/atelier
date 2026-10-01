import { evidenceJson } from '../evidence-navigation/contracts.mjs'
import { validateDecisionRequest } from '../decisions/contracts.mjs'
import { contentDigest, harnessRef } from '../harnesses/contracts.mjs'
import { inspectKnowledge } from '../knowledge/ledger.mjs'

// Internal composition format. No schema, package export, CLI or separate store.
export const DECISION_PRACTICE_FORMAT = 'atelier.decision-practice/v0'
const flags = { executionAuthorized: false, authorityTransferred: false, semanticTruthVerified: false }
const refusal = reason => ({ status: 'refused', reason, ...flags })
const id = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4000
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const ids = value => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(id) && new Set(value).size === value.length

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
    const reasons = inspect(evidenceJson(input))
    return { valid: reasons.length === 0, reasons }
  } catch { return { valid: false, reasons: ['invalid-definition'] } }
}

/** Prepare an ordinary Knowledge contribution draft; never append or adopt it. */
export function prepareDecisionPracticeContribution(input) {
  try {
    const value = evidenceJson(input)
    if (!closed(value, ['records', 'definition', 'title', 'term']) || !text(value.title) || !id(value.term) || inspect(value.definition).length) return refusal('invalid-definition')
    const domain = inspectKnowledge(value.records).domain
    if (!domain || !domain.data.vocabulary.types.some(term => term.id === value.term)) return refusal('unknown-domain-or-term')
    const body = JSON.stringify(value.definition, null, 2)
    return { status: 'prepared', data: { domain: harnessRef(domain), category: 'decision-rationale', title: value.title, term: value.term,
      body, audience: domain.data.audience, scope: domain.data.scope,
      origin: { method: 'captured', locator: `decision-practice:${value.definition.id}`, contentDigest: contentDigest(body), rightsBasis: value.definition.rightsBasis }, basedOn: [] },
    semanticAcceptance: 'pending', ...flags }
  } catch { return refusal('invalid-definition') }
}

/** Resolve exact reviewed/current activation from the caller's Knowledge history. */
export function readAdoptedDecisionPractice(input) {
  try {
    const value = evidenceJson(input)
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
    const definition = evidenceJson(JSON.parse(contribution.data.body))
    if (inspect(definition).length) return refusal('invalid-definition')
    return { status: 'resolved', definition, definitionRef: harnessRef(contribution), activationRef: harnessRef(activation), historyDigest: state.head, ...flags }
  } catch { return refusal('invalid-definition-history') }
}
