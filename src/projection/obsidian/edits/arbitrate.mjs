import { canonicalJson } from '../../../runtime/obsidian/documents.mjs'
import { OBSIDIAN_EXT_KEY } from '../contracts.mjs'
import { isIdentifier } from './object-identity.mjs'

// Arbitration of the edits of one object, as a pure function of its event
// list. Nothing here reads a clock, a file or a process table: equal events
// give an equal result, which is what makes every index a cache.
//
// The rules, in the order they are applied to a new body replacement:
//
//   1. Equal idempotency key (equal base and equal edited bytes): one logical
//      operation; every origin is recorded.
//   2. A base that is not the source digest the object is known to have now
//      is stale. Its result already being the present source makes it
//      `superseded` (nothing is left to apply); otherwise it is `conflicted`.
//      The present digest is the last fact recorded under the object lease
//      (`applied`, or a refusal that read the source); before any such fact it
//      is what the observer said it read.
//   3. An operation that names the operations it resolves, whose base is the
//      present digest and which names every conflicted operation, supersedes
//      the ones it names and is pending. A resolution that cannot be checked
//      against a present digest, or that leaves a conflict unnamed, is itself
//      conflicted. Rule 2 is applied first and is never overridden.
//   4. While any operation is conflicted, a new one joins the conflict.
//   5. Open operations that would not produce the same source from the same
//      base are all conflicted, whatever order, view or process they came
//      from. Nothing is dropped and no winner is chosen.
//
// Operations that arrive as `proposed` or `refused` are recorded and take no
// part; one that arrives `conflicted` (the lens found its base stale) is
// retained as a conflict.

const EXT = OBSIDIAN_EXT_KEY
export const OBJECT_EVENT_SCHEMA = 'atelier-obsidian-object-event/v1'
export const OBJECT_EVENT_TYPES = Object.freeze(['observed', 'coalesced', 'conflict-declared', 'superseded', 'lease-acquired', 'lease-released', 'apply-intent', 'applied', 'apply-refused', 'siblings-stale'])
export const ARBITRATION_REASONS = Object.freeze(['stale-base', 'divergent-edits', 'divergent-bases', 'object-conflicted', 'resolution-incomplete', 'resolution-unverifiable', 'already-applied', 'resolved'])
export const REFUSED_DISPOSITIONS = Object.freeze(['retained', 'conflicted', 'refused'])

export class EditArbitrationRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'EditArbitrationRefusal'
    this.code = code
    this.detail = detail
  }
}

export function refuseArbitration(code, message, detail) {
  throw new EditArbitrationRefusal(code, message, detail)
}

// ---------------------------------------------------------------------------
// Documents. Every shape is closed and every string is an identifier, a
// digest, a store reference, a code or a timestamp.

const DIGEST = /^sha256:[0-9a-f]{64}$/
const KEY = /^op-[0-9a-f]{64}$/
const NONCE = /^[0-9a-f]{32}$/
const MACHINE = /^[0-9a-f]{64}$/
const CODE = /^[a-z][a-z0-9-]{0,63}$/
const REFERENCE = /^recovery\/objects\/[0-9a-f]{64}\.bin$/
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/
const VERSION = /^\d+\.\d+\.\d+$/

