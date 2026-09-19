import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isPendingPrivateWrite } from '../../../project/durable-state.mjs'
import { checkManagedRoots } from '../../../project/file-class.mjs'
import { atomicReplacePrivateText, ensureContainedPrivateDirectory, openRegularFileNoFollow, syncPrivateDirectory } from '../../../project/private-state.mjs'
import { canonicalJson, isoTime } from '../../../runtime/obsidian/documents.mjs'
import { createAbandonmentProof, machineDigest } from '../../../runtime/obsidian/private-lock.mjs'
import { OBSIDIAN_EXT_KEY, validateObsidianContract } from '../contracts.mjs'
import { sha256Digest } from '../materialize/byte-lens.mjs'
import { ARBITRATION_RULES, EditArbitrationRefusal, OBJECT_EVENT_SCHEMA, REFUSED_DISPOSITIONS, arbitrateEvents, isObjectEvent, recordableOperation, refuseArbitration, sameOrigin } from './arbitrate.mjs'
import { decodeIdentitySegment, encodeIdentitySegment, isIdentifier, isIdentitySegment } from './object-identity.mjs'
import { editIdempotencyKey } from './observe.mjs'

// Durable arbitration of edits, shared by every view of one workspace.
//
//   <stateRoot>/state/objects/<repo>/<node>/000000000001.json   the events of one object
//   <stateRoot>/state/object-index/<repo>/<node>.json           a derived summary, a cache
//
// <repo> and <node> are encoded identifiers (object-identity.mjs); the
// repository is part of the key, so equal node ids of two repositories never
// meet. The state root is private workspace state, outside every repository
// and vault.
//
// The events of an object are its only truth. An event is one complete,
// canonical JSON file named by its sequence number, published with a
// non-overwriting hard link and never rewritten or removed. Every event names
// the digest of the one before it. An appender reads the log through N,
// decides, and publishes N+1; of two appenders exactly one gets the name, and
// the other reads again and decides again against what it lost to. So every
// event was decided against exactly the events before it, the log is a
// serialization of everything any process did, and there is no last writer to
// win: what an operation becomes is a function of the whole log
// (arbitrate.mjs), not of who wrote last.
//
// The compare/apply lease of an object is two of those events. Holding it
// means the last `lease-acquired` is not followed by its `lease-released`.
// It is taken from a holder only with proof that the holder is gone: its
// process does not exist on this machine (the proof rules of the engine lock,
// runtime/obsidian/private-lock.mjs). No amount of elapsed time is proof. A
// holder on another machine, or a live process that no longer knows it holds
// the lease, needs a person; so does an object whose log cannot be read,
// which refuses every operation and is never repaired by guessing.
//
// Only what the log cannot derive is asked of the caller; what it can derive
// is also written down, as `conflict-declared`, `superseded` and
// `siblings-stale` events that follow the event that caused them. A crash
// between the two loses nothing: the state is derived from the cause, and the
// next writer or `recoverObject` appends the declaration that is missing.
//
// Bounds. An event is at most 16 KiB (an observation is about 1.5 KiB). An
// object holds at most 4096 events, about 500 edits taken through a full
// apply; the last 64 are kept for settling what is in flight (intent,
// outcome, declarations, release), so an observation or a new lease refuses
// `object-log-full` first. Nothing is rotated, compacted or dropped: a full
// object refuses, and what becomes of it is a person's decision.
//
// Nothing here writes to a source file or to a vault, and no event, index or
// error holds note or source text: identifiers, digests, store references,
// codes, numbers and timestamps only.

export const OBJECTS_DIRECTORY = path.join('state', 'objects')
export const OBJECT_INDEX_DIRECTORY = path.join('state', 'object-index')
export const OBJECT_INDEX_SCHEMA = 'atelier-obsidian-object-index/v1'
export const EDIT_ACKNOWLEDGEMENT_SCHEMA = 'atelier-obsidian-edit-acknowledgement/v1'
export const OBJECT_STORE_LIMITS = Object.freeze({ maxEventBytes: 16 * 1024, maxEventsPerObject: 4096, reservedForSettlement: 64, maxAppendAttempts: 256 })
export const OBJECT_STORE_CRASH_STEPS = Object.freeze(['event-linked', 'event-published', 'index-updated'])

