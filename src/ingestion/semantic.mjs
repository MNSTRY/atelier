import { ingestionDigest, ingestionJson } from './contracts.mjs'
import { assertHarness, harnessRef } from '../harnesses/contracts.mjs'

// Internal first-consumer formats. These are not registered public contracts.
export const SEMANTIC_CANDIDATE_VERSION = 'atelier.semantic-candidate/v0'
const INPUT_VERSION = 'atelier.semantic-input/v0'
const PROPOSAL_VERSION = 'atelier.semantic-proposals/v0'
const modalities = new Set(['asserted', 'conditional', 'proposed', 'possible', 'uncertain', 'unknown'])
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
const string = (value, max = 8192) => {
  if (typeof value === 'string') check(value.length <= max, 'SEMANTIC_LIMIT', 'Semantic text length exceeded')
  return typeof value === 'string' && value.length > 0
}
const array = (value, max) => {
  if (Array.isArray(value)) check(value.length <= max, 'SEMANTIC_LIMIT', 'Semantic collection limit exceeded')
  return Array.isArray(value)
}
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export class SemanticProposalError extends Error {
  constructor(code, message) { super(message); this.name = 'SemanticProposalError'; this.code = code; this.refusalCount = 1 }
}
function check(condition, code, message) { if (!condition) throw new SemanticProposalError(code, message) }
function plain(value) {
  try { return ingestionJson(value) }
  catch (error) {
    const limit = ['ingestion JSON depth exceeded', 'ingestion member ceiling exceeded', 'ingestion document byte ceiling exceeded'].includes(error?.message)
    throw new SemanticProposalError(limit ? 'SEMANTIC_LIMIT' : 'SEMANTIC_INVALID', limit ? 'Semantic JSON limit exceeded' : 'Bounded plain JSON is required')
  }
}
function closed(value, fields, code = 'SEMANTIC_INVALID') {
  check(value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)), code, 'The declared semantic shape is required')
}
function profile(value) {
  const domain = plain(value)
  try { assertHarness(domain, 'knowledge') }
  catch { throw new SemanticProposalError('SEMANTIC_PROFILE', 'A valid existing knowledge domain is required') }
  check(['domain', 'domain-revision'].includes(domain.kind), 'SEMANTIC_PROFILE', 'A domain definition is required')
  for (const entries of [domain.data.vocabulary.types, domain.data.vocabulary.relations]) {
    check(new Set(entries.map(entry => entry.id)).size === entries.length, 'SEMANTIC_PROFILE', 'Vocabulary identifiers must be unambiguous')
  }
  return domain
}
function evidenceReference(value) {
  closed(value, ['sourceId', 'sourceDigest', 'attemptId', 'locator'])
  check(identifier(value.sourceId) && digest(value.sourceDigest) && string(value.attemptId, 256), 'SEMANTIC_EVIDENCE', 'Exact source and attempt bindings are required')
  closed(value.locator, ['kind', 'value'])
  check(['line', 'csv-cell', 'json-pointer'].includes(value.locator.kind) && typeof value.locator.value === 'string', 'SEMANTIC_EVIDENCE', 'A supported exact locator is required')
  check(value.locator.value.length <= 16384, 'SEMANTIC_LIMIT', 'Semantic locator length exceeded')
}
function readEvidence(store, plan, reference) {
  check(typeof store?.getEvidence === 'function', 'SEMANTIC_EVIDENCE', 'The existing exact evidence reader is required')
  let receipt
  try { receipt = plain(store.getEvidence(plain({ ...plan, ...reference }))) }
  catch (error) {
    if (error instanceof SemanticProposalError) throw error
    throw new SemanticProposalError(error?.code === 'INGESTION_STALE' ? 'SEMANTIC_STALE' : 'SEMANTIC_EVIDENCE', 'Current verified evidence could not be read')
  }
  check(receipt && typeof receipt === 'object' && !Array.isArray(receipt), 'SEMANTIC_EVIDENCE', 'An evidence receipt object is required')
  check(receipt.readScope === 'all-plan', 'SEMANTIC_READ_SCOPE', 'This profile requires the existing all-plan read scope')
  check(receipt.schema === 'mnstry.atelier-ingestion-evidence@v1' && receipt.freshness === 'current' && receipt.integrity === 'verified' && receipt.semanticAcceptance === 'pending' && receipt.synthesized === false && string(receipt.ref, 16384) && typeof receipt.text === 'string', 'SEMANTIC_EVIDENCE', 'Verified located source evidence is required')
  for (const key of ['planId', 'planDigest', 'sourceId', 'sourceDigest', 'attemptId']) check(receipt[key] === { ...plan, ...reference }[key], 'SEMANTIC_BINDING', 'Evidence differs from its requested binding')
  closed(receipt.locator, ['kind', 'value'], 'SEMANTIC_EVIDENCE')
  check(ingestionDigest(receipt.locator) === ingestionDigest(reference.locator), 'SEMANTIC_BINDING', 'Evidence locator differs from its requested binding')
  return receipt
}
function payload(input) { const { digest: ignored, ...value } = input; return value }