const is = {
  digest: (value) => typeof value === 'string' && DIGEST.test(value),
  key: (value) => typeof value === 'string' && KEY.test(value),
  nonce: (value) => typeof value === 'string' && NONCE.test(value),
  machine: (value) => typeof value === 'string' && MACHINE.test(value),
  code: (value) => typeof value === 'string' && CODE.test(value),
  reference: (value) => typeof value === 'string' && REFERENCE.test(value),
  time: (value) => typeof value === 'string' && TIME.test(value) && !Number.isNaN(Date.parse(value)),
  version: (value) => typeof value === 'string' && VERSION.test(value),
  identifier: isIdentifier,
  count: (value) => Number.isSafeInteger(value) && value >= 0,
  positive: (value) => Number.isSafeInteger(value) && value > 0,
}
const nullable = (check) => (value) => value === null || check(value)
const oneOf = (values) => (value) => values.includes(value)
const listOf = (check, { max = 4096, sortedBy = null } = {}) => (value) => Array.isArray(value) && value.length <= max && value.every(check)
  && (sortedBy === null || value.every((item, index) => index === 0 || sortedBy(value[index - 1]) < sortedBy(item)))
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// A closed object: exactly the required keys plus any of the optional ones.
const shape = (required, optional = {}) => (value) => plain(value)
  && Object.keys(value).every((key) => Object.hasOwn(required, key) || Object.hasOwn(optional, key))
  && Object.entries(required).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]))
  && Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]))
const extOf = (check) => shape({ [EXT]: check })

const policy = (value) => shape({ mode: oneOf(['manual']) })(value) || shape({ mode: oneOf(['automatic']), policyDigest: is.digest })(value)

// The recorded form of an edit operation: the frozen contract's required
// members and, under the extension key, digests and references only. The
// vault-relative note path of the original document is readable text and is
// not recorded; the note is found again from the origin and the identity.
const recordedOperation = shape({
  schema: oneOf(['atelier-obsidian-edit-operation/v1']),
  editId: is.identifier,
  workspaceId: is.identifier,
  repoId: is.identifier,
  nodeId: is.identifier,
  origin: shape({ scopeId: is.identifier, generationId: is.identifier }, { ext: extOf(shape({}, { baseNoteDigest: is.digest, publishedNoteDigest: nullable(is.digest) })) }),
  kind: oneOf(['body-replacement', 'semantic-proposal']),
  baseSourceDigest: is.digest,
  observed: shape({ digest: is.digest, byteLength: is.count, recoveryRef: is.reference }),
  idempotencyKey: is.key,
  state: oneOf(['pending', 'proposed', 'conflicted', 'refused']),
}, {
  contractVersion: is.version,
  observedAt: is.time,
  ext: extOf(shape({}, { lensVersion: is.version, publishedNoteRef: is.reference, baseSourceRef: is.reference, currentSourceDigest: is.digest, newSourceDigest: is.digest, newByteLength: is.count, refusalCode: is.code })),
})

const observation = shape({ operation: recordedOperation, presentSourceDigest: nullable(is.digest), resolves: listOf(is.key, { max: 256, sortedBy: (key) => key }) })
// A reason is one of ARBITRATION_REASONS or the code of an apply refusal.
const declared = () => listOf(shape({ idempotencyKey: is.key, reason: is.code }, { by: nullable(is.key) }), { sortedBy: (item) => item.idempotencyKey })
const viewKey = (view) => `${view.scopeId}\u0000${view.generationId}`

const BODIES = {
  observed: observation,
  coalesced: observation,
  'conflict-declared': shape({ operations: declared() }),
  superseded: shape({ operations: declared() }),
  'lease-acquired': shape({
    lease: shape({ nonce: is.nonce, pid: is.positive, machine: is.machine, runtimeId: nullable(is.identifier), acquiredAt: is.time }),
    takeover: nullable(shape({ nonce: is.nonce, reason: is.code })),
  }),
  'lease-released': shape({ nonce: is.nonce }),
  'apply-intent': shape({ nonce: is.nonce, idempotencyKey: is.key, expectedSourceDigest: is.digest, newSourceDigest: is.digest, actor: is.identifier, policy }),
  applied: shape({ nonce: is.nonce, idempotencyKey: is.key, oldSourceDigest: is.digest, newSourceDigest: is.digest, actor: is.identifier, policy }),
  'apply-refused': shape({ nonce: is.nonce, idempotencyKey: is.key, code: is.code, presentSourceDigest: nullable(is.digest), disposition: oneOf(REFUSED_DISPOSITIONS) }),
  'siblings-stale': shape({
    appliedSequence: is.positive,
    newSourceDigest: is.digest,
    views: listOf(shape({ scopeId: is.identifier, generationId: is.identifier, role: oneOf(['origin', 'sibling']) }), { sortedBy: viewKey }),
  }),
}

