import { createHash } from 'node:crypto'
import { MAX_CAPTURE_BYTES } from './index.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const candidateId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key)
const same = (a, b) => a?.id === b?.id && a?.digest === b?.digest
const modalities = new Set(['asserted', 'conditional', 'proposed', 'possible', 'uncertain', 'unknown'])
const nativeAuxiliary = {
  graphify: new Set(['id', 'source', 'target', 'relation', 'description', 'source_file', 'source_location', 'source_url', 'confidence', 'confidence_score', 'weight']),
  'lightrag-json': new Set(['id', 'source', 'target', 'description', 'keywords', 'source_id', 'file_path', 'timestamp', 'weight']),
}

export class NativeHandoffError extends Error {
  constructor(code, message, normalization = null) {
    super(message); this.name = 'NativeHandoffError'; this.code = code
    if (normalization) this.normalization = normalization
  }
}
const check = (condition, code, message) => { if (!condition) throw new NativeHandoffError(code, message) }
function call(mapper, context) {
  const value = mapper(structuredClone(context))
  check(!value || typeof value.then !== 'function', 'NATIVE_MAPPER_ASYNC', 'Mapping callbacks must be cheap synchronous owner mappings')
  return value
}
function atPath(record, path) {
  check(Array.isArray(path) && path.length > 0 && path.every(key => typeof key === 'string' || Number.isSafeInteger(key)),
    'NATIVE_QUALIFIER_MISSING', 'Explicit raw-field qualifier paths are required')
  let value = record
  for (const key of path) {
    check(own(value, key), 'NATIVE_QUALIFIER_MISSING', 'The qualifier is absent from the received native object')
    value = value[key]
  }
  return structuredClone(value)
}
function approved(mapping, input, vocabulary) {
  return mapping?.approved === true && same(mapping.ownerRef, input.domainRef) && vocabulary.has(mapping.id)
}
function fieldsAccounted(record, paths, auxiliary, prefix = []) {
  if (paths.some(path => path.length === prefix.length && path.every((key, index) => key === prefix[index]))) return true
  if (prefix.length === 1 && auxiliary.has(prefix[0])) return true
  if (!record || typeof record !== 'object') return false
  return Object.keys(record).every(key => {
    const next = [...prefix, key]
    if (next.length === 1 && auxiliary.has(key)) return true
    return paths.some(path => path.length >= next.length && next.every((item, index) => path[index] === item)) &&
      fieldsAccounted(record[key], paths, auxiliary, next)
  })
}

/** Pure conversion of received raw Graphify nodes/edges or LightRAG model JSON.
 * It does not run either tool, find evidence, approve mappings or resolve identity.
 */
