import { evidenceJson, validateEvidenceDocument } from '../evidence-navigation/contracts.mjs'
import { assessEvidenceCurrency } from '../evidence-navigation/evaluate.mjs'
import { validateDecisionRequest, validateDecisionResult, decisionRequestDigest } from '../decisions/contracts.mjs'
import { contentDigest, harnessRef } from '../harnesses/contracts.mjs'
import { inspectKnowledge } from '../knowledge/ledger.mjs'
import { readAdoptedDecisionPractice } from './practice.mjs'

const flags = { executionAuthorized: false, authorityTransferred: false, semanticTruthVerified: false }
const outcome = (status, reason) => ({ status, reason, ...flags })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const closed = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const canonical = value => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const countKeys = ['stages', 'evidence', 'assessments', 'proposals']

/** Inspect supplied facts and assessments. Outcomes never execute a stage. */
export function evaluateDecisionPractice(input) {
  try {
    const value = evidenceJson(input)
    if (!closed(value, ['records', 'definitionRef', 'instance']) ||
        !closed(value.instance, ['id', 'evidence', 'snapshots', 'at', 'prerequisites', 'spent', 'request', 'result', 'proposal']) ||
        typeof value.instance.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.instance.id)) return outcome('refuse', 'invalid-instance')
    const adopted = readAdoptedDecisionPractice({ records: value.records, definitionRef: value.definitionRef })
    if (adopted.status !== 'resolved') return outcome('refuse', adopted.reason)
    const definition = adopted.definition, instance = value.instance
    const protectedIds = new Set([adopted.definitionRef.id, adopted.activationRef.id, ...value.records.filter(record => record.kind === 'review' && record.data.target.id === adopted.definitionRef.id).map(record => record.id)])
    if (!closed(instance.proposal, ['type', 'target', 'term', 'title'])) return outcome('refuse', 'unsupported-proposal-type')
    if (protectedIds.has(instance.proposal.target?.id)) return outcome('refuse', 'self-definition-proposal')
    if (!definition.allowedProposals.includes(instance.proposal.type)) return outcome('refuse', 'unsupported-proposal-type')
    if (!Array.isArray(instance.evidence) || instance.evidence.length < definition.evidenceRoles.length ||
        instance.evidence.some(item => !closed(item, ['role', 'requestId', 'sourceRef', 'text', 'reference'])) ||
        instance.evidence.some(item => !definition.evidenceRoles.includes(item.role)) ||
        !definition.evidenceRoles.every(role => instance.evidence.some(item => item.role === role)) ||
        new Set(instance.evidence.map(item => item.requestId)).size !== instance.evidence.length) return outcome('refuse', 'missing-evidence')
    if (!closed(instance.spent, countKeys) || !Object.values(instance.spent).every(count => Number.isSafeInteger(count) && count >= 0 && count <= 256)) return outcome('refuse', 'invalid-budget')
    const required = { stages: 1, evidence: instance.evidence.length, assessments: 1, proposals: 1 }
    if (countKeys.some(key => instance.spent[key] + required[key] > definition.limits[key])) return outcome('refuse', 'budget-exhausted')
    if (!Array.isArray(instance.prerequisites) || instance.prerequisites.length !== definition.prerequisites.length ||
        instance.prerequisites.some(item => !closed(item, ['id', 'value']) || !definition.prerequisites.includes(item.id) || typeof item.value !== 'boolean') ||
        new Set(instance.prerequisites.map(item => item.id)).size !== instance.prerequisites.length) return outcome('refuse', 'unknown-prerequisite')
    for (const item of instance.evidence) {
      if (!validateEvidenceDocument('evidenceRef', item.reference).valid || typeof item.text !== 'string' || contentDigest(item.text) !== item.reference.contentDigest) return outcome('refuse', 'changed-evidence-text')
      if (assessEvidenceCurrency(item.reference, instance.snapshots, { at: instance.at }).status !== 'current') return outcome('refuse', 'stale-evidence')
    }
    const request = instance.request
    if (!validateDecisionRequest(request).ok || request.task !== definition.rubric.task || request.rubricVersion !== definition.rubric.rubricVersion ||
        canonical(request.questions) !== canonical(definition.rubric.questions) || canonical(request.scope) !== canonical(definition.rubric.scope)) return outcome('refuse', 'changed-rubric')
    if (request.evidence.length !== instance.evidence.length || !request.evidence.every(pin => instance.evidence.some(item => item.requestId === pin.id && item.sourceRef === pin.sourceRef)) ||
        request.state !== request.evidence.map(pin => `${pin.id}: ${instance.evidence.find(item => item.requestId === pin.id).text}`).join('\n')) return outcome('refuse', 'unbound-request-evidence')
    if (!validateDecisionResult(request, instance.result).ok) return outcome('refuse', 'invalid-rubric-result')
    if (instance.prerequisites.some(item => !item.value)) return outcome('stop', 'prerequisite-false')
    if (instance.result.status === 'abstained') return outcome('escalate', 'rubric-abstained')
    const disposition = definition.outcomeMap.choices[instance.result.answers[definition.outcomeMap.question].choice]
    if (disposition !== 'proceed') return outcome(disposition, 'rubric-disposition')
    const state = inspectKnowledge(value.records), target = state.records.find(record => record.id === instance.proposal.target?.id)
    if (!target || target.kind !== 'contribution' || !closed(instance.proposal.target, ['id', 'digest']) || harnessRef(target).digest !== instance.proposal.target.digest) return outcome('refuse', 'changed-proposal-target')
    if (!state.domain.data.vocabulary.types.some(term => term.id === instance.proposal.term) ||
        typeof instance.proposal.title !== 'string' || !instance.proposal.title.trim() || instance.proposal.title.length > 4000) return outcome('refuse', 'invalid-proposal')
    const body = JSON.stringify({ format: 'atelier.decision-reconsideration/v0', instanceId: instance.id,
      definitionRef: adopted.definitionRef, activationRef: adopted.activationRef, target: harnessRef(target),
      evidence: instance.evidence.map(item => ({ role: item.role, reference: item.reference })), requestDigest: decisionRequestDigest(request),
      assessment: instance.result, nativeAuthorityTransferred: false }, null, 2)
    return { ...outcome('proceed', 'reconsideration-draft-prepared'),
      proposal: { data: { domain: harnessRef(state.domain), category: 'interpretation', term: instance.proposal.term, title: instance.proposal.title,
        body, audience: state.domain.data.audience, scope: state.domain.data.scope,
        origin: { method: 'captured', locator: `decision-reconsideration:${instance.id}`, contentDigest: contentDigest(body), rightsBasis: definition.rightsBasis }, basedOn: [] },
      semanticAcceptance: 'pending', ...flags },
      declaredRemaining: Object.fromEntries(countKeys.map(key => [key, definition.limits[key] - instance.spent[key] - required[key]])) }
  } catch { return outcome('refuse', 'invalid-instance') }
}