const envelope = shape({
  schema: oneOf([OBJECT_EVENT_SCHEMA]),
  workspaceId: is.identifier,
  repoId: is.identifier,
  nodeId: is.identifier,
  sequence: is.positive,
  previous: nullable(is.digest),
  type: oneOf(OBJECT_EVENT_TYPES),
  recordedAt: is.time,
  body: plain,
})

export function isObjectEvent(document) {
  if (!envelope(document) || !BODIES[document.type](document.body)) return false
  if (document.type !== 'observed' && document.type !== 'coalesced') return true
  const { operation } = document.body
  return operation.workspaceId === document.workspaceId && operation.repoId === document.repoId && operation.nodeId === document.nodeId
}

// What of an edit operation document is recorded. The caller has validated
// the document against the frozen contract.
export function recordableOperation(operation) {
  const ext = operation.ext?.[EXT] ?? {}
  const originExt = operation.origin.ext?.[EXT] ?? {}
  const kept = {}
  for (const name of ['lensVersion', 'publishedNoteRef', 'baseSourceRef', 'currentSourceDigest']) if (ext[name] !== undefined) kept[name] = ext[name]
  if (ext.result?.newSourceDigest !== undefined) { kept.newSourceDigest = ext.result.newSourceDigest; kept.newByteLength = ext.result.newByteLength }
  if (ext.refusal?.code !== undefined) kept.refusalCode = ext.refusal.code
  const keptOrigin = {}
  for (const name of ['baseNoteDigest', 'publishedNoteDigest']) if (originExt[name] !== undefined) keptOrigin[name] = originExt[name]
  const recorded = {
    schema: operation.schema,
    ...(operation.contractVersion === undefined ? {} : { contractVersion: operation.contractVersion }),
    editId: operation.editId,
    workspaceId: operation.workspaceId,
    repoId: operation.repoId,
    nodeId: operation.nodeId,
    origin: { scopeId: operation.origin.scopeId, generationId: operation.origin.generationId, ...(Object.keys(keptOrigin).length > 0 ? { ext: { [EXT]: keptOrigin } } : {}) },
    kind: operation.kind,
    baseSourceDigest: operation.baseSourceDigest,
    observed: { digest: operation.observed.digest, byteLength: operation.observed.byteLength, recoveryRef: operation.observed.recoveryRef },
    idempotencyKey: operation.idempotencyKey,
    state: operation.state,
    ...(operation.observedAt === undefined ? {} : { observedAt: operation.observedAt }),
    ...(Object.keys(kept).length > 0 ? { ext: { [EXT]: kept } } : {}),
  }
  return recordedOperation(recorded) ? recorded : null
}

// ---------------------------------------------------------------------------
// The rules that differ between a correct arbiter and the broken ones the
// tests substitute. Each returns what becomes of the operations involved.

export const ARBITRATION_RULES = Object.freeze({
  // `incoming` would not produce the same source from the same base as `open`.
  divergent: ({ incoming, open }) => {
    const reason = open.every((other) => other.baseSourceDigest === incoming.baseSourceDigest) ? 'divergent-edits' : 'divergent-bases'
    return [incoming, ...open].map((entry) => ({ entry, state: 'conflicted', reason }))
  },
  // The base of `incoming` is not the present source digest.
  stale: ({ incoming }) => [{ entry: incoming, state: 'conflicted', reason: 'stale-base' }],
})

