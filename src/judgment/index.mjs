import fs from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { boundedLearningValue, learningDigest } from '../learning/contracts.mjs'
import { assertAudience, contentDigest, harnessRef } from '../harnesses/contracts.mjs'
import { inspectKnowledge } from '../knowledge/ledger.mjs'
import { createHarnessHandoff, verifyHarnessHandoff } from '../harnesses/exchange.mjs'

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-judgment.v1.schema.json', import.meta.url)))
const ajv = new Ajv({ strict: true, allErrors: true }), validators = new Map()
export function validateJudgment(value, profile = 'case') {
  try { boundedLearningValue(value) } catch (error) { return [error.message] }
  if (!['case', 'decision'].includes(profile)) return ['unknown judgment profile']
  if (!validators.has(profile)) validators.set(profile, ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${profile}` }))
  const validate = validators.get(profile)
  if (!validate(value)) return validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
  const errors = []
  if (profile === 'case') {
    const options = new Set(value.alternatives.map(a => a.id))
    if (options.size !== value.alternatives.length) errors.push('alternative identities must be unique')
    if (value.disposition.choice !== null && !options.has(value.disposition.choice)) errors.push('choice must name a considered alternative')
    if (value.disposition.status === 'chosen' && value.disposition.choice === null) errors.push('chosen disposition requires an alternative')
    if (value.disposition.status !== 'chosen' && value.disposition.choice !== null) errors.push('open deliberation cannot claim a choice')
  } else {
    if (value.supersedes?.id === value.native.id) errors.push('a decision cannot supersede its own native identity')
    if (value.evidence.status === 'current' && !value.evidence.references.length) errors.push('current evidence requires exact references')
    if (value.implementation.status === 'verified' && value.implementation.receipt === null) errors.push('verified implementation requires its own receipt')
  }
  return errors
}
function assert(value, profile) {
  const errors = validateJudgment(value, profile)
  if (errors.length) throw new Error(`invalid judgment ${profile}: ${errors.join('; ')}`)
  return value
}
export function inspectPracticalCase(value) {
  assert(value, 'case')
  return { case: structuredClone(value), digest: learningDigest(value),
    ruleRequired: false, disposition: value.disposition.status, wisdomVerified: false,
    nextQuestions: value.questions, unresolvedDissent: value.voices.filter(v => v.position === 'dissent') }
}
// Native identity and decision status belong to the source repository. This
// adapter records a declared interpretation of exact source bytes, not a new ADR
// number, signature, status transition or repository-wide adoption.
export function importArchitectureDecision({ decision, sourceText }) {
  assert(decision, 'decision')
  if (typeof sourceText !== 'string' || Buffer.byteLength(sourceText) > 256 * 1024 || contentDigest(sourceText) !== decision.native.digest) throw new Error('native ADR source bytes differ')
  return { schema: 'atelier-decision-import@v1', decision: structuredClone(decision), sourceVerified: true,
    sourceDigest: contentDigest(sourceText), interpretationVerified: false, authorityTransferred: false }
}
export function renderArchitectureDecision(decision) {
  assert(decision, 'decision')
  return [`# ${decision.native.id}: ${decision.title}`, '', `Decision: ${decision.decision.status}`, `Implementation: ${decision.implementation.status}`, `Evidence: ${decision.evidence.status}`, '',
    '## Context', '', decision.context, '', '## Choice and rationale', '', decision.decision.choice, '', decision.decision.reason,
    '', '## Alternatives', '', ...decision.alternatives.map(a => `- ${a}`), '', '## Consequences and reconsideration', '', ...decision.consequences.map(c => `- ${c}`),
    '', ...decision.reconsiderWhen.map(c => `- Reconsider when ${c}`), '', 'Native status remains owned by the source repository.', ''].join('\n')
}
export function prepareJudgmentContribution({ records, value, profile, title, term, rightsBasis, sourceText }) {
  assert(value, profile)
  if (profile === 'decision') importArchitectureDecision({ decision: value, sourceText })
  const domain = inspectKnowledge(records).domain
  if (!domain) throw new Error('establish a knowledge domain first')
  assertAudience(domain.data.audience, value.audience)
  const body = JSON.stringify({ profile: `atelier-judgment-${profile}@v1`, value }, null, 2)
  return { data: { domain: harnessRef(domain), category: 'decision-rationale', title, term, body, audience: domain.data.audience, scope: domain.data.scope,
    origin: { method: 'captured', locator: profile === 'decision' ? value.native.ref : `practical-case:${value.id}`, contentDigest: contentDigest(body), rightsBasis }, basedOn: [] },
    semanticAcceptance: 'pending', authority: 'none' }
}
// Reviewed judgment travels through the existing Knowledge writer and Build
// dependency protocol. The typed payload is validated again, not hidden in ext.
export function createJudgmentDependency({ records, subjectId, target, dependencySnapshots = [], nativeSourceText }) {
  const subject = records.find(r => r.id === subjectId)
  if (subject?.kind !== 'contribution') throw new Error('judgment contribution required')
  let payload
  try { payload = JSON.parse(subject.data.body) } catch { throw new Error('typed judgment payload required') }
  const profile = payload.profile === 'atelier-judgment-case@v1' ? 'case' : payload.profile === 'atelier-judgment-decision@v1' ? 'decision' : null
  assert(payload.value, profile)
  if (profile === 'decision') importArchitectureDecision({ decision: payload.value, sourceText: nativeSourceText })
  const state = inspectKnowledge(records)
  const handoff = createHarnessHandoff({ profile: 'knowledge', repository: state.domain.data.repository, records, subjectId, target, dependencySnapshots })
  verifyHarnessHandoff({ handoff, records, dependencySnapshots })
  return { profile: `atelier-judgment-${profile}@v1`, subjectDigest: learningDigest(payload.value), handoff, nativeAuthorityTransferred: false }
}
