import { canonicalize } from '../attestation/jcs.mjs'
import { createIntakeStore, intakeDigest } from '../intake/store.mjs'
import { createIngestionStore } from '../ingestion/store.mjs'
import { ingestionJson, ingestionDigest } from '../ingestion/contracts.mjs'
import { prepareSemanticInput, prepareSemanticProposals, readSemanticProposals } from '../ingestion/semantic.mjs'
import { appendHarness, readHarness } from '../harnesses/store.mjs'
import { harnessRef, contentDigest } from '../harnesses/contracts.mjs'
import { inspectKnowledge } from './ledger.mjs'
import { prepareIngestionContribution, localKnowledgeContext } from './ingestion.mjs'
import { knowledgeGraphProposal } from './projection.mjs'
import { learningDigest } from '../learning/contracts.mjs'

const OPERATION = 'atelier.semantic-operation/v0'
export const SEMANTIC_OPERATION_PROFILE = 'atelier.semantic-operation-profile/v0'
export class SemanticOperationError extends Error {
  constructor(code, message) { super(message); this.name = 'SemanticOperationError'; this.code = code }
}
function check(condition, code, message) { if (!condition) throw new SemanticOperationError(code, message) }
function identifier(value) { check(typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value), 'SEMANTIC_OPERATION_INVALID', 'A bounded operation identifier is required'); return value }
function json(value) {
  try { return ingestionJson(value) }
  catch (error) {
    const limit = ['ingestion JSON depth exceeded', 'ingestion member ceiling exceeded', 'ingestion document byte ceiling exceeded'].includes(error?.message)
    throw new SemanticOperationError(limit ? 'SEMANTIC_OPERATION_LIMIT' : 'SEMANTIC_OPERATION_INVALID', limit ? 'Operation JSON limit exceeded' : 'Bounded plain operation JSON is required')
  }
}
function closed(value, fields) {
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), 'SEMANTIC_OPERATION_INVALID', 'The declared operation shape is required')
}
const eventId = (operationId, phase) => `semantic-${intakeDigest(`${operationId}:${phase}`).slice(0, 40)}`
function extractorPins(value, inputDigest) {
  const pins = json(value)
  closed(pins, ['id', 'version', 'route', 'model', 'promptDigest', 'parameters'])
  identifier(pins.id)
  check(typeof pins.version === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(pins.version), 'SEMANTIC_OPERATION_INVALID', 'A bounded extractor version is required')
  check(['model', 'deterministic', 'authored'].includes(pins.route), 'SEMANTIC_OPERATION_INVALID', 'Declare the extraction route')
  check(pins.route === 'model' ? typeof pins.model === 'string' && pins.model.length > 0 && pins.model.length <= 256 : pins.model === null, 'SEMANTIC_OPERATION_INVALID', 'Model routes need a model pin; other routes use null')
  check(typeof pins.promptDigest === 'string' && /^[a-f0-9]{64}$/.test(pins.promptDigest), 'SEMANTIC_OPERATION_INVALID', 'A prompt or configuration digest is required')
  check(pins.parameters && typeof pins.parameters === 'object' && !Array.isArray(pins.parameters), 'SEMANTIC_OPERATION_INVALID', 'Plain extractor parameters are required')
  return { ...pins, configurationDigest: intakeDigest(canonicalize({ ...pins, inputDigest })) }
}

// Called only after the proposal validator has checked the complete assertion.
// Omission is explicit: the qualified contribution remains available for review.
export function plainAssertionEligibility(assertion, domain) {
  check(assertion && assertion.time && Array.isArray(assertion.time.unknowns) && domain?.data &&
    ['from', 'until', 'expression'].every(key => Object.hasOwn(assertion.time, key)), 'SEMANTIC_PROJECTION_SUPPORT', 'An explicitly qualified assertion and domain are required')
  const reasons = []
  if (assertion.objectId === null || assertion.direction !== 'subject-to-object') reasons.push('unary')
  if (assertion.negated !== false) reasons.push('negated')
  if (assertion.modality !== 'asserted') reasons.push('modal')
  if (assertion.time.from !== null || assertion.time.until !== null || assertion.time.expression !== null || assertion.time.unknowns.length) reasons.push('temporal')
  if (assertion.scope !== domain.data.scope) reasons.push('scope')
  return { eligible: reasons.length === 0, reasons }
}