export function normalizeNativeExtraction({ bytes, input, profile, mappers }) {
  check(bytes instanceof Uint8Array && bytes.length <= MAX_CAPTURE_BYTES, 'NATIVE_RAW_LIMIT', 'Bounded original native bytes are required')
  check(['graphify', 'lightrag-json'].includes(profile), 'NATIVE_PROFILE_UNSUPPORTED', 'Select an inspected native JSON profile')
  check(input?.schema === 'atelier.semantic-input/v0' && input.coverage === 'selected-spans-only' && input.readScope === 'all-plan',
    'NATIVE_INPUT_BINDING', 'The existing pinned semantic input is required')
  for (const name of ['entityType', 'identity', 'predicate', 'evidence', 'participants', 'qualifiers'])
    check(typeof mappers?.[name] === 'function', 'NATIVE_MAPPER_MISSING', `Existing owner ${name} mapping callback is required`)
  let raw
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new NativeHandoffError('NATIVE_RAW_INVALID', 'Native output must be exact UTF-8 JSON; original bytes stay with intake') }
  const entityKey = profile === 'graphify' ? 'nodes' : 'entities', assertionKey = profile === 'graphify' ? 'edges' : 'relationships'
  check(raw && Array.isArray(raw[entityKey]) && Array.isArray(raw[assertionKey]), 'NATIVE_PROFILE_UNSUPPORTED', 'The selected native collection shape is required')
  check(raw.hyperedges === undefined || Array.isArray(raw.hyperedges), 'NATIVE_PROFILE_UNSUPPORTED', 'Native hyperedges must retain their actual collection shape')
  check(raw[entityKey].length <= 64 && raw[assertionKey].length <= 64 && (raw.hyperedges?.length ?? 0) <= 64,
    'NATIVE_HANDOFF_LIMIT', 'Existing candidate collections require an owner-selected bounded native slice')
  const candidates = { schema: 'atelier.semantic-candidate/v0', inputDigest: input.digest, entities: [], assertions: [], unknowns: [] }
  const unresolved = [], mappings = [], ids = new Set(), entities = new Map()
  const types = new Set(input.domain.data.vocabulary.types.map(x => x.id)), predicates = new Set(input.domain.data.vocabulary.relations.map(x => x.id))
  const context = (record, kind, index, collection) => ({ native: record, nativeRef: { profile, collection, index }, kind, input })
  function support(ctx) {
    const selected = call(mappers.evidence, ctx)
    check(Array.isArray(selected) && selected.length > 0 && selected.length <= 16, 'NATIVE_SUPPORT_MISSING', 'Exact existing located input support is required')
    const seen = new Set()
    return selected.map(value => {
      const matches = input.evidence.filter(span => {
        const a = span.reference, b = value.reference
        return b && a.sourceId === b.sourceId && a.sourceDigest === b.sourceDigest && a.attemptId === b.attemptId &&
          a.locator.kind === b.locator?.kind && a.locator.value === b.locator.value
      })
      check(matches.length === 1 && !seen.has(matches[0].id), 'NATIVE_SUPPORT_BINDING', 'Support must resolve to one exact current selected input reference')
      const span = matches[0]; seen.add(span.id)
      check(typeof value.quote === 'string' && value.quote.length > 0 && span.receipt.text.includes(value.quote),
        'NATIVE_SUPPORT_QUOTE', 'Owner-supplied quote must occur in its exact input span')
      check(!/[\r\n]/u.test(value.quote), 'NATIVE_LOCATOR_UNSUPPORTED', 'Current runner does not represent multiline assertion quotes')
      return { id: span.id, quote: value.quote }
    })
  }
  function loss(ctx, code, reason, located = []) {
    let unknownId = null
    if (located.length && candidates.unknowns.length < 64) {
      unknownId = `native-unresolved-${candidates.unknowns.length + 1}`
      while (ids.has(unknownId)) unknownId += '-x'
      ids.add(unknownId)
      candidates.unknowns.push({ id: unknownId, relatedCandidateId: null,
        reason: `${code}: ${reason}; retained ${profile} ${ctx.nativeRef.collection}[${ctx.nativeRef.index}] in raw sha256:${sha(bytes)}`,
        evidence: located.map(x => x.id) })
    }
    unresolved.push({ code, reason, nativeRef: ctx.nativeRef, native: structuredClone(ctx.native),
      representedUnknownId: unknownId, support: located })
  }
  function identity(ctx, located) {
    const choice = call(mappers.identity, ctx)
    check(choice && same(choice.ownerRef, input.domainRef) && candidateId(choice.id) && !ids.has(choice.id),
      'NATIVE_IDENTITY_UNMAPPED', 'Explicit unique owner-mapped source candidate identity is required; labels do not merge IDs')
    const selected = ctx.kind === 'entity' ? choice.identity : null
    check(ctx.kind !== 'entity' || selected && ['source-local', 'existing-candidate', 'unknown'].includes(selected.status) && Array.isArray(selected.candidateIds),
      'NATIVE_IDENTITY_UNMAPPED', 'Existing candidate identity semantics must be supplied explicitly')
    // The existing semantic validator checks matching supplied canonical candidates.
    ids.add(choice.id)
    return { id: choice.id, identity: structuredClone(selected), evidence: located.map(x => x.id) }
  }
  for (const [index, native] of raw[entityKey].entries()) {
    const ctx = context(native, 'entity', index, entityKey); let located = []
    if (!native || typeof native !== 'object' || Array.isArray(native)) { loss(ctx, 'NATIVE_OBJECT_UNSUPPORTED', 'A received native entity object is required'); continue }
    try {
      located = support(ctx)
      const type = call(mappers.entityType, ctx)
      check(approved(type, input, types), 'NATIVE_TYPE_UNMAPPED', 'Explicit owner-approved existing vocabulary entity type is required')
      const mapped = identity(ctx, located), label = profile === 'graphify' ? native.label : native.name
      const nativeId = profile === 'graphify' ? native.id : native.name
      check(typeof label === 'string' && label.length > 0, 'NATIVE_LABEL_MISSING', 'Native display label is required')
      check(typeof nativeId === 'string' && nativeId.length > 0, 'NATIVE_IDENTITY_UNMAPPED', 'Actual native identifier is required before participant mapping')
      candidates.entities.push({ ...mapped, label, type: type.id })
      entities.set(mapped.id, { native, nativeRef: ctx.nativeRef, nativeId })
      mappings.push({ nativeRef: ctx.nativeRef, candidateId: mapped.id, entityType: type })
    } catch (error) {
      if (!(error instanceof NativeHandoffError)) throw error
      loss(ctx, error.code, error.message, located)
    }
  }
  for (const [index, native] of raw[assertionKey].entries()) {
    const ctx = context(native, 'assertion', index, assertionKey); let located = []
    if (!native || typeof native !== 'object' || Array.isArray(native)) { loss(ctx, 'NATIVE_OBJECT_UNSUPPORTED', 'A received native assertion object is required'); continue }
    try {
      located = support(ctx)
      const predicate = call(mappers.predicate, ctx)
      check(approved(predicate, input, predicates), 'NATIVE_PREDICATE_UNMAPPED', 'Explicit owner-approved existing vocabulary predicate is required')
      const choice = call(mappers.participants, { ...ctx, entityMappings: [...entities].map(([id, entity]) => ({ id, ...entity })) })
      check(same(choice?.ownerRef, input.domainRef) && entities.has(choice.subjectId) &&
        (choice.objectId === null || entities.has(choice.objectId)), 'NATIVE_PARTICIPANT_UNMAPPED', 'Explicit mapped source participants are required')
      check(native.source === entities.get(choice.subjectId).nativeId &&
        (choice.objectId === null ? native.target === null : native.target === entities.get(choice.objectId).nativeId),
        'NATIVE_PARTICIPANT_BINDING', 'Mapped participants differ from actual native source/target fields')
      const proof = call(mappers.qualifiers, ctx), qualifier = {}
      check(proof?.paths && Object.keys(proof.paths).length === 5 && ['direction', 'negated', 'modality', 'scope', 'time'].every(field => own(proof.paths, field)),
        'NATIVE_QUALIFIER_MISSING', 'Provide exactly the five existing qualifier paths; extra qualifiers require a separate supported mapping')
      for (const field of ['direction', 'negated', 'modality', 'scope', 'time']) qualifier[field] = atPath(native, proof?.paths?.[field])
      check(qualifier.direction === (choice.objectId === null ? 'subject-only' : 'subject-to-object') && typeof qualifier.negated === 'boolean' &&
        modalities.has(qualifier.modality), 'NATIVE_QUALIFIER_UNSUPPORTED', 'Explicit native direction, polarity and supported modality are required')
      check(typeof qualifier.scope === 'string' && qualifier.scope === input.domain.data.scope, 'NATIVE_SCOPE_UNSUPPORTED', 'Native assertion scope must equal the existing domain scope')
      const time = qualifier.time
      check(time && ['from', 'until', 'expression', 'unknowns'].every(field => own(time, field)) && Object.keys(time).length === 4,
        'NATIVE_TIME_UNSUPPORTED', 'Native time must explicitly retain the existing four-field qualification')
      check(fieldsAccounted(native, Object.values(proof.paths), nativeAuxiliary[profile]),
        'NATIVE_QUALIFIER_UNMAPPED', 'Additional native fields require an explicit reviewed mapping; retained unresolved rather than dropped')
      const mapped = identity(ctx, located)
      candidates.assertions.push({ id: mapped.id, subjectId: choice.subjectId, predicate: predicate.id, objectId: choice.objectId,
        ...qualifier, evidence: located })
      mappings.push({ nativeRef: ctx.nativeRef, candidateId: mapped.id, predicate, qualifierPaths: proof.paths })
    } catch (error) {
      if (!(error instanceof NativeHandoffError)) throw error
      loss(ctx, error.code, error.message, located)
    }
  }
  for (const [index, native] of (raw.hyperedges ?? []).entries()) {
    const ctx = context(native, 'hyperedge', index, 'hyperedges'); let located = []
    try { located = support(ctx) } catch (error) { if (!(error instanceof NativeHandoffError)) throw error }
    loss(ctx, 'NATIVE_HYPEREDGE_UNSUPPORTED', 'Current candidate profile has unary/binary assertions only', located)
  }
  return { candidates, mappings, unresolved,
    refused: unresolved.some(item => item.representedUnknownId === null),
    rawBinding: { bytes: bytes.length, sha256: sha(bytes) },
    coverage: input.coverage, readScope: input.readScope,
    semanticAcceptance: 'pending', authority: 'none', canonicalMutation: false }
}

/** Pass directly as bridge.normalize; immutable provider/tool bytes stay intact. */
export function createNativeNormalizer({ profile, mappers }) {
  return ({ bytes, input }) => {
    const handoff = normalizeNativeExtraction({ bytes, input, profile, mappers })
    if (handoff.refused) throw new NativeHandoffError('NATIVE_HANDOFF_UNRESOLVED', 'Native objects lack representable existing-profile support; reopen retained raw capture', handoff)
    return handoff.candidates
  }
}
