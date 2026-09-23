import fs from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { boundedLearningValue, learningDigest as digest } from '../learning/contracts.mjs'
const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-interaction.v1.schema.json', import.meta.url)))
const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv)
const validators = new Map()
export function validateInteraction(value, shape) {
  try { boundedLearningValue(value) } catch (error) { return [error.message] }
  if (!['observation', 'assessment', 'act', 'policy'].includes(shape)) return ['unsupported interaction shape']
  if (!validators.has(shape)) validators.set(shape, ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${shape}` }))
  const validate = validators.get(shape)
  return validate(value) ? [] : validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
}
export function assertInteraction(value, shape) {
  const errors = validateInteraction(value, shape)
  if (errors.length) throw new Error(`invalid ${shape}: ${errors.join('; ')}`)
  return value
}
export function reflectionReference(record) {
  const kind = record?.schema === 'atelier-reflection-observation@v1' ? 'observation' : 'assessment'
  assertInteraction(record, kind)
  return { kind, id: record.id, digest: digest(record) }
}
export function qualifyReflection({ assessment, observations, scope, purpose }) {
  assertInteraction(assessment, 'assessment'); boundedLearningValue(observations)
  if (!Array.isArray(observations) || observations.length > 128) throw new Error('bounded observations required')
  for (const o of observations) assertInteraction(o, 'observation')
  if (new Set(observations.map(o => o.id)).size !== observations.length) throw new Error('ambiguous observation identity')
  const reasons = []
  if (assessment.scope !== scope || assessment.purpose !== purpose || assessment.status !== 'active') reasons.push('assessment-outside-active-purpose')
  if (!assessment.evidence.length) reasons.push('assessment-without-evidence')
  if (new Set(assessment.evidence.map(e => `${e.kind}:${e.id}`)).size !== assessment.evidence.length) reasons.push('duplicate-evidence')
  const admitted = []
  for (const pin of assessment.evidence) {
    const o = observations.find(o => o.id === pin.id)
    if (pin.kind !== 'observation' || !o || digest(o) !== pin.digest || o.status !== 'active' || o.scope !== scope || o.purpose !== purpose) reasons.push(`evidence-stale-or-outside-purpose:${pin.id}`)
    else admitted.push(o)
  }
  if (assessment.claimKind === 'independent-capacity' && (assessment.subject.kind !== 'person' || admitted.some(o => o.assistance !== 'independent' || o.subject.kind !== 'person' || o.subject.id !== assessment.subject.id))) reasons.push('independent-capacity-not-supported-by-admitted-evidence')
  if (assessment.claimKind === 'system-friction' && assessment.subject.kind === 'person') reasons.push('system-friction-cannot-be-a-personal-capacity-claim')
  return { reference: reflectionReference(assessment), current: reasons.length === 0, reasons,
    uncertainty: assessment.uncertainty, limits: assessment.limits, semanticTruthVerified: false, observationAuthorityTransferred: false }
}
// The caller supplies an attributed judgment. This function qualifies its exact
// evidence, never invents a developmental score or silently persists a profile.
export function prepareReflectiveAct({ assessment, observations, act }) {
  assertInteraction(act, 'act')
  const result = qualifyReflection({ assessment, observations, scope: act.scope, purpose: act.purpose })
  if (!result.current) throw new Error(`reflection unavailable: ${result.reasons.join('; ')}`)
  if (act.origin !== 'witness' || !['reflective', 'coaching'].includes(act.mode)) throw new Error('reflective contribution requires Witness origin and declared mode')
  const required = [reflectionReference(assessment), ...assessment.evidence]
  for (const pin of required) if (!act.dependencies.some(p => digest(p) === digest(pin))) throw new Error('reflective act must pin its assessment and evidence')
  if (act.mode === 'coaching' && !act.dependencies.some(p => p.kind === 'intention')) throw new Error('coaching requires a current chosen intention')
  return { act: structuredClone(act), assessment: result, deliverable: false, executionAuthorized: false }
}