export const semanticRelationId = assertionId => `relation-${intakeDigest(identifier(assertionId)).slice(0, 40)}`
export function assertSemanticOperationProfile({ references = [], candidates = null }) {
  if (Array.isArray(references)) for (const reference of references) {
    check(!reference?.locator || ['line', 'csv-cell', 'json-pointer'].includes(reference.locator.kind), 'SEMANTIC_UNSUPPORTED_LOCATOR', 'unsupported-locator')
  }
  if (Array.isArray(candidates?.assertions)) for (const assertion of candidates.assertions) {
    if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) continue
    check(assertion.scope === undefined || typeof assertion.scope === 'string', 'SEMANTIC_UNSUPPORTED_SCOPE', 'unsupported-scope')
    check(!Object.hasOwn(assertion, 'literalObject') && (assertion.objectId === undefined || assertion.objectId === null || typeof assertion.objectId === 'string'), 'SEMANTIC_UNSUPPORTED_LITERAL_OBJECT', 'unsupported-literal-object')
    if (Array.isArray(assertion.evidence)) for (const support of assertion.evidence) {
      check(typeof support?.quote !== 'string' || !/[\r\n]/u.test(support.quote), 'SEMANTIC_UNSUPPORTED_LOCATOR', 'unsupported-locator: multiline quote')
    }
  }
}
export function semanticDependencyWitnesses({ citations, sources, endpoints = [] }) {
  const basedOn = [], sourceWitness = []
  function witness(record, quote) {
    check(typeof quote === 'string' && quote.length > 0, 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION', 'A source quote is required for a dependency witness')
    let encoded = ''
    for (const point of quote) {
      const encodedPoint = JSON.stringify(point).slice(1, -1)
      if (encoded.length + encodedPoint.length > 8192) break
      encoded += encodedPoint
    }
    check(encoded.length > 0 && record.data.body.includes(encoded), 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION', 'The encoded dependency witness is absent from the stored contribution body')
    if (basedOn.some(item => item.contribution.id === record.id)) return
    check(basedOn.length < 64, 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION', 'Sources and endpoints exceed the existing dependency limit')
    basedOn.push({ contribution: harnessRef(record), quote: encoded })
    sourceWitness.push({ contributionId: record.id, encoding: 'json-string-substring', purpose: 'ledger-dependency-only' })
  }
  for (const citation of citations) {
    const matches = sources.filter(record => record.data.origin.method === 'extracted' && record.data.origin.attemptId === citation.attemptId && record.data.origin.blobDigest === `sha256:${citation.sourceDigest}`)
    check(matches.length === 1, 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION', 'Each citation needs one exact current structural source contribution')
    witness(matches[0], citation.quote)
  }
  for (const endpoint of endpoints) witness(endpoint.record, endpoint.quote)
  return { basedOn, sourceWitness }
}
// Relation support is not a ledger dependency in harness v1. This guard is
// stateless and fails closed even when withdrawal cleanup has not run.
export function assertSemanticProjection({ records, activationId, reconsider = [] }) {
  const state = inspectKnowledge(records), byId = new Map(records.map(record => [record.id, record]))
  const stale = new Set([...state.reconsider, ...reconsider].map(item => item.id))
  const accepted = new Set(state.accepted), active = new Set(), selected = new Set()
  const activation = byId.get(activationId)
  check(activation?.kind === 'activation' && !stale.has(activationId), 'SEMANTIC_PROJECTION_STALE', 'A current activation is required')
  for (const record of records) if (record.kind === 'activation' && !stale.has(record.id)) {
    for (const pin of record.data.reviews) active.add(byId.get(pin.id).data.target.id)
  }
  function include(id) {
    if (selected.has(id)) return
    check(accepted.has(id) && !stale.has(id), 'SEMANTIC_PROJECTION_STALE', 'Every projected dependency must have current acceptance')
    selected.add(id)
    const record = byId.get(id)
    if (record.kind === 'relation') {
      const support = /(?:^|\n)semantic-support: ([a-z][a-z0-9-]{0,63}) (sha256:[a-f0-9]{64})$/.exec(record.data.rationale)
      check(support && record.id === semanticRelationId(support[1]), 'SEMANTIC_PROJECTION_SUPPORT', 'A semantic relation needs its unique exact assertion support pin')
      const assertion = byId.get(support[1])
      check(assertion?.kind === 'contribution' && harnessRef(assertion).digest === support[2], 'SEMANTIC_PROJECTION_SUPPORT', 'Relation assertion support digest differs')
      check(accepted.has(assertion.id) && active.has(assertion.id) && !stale.has(assertion.id), 'SEMANTIC_PROJECTION_SUPPORT', 'Relation support must be currently accepted, active and not withdrawn or superseded')
      let body
      try { body = JSON.parse(assertion.data.body) } catch { throw new SemanticOperationError('SEMANTIC_PROJECTION_SUPPORT', 'A qualified assertion body is required') }
      check(body?.schema === SEMANTIC_OPERATION_PROFILE && body.kind === 'assertion', 'SEMANTIC_PROJECTION_SUPPORT', 'A semantic assertion contribution is required')
      check(plainAssertionEligibility(body.candidate, state.domain).eligible, 'SEMANTIC_PROJECTION_QUALIFIED', 'A qualified assertion cannot become a plain edge')
      check(body.candidate.predicate === record.data.predicate && body.endpoints?.subject?.id === record.data.subject.id && body.endpoints?.object?.id === record.data.object.id,
        'SEMANTIC_PROJECTION_SUPPORT', 'Relation participants differ from its reviewed assertion')
      include(assertion.id)
      include(record.data.subject.id); include(record.data.object.id)
    } else for (const pin of record.data.basedOn) include(pin.contribution.id)
  }
  for (const pin of activation.data.reviews) include(byId.get(pin.id).data.target.id)
  return { selected: [...selected], activation: harnessRef(activation), authority: 'none' }
}

// Existing intake owns bytes; the existing harness owns all durable metadata.
// This runner never invokes an extractor or infers a receiver decision.
export function createSemanticOperation({ workspaceRoot, workspaceId, run }) {
  identifier(run)
  const intake = createIntakeStore({ workspaceRoot })
  const store = createIngestionStore({ workspaceRoot, workspaceId })
  const readHistory = () => readHarness({ workspaceRoot, profile: 'knowledge', run })
  let verification = null
  const history = () => verification?.state ?? readHistory()
  function verified(read) {
    if (verification) return read()
    const state = readHistory()
    verification = { state, completed: new Map(), sources: new Map() }
    let result
    try {
      result = read()
      for (const current of verification.completed.values()) {
        const input = current.initial.value.input
        const refreshed = prepareSemanticInput({ store, plan: input.plan, domain: state.domain, references: input.evidence.map(span => span.reference), identityCandidates: input.identityCandidates })
        check(refreshed.digest === input.digest, 'SEMANTIC_OPERATION_STALE', 'Semantic evidence changed during the operation')
      }
      check(readHistory().head === (result.head ?? state.head), 'SEMANTIC_OPERATION_HEAD', 'Knowledge history changed during the operation')
      return result
    } catch (error) {
      if (result?.record && result.head) {
        error.recorded = { record: harnessRef(result.record), head: result.head, nextAction: 'reopen-recorded-write' }
      }
      throw error
    } finally { verification = null }
  }
  function events(state) {
    const result = []
    for (const record of state.records) {
      if (record.kind !== 'contribution') continue
      let value
      try { value = JSON.parse(record.data.body) } catch { continue }
      if (value?.schema !== OPERATION) continue
      check(record.data.origin.method === 'captured' && record.data.origin.contentDigest === contentDigest(record.data.body) && record.id === eventId(value.operationId, value.phase), 'SEMANTIC_OPERATION_INTEGRITY', 'Operation record identity differs')
      result.push({ record, value })
    }
    return result
  }
  function operation(operationId, state = history()) {
    identifier(operationId)
    const matching = events(state).filter(event => event.value.operationId === operationId)
    check(matching.length > 0 && matching[0].value.phase === 'reserved', 'SEMANTIC_OPERATION_MISSING', 'No reserved semantic operation exists')
    return { initial: matching[0], latest: matching.at(-1), state }
  }
  function append(value, { term, at, by, confirm, basedOn = [] }) {
    const state = history(), domain = state.domain
    check(domain && state.head === confirm, 'SEMANTIC_OPERATION_HEAD', 'The current knowledge history digest is required')
    const body = canonicalize(json(value))
    const record = { schema: 'atelier-knowledge-record@v1', id: eventId(value.operationId, value.phase), run, at, by, kind: 'contribution', data: {
      domain: harnessRef(domain), category: 'decision-rationale', term, title: `Semantic operation ${value.operationId}: ${value.phase}`, body,
      audience: domain.data.audience, scope: domain.data.scope,
      origin: { method: 'captured', locator: `semantic-operation:${value.operationId}`, contentDigest: contentDigest(body), rightsBasis: 'Host-declared operation metadata; integrity is not semantic acceptance.' }, basedOn,
    } }
    return appendHarness({ workspaceRoot, profile: 'knowledge', record, confirm })
  }
  function inspected(initial) {
    const value = initial.value, result = intake.readAttempt(value.attemptId)
    if (result.status !== 'absent') {
      check(ingestionDigest(result.attempt) === ingestionDigest({ schema: 'mnstry.atelier-intake-attempt@v1', attemptId: value.attemptId, blobId: value.source.digest,
        extractorId: value.extractor.id, extractorVersion: value.extractor.version, configurationDigest: value.extractor.configurationDigest }), 'SEMANTIC_OPERATION_INTEGRITY', 'Raw attempt differs from its operation pins')
    }
    if (result.status === 'complete') {
      check(ingestionDigest(intake.readCompletion(value.attemptId)) === ingestionDigest(result.completion), 'SEMANTIC_OPERATION_INTEGRITY', 'Completion readback differs')
    }
    return result
  }
  function status({ operationId }) {
    const { initial, latest, state } = operation(operationId), value = initial.value
    const attempt = inspected(initial)
    let freshness = 'current'
    try {
      intake.readSource({ ref: value.source.ref, expectedDigest: value.source.digest })
      const refreshed = prepareSemanticInput({ store, plan: value.input.plan, domain: state.domain, references: value.input.evidence.map(span => span.reference), identityCandidates: value.input.identityCandidates })
      check(refreshed.digest === value.input.digest, 'SEMANTIC_OPERATION_STALE', 'Current semantic input differs')
    } catch { freshness = 'stale' }
    if (latest.value.phase === 'completed') {
      check(attempt.status === 'complete' && ingestionDigest(attempt.completion) === ingestionDigest(latest.value.completion), 'SEMANTIC_OPERATION_INTEGRITY', 'Saved completion differs from intake')
    }
    return { schema: 'atelier.semantic-operation-status/v0', operationId, phase: latest.value.phase, head: state.head, input: value.input, extractor: value.extractor,
      attempt, freshness, execution: latest.value.phase === 'reconciled' ? 'reconciled' : attempt.status === 'complete' ? 'complete' : 'unknown',
      usage: latest.value.usage ?? null, authority: 'none', semanticAcceptance: 'pending' }
  }
  function begin(request) {
    const selected = json(request)
    closed(selected, ['operationId', 'attemptId', 'at', 'term', 'plan', 'references', 'identityCandidates', 'extractor', 'confirm'])
    const { operationId, attemptId, at, term, confirm } = selected
    assertSemanticOperationProfile({ references: selected.references })
    identifier(operationId); identifier(attemptId)
    const state = history()
    check(state.domain && state.head === confirm, 'SEMANTIC_OPERATION_HEAD', 'The current knowledge history digest is required')
    check(!events(state).some(event => event.value.operationId === operationId), 'SEMANTIC_OPERATION_EXISTS', 'Reopen the existing operation; do not execute it again')
    const input = prepareSemanticInput({ store, domain: state.domain, ...selected })
    const extractor = extractorPins(selected.extractor, input.digest), source = { ref: input.evidence[0].receipt.ref, digest: input.evidence[0].reference.sourceDigest }
    const starts = events(state).filter(event => event.value.phase === 'reserved')
    for (const prior of starts) {
      if (prior.value.source.digest !== source.digest || prior.value.source.ref !== source.ref || prior.value.extractor.configurationDigest !== extractor.configurationDigest) continue
      const known = operation(prior.value.operationId, state), attempt = inspected(known.initial)
      if (known.latest.value.phase === 'reconciled') continue
      check(attempt.status === 'complete', 'SEMANTIC_EXECUTION_UNKNOWN', 'Reconcile the prior source/configuration execution before a new attempt')
      check(known.latest.value.phase === 'completed', 'SEMANTIC_RECONCILE_REQUIRED', 'Finish recording the existing completed attempt before reuse')
      const cached = status({ operationId: prior.value.operationId })
      check(cached.freshness === 'current', 'SEMANTIC_OPERATION_STALE', 'Cached semantic input is stale')
      return { ...cached, cacheReuse: true }
    }
    check(intake.readAttempt(attemptId).status === 'absent', 'SEMANTIC_OPERATION_EXISTS', 'Attempt identity is already in use')
    intake.ingest({ ref: source.ref, expectedDigest: source.digest })
    const value = { schema: OPERATION, operationId, phase: 'reserved', attemptId, source, input, extractor }
    const recorded = append(value, { term, at, by: `host-model:${extractor.id}@${extractor.version}`, confirm })
    intake.beginAttempt({ attemptId, blobId: source.digest, extractorId: extractor.id, extractorVersion: extractor.version, configurationDigest: extractor.configurationDigest })
    const ready = status({ operationId })
    check(ready.freshness === 'current', 'SEMANTIC_OPERATION_STALE', 'Source or domain changed during reservation')
    return { ...ready, head: recorded.head, execution: 'ready-for-host', cacheReuse: false }
  }
  function reconcile({ operationId, at, by, reason, outcome, confirm }) {
    const { initial, latest } = operation(operationId), attempt = inspected(initial)
    check(latest.value.phase === 'reserved' && ['absent', 'begun'].includes(attempt.status), 'SEMANTIC_RECONCILE_REQUIRED', 'Partial output must be completed on its original attempt; completed attempts cannot be abandoned')
    check(['not-executed', 'failed-no-output'].includes(outcome) && typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 8192, 'SEMANTIC_OPERATION_INVALID', 'An explicit host reconciliation outcome and reason are required')
    const recorded = append({ schema: OPERATION, operationId, phase: 'reconciled', reserved: harnessRef(initial.record), outcome, reason, assurance: 'host-declared-not-independently-verified' }, { term: initial.record.data.term, at, by, confirm })
    return { ...status({ operationId }), head: recorded.head }
  }
  function complete({ operationId, output, expectedOutputDigest, candidates, usage, at, confirm }) {
    const { initial, latest, state } = operation(operationId), value = initial.value
    check(state.head === confirm && latest.value.phase === 'reserved', 'SEMANTIC_OPERATION_HEAD', 'Complete the reserved operation against current history')
    check(status({ operationId }).freshness === 'current', 'SEMANTIC_OPERATION_STALE', 'The source or adopted domain changed before completion')
    // Store executed bytes before interpreting even an oversized/malformed envelope.
    intake.completeAttempt({ attemptId: value.attemptId, output, expectedOutputDigest })
    const attempt = inspected(initial)
    const declared = json({ candidates, usage })
    closed(declared.usage, ['inputTokens', 'outputTokens', 'cost', 'currency', 'elapsedMs', 'retries'])
    for (const key of ['inputTokens', 'outputTokens', 'elapsedMs', 'retries']) check(declared.usage[key] === null || Number.isSafeInteger(declared.usage[key]) && declared.usage[key] >= 0, 'SEMANTIC_OPERATION_INVALID', 'Usage counts are nonnegative integers or unknown')
    check(declared.usage.cost === null || typeof declared.usage.cost === 'number' && Number.isFinite(declared.usage.cost) && declared.usage.cost >= 0, 'SEMANTIC_OPERATION_INVALID', 'Cost is nonnegative or unknown')
    check(declared.usage.currency === null || typeof declared.usage.currency === 'string' && /^[A-Z]{3}$/.test(declared.usage.currency), 'SEMANTIC_OPERATION_INVALID', 'Currency is explicit or unknown')
    assertSemanticOperationProfile({ candidates: declared.candidates })
    // Preserve executed raw bytes even when their interpretation is refused.
    // Resuming interpretation reuses this completion; it never runs the host.
    const proposals = prepareSemanticProposals({ store, input: value.input, candidates: declared.candidates })
    const recorded = append({ schema: OPERATION, operationId, phase: 'completed', reserved: harnessRef(initial.record), completion: attempt.completion,
      candidates: declared.candidates, usage: declared.usage, usageAssurance: 'host-reported', inputDigest: value.input.digest }, { term: initial.record.data.term, at, by: `host-model:${value.extractor.id}@${value.extractor.version}`, confirm })
    const ready = status({ operationId })
    if (ready.freshness !== 'current') {
      const error = new SemanticOperationError('SEMANTIC_OPERATION_STALE', 'Source or domain changed after recording completion')
      error.recorded = { record: harnessRef(history().records.find(record => record.id === eventId(operationId, 'completed'))), head: recorded.head, nextAction: 'reopen-recorded-write' }
      throw error
    }
    return { ...ready, head: recorded.head, proposals }
  }
  function completed(operationId) {
    if (verification?.completed.has(operationId)) return verification.completed.get(operationId)
    const value = operation(operationId), inspectedStatus = status({ operationId })
    check(value.latest.value.phase === 'completed' && inspectedStatus.attempt.status === 'complete', 'SEMANTIC_RECONCILE_REQUIRED', 'Record the completed raw attempt before preparing interpretations')
    check(inspectedStatus.freshness === 'current', 'SEMANTIC_OPERATION_STALE', 'Current source and adopted domain are required')
    const proposals = prepareSemanticProposals({ store, input: value.initial.value.input, candidates: value.latest.value.candidates })
    const receipt = inspectedStatus.attempt.completion
    const result = { ...value, proposals, raw: { attemptId: value.initial.value.attemptId, attemptDigest: receipt.attemptDigest, outputDigest: receipt.outputDigest, completionDigest: intakeDigest(JSON.stringify(receipt)) } }
    verification?.completed.set(operationId, result)
    return result
  }
  function proposals({ operationId, query, limit = 64 }) {
    const current = completed(operationId)
    return { answerClass: 'pending-proposals', ...readSemanticProposals({ store, input: current.initial.value.input, proposals: current.proposals, query, limit }) }
  }
  function semanticBody(record) {
    if (record?.kind !== 'contribution') return null
    let body
    try { body = JSON.parse(record.data.body) } catch { return null }
    return body?.schema === SEMANTIC_OPERATION_PROFILE ? body : null
  }
  function verifySemantic(record) {
    const body = semanticBody(record)
    check(body && ['entity', 'assertion', 'unknown'].includes(body.kind), 'SEMANTIC_OPERATION_INTEGRITY', 'An operation interpretation is required')
    const current = completed(body.operationId), collection = { entity: 'entities', assertion: 'assertions', unknown: 'unknowns' }[body.kind]
    const candidate = current.proposals[collection].find(value => value.id === body.candidate?.id)
    check(candidate && ingestionDigest(candidate) === ingestionDigest(body.candidate) && ingestionDigest(current.raw) === ingestionDigest(body.raw) &&
      body.inputDigest === current.proposals.inputDigest && ingestionDigest(body.usage) === ingestionDigest(current.latest.value.usage), 'SEMANTIC_OPERATION_INTEGRITY', 'Interpretation differs from current candidate or raw capture pins')
    closed(body, ['schema', 'operationId', 'kind', 'candidate', 'endpoints', 'raw', 'inputDigest', 'usage', 'sourceBinding', 'source', 'sourceWitness'])
    const sourceRecord = sourceFor(body.source, body.sourceBinding, current), endpoints = {}, endpointWitnesses = []
    if (body.kind === 'assertion') for (const role of ['subject', 'object']) {
      const id = candidate[`${role}Id`]
      if (id === null) { endpoints[role] = null; continue }
      const resolved = endpoint(current.proposals.entities.find(entity => entity.id === id), current)
      endpoints[role] = harnessRef(resolved)
      endpointWitnesses.push({ record: resolved, quote: semanticBody(resolved)?.candidate.id ?? resolved.id })
    }
    const witnesses = semanticDependencyWitnesses({ citations: candidate.evidence, sources: [sourceRecord], endpoints: endpointWitnesses })
    check(ingestionDigest(body.endpoints) === ingestionDigest(endpoints) && ingestionDigest(record.data.basedOn) === ingestionDigest(witnesses.basedOn) && ingestionDigest(body.sourceWitness) === ingestionDigest(witnesses.sourceWitness), 'SEMANTIC_OPERATION_INTEGRITY', 'Interpretation dependency, witness or endpoint pins differ')
    const value = current.initial.value
    check(record.by === `host-model:${value.extractor.id}@${value.extractor.version}` && record.data.origin.method === 'authored' &&
      record.data.category === (body.kind === 'entity' ? 'concept' : body.kind === 'assertion' ? 'claim' : 'interpretation') &&
      (body.kind !== 'entity' || record.data.term === candidate.type), 'SEMANTIC_OPERATION_INTEGRITY', 'Interpretation author, category or entity type differs')
    return body
  }
  function sourceFor(source, binding, current) {
    const record = current.state.records.find(record => record.id === source.id)
    check(record?.kind === 'contribution' && harnessRef(record).digest === source.digest, 'SEMANTIC_OPERATION_INTEGRITY', 'The exact structural source contribution is required')
    check(!current.state.reconsider.some(item => item.id === record.id), 'SEMANTIC_UNSUPPORTED_LEDGER_CITATION', 'The structural source contribution requires reconsideration')
    const key = ingestionDigest({ source, binding })
    if (verification?.sources.has(key)) return verification.sources.get(key)
    const value = current.initial.value, selected = prepareIngestionContribution({ workspaceRoot, workspaceId, records: current.state.records, ...value.input.plan,
      sourceId: value.input.evidence[0].reference.sourceId, title: record.data.title, term: record.data.term })
    const expected = { ...selected.sourceBinding, contributionDataDigest: learningDigest(record.data) }
    check(ingestionDigest(expected) === ingestionDigest(binding) && record.data.body === selected.data.body && ingestionDigest(record.data.origin) === ingestionDigest(selected.data.origin), 'SEMANTIC_OPERATION_INTEGRITY', 'Structural source provenance or binding differs')
    verification?.sources.set(key, record)
    return record
  }
  function endpoint(entity, current) {
    const record = current.state.records.findLast(record => {
      const body = semanticBody(record)
      return body?.operationId === current.initial.value.operationId && body.kind === 'entity' && body.candidate?.id === entity.id
    })
    check(record && current.state.accepted.includes(record.id), 'SEMANTIC_IDENTITY_PENDING', 'The receiver must review each endpoint entity first')
    verifySemantic(record)
    if (entity.identity.status === 'source-local') return record
    // The ordinary review record carries the explicit receiver identity choice.
    const acceptedReview = current.state.records.findLast(item => item.kind === 'review' && item.data.target.id === record.id)
    let decision
    try { decision = JSON.parse(acceptedReview.data.basis) } catch { /* A prose acceptance does not resolve a canonical identity. */ }
    check(decision?.schema === 'atelier.semantic-identity-decision/v0' && decision.operationId === current.initial.value.operationId && decision.candidateId === entity.id && ['existing', 'source-local'].includes(decision.resolution?.status), 'SEMANTIC_IDENTITY_PENDING', 'An explicit receiver identity review is required')
    if (decision.resolution.status === 'source-local') return record
    const target = current.state.records.find(item => item.id === decision.resolution.contribution?.id)
    check(target?.kind === 'contribution' && entity.identity.candidateIds.includes(target.id) && target.data.term === entity.type && current.state.accepted.includes(target.id) && harnessRef(target).digest === decision.resolution.contribution.digest,
      'SEMANTIC_IDENTITY_PENDING', 'Canonical identity must be a supplied currently accepted matching contribution')
    return target
  }
  function prepareContribution({ operationId, id, kind, candidateId, source, sourceBinding, term, at, confirm, supersedes = null, revisionReason = null }) {
    identifier(id)
    const current = completed(operationId), collection = { entity: 'entities', assertion: 'assertions', unknown: 'unknowns' }[kind]
    check(collection && current.state.head === confirm, 'SEMANTIC_OPERATION_HEAD', 'A declared interpretation kind and current history are required')
    const candidate = current.proposals[collection].find(value => value.id === candidateId)
    check(candidate, 'SEMANTIC_OPERATION_INVALID', 'The candidate is absent from the completed operation')
    check(kind !== 'entity' || term === candidate.type, 'SEMANTIC_OPERATION_INVALID', 'Entity contributions must retain their proposed vocabulary type')
    const sourceRecord = sourceFor(source, sourceBinding, current), endpoints = {}, endpointWitnesses = []
    if (kind === 'assertion') for (const role of ['subject', 'object']) {
      const candidateId = candidate[`${role}Id`]
      if (candidateId === null) { endpoints[role] = null; continue }
      const entity = current.proposals.entities.find(entity => entity.id === candidateId), resolved = endpoint(entity, current)
      endpoints[role] = harnessRef(resolved)
      endpointWitnesses.push({ record: resolved, quote: semanticBody(resolved)?.candidate.id ?? resolved.id })
    }
    const witnesses = semanticDependencyWitnesses({ citations: candidate.evidence, sources: [sourceRecord], endpoints: endpointWitnesses })
    const value = current.initial.value, body = canonicalize(json({ schema: SEMANTIC_OPERATION_PROFILE, operationId, kind, candidate, endpoints, raw: current.raw,
      inputDigest: current.proposals.inputDigest, usage: current.latest.value.usage, sourceBinding, source: harnessRef(sourceRecord), sourceWitness: witnesses.sourceWitness }))
    const record = { schema: 'atelier-knowledge-record@v1', id, run, at, by: `host-model:${value.extractor.id}@${value.extractor.version}`, kind: 'contribution', data: {
      domain: current.proposals.domainRef, category: kind === 'entity' ? 'concept' : kind === 'assertion' ? 'claim' : 'interpretation', term,
      title: kind === 'entity' ? candidate.label : kind === 'assertion' ? `${candidate.subjectId} ${candidate.predicate} ${candidate.objectId ?? ''}`.trim() : candidate.reason,
      body, audience: current.state.domain.data.audience, scope: current.state.domain.data.scope,
      origin: { method: 'authored', reason: `Machine-authored interpretation by ${value.extractor.id}@${value.extractor.version} in operation ${operationId}; pending receiver review.` }, basedOn: witnesses.basedOn,
    } }
    const prior = current.state.records.filter(item => semanticBody(item)?.operationId === operationId && semanticBody(item)?.kind === kind && semanticBody(item)?.candidate?.id === candidateId)
    if (supersedes !== null) {
      const old = prior.at(-1)
      check(old && ingestionDigest(harnessRef(old)) === ingestionDigest(supersedes) && typeof revisionReason === 'string' && revisionReason.trim().length > 0 && revisionReason.length <= 8192,
        'SEMANTIC_OPERATION_INVALID', 'A revision must explicitly supersede the latest exact interpretation with a reason')
      record.data.supersedes = supersedes; record.data.revisionReason = revisionReason
    } else check(prior.length === 0 && revisionReason === null, 'SEMANTIC_OPERATION_EXISTS', 'A candidate already has its immutable contribution; an explicit revision is required')
    return { ...appendHarness({ workspaceRoot, profile: 'knowledge', record, confirm }), record, semanticAcceptance: 'pending' }
  }
  function record({ record, confirm }) {
    check(record.run === run && ['evaluation', 'review', 'withdrawal', 'activation'].includes(record.kind), 'SEMANTIC_OPERATION_INVALID', 'Supply an actual receiver evaluation, review, withdrawal or activation')
    return appendHarness({ workspaceRoot, profile: 'knowledge', record, confirm })
  }
  function prepareRelation({ assertion, at, confirm }) {
    const state = history(), contribution = state.records.find(record => record.id === assertion.id)
    check(contribution && harnessRef(contribution).digest === assertion.digest && state.head === confirm, 'SEMANTIC_OPERATION_HEAD', 'The exact assertion and current history are required')
    const body = verifySemantic(contribution)
    check(body.kind === 'assertion' && state.accepted.includes(contribution.id), 'SEMANTIC_IDENTITY_PENDING', 'The receiver must accept the assertion before its relation')
    const eligibility = plainAssertionEligibility(body.candidate, state.domain)
    if (!eligibility.eligible) return { head: state.head, record: null, projectionOmission: { assertion, ...eligibility }, authority: 'none' }
    const relation = { schema: 'atelier-knowledge-record@v1', run, id: semanticRelationId(contribution.id), at, by: contribution.by, kind: 'relation', data: {
      domain: contribution.data.domain, subject: body.endpoints.subject, object: body.endpoints.object, predicate: body.candidate.predicate,
      rationale: `Machine-prepared plain relation; pending receiver review.\nsemantic-support: ${contribution.id} ${assertion.digest}`,
    } }
    return { ...appendHarness({ workspaceRoot, profile: 'knowledge', record: relation, confirm }), record: relation, semanticAcceptance: 'pending' }
  }
  function cascade({ withdrawalId, at, confirm }) {
    let state = history(), head = confirm
    check(state.head === confirm, 'SEMANTIC_OPERATION_HEAD', 'Resume cleanup against current history')
    const withdrawal = state.records.find(record => record.id === withdrawalId && record.kind === 'withdrawal')
    check(withdrawal, 'SEMANTIC_OPERATION_INVALID', 'An existing explicit receiver withdrawal is required')
    const cleaned = []
    for (const relation of state.records.filter(record => record.kind === 'relation')) {
      const support = /(?:^|\n)semantic-support: ([a-z][a-z0-9-]{0,63}) (sha256:[a-f0-9]{64})$/.exec(relation.data.rationale)
      if (support?.[1] !== withdrawal.data.target.id) continue
      state = history()
      if (state.records.some(record => record.kind === 'withdrawal' && record.data.target.id === relation.id)) continue
      const cleanup = { schema: 'atelier-knowledge-record@v1', id: `cleanup-${intakeDigest(`${withdrawalId}:${relation.id}`).slice(0, 40)}`, run, at, by: 'semantic-operation:withdrawal-cleanup', kind: 'withdrawal', data: {
        target: harnessRef(relation), reason: `Consequential cleanup of explicit receiver withdrawal ${withdrawalId}; supporting assertion is withdrawn.`,
      } }
      head = appendHarness({ workspaceRoot, profile: 'knowledge', record: cleanup, confirm: head }).head
      cleaned.push(relation.id)
    }
    return { head, cleaned, authority: 'none' }
  }
  function context({ query }) {
    const state = history(), bindings = []
    for (const record of state.records) {
      const body = semanticBody(record)
      if (!body) continue
      try { if (state.accepted.includes(record.id)) verifySemantic(record) }
      catch (error) { if (error.code !== 'SEMANTIC_OPERATION_STALE') throw error }
      if (!bindings.some(binding => ingestionDigest(binding) === ingestionDigest(body.sourceBinding))) bindings.push(body.sourceBinding)
    }
    return { answerClass: 'accepted-knowledge', ...localKnowledgeContext({ workspaceRoot, workspaceId, records: state.records, sourceBindings: bindings, query }) }
  }
  function project({ activationId, namespace }) {
    const state = history(), view = context({ query: 'semantic' })
    const selected = assertSemanticProjection({ records: state.records, activationId, reconsider: view.reconsider }).selected
    const typed = selected.map(id => ({ record: state.records.find(record => record.id === id), body: semanticBody(state.records.find(record => record.id === id)) })).filter(item => item.body)
    for (const item of typed) verifySemantic(item.record)
    return { ...knowledgeGraphProposal(state.records, { activationId, namespace }), semanticProfile: SEMANTIC_OPERATION_PROFILE,
      semanticEntities: typed.filter(item => item.body.kind === 'entity').map(item => ({ record: harnessRef(item.record), candidate: item.body.candidate })),
      semanticAssertions: typed.filter(item => item.body.kind === 'assertion').map(item => ({ record: harnessRef(item.record), candidate: item.body.candidate, endpoints: item.body.endpoints })),
      projectionOmissions: typed.filter(item => item.body.kind === 'assertion').map(item => ({ assertion: harnessRef(item.record), ...plainAssertionEligibility(item.body.candidate, state.domain) })).filter(item => !item.eligible) }
  }
  return Object.freeze({ begin, status, reconcile, complete, proposals: request => verified(() => proposals(request)),
    prepareContribution: request => verified(() => prepareContribution(request)), prepareRelation: request => verified(() => prepareRelation(request)),
    record, cascade, context: request => verified(() => context(request)), project: request => verified(() => project(request)) })
}