const OPEN = new Set(['pending', 'conflicted'])
// Equal whatever order the keys were written in.
const sameDocument = (left, right) => canonicalJson(left) === canonicalJson(right)
const sameList = (left, right) => left.length === right.length && left.every((item, index) => item === right[index])
const equivalent = (left, right) => left.baseSourceDigest === right.baseSourceDigest && left.newSourceDigest !== null && left.newSourceDigest === right.newSourceDigest

function createState() {
  return { identity: null, sequence: 0, operations: new Map(), sourceDigest: null, sourceFrom: null, hint: null, lastAppliedKey: null, lease: null, intent: null, applies: [], declared: new Map(), violations: [] }
}

function assign(state, { entry, state: next, reason = null, by = null, drop = false }) {
  // Only a broken arbiter of the tests drops anything.
  if (drop) { state.operations.delete(entry.idempotencyKey); return }
  if (entry.state !== next) state.declared.delete(entry.idempotencyKey)
  Object.assign(entry, { state: next, reason, by })
}

function place(state, entry, resolves, rules) {
  const present = state.sourceDigest ?? state.hint
  const others = [...state.operations.values()].filter((other) => other !== entry)
  if (present !== null && entry.baseSourceDigest !== present) {
    if (entry.newSourceDigest === present) return assign(state, { entry, state: 'superseded', reason: 'already-applied', by: state.sourceFrom })
    for (const outcome of rules.stale({ incoming: entry, present })) assign(state, outcome)
    return undefined
  }
  const conflicted = others.filter((other) => other.state === 'conflicted')
  if (resolves.length > 0) {
    if (present === null) return assign(state, { entry, state: 'conflicted', reason: 'resolution-unverifiable' })
    const named = new Set(resolves)
    if (named.has(entry.idempotencyKey) || resolves.some((key) => !state.operations.has(key)) || conflicted.some((other) => !named.has(other.idempotencyKey))) {
      return assign(state, { entry, state: 'conflicted', reason: 'resolution-incomplete' })
    }
    for (const other of others) if (named.has(other.idempotencyKey) && OPEN.has(other.state)) assign(state, { entry: other, state: 'superseded', reason: 'resolved', by: entry.idempotencyKey })
  } else if (conflicted.length > 0) {
    return assign(state, { entry, state: 'conflicted', reason: 'object-conflicted' })
  }
  const open = others.filter((other) => other.state === 'pending' && !equivalent(other, entry))
  if (open.length > 0) { for (const outcome of rules.divergent({ incoming: entry, open })) assign(state, outcome); return undefined }
  return assign(state, { entry, state: 'pending' })
}

// The source is now `digest`: what was open against another base is settled.
function sourceMoved(state, digest, byKey, rules) {
  state.sourceDigest = digest
  state.sourceFrom = byKey
  for (const entry of state.operations.values()) {
    if (!OPEN.has(entry.state) || entry.baseSourceDigest === digest) continue
    if (entry.newSourceDigest === digest) assign(state, { entry, state: 'superseded', reason: 'already-applied', by: byKey })
    else if (entry.state === 'pending') for (const outcome of rules.stale({ incoming: entry, present: digest })) assign(state, outcome)
  }
}

const undeclared = (state, which) => [...state.operations.values()]
  .filter((entry) => entry.state === which && state.declared.get(entry.idempotencyKey) !== which)
  .map((entry) => ({ idempotencyKey: entry.idempotencyKey, reason: entry.reason, ...(which === 'superseded' ? { by: entry.by } : {}) }))
  .sort((left, right) => (left.idempotencyKey < right.idempotencyKey ? -1 : 1))

function viewsOf(state, appliedKey) {
  const views = new Map()
  for (const entry of state.operations.values()) {
    for (const origin of entry.origins) {
      const view = { scopeId: origin.scopeId, generationId: origin.generationId, role: entry.idempotencyKey === appliedKey ? 'origin' : 'sibling' }
      if (views.get(viewKey(view))?.role !== 'origin') views.set(viewKey(view), view)
    }
  }
  return [...views.values()].sort((left, right) => (viewKey(left) < viewKey(right) ? -1 : 1))
}