// The trusted host supplies a permitted all-plan reader and current domain.
// It invokes its chosen extractor separately, using the returned pinned input.
export function prepareSemanticInput({ store, plan, domain, references, identityCandidates = [] }) {
  const selected = plain({ plan, references, identityCandidates }), definition = profile(domain)
  closed(selected.plan, ['planId', 'planDigest'])
  check(string(selected.plan.planId, 256) && /^sha256:[a-f0-9]{64}$/.test(selected.plan.planDigest), 'SEMANTIC_BINDING', 'A bound ingestion plan is required')
  check(array(selected.references, 64), 'SEMANTIC_INVALID', 'Evidence references must be an array')
  check(selected.references.length > 0, 'SEMANTIC_EVIDENCE', 'At least one evidence span is required')
  check(array(selected.identityCandidates, 64), 'SEMANTIC_IDENTITY', 'Identity candidates must be an array')
  const identities = new Set(), types = new Set(definition.data.vocabulary.types.map(t => t.id))
  for (const candidate of selected.identityCandidates) {
    closed(candidate, ['id', 'label', 'type'], 'SEMANTIC_IDENTITY')
    check(identifier(candidate.id) && !identities.has(candidate.id) && string(candidate.label) && types.has(candidate.type), 'SEMANTIC_IDENTITY', 'Unique supplied typed identity candidates are required'); identities.add(candidate.id)
  }
  const seen = new Set(), evidence = []
  let sourceId
  for (const reference of selected.references) {
    evidenceReference(reference)
    sourceId ??= reference.sourceId
    check(sourceId === reference.sourceId, 'SEMANTIC_SCOPE', 'The first semantic profile processes one source per input')
    const key = ingestionDigest(reference)
    check(!seen.has(key), 'SEMANTIC_EVIDENCE', 'Duplicate evidence references are refused'); seen.add(key)
    evidence.push({ id: `span-${evidence.length + 1}`, reference, receipt: readEvidence(store, selected.plan, reference) })
  }
  const input = plain({ schema: INPUT_VERSION, plan: selected.plan, domain: definition, domainRef: harnessRef(definition), identityCandidates: selected.identityCandidates, evidence,
    coverage: 'selected-spans-only', readScope: 'all-plan', authority: 'none' })
  return { ...input, digest: ingestionDigest(input) }
}
function currentInput(store, value) {
  const input = plain(value)
  closed(input, ['schema', 'plan', 'domain', 'domainRef', 'identityCandidates', 'evidence', 'coverage', 'readScope', 'authority', 'digest'])
  check(input.schema === INPUT_VERSION && input.authority === 'none' && input.coverage === 'selected-spans-only' && input.readScope === 'all-plan', 'SEMANTIC_BINDING', 'The pinned semantic input is required')
  check(input.digest === ingestionDigest(payload(input)), 'SEMANTIC_BINDING', 'Semantic input digest differs')
  check(array(input.evidence, 64) && input.evidence.length > 0, 'SEMANTIC_BINDING', 'A nonempty evidence array is required')
  for (const span of input.evidence) closed(span, ['id', 'reference', 'receipt'])
  const rebuilt = prepareSemanticInput({ store, plan: input.plan, domain: input.domain, references: input.evidence.map(e => e.reference), identityCandidates: input.identityCandidates })
  check(rebuilt.digest === input.digest, 'SEMANTIC_BINDING', 'Current evidence or profile binding differs')
  return rebuilt
}
function date(value) {
  if (value === null) return true
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function prepareSemanticProposals({ store, input: original, candidates: supplied }) {
  const candidates = plain(supplied), input = currentInput(store, original)
  closed(candidates, ['schema', 'inputDigest', 'entities', 'assertions', 'unknowns'])
  check(candidates.schema === SEMANTIC_CANDIDATE_VERSION && candidates.inputDigest === input.digest, 'SEMANTIC_BINDING', 'Candidates must bind the exact extractor input')
  for (const key of ['entities', 'assertions', 'unknowns']) check(array(candidates[key], 64), 'SEMANTIC_INVALID', 'Semantic candidate collections must be arrays')
  const ids = new Set(), entities = new Map(), spans = new Map(input.evidence.map(e => [e.id, e])), identityCandidates = new Map(input.identityCandidates.map(c => [c.id, c]))
  const types = new Set(input.domain.data.vocabulary.types.map(t => t.id)), predicates = new Set(input.domain.data.vocabulary.relations.map(r => r.id))
  function identity(id) { check(identifier(id) && !ids.has(id), 'SEMANTIC_IDENTITY', 'Unique source-local candidate identities are required'); ids.add(id) }
  function supports(references, quoteRequired = false) {
    check(array(references, 16) && references.length > 0, 'SEMANTIC_EVIDENCE', 'At least one bounded supporting span is required')
    const seen = new Set()
    return references.map(value => {
      if (quoteRequired) closed(value, ['id', 'quote'], 'SEMANTIC_EVIDENCE')
      const id = quoteRequired ? value.id : value, span = spans.get(id)
      check(span && !seen.has(id), 'SEMANTIC_EVIDENCE', 'Supporting evidence must resolve uniquely'); seen.add(id)
      const quote = quoteRequired ? value.quote : span.receipt.text
      check(string(quote, 65536) && span.receipt.text.includes(quote), 'SEMANTIC_EVIDENCE', 'The quote must occur in the declared span')
      return { id, ...span.reference, ref: span.receipt.ref, quote }
    })
  }
  const preparedEntities = candidates.entities.map(entity => {
    closed(entity, ['id', 'label', 'type', 'identity', 'evidence']); identity(entity.id)
    check(types.has(entity.type) && string(entity.label), 'SEMANTIC_TYPE', 'Entity type and label must fit the supplied domain')
    closed(entity.identity, ['status', 'candidateIds'], 'SEMANTIC_IDENTITY')
    check(['source-local', 'existing-candidate', 'unknown'].includes(entity.identity.status) && array(entity.identity.candidateIds, 16), 'SEMANTIC_IDENTITY', 'Explicit candidate identity status is required')
    const candidateIds = entity.identity.candidateIds
    check(new Set(candidateIds).size === candidateIds.length && candidateIds.every(id => identityCandidates.get(id)?.type === entity.type), 'SEMANTIC_IDENTITY', 'Identity mappings must use supplied matching candidates')
    check(entity.identity.status === 'existing-candidate' ? candidateIds.length > 0 : candidateIds.length === 0, 'SEMANTIC_IDENTITY', 'Identity status and candidates differ')
    const prepared = { ...entity, evidence: supports(entity.evidence), identityAcceptance: 'pending' }
    entities.set(entity.id, prepared); return prepared
  })
  const preparedAssertions = candidates.assertions.map(assertion => {
    closed(assertion, ['id', 'subjectId', 'predicate', 'objectId', 'direction', 'negated', 'modality', 'scope', 'time', 'evidence']); identity(assertion.id)
    check(entities.has(assertion.subjectId) && (assertion.objectId === null || entities.has(assertion.objectId)), 'SEMANTIC_IDENTITY', 'Assertion endpoints must resolve to supplied entities')
    check(predicates.has(assertion.predicate), 'SEMANTIC_PREDICATE', 'Unmodeled predicates must remain explicit findings')
    check(assertion.direction === (assertion.objectId === null ? 'subject-only' : 'subject-to-object'), 'SEMANTIC_DIRECTION', 'Unary or directed binary roles must match the supplied endpoints')
    check(typeof assertion.negated === 'boolean', 'SEMANTIC_NEGATION', 'Explicit Boolean negation is required')
    check(modalities.has(assertion.modality), 'SEMANTIC_MODALITY', 'Explicit supported modality is required')
    check(assertion.scope === input.domain.data.scope, 'SEMANTIC_SCOPE', 'Assertion scope differs from its supplied domain')
    const evidence = supports(assertion.evidence, true), time = assertion.time
    closed(time, ['from', 'until', 'expression', 'unknowns'], 'SEMANTIC_TIME')
    check(date(time.from) && date(time.until) && (!time.from || !time.until || time.from <= time.until), 'SEMANTIC_TIME', 'Valid ordered calendar dates are required')
    check((time.expression === null || string(time.expression)) && array(time.unknowns, 16) && time.unknowns.every(value => string(value)), 'SEMANTIC_TIME', 'Explicit bounded time qualifications are required')
    check(time.expression === null || evidence.some(item => item.quote.includes(time.expression)), 'SEMANTIC_TIME', 'A temporal expression must be located in its cited passage')
    check(time.expression === null || time.from !== null || time.until !== null || time.unknowns.length > 0, 'SEMANTIC_TIME', 'Unresolved temporal expressions must preserve their unknowns')
    return { ...assertion, evidence, proposalAcceptance: 'pending' }
  })
  const unknowns = candidates.unknowns.map(unknown => {
    closed(unknown, ['id', 'relatedCandidateId', 'reason', 'evidence'], 'SEMANTIC_UNKNOWN'); identity(unknown.id)
    check(string(unknown.reason) && (unknown.relatedCandidateId === null || [...entities.keys(), ...preparedAssertions.map(a => a.id)].includes(unknown.relatedCandidateId)), 'SEMANTIC_UNKNOWN', 'An explicit finding reason and valid optional subject are required')
    return { ...unknown, evidence: supports(unknown.evidence) }
  })
  return plain({ schema: PROPOSAL_VERSION, inputDigest: input.digest, domainRef: input.domainRef,
    entities: preparedEntities, assertions: preparedAssertions, unknowns, rawCandidates: candidates,
    counts: { entities: preparedEntities.length, assertions: preparedAssertions.length, abstentions: unknowns.length, refusals: 0 },
    semanticAcceptance: 'pending', authority: 'none', canonicalMutation: false, coverage: input.coverage, readScope: input.readScope })
}

// A fresh, derived proposal view. Acceptance is still owned by knowledge review.
export function readSemanticProposals({ store, input, proposals: supplied, query, limit = 64 }) {
  check(string(query, 512) && query.trim().length > 0, 'SEMANTIC_INVALID', 'A bounded nonempty query is required')
  check(Number.isSafeInteger(limit), 'SEMANTIC_INVALID', 'The result limit must be a safe integer')
  check(limit > 0 && limit <= 64, 'SEMANTIC_LIMIT', 'The result limit must be between one and 64')
  const proposals = plain(supplied)
  closed(proposals, ['schema', 'inputDigest', 'domainRef', 'entities', 'assertions', 'unknowns', 'rawCandidates', 'counts', 'semanticAcceptance', 'authority', 'canonicalMutation', 'coverage', 'readScope'])
  const current = prepareSemanticProposals({ store, input, candidates: proposals.rawCandidates })
  check(ingestionDigest(current) === ingestionDigest(proposals), 'SEMANTIC_BINDING', 'The proposal view differs from its validated candidates')
  const byId = new Map(current.entities.map(entity => [entity.id, entity])), terms = query.toLowerCase().trim().split(/\s+/u)
  const matched = current.assertions.filter(assertion => {
    const subject = byId.get(assertion.subjectId), object = byId.get(assertion.objectId)
    const description = [subject.id, subject.label, object?.id ?? '', object?.label ?? '', assertion.predicate,
      ...assertion.evidence.map(item => item.quote), assertion.time.expression ?? ''].join('\n').toLowerCase()
    return terms.every(term => description.includes(term))
  })
  return plain({ schema: 'atelier.semantic-proposal-view/v0', inputDigest: current.inputDigest, domainRef: current.domainRef, entities: current.entities,
    assertions: matched.slice(0, limit), unknowns: current.unknowns, totalMatched: matched.length, omitted: Math.max(0, matched.length - limit),
    counts: current.counts, coverage: current.coverage, readScope: current.readScope, semanticAcceptance: 'pending', synthesized: false, canonicalMutation: false, authority: 'none' })
}
