import { compareText } from '../../../runtime/obsidian/documents.mjs'
import { OPEN_EDIT_STATES, createMaintenanceStateStore } from '../../../runtime/obsidian/state-store.mjs'
import { openObjectStore } from '../edits/object-store.mjs'

// A read-only, typed view of the shared conflict state AOP-2's arbitration
// keeps per object: which objects are conflicted, pending, settled or
// unreadable, which operations are involved and why, and which pending edit
// records of which views feed them. Identities, states, codes and digests
// only: no note text, title or path.
//
// `conflictView` is pure: it is a function of the object entries (the
// object store's `list()` or an `arbitrateEvents` summary) and the pending
// edit records. `readConflictView` reads both from the workspace's private
// state. Neither decides anything, writes an event or touches a source file
// or a vault.

export const CONFLICT_VIEW_SCHEMA = 'atelier-obsidian-conflict-view/v1'
export const OBJECT_VIEW_STATES = Object.freeze(['conflicted', 'pending', 'settled', 'empty', 'inconsistent', 'unreadable'])

// What a person or an agent does next. A conflict is resolved by a new
// operation that names the ones it resolves; nothing here chooses a winner.
const NEXT = Object.freeze({
  conflicted: 'offer a resolution that names every conflicted operation; no operation is dropped and no winner is chosen',
  pending: 'apply explicitly, or let an active automatic policy dispatch it',
  settled: 'nothing: every recorded operation is applied, superseded or refused',
  empty: 'nothing: no operation is recorded for this object',
  inconsistent: 'a person looks at the object log; an event the log did not allow is recorded',
  unreadable: 'a person looks at the object directory; nothing is decided until then',
})

const NEEDS_PERSON = new Set(['conflicted', 'inconsistent', 'unreadable'])

function operationView(operation) {
  return {
    idempotencyKey: operation.idempotencyKey,
    kind: operation.kind ?? null,
    state: operation.state,
    reason: operation.reason ?? null,
    by: operation.by ?? null,
  }
}

export function conflictView({ objects, edits = [], scopeId } = {}) {
  if (!Array.isArray(objects)) throw new TypeError('conflictView needs the list of object entries')
  const openEdits = edits.filter((edit) => OPEN_EDIT_STATES.includes(edit.state) && (scopeId === undefined || edit.scopeId === scopeId))
  const editsOf = (repoId, nodeId) => openEdits
    .filter((edit) => edit.identity?.repoId === repoId && edit.identity?.nodeId === nodeId)
    .map((edit) => ({ editId: edit.editId, scopeId: edit.scopeId, state: edit.state, lastCode: edit.lastResult?.code ?? null }))
    .sort((left, right) => compareText(left.scopeId, right.scopeId) || compareText(left.editId, right.editId))

  const entries = objects.map((object) => {
    const state = OBJECT_VIEW_STATES.includes(object.state) ? object.state : 'unreadable'
    const identity = object.identity ?? object
    const repoId = identity.repoId ?? null
    const nodeId = identity.nodeId ?? null
    const operations = (object.operations ?? []).map(operationView)
    const intentOutcomeUnknown = object.intentOutcomeUnknown === true || (object.intent !== undefined && object.intent !== null)
    const needsPerson = NEEDS_PERSON.has(state) || intentOutcomeUnknown
    return {
      repoId, nodeId, state,
      code: object.code ?? null,
      sourceDigest: object.sourceDigest ?? null,
      leaseHeld: object.leaseHeld === true || (object.lease !== undefined && object.lease !== null),
      intentOutcomeUnknown,
      operations,
      conflictedOperations: operations.filter((operation) => operation.state === 'conflicted').map((operation) => operation.idempotencyKey),
      pendingEdits: repoId === null ? [] : editsOf(repoId, nodeId),
      needsPerson,
      next: intentOutcomeUnknown && !NEEDS_PERSON.has(state) ? 'an apply was started and its outcome is not recorded; the next lease holder reads the source and decides' : NEXT[state],
    }
  }).sort((left, right) => compareText(left.repoId ?? '', right.repoId ?? '') || compareText(left.nodeId ?? '', right.nodeId ?? ''))

  const byState = Object.fromEntries(OBJECT_VIEW_STATES.map((state) => [state, entries.filter((entry) => entry.state === state).length]))
  return {
    schema: CONFLICT_VIEW_SCHEMA,
    scopeId: scopeId ?? null,
    objects: entries,
    summary: { total: entries.length, byState, needsPerson: entries.filter((entry) => entry.needsPerson).length, openEdits: openEdits.length },
    needsPerson: entries.some((entry) => entry.needsPerson),
  }
}

// Reads the object index (a cache the store rebuilds from the events where
// it is not current) and the pending edit records of the workspace.
export function readConflictView({ workspaceRoot, workspaceId, repositoryRoots, clock, scopeId, objectStore = openObjectStore }) {
  const store = objectStore({ stateRoot: workspaceRoot, workspaceId, repositoryRoots, clock })
  const { objects, foreign } = store.list(scopeId === undefined ? {} : { scopeId })
  const edits = createMaintenanceStateStore({ workspaceRoot, workspaceId }).readPendingEdits().edits
  const view = conflictView({ objects, edits, scopeId })
  return { ...view, foreign }
}