const HANDLERS = {
  observed: observe,
  coalesced: observe,
  'conflict-declared': (state, event) => declare(state, event, 'conflicted'),
  superseded: (state, event) => declare(state, event, 'superseded'),
  'lease-acquired'(state, { body, sequence }) {
    if (state.lease === null ? body.takeover !== null : body.takeover?.nonce !== state.lease.nonce) return state.lease === null ? 'takeover-without-holder' : 'lease-held'
    state.lease = { ...body.lease, sequence, takeover: body.takeover }
    return null
  },
  'lease-released'(state, { body }) {
    if (state.lease?.nonce !== body.nonce) return 'lease-not-held'
    state.lease = null
    return null
  },
  'apply-intent'(state, { body, sequence }) {
    if (state.lease?.nonce !== body.nonce) return 'lease-not-held'
    if (state.intent !== null) return 'intent-unresolved'
    const entry = state.operations.get(body.idempotencyKey)
    if (entry === undefined) return 'unknown-operation'
    if ([...state.operations.values()].some((other) => other.state === 'conflicted')) return 'object-conflicted'
    if (entry.state !== 'pending' || entry.kind !== 'body-replacement') return 'operation-not-applicable'
    if (body.expectedSourceDigest !== entry.baseSourceDigest || body.newSourceDigest !== entry.newSourceDigest) return 'digest-mismatch'
    state.intent = { ...body, sequence }
    return null
  },
  applied(state, { body, sequence }, rules) {
    if (state.lease?.nonce !== body.nonce) return 'lease-not-held'
    if (state.intent === null || state.intent.idempotencyKey !== body.idempotencyKey) return 'intent-missing'
    if (body.oldSourceDigest !== state.intent.expectedSourceDigest || body.newSourceDigest !== state.intent.newSourceDigest) return 'digest-mismatch'
    const entry = state.operations.get(body.idempotencyKey)
    state.intent = null
    assign(state, { entry, state: 'applied' })
    state.lastAppliedKey = body.idempotencyKey
    sourceMoved(state, body.newSourceDigest, body.idempotencyKey, rules)
    state.applies.push({ appliedSequence: sequence, newSourceDigest: body.newSourceDigest, views: viewsOf(state, body.idempotencyKey), declared: false })
    return null
  },
  'apply-refused'(state, { body }, rules) {
    if (state.lease?.nonce !== body.nonce) return 'lease-not-held'
    const entry = state.operations.get(body.idempotencyKey)
    if (entry === undefined) return 'unknown-operation'
    if (state.intent !== null && state.intent.idempotencyKey !== body.idempotencyKey) return 'intent-unresolved'
    if (state.intent === null && !OPEN.has(entry.state)) return 'operation-not-applicable'
    state.intent = null
    if (body.presentSourceDigest !== null) sourceMoved(state, body.presentSourceDigest, null, rules)
    if (entry.state === 'pending' && body.disposition !== 'retained') assign(state, { entry, state: body.disposition, reason: body.code })
    return null
  },
  'siblings-stale'(state, { body }) {
    const next = state.applies.find((apply) => !apply.declared)
    if (next === undefined || next.appliedSequence !== body.appliedSequence || next.newSourceDigest !== body.newSourceDigest || !sameDocument(next.views, body.views)) return 'declaration-mismatch'
    next.declared = true
    return null
  },
}

