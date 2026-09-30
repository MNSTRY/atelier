import fs from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { boundedLearningValue, learningDigest as digest } from '../learning/contracts.mjs'

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-trackable.v1.schema.json', import.meta.url)))
const ajv = new Ajv({ strict: true, allErrors: true }); addFormats(ajv)
const validators = new Map()
export const TRACKABLE_ENGINE_REVISION = 'atelier-trackable-reference@v1'
export function validateTrackable(value, shape = 'definition') {
  try { boundedLearningValue(value) } catch (error) { return [error.message] }
  if (!['definition', 'request'].includes(shape)) return ['unsupported trackable shape']
  if (!validators.has(shape)) validators.set(shape, ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${shape}` }))
  const validate = validators.get(shape)
  if (!validate(value)) return validate.errors.map(e => `${e.instancePath || '/'}: ${e.message}`)
  if (shape === 'definition') {
    if ((value.profile === 'recurring-practice') !== (value.schedule !== null)) return ['/schedule: daily schedule is required only for recurring practice']
    if (value.schedule) try { new Intl.DateTimeFormat('en', { timeZone: value.schedule.timezone }).format(0) } catch { return ['/schedule/timezone: unsupported timezone'] }
  }
  return []
}
function valid(value, shape) {
  const errors = validateTrackable(value, shape)
  if (errors.length) throw new Error(`invalid trackable ${shape}: ${errors.join('; ')}`)
  return value
}
export function releaseTrackable(definition) {
  valid(definition, 'definition')
  return { definition: structuredClone(definition), digest: digest(definition), engine: TRACKABLE_ENGINE_REVISION }
}
export function initialTrackables(scope) {
  if (typeof scope !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(scope)) throw new Error('exact scope identity required')
  return { scope, revision: 0, definitions: [], instances: [], evidence: [] }
}
function instanceFor(state, id) {
  const instance = state.instances.find(i => i.id === id)
  if (!instance) throw new Error('trackable instance not found in scope')
  return instance
}
function definitionFor(state, pin) {
  const release = state.definitions.find(d => d.digest === pin)
  if (!release || releaseTrackable(release.definition).digest !== pin) throw new Error('immutable definition missing or changed')
  return release.definition
}
function adoptionAt(instance, at) {
  const adoption = instance.adoptions.findLast(a => Date.parse(a.effectiveAt) <= Date.parse(at))
  if (!adoption) throw new Error('no adopted definition at occurrence time')
  return adoption
}
function dateAt(at, timezone) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k).value).join('-')
}
export function trackableOccurrence(state, instanceId, occurredAt, eventId = null) {
  return resolveOccurrence(state, instanceId, occurredAt, eventId)
}
function resolveOccurrence(state, instanceId, occurredAt, eventId, resolution = null) {
  if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) throw new Error('UTC occurrence instant required')
  const instance = instanceFor(state, instanceId), adoption = adoptionAt(instance, occurredAt)
  const definition = definitionFor(state, adoption.definitionDigest)
  if (definition.profile === 'qualitative-series' && (typeof eventId !== 'string' || !eventId)) throw new Error('qualitative occurrence requires source event identity')
  // Replay owns a journal-pinned calendar observation. New commands and previews
  // omit it and resolve using the current host. Never accept it in command input.
  const localDate = resolution ? resolution.occurrence?.localDate
    : definition.schedule ? dateAt(occurredAt, definition.schedule.timezone) : null
  if (definition.schedule) {
    if (typeof localDate !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(localDate) || !Number.isFinite(Date.parse(localDate)) || new Date(localDate).toISOString().slice(0, 10) !== localDate) throw new Error('invalid recorded calendar date')
  } else if (localDate !== null) throw new Error('invalid recorded calendar date')
  const key = { scope: state.scope, instanceId, definitionDigest: adoption.definitionDigest, effectiveAt: adoption.effectiveAt,
    window: localDate ?? (definition.profile === 'milestone' ? 'milestone' : eventId) }
  const occurrence = { id: digest(key), ...key, localDate, timezone: definition.schedule?.timezone ?? null }
  if (resolution) {
    const tzdata = resolution.tzdata
    if (tzdata !== null && (typeof tzdata !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(tzdata))) throw new Error('invalid recorded timezone data version')
    if (digest(resolution) !== digest({ occurredAt, sourceRef: eventId, occurrence, tzdata })) throw new Error('recorded occurrence identity differs')
  }
  return occurrence
}
function checkResult(definition, result, value) {
  if (definition.profile === 'qualitative-series') {
    if (result !== 'observed' || typeof value !== 'string' || !value.trim()) throw new Error('qualitative series requires an attributed text observation')
  } else if (result === 'observed' || (result === 'completed' ? value !== true : value !== null)) {
    throw new Error('practice/milestone completion requires true; other dispositions carry no value')
  }
}
function effectiveEvidence(state, instanceId) { return state.evidence.filter(e => e.instanceId === instanceId && !e.withdrawn) }
// The same reducer is used by authoring preview, durable local execution and
// host adapters. Host authentication and storage are separate responsibilities.
export function reduceTrackables(previous, command, { actor, recordedAt, occurrenceResolution = null } = {}) {
  valid(command, 'request')
  if (occurrenceResolution !== null && (command.operation !== 'record' || typeof occurrenceResolution !== 'object' || Array.isArray(occurrenceResolution))) throw new Error('recorded occurrence requires a record command')
  if (typeof actor !== 'string' || !actor || actor.length > 128 || !Number.isFinite(Date.parse(recordedAt))) throw new Error('actor and recording time required')
  if (command.expectedRevision !== previous.revision) throw new Error('trackable revision changed; reload')
  const state = structuredClone(previous), input = command.input
  if (command.operation === 'release') {
    const release = releaseTrackable(input.definition)
    if (state.definitions.some(d => d.definition.id === input.definition.id && d.definition.revision === input.definition.revision)) throw new Error('definition revision already exists; publish a new revision')
    state.definitions.push(release)
  } else if (command.operation === 'instantiate') {
    if (state.instances.some(i => i.id === input.instanceId)) throw new Error('instance identity already exists')
    const definition = definitionFor(state, input.definitionDigest)
    state.instances.push({ id: input.instanceId, subject: input.subject, owner: actor, lifecycle: 'active',
      disposition: definition.profile === 'milestone' ? 'open' : null, dispositionBasis: [],
      adoptions: [{ definitionDigest: input.definitionDigest, effectiveAt: input.effectiveAt }] })
  } else if (command.operation === 'correct') {
    const evidence = state.evidence.find(e => e.id === input.evidenceId)
    if (!evidence) throw new Error('evidence not found in scope')
    if (evidence.withdrawn) throw new Error('withdrawn evidence cannot be silently restored')
    if (input.replacement) checkResult(definitionFor(state, evidence.occurrence.definitionDigest), input.replacement.result, input.replacement.value)
    evidence.corrections.push({ actor, recordedAt, reason: input.reason, previous: { result: evidence.result, value: evidence.value } })
    if (input.replacement) Object.assign(evidence, input.replacement)
    else evidence.withdrawn = true
  } else {
    const instance = instanceFor(state, input.instanceId)
    if (command.operation === 'lifecycle') {
      if (instance.lifecycle === 'retired') throw new Error('retired instance cannot be resumed; instantiate separately')
      instance.lifecycle = input.status
    } else if (command.operation === 'adopt') {
      if (instance.lifecycle === 'retired') throw new Error('retired instance cannot adopt')
      const definition = definitionFor(state, input.definitionDigest), last = instance.adoptions.at(-1)
      const previousDefinition = definitionFor(state, last.definitionDigest)
      if (definition.id !== previousDefinition.id || definition.profile !== previousDefinition.profile || definition.revision <= previousDefinition.revision) throw new Error('adoption requires a later compatible definition revision')
      if (Date.parse(input.effectiveAt) <= Date.parse(last.effectiveAt) || state.evidence.some(e => e.instanceId === instance.id && Date.parse(e.occurredAt) >= Date.parse(input.effectiveAt))) throw new Error('adoption would reinterpret recorded occurrences')
      instance.adoptions.push({ definitionDigest: input.definitionDigest, effectiveAt: input.effectiveAt })
    } else if (command.operation === 'record') {
      if (instance.lifecycle !== 'active') throw new Error('recording requires active tracking')
      const evidence = input.evidence
      if (state.evidence.some(e => e.id === evidence.id)) throw new Error('evidence identity already exists')
      if (Date.parse(evidence.occurredAt) > Date.parse(recordedAt)) throw new Error('future occurrence evidence refused')
      const occurrence = resolveOccurrence(state, instance.id, evidence.occurredAt, evidence.source.ref, occurrenceResolution)
      checkResult(definitionFor(state, occurrence.definitionDigest), evidence.result, evidence.value)
      if (state.evidence.some(e => e.instanceId === instance.id && e.source.kind === evidence.source.kind && e.source.ref === evidence.source.ref)) throw new Error('source event already recorded; retry the original command or correct it')
      state.evidence.push({ ...structuredClone(evidence), instanceId: instance.id, occurrence, recorder: actor, recordedAt, corrections: [], withdrawn: false })
    } else if (command.operation === 'disposition') {
      if (instance.disposition === null) throw new Error('domain fulfillment is available only for the milestone profile')
      const evidence = input.basisEvidenceIds.map(id => effectiveEvidence(state, instance.id).find(e => e.id === id))
      if (evidence.some(e => !e) || new Set(input.basisEvidenceIds).size !== evidence.length) throw new Error('fulfillment basis must identify distinct current evidence in this instance')
      if (input.status === 'fulfilled' && !evidence.some(e => e.result === 'completed')) throw new Error('fulfillment requires current completion evidence')
      instance.disposition = input.status; instance.dispositionBasis = [...input.basisEvidenceIds]
    }
  }
  state.revision++
  return state
}
export function trackableView(state, { instanceId, at = new Date().toISOString() }) {
  const instance = instanceFor(state, instanceId), current = trackableOccurrence(state, instanceId, at, 'current')
  const definition = definitionFor(state, current.definitionDigest)
  const groups = new Map()
  for (const evidence of effectiveEvidence(state, instanceId)) {
    if (Date.parse(evidence.occurredAt) > Date.parse(at)) continue
    if (!groups.has(evidence.occurrence.id)) groups.set(evidence.occurrence.id, { occurrence: evidence.occurrence, evidence: [] })
    groups.get(evidence.occurrence.id).evidence.push(evidence)
  }
  if (definition.profile !== 'qualitative-series' && !groups.has(current.id)) groups.set(current.id, { occurrence: current, evidence: [] })
  const occurrences = [...groups.values()].map(({ occurrence, evidence }) => {
    const values = [...new Set(evidence.map(e => e.result))]
    return { occurrence, result: values.length === 0 ? 'unobserved' : values.length > 1 ? 'disputed' : values[0],
      evidenceIds: evidence.map(e => e.id), values: evidence.map(e => e.value), assistance: [...new Set(evidence.map(e => e.assistance))] }
  })
  const staleDisposition = instance.disposition === 'fulfilled' && !effectiveEvidence(state, instanceId).some(e => instance.dispositionBasis.includes(e.id) && e.result === 'completed')
  return { schema: 'atelier-trackable-view@v1', engine: TRACKABLE_ENGINE_REVISION, scope: state.scope, revision: state.revision,
    instanceId, subject: instance.subject, definitionDigest: current.definitionDigest, at, lifecycle: instance.lifecycle,
    disposition: instance.disposition, dispositionEvidence: staleDisposition ? 'needs-reconsideration' : 'current', occurrences,
    coverage: 'recorded-evidence-and-current-window', completedOccurrences: occurrences.filter(o => o.result === 'completed').length,
    evidenceQuality: occurrences.some(o => o.result === 'disputed') ? 'disputed' : (!occurrences.length || occurrences.some(o => o.result === 'unobserved')) ? 'missing' : 'available',
    attention: 'unassessed', progressPercent: null, abilityAssessed: false, interpretationLimits: definition.interpretationLimits }
}
export function previewTrackable({ definition, subject = 'preview-subject', at, effectiveAt = at, evidence = [] }) {
  let state = initialTrackables('preview')
  let serial = 0
  const apply = (operation, input) => { state = reduceTrackables(state, { schema: 'atelier-trackable-command@v1', requestId: `preview-${++serial}`, expectedRevision: state.revision, operation, input }, { actor: 'preview-author', recordedAt: at }) }
  apply('release', { definition }); apply('instantiate', { instanceId: 'preview', subject, definitionDigest: digest(definition), effectiveAt })
  for (const entry of evidence) apply('record', { instanceId: 'preview', evidence: entry })
  return { ...trackableView(state, { instanceId: 'preview', at }), mode: 'preview', persisted: false }
}