const EVENT_NAME = /^(\d{12})\.json$/
const eventName = (sequence) => `${String(sequence).padStart(12, '0')}.json`
const NEEDS_PERSON = new Set(['held-on-another-machine'])

export const OBJECT_STORE_PRIMITIVES = Object.freeze({
  rules: ARBITRATION_RULES,
  limits: OBJECT_STORE_LIMITS,
  // Proof that the holder of a lease is gone: its process does not exist on
  // this machine. There is no maximum age.
  proveAbandoned: createAbandonmentProof(),
  // An index is used only when it was derived from exactly the events present.
  indexIsCurrent: ({ index, eventCount, headDigest }) => index.sequence === eventCount && index.headDigest === headDigest,
})

// The members of `values` that were given: an absent optional member is absent from the event, never null.
const optional = (values) => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null))

function readBytesNoFollow(file) {
  const descriptor = openRegularFileNoFollow(file)
  try { return fs.readFileSync(descriptor) } finally { fs.closeSync(descriptor) }
}

export function createObjectStoreForOracleTests(primitives = OBJECT_STORE_PRIMITIVES) {
  const { rules, limits, proveAbandoned, indexIsCurrent } = primitives

  return function openObjectStore({ stateRoot, workspaceId, repositoryRoots, clock, crash = () => {}, randomBytes = cryptoRandomBytes } = {}) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) throw new TypeError('stateRoot must be an absolute path')
    if (!isIdentifier(workspaceId)) throw new TypeError('workspaceId must be a contract identifier')
    if (typeof clock !== 'function') throw new TypeError('a clock must be injected')
    if (!Array.isArray(repositoryRoots) || repositoryRoots.some((item) => typeof item !== 'string' || !path.isAbsolute(item))) {
      throw new TypeError('repositoryRoots must list the absolute root of every enrolled repository; pass an explicit empty list when there is none')
    }
    const guard = checkManagedRoots({ managedRoots: [stateRoot], repositoryRoots })
    if (!guard.ok) refuseArbitration('state-root-overlaps-repository', 'the arbitration state may not overlap an enrolled repository', { codes: guard.refusals.map((item) => item.code) })
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
    const root = fs.realpathSync.native(stateRoot)
    // Two processes may create the same directory at once; the one that loses
    // the mkdir finds it made, and checks it like any other.
    const privateDir = (...parts) => {
      for (let attempt = 0; ; attempt += 1) {
        try { return ensureContainedPrivateDirectory({ workspaceRoot: root, directory: path.join(root, ...parts), label: 'edit arbitration state' }) } catch (error) {
          if (error.code !== 'EEXIST' || attempt >= 8) throw error
        }
      }
    }
    const objectsRoot = privateDir(OBJECTS_DIRECTORY)
    const indexRoot = privateDir(OBJECT_INDEX_DIRECTORY)
    // Verified prefixes of logs this store has read. Events are immutable and
    // chained, so a verified prefix stays verified; recoverObject reads afresh.
    const verified = new Map()

    function identityOf(value) {
      const identity = { workspaceId, repoId: value?.repoId, nodeId: value?.nodeId }
      if (!isIdentifier(identity.repoId) || !isIdentifier(identity.nodeId)) refuseArbitration('invalid-identity', 'an object is named by a repository identifier and a node identifier')
      if (value.workspaceId !== undefined && value.workspaceId !== workspaceId) refuseArbitration('foreign-workspace', 'the object belongs to another workspace')
      return identity
    }
    const segmentsOf = (identity) => [encodeIdentitySegment(identity.repoId), encodeIdentitySegment(identity.nodeId)]
    const pointerOf = (identity) => ({ repoId: identity.repoId, nodeId: identity.nodeId })

    // ---- reading ---------------------------------------------------------

    function listEventNames(directory, identity) {
      let names
      try { names = fs.readdirSync(directory) } catch (error) {
        if (error.code === 'ENOENT') return 0
        if (error.code === 'ENOTDIR') refuseArbitration('foreign-object-file', 'something that is not a directory stands where the object is kept', pointerOf(identity))
        throw error
      }
      let highest = 0
      for (const name of names) {
        if (isPendingPrivateWrite(name)) continue
        const match = EVENT_NAME.exec(name)
        if (!match || Number(match[1]) < 1) refuseArbitration('foreign-object-file', 'the object directory holds a file that is not an event; nothing is decided until a person has looked', pointerOf(identity))
        highest = Math.max(highest, Number(match[1]))
      }
      return highest
    }

    function readEvent(directory, identity, sequence, previous) {
      const corrupt = (code, message) => refuseArbitration(code, message, { ...pointerOf(identity), sequence })
      let bytes
      try {
        const file = path.join(directory, eventName(sequence))
        if (fs.lstatSync(file).size > limits.maxEventBytes) corrupt('object-event-too-large', 'an event is larger than an event can be')
        bytes = readBytesNoFollow(file)
      } catch (error) {
        if (error instanceof EditArbitrationRefusal) throw error
        // Events are published in order and never removed, so a name that is
        // listed has every lower name beside it.
        return corrupt(error.code === 'ENOENT' ? 'object-log-gap' : 'object-event-unreadable', 'an event of the object cannot be read')
      }
      let document
      try { document = JSON.parse(bytes.toString('utf8')) } catch { return corrupt('object-event-malformed', 'an event of the object is not a document') }
      if (!isObjectEvent(document) || canonicalJson(document) !== bytes.toString('utf8')) corrupt('object-event-malformed', 'an event of the object is not a valid canonical event')
      if (document.workspaceId !== identity.workspaceId || document.repoId !== identity.repoId || document.nodeId !== identity.nodeId) corrupt('object-event-foreign', 'an event names another object')
      if (document.sequence !== sequence || document.previous !== previous) corrupt('object-log-chain-broken', 'an event does not follow the one before it')
      return { document, digest: sha256Digest(bytes) }
    }

    // { directory, events, digests, derived }. Refuses a log that cannot be trusted.
    function readLog(identity, { fresh = false } = {}) {
      const directory = path.join(objectsRoot, ...segmentsOf(identity))
      const highest = listEventNames(directory, identity)
      const cached = fresh ? undefined : verified.get(directory)
      const events = cached ? [...cached.events] : []
      const digests = cached ? [...cached.digests] : []
      if (highest < events.length) refuseArbitration('object-log-shortened', 'events of the object have disappeared', pointerOf(identity))
      for (let sequence = events.length + 1; sequence <= highest; sequence += 1) {
        const { document, digest } = readEvent(directory, identity, sequence, digests.at(-1) ?? null)
        events.push(document)
        digests.push(digest)
      }
      verified.set(directory, { events, digests })
      const derived = arbitrateEvents(events, rules)
      if (derived.violations.length > 0) {
        refuseArbitration('object-log-inconsistent', 'the events of the object are not a history this store could have written', { ...pointerOf(identity), violations: derived.violations })
      }
      return { directory, events, digests, derived: { ...derived, identity } }
    }

    // ---- writing ---------------------------------------------------------

    // 'published' or 'taken'. A crash leaves a complete event or none, and at
    // most a private staging file that no reader takes for an event.
    function publishEvent(directory, document) {
      const text = canonicalJson(document)
      const bytes = Buffer.from(text, 'utf8')
      if (bytes.length > limits.maxEventBytes) refuseArbitration('object-event-too-large', 'the event is larger than an event can be', { sequence: document.sequence, bytes: bytes.length })
      const file = path.join(directory, eventName(document.sequence))
      const pending = path.join(directory, `.atelier-write-${randomUUID()}.tmp`)
      const context = { type: document.type, sequence: document.sequence, repoId: document.repoId, nodeId: document.nodeId }
      let descriptor
      let crashed = false
      const seam = (step) => { try { crash(step, context) } catch (error) { crashed = true; throw error } }
      try {
        descriptor = openRegularFileNoFollow(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
        fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined
        try { fs.linkSync(pending, file) } catch (error) {
          if (error.code !== 'EEXIST') throw error
          // The same bytes under the name: the same decision, made twice.
          if (!readBytesNoFollow(file).equals(bytes)) return 'taken'
        }
        seam('event-linked')
        syncPrivateDirectory(directory)
        if (!readBytesNoFollow(file).equals(bytes)) throw new Error('published event readback mismatch')
        seam('event-published')
        return 'published'
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor)
        // A crashed process removes nothing.
        if (!crashed) try { fs.unlinkSync(pending) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }

    function objectDirectory(identity) {
      const [repo, node] = segmentsOf(identity)
      const existed = fs.existsSync(path.join(objectsRoot, repo, node))
      const directory = privateDir(OBJECTS_DIRECTORY, repo, node)
      if (!existed) { syncPrivateDirectory(path.join(objectsRoot, repo)); syncPrivateDirectory(objectsRoot) }
      return directory
    }

    // Appends the event `build(derived)` describes, decided against exactly
    // the events before it. `build` returns { type, body }, or { done } when
    // nothing is to be appended. The reducer is the judge: an event it would
    // list as a violation is refused with that code and never written.
    function append(identity, build, { settling = false } = {}) {
      for (let attempt = 0; attempt < limits.maxAppendAttempts; attempt += 1) {
        const log = readLog(identity)
        const decided = build(log.derived, log)
        if (Object.hasOwn(decided, 'done')) return { appended: false, log, value: decided.done }
        const ceiling = limits.maxEventsPerObject - (settling ? 0 : limits.reservedForSettlement)
        if (log.events.length >= ceiling) refuseArbitration('object-log-full', 'the object holds as many events as an object may; nothing is rotated or dropped', { ...pointerOf(identity), events: log.events.length, limit: limits.maxEventsPerObject })
        const event = { schema: OBJECT_EVENT_SCHEMA, ...identity, sequence: log.events.length + 1, previous: log.digests.at(-1) ?? null, type: decided.type, recordedAt: isoTime(clock), body: decided.body }
        if (!isObjectEvent(event)) refuseArbitration('invalid-event', 'the event is not one this store records', { type: decided.type })
        const after = arbitrateEvents([...log.events, event], rules)
        if (after.violations.length > 0) refuseArbitration(after.violations[0].code, 'the events of the object do not allow this', { ...pointerOf(identity), type: decided.type })
        if (publishEvent(objectDirectory(identity), event) === 'taken') continue
        return { appended: true, event, log: readLog(identity) }
      }
      return refuseArbitration('append-contention', 'the object was appended to by others on every attempt', pointerOf(identity))
    }

    // What the log can derive and has not yet written down, oldest cause first.
    function declare(identity) {
      for (;;) {
        const { appended } = append(identity, ({ undeclared }) => {
          if (undeclared.siblingsStale !== null) return { type: 'siblings-stale', body: undeclared.siblingsStale }
          if (undeclared.superseded.length > 0) return { type: 'superseded', body: { operations: undeclared.superseded } }
          if (undeclared.conflicted.length > 0) return { type: 'conflict-declared', body: { operations: undeclared.conflicted } }
          return { done: true }
        }, { settling: true })
        if (!appended) return
      }
    }

    // ---- the index, a cache ---------------------------------------------

    const indexFile = (identity) => { const [repo, node] = segmentsOf(identity); return path.join(indexRoot, repo, `${node}.json`) }

    function indexDocument({ derived, digests }) {
      const scopes = new Set()
      const operations = derived.operations.map((entry) => {
        const own = [...new Set(entry.origins.map((origin) => origin.scopeId))].sort()
        for (const scopeId of own) scopes.add(scopeId)
        return { idempotencyKey: entry.idempotencyKey, kind: entry.kind, state: entry.state, reason: entry.reason, scopes: own }
      })
      return {
        schema: OBJECT_INDEX_SCHEMA, ...derived.identity, sequence: derived.sequence, headDigest: digests.at(-1) ?? null,
        state: derived.state, sourceDigest: derived.sourceDigest, operations, scopes: [...scopes].sort(),
        leaseHeld: derived.lease !== null, intentOutcomeUnknown: derived.intent !== null,
      }
    }

    function writeIndex(log) {
      if (log.events.length === 0) return
      const [repo] = segmentsOf(log.derived.identity)
      privateDir(OBJECT_INDEX_DIRECTORY, repo)
      const text = canonicalJson(indexDocument(log))
      const file = indexFile(log.derived.identity)
      try { if (readBytesNoFollow(file).toString('utf8') === text) return } catch { /* absent or unreadable: written below */ }
      atomicReplacePrivateText(file, text)
    }

    function settle(identity) {
      declare(identity)
      const log = readLog(identity)
      // The index is a cache: when it cannot be written, every reader derives
      // what it needs from the events, and says so here.
      let indexed = true
      try { writeIndex(log) } catch { indexed = false }
      crash('index-updated', { type: null, sequence: log.events.length, ...pointerOf(identity) })
      return { log, indexed }
    }

    function readIndex(identity) {
      try {
        const document = JSON.parse(readBytesNoFollow(indexFile(identity)).toString('utf8'))
        return document?.schema === OBJECT_INDEX_SCHEMA && document.workspaceId === workspaceId && document.repoId === identity.repoId && document.nodeId === identity.nodeId && Array.isArray(document.operations) && Array.isArray(document.scopes) ? document : null
      } catch { return null }
    }

    // ---- objects on disk -------------------------------------------------

    const directoriesOf = (directory) => {
      let entries
      try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return { names: [], foreign: 0 }; throw error }
      const names = entries.filter((entry) => entry.isDirectory() && isIdentitySegment(entry.name)).map((entry) => entry.name).sort()
      return { names, foreign: entries.length - names.length }
    }

    // The identity of the object in <repo>/<node>: decoded from the names, or
    // read from the first event when a name is hashed.
    function identityAt(repo, node) {
      let repoId = decodeIdentitySegment(repo)
      let nodeId = decodeIdentitySegment(node)
      if (repoId === null || nodeId === null) {
        try {
          const first = JSON.parse(readBytesNoFollow(path.join(objectsRoot, repo, node, eventName(1))).toString('utf8'))
          if (isObjectEvent(first)) { repoId = first.repoId; nodeId = first.nodeId }
        } catch { /* reported below */ }
      }
      if (!isIdentifier(repoId) || !isIdentifier(nodeId) || encodeIdentitySegment(repoId) !== repo || encodeIdentitySegment(nodeId) !== node) return null
      return { workspaceId, repoId, nodeId }
    }

    function walkObjects(visit) {
      let foreign = 0
      const repos = directoriesOf(objectsRoot)
      foreign += repos.foreign
      for (const repo of repos.names) {
        const nodes = directoriesOf(path.join(objectsRoot, repo))
        foreign += nodes.foreign
        for (const node of nodes.names) visit(identityAt(repo, node), path.join(objectsRoot, repo, node))
      }
      return foreign
    }

    // ---- the lease --------------------------------------------------------

    function leaseOf(lease) {
      if (lease === null || typeof lease !== 'object' || typeof lease.nonce !== 'string') refuseArbitration('lease-required', 'this is recorded only under the lease of the object')
      return { identity: identityOf(lease), nonce: lease.nonce }
    }

    function underLease(lease, type, body) {
      const { identity, nonce } = leaseOf(lease)
      const { event } = append(identity, () => ({ type, body: { nonce, ...body } }), { settling: true })
      const { log, indexed } = settle(identity)
      return { sequence: event.sequence, state: log.derived, indexed }
    }

    return {
      workspaceId,
      stateRoot: root,

      // Records one edit operation document. Returns { acknowledgement,
      // appended, operation, object }. The acknowledgement depends only on the
      // event that recorded this origin, so offering the same document again
      // (a lost acknowledgement, a second tick, another process) appends
      // nothing and answers the same.
      observe(operation, { presentSourceDigest, resolves = [] } = {}) {
        if (validateObsidianContract('edit-operation', operation).length > 0) refuseArbitration('invalid-operation', 'the document is not an edit operation')
        const identity = identityOf(operation)
        const recorded = recordableOperation(operation)
        const expectedKey = editIdempotencyKey({ ...identity, baseSourceDigest: operation.baseSourceDigest, observedDigest: operation.observed.digest })
        if (recorded === null || operation.idempotencyKey !== expectedKey) refuseArbitration('invalid-operation', 'the edit operation cannot be recorded as it is', { editId: operation.editId })
        if (recorded.state === 'pending' && (recorded.kind !== 'body-replacement' || recorded.ext?.[OBSIDIAN_EXT_KEY]?.newSourceDigest === undefined)) {
          refuseArbitration('invalid-operation', 'a pending operation is a body replacement that names its result', { editId: operation.editId })
        }
        const present = presentSourceDigest === undefined ? (recorded.ext?.[OBSIDIAN_EXT_KEY]?.currentSourceDigest ?? null) : presentSourceDigest
        const body = { operation: recorded, presentSourceDigest: present, resolves: [...new Set(resolves)].sort() }
        const origin = { scopeId: recorded.origin.scopeId, generationId: recorded.origin.generationId, editId: recorded.editId, resolves: body.resolves }
        const recordedAt = (derived) => derived.operations.find((entry) => entry.idempotencyKey === recorded.idempotencyKey)?.origins.find((known) => sameOrigin(known, origin))?.sequence
        const result = append(identity, (derived) => {
          const sequence = recordedAt(derived)
          if (sequence !== undefined) return { done: sequence }
          return { type: derived.operations.some((entry) => entry.idempotencyKey === recorded.idempotencyKey) ? 'coalesced' : 'observed', body }
        })
        const { log, indexed } = settle(identity)
        const sequence = result.appended ? result.event.sequence : result.value
        return {
          acknowledgement: { schema: EDIT_ACKNOWLEDGEMENT_SCHEMA, ...identity, idempotencyKey: recorded.idempotencyKey, editId: recorded.editId, sequence, eventDigest: log.digests[sequence - 1] },
          appended: result.appended,
          operation: log.derived.operations.find((entry) => entry.idempotencyKey === recorded.idempotencyKey) ?? null,
          object: log.derived,
          indexed,
        }
      },

      stateOf(identity) {
        return readLog(identityOf(identity)).derived
      },

      // Every object on disk, from the index where it is current and from the
      // events where it is not. An object that cannot be read is listed as
      // such and hides nothing else. { objects, foreign }
      list({ state, scopeId } = {}) {
        const objects = []
        const foreign = walkObjects((identity, directory) => {
          if (identity === null) { objects.push({ repoId: null, nodeId: null, state: 'unreadable', code: 'object-identity-unknown' }); return }
          try {
            const eventCount = listEventNames(directory, identity)
            if (eventCount === 0) return
            let index = readIndex(identity)
            const headDigest = index === null ? null : sha256Digest(readBytesNoFollow(path.join(directory, eventName(eventCount))))
            if (index === null || !indexIsCurrent({ index, eventCount, headDigest })) {
              const log = readLog(identity)
              index = indexDocument(log)
              try { writeIndex(log) } catch { /* still a cache */ }
            }
            objects.push({ repoId: index.repoId, nodeId: index.nodeId, state: index.state, sequence: index.sequence, sourceDigest: index.sourceDigest, scopes: index.scopes, operations: index.operations, leaseHeld: index.leaseHeld, intentOutcomeUnknown: index.intentOutcomeUnknown })
          } catch (error) {
            if (!(error instanceof EditArbitrationRefusal)) throw error
            objects.push({ ...pointerOf(identity), state: 'unreadable', code: error.code })
          }
        })
        return {
          objects: objects.filter((item) => (state === undefined || item.state === state) && (scopeId === undefined || item.scopes?.includes(scopeId))),
          foreign,
        }
      },

      // { acquired: true, lease } or { acquired: false, code: 'lease-held',
      // reason, needsPerson, holder }. Never waits.
      async acquireLease(identityInput, { pid = process.pid, runtimeId = null } = {}) {
        const identity = identityOf(identityInput)
        for (let attempt = 0; attempt < limits.maxAppendAttempts; attempt += 1) {
          const before = readLog(identity).derived
          let takeover = null
          if (before.lease !== null) {
            const held = before.lease
            const proof = await proveAbandoned({ machine: held.machine, pid: held.pid, service: null, acquiredAt: held.acquiredAt }, { nowMs: Date.parse(isoTime(clock)) })
            if (!proof.abandoned) {
              return { acquired: false, code: 'lease-held', reason: proof.reason, needsPerson: NEEDS_PERSON.has(proof.reason), holder: { pid: held.pid, runtimeId: held.runtimeId, acquiredAt: held.acquiredAt, sequence: held.sequence } }
            }
            takeover = { nonce: held.nonce, reason: proof.reason }
          }
          const nonce = randomBytes(16).toString('hex')
          let lost = false
          const { event } = append(identity, (derived) => {
            // The holder changed while it was being examined: examine again.
            if ((derived.lease?.nonce ?? null) !== (takeover?.nonce ?? null)) { lost = true; return { done: null } }
            return { type: 'lease-acquired', body: { lease: { nonce, pid, machine: machineDigest(), runtimeId, acquiredAt: isoTime(clock) }, takeover } }
          })
          if (lost) continue
          const { log } = settle(identity)
          return { acquired: true, lease: { ...identity, nonce, sequence: event.sequence }, takeover, object: log.derived }
        }
        return refuseArbitration('append-contention', 'the lease of the object changed hands on every attempt', pointerOf(identity))
      },

      // false when the lease is no longer this one (it was taken over after a
      // proof that this holder was gone).
      releaseLease(lease) {
        const { identity, nonce } = leaseOf(lease)
        const { appended } = append(identity, (derived) => (derived.lease?.nonce === nonce ? { type: 'lease-released', body: { nonce } } : { done: false }), { settling: true })
        settle(identity)
        return appended
      },

      // Write-ahead: recorded before the source is touched.
      recordIntent(lease, { idempotencyKey, expectedSourceDigest, newSourceDigest, actor, policy, applyId }) {
        return underLease(lease, 'apply-intent', { idempotencyKey, expectedSourceDigest, newSourceDigest, actor, policy, ...optional({ applyId }) })
      },

      // The source was written: old and new digests, who, and under what.
      recordApplied(lease, { idempotencyKey, oldSourceDigest, newSourceDigest, actor, policy, applyId, backupRef }) {
        return underLease(lease, 'applied', { idempotencyKey, oldSourceDigest, newSourceDigest, actor, policy, ...optional({ applyId, backupRef }) })
      },

      // The source was not written. `presentSourceDigest` is what the source
      // was read to be, when it was read. `disposition` is what becomes of a
      // pending operation: 'retained' (try again later), 'conflicted', 'refused'.
      recordRefused(lease, { idempotencyKey, code, presentSourceDigest = null, disposition = 'retained', applyId, policy, recoveryRefs }) {
        if (!REFUSED_DISPOSITIONS.includes(disposition)) refuseArbitration('invalid-event', 'the disposition is not one this store records', { type: 'apply-refused' })
        return underLease(lease, 'apply-refused', { idempotencyKey, code, presentSourceDigest, disposition, ...optional({ applyId, policy, recoveryRefs }) })
      },

      // Reads every event of the object again, from the files, writes down
      // whatever declaration a crash left unwritten, and rebuilds its index.
      recoverObject(identityInput) {
        const identity = identityOf(identityInput)
        readLog(identity, { fresh: true })
        const { log, indexed } = settle(identity)
        return { ...log.derived, indexed }
      },

      // Deletes every index and derives it again from the events. Equal events
      // give equal bytes.
      rebuildIndexes() {
        fs.rmSync(indexRoot, { recursive: true, force: true })
        privateDir(OBJECT_INDEX_DIRECTORY)
        const result = { rebuilt: 0, unreadable: [], foreign: 0 }
        result.foreign = walkObjects((identity) => {
          if (identity === null) { result.unreadable.push({ repoId: null, nodeId: null, code: 'object-identity-unknown' }); return }
          try { writeIndex(readLog(identity, { fresh: true })); result.rebuilt += 1 } catch (error) {
            if (!(error instanceof EditArbitrationRefusal)) throw error
            result.unreadable.push({ ...pointerOf(identity), code: error.code })
          }
        })
        return result
      },
    }
  }
}

export const openObjectStore = createObjectStoreForOracleTests()