function observe(state, { type, body, sequence }, rules) {
  const { operation, resolves } = body
  const existing = state.operations.get(operation.idempotencyKey)
  if ((type === 'observed') !== (existing === undefined)) return 'observation-kind-mismatch'
  const origin = { scopeId: operation.origin.scopeId, generationId: operation.origin.generationId, editId: operation.editId, recoveryRef: operation.observed.recoveryRef, observedAt: operation.observedAt ?? null, sequence, resolves }
  if (existing?.origins.some((known) => sameOrigin(known, origin))) return 'duplicate-origin'
  const ext = operation.ext?.[EXT] ?? {}
  if (operation.state === 'pending' && (operation.kind !== 'body-replacement' || ext.newSourceDigest === undefined)) return 'operation-unusable'
  if (existing !== undefined && (existing.baseSourceDigest !== operation.baseSourceDigest || existing.observedDigest !== operation.observed.digest || existing.kind !== operation.kind)) return 'operation-identity-mismatch'
  if (body.presentSourceDigest !== null) state.hint = body.presentSourceDigest
  if (existing !== undefined) {
    existing.origins.push(origin)
    // A known operation offered again as the resolution of a conflict.
    if (resolves.length > 0 && operation.state === 'pending' && OPEN.has(existing.state)) place(state, existing, resolves, rules)
    return null
  }
  const entry = {
    idempotencyKey: operation.idempotencyKey, kind: operation.kind, baseSourceDigest: operation.baseSourceDigest,
    observedDigest: operation.observed.digest, observedByteLength: operation.observed.byteLength, newSourceDigest: ext.newSourceDigest ?? null,
    state: operation.state, reason: null, by: null, firstSequence: sequence, origins: [origin],
  }
  state.operations.set(entry.idempotencyKey, entry)
  if (operation.state === 'pending') place(state, entry, resolves, rules)
  else if (operation.state === 'conflicted') entry.reason = 'stale-base'
  else if (operation.state === 'refused') entry.reason = ext.refusalCode ?? null
  return null
}

export const sameOrigin = (left, right) => left.scopeId === right.scopeId && left.generationId === right.generationId && left.editId === right.editId && sameList(left.resolves, right.resolves)

function declare(state, { body }, which) {
  if (body.operations.length === 0 || !sameDocument(undeclared(state, which), body.operations)) return 'declaration-mismatch'
  for (const item of body.operations) state.declared.set(item.idempotencyKey, which)
  return null
}

function summarize(state) {
  const operations = [...state.operations.values()].sort((left, right) => left.firstSequence - right.firstSequence)
  const objectState = state.violations.length > 0 ? 'inconsistent'
    : operations.some((entry) => entry.state === 'conflicted') ? 'conflicted'
      : operations.some((entry) => entry.state === 'pending') ? 'pending'
        : operations.length === 0 ? 'empty' : 'settled'
  const pendingApply = state.applies.find((apply) => !apply.declared)
  return {
    identity: state.identity,
    sequence: state.sequence,
    state: objectState,
    sourceDigest: state.sourceDigest ?? state.hint,
    sourceDigestProven: state.sourceDigest !== null,
    operations,
    lease: state.lease,
    // An intent with no outcome recorded: whether the source was written is
    // not known here. Whoever holds the lease next reads the source and
    // decides from its digest.
    intent: state.intent === null ? null : { ...state.intent, status: 'outcome-unknown' },
    siblingsStale: state.applies.map((apply) => ({ ...apply })),
    undeclared: {
      siblingsStale: pendingApply === undefined ? null : { appliedSequence: pendingApply.appliedSequence, newSourceDigest: pendingApply.newSourceDigest, views: pendingApply.views },
      superseded: undeclared(state, 'superseded'),
      conflicted: undeclared(state, 'conflicted'),
    },
    violations: state.violations,
  }
}

// `events` are validated object events in sequence order. An event that the
// events before it do not allow changes nothing and is listed in `violations`.
export function arbitrateEvents(events, rules = ARBITRATION_RULES) {
  const state = createState()
  for (const event of events) {
    state.identity ??= { workspaceId: event.workspaceId, repoId: event.repoId, nodeId: event.nodeId }
    state.sequence = event.sequence
    const violation = HANDLERS[event.type](state, event, rules)
    if (violation) state.violations.push({ sequence: event.sequence, code: violation })
  }
  return summarize(state)
}
