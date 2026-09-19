import { createHash } from 'node:crypto'
import path from 'node:path'
import { publishedSinceCommit } from '../../projection/obsidian/recovery/restart.mjs'
import { readFileBytes, sha256Digest } from '../../projection/obsidian/recovery/store.mjs'
import { compareText } from './documents.mjs'
import { normalizeApplyResult } from './extension-points.mjs'
import { OPEN_EDIT_STATES } from './state-store.mjs'

// Edits a person (or another program) made in a vault.
//
// A note whose bytes differ from the digest its view was generated with has
// been edited. The order is fixed: the edited bytes are copied into the
// recovery object store first, and only then is a record queued. The engine
// never writes such a note. Whether an edit reaches a source file is a
// separate, explicit operation: never on a tick in manual mode, and in
// automatic mode only through the registered apply operation under an
// installed policy that is read again immediately before every dispatch.

const DISPATCHABLE = new Set(['queued', 'apply-unavailable', 'apply-failed'])
export const isOpenEdit = (edit) => OPEN_EDIT_STATES.includes(edit.state)

export function editIdentifier({ workspaceId, repoId, nodeId, scopeId, generationId, observedDigest }) {
  return `edit-${createHash('sha256').update([workspaceId, repoId, nodeId, scopeId, generationId, observedDigest].join('\u0000')).digest('hex').slice(0, 32)}`
}

// The digest each note of a view is bound to, exactly as the publisher binds
// it: the trusted manifest, then whatever an unfinished publication of this
// view has verifiably published since. Without the second part a note written
// by an interrupted run would look like somebody's edit.
export function trustedNoteBases(store) {
  const manifest = store.readCurrentManifest()
  const bases = new Map()
  if (!manifest) return { manifest: null, bases }
  const published = publishedSinceCommit({ store })
  for (const note of manifest.notes) {
    const digest = published.has(note.path) ? published.get(note.path) : note.noteDigest
    if (digest !== null) bases.set(note.path, { digest, repoId: note.repoId, nodeId: note.nodeId })
  }
  return { manifest, bases }
}

// Production preservation: an immutable, content-addressed copy in the
// recovery object store, through the store's own primitive.
export const preserveInRecoveryStore = (store, bytes) => store.retainObject(bytes)

// Compares each note with its base and returns the next list of edit records.
// `digestOf(path)` is the digest observation found; the bytes are read again
// here and hashed, and that second reading is what gets preserved and recorded.
export function observeVaultEdits({ store, workspaceId, scopeId, manifest, bases, digestOf, edits, now, preserve = preserveInRecoveryStore }) {
  const next = edits.map((edit) => ({ ...edit }))
  const events = []
  const openFor = (notePath) => next.filter((edit) => edit.scopeId === scopeId && edit.path === notePath && isOpenEdit(edit))
  const close = (edit, state) => { edit.state = state; edit.closedAt = now }

  for (const [notePath, base] of bases) {
    const observed = digestOf(notePath)
    // A missing note holds no bytes to keep; the publisher restores it.
    if (observed === null || observed === undefined) continue
    if (observed === base.digest) {
      for (const edit of openFor(notePath)) { close(edit, 'withdrawn'); events.push({ kind: 'withdrawn', scopeId, path: notePath, editId: edit.editId }) }
      continue
    }
    if (openFor(notePath).some((edit) => edit.observedDigest === observed)) continue
    let bytes
    try { bytes = readFileBytes(path.join(store.vaultRoot, ...notePath.split('/'))) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    const observedDigest = sha256Digest(bytes)
    if (observedDigest === base.digest) continue
    // Preserved first. If this throws, nothing has been recorded.
    const object = preserve(store, bytes)
    if (openFor(notePath).some((edit) => edit.observedDigest === observedDigest)) continue
    for (const edit of openFor(notePath)) { close(edit, 'superseded'); events.push({ kind: 'superseded', scopeId, path: notePath, editId: edit.editId }) }
    const identity = { workspaceId, repoId: base.repoId, nodeId: base.nodeId }
    const editId = editIdentifier({ ...identity, scopeId, generationId: manifest.generationId, observedDigest })
    // The same bytes over the same generation, seen again after being closed: reopened, not duplicated.
    const index = next.findIndex((edit) => edit.editId === editId)
    const record = {
      editId, identity, scopeId, generationId: manifest.generationId, path: notePath, baseNoteDigest: base.digest, observedDigest, objectRef: object.ref,
      observedAt: now, state: 'queued', attempts: 0, retryBudget: null, lastAttemptAt: null, lastResult: null, closedAt: null,
    }
    if (index === -1) next.push(record); else next[index] = record
    events.push({ kind: 'queued', scopeId, path: notePath, editId })
  }
  // A note that left the view is no longer compared; its record stays open and its bytes stay kept.
  return { edits: next, events }
}

export function heldPaths(edits, scopeId) {
  return [...new Set(edits.filter((edit) => edit.scopeId === scopeId && isOpenEdit(edit)).map((edit) => edit.path))].sort(compareText)
}

// Automatic dispatch. `authorize()` reads the machine settings and the policy
// from disk. It is called before the batch and again immediately before each
// edit, so a revocation, a pause or a switch back to manual stops the very
// next dispatch. Attempts are bounded by the policy's retry budget and spaced
// by `retryIntervalMs`; an exhausted edit stays pending and is not dispatched
// again until the operation or the policy changes.
export async function dispatchAutomaticApply({ edits, authorize, applyOperation, now, nowMs, retryIntervalMs }) {
  const next = edits.map((edit) => ({ ...edit }))
  const dispatched = []
  const first = authorize()
  if (!first.authorized) return { edits: next, dispatched, authorization: first.reason }
  let authorization = first.reason
  let remaining = first.policy.maxBatchSize
  const ordered = next.filter((edit) => isOpenEdit(edit)).sort((left, right) => compareText(left.observedAt, right.observedAt) || compareText(left.editId, right.editId))
  for (const edit of ordered) {
    if (remaining <= 0) break
    const current = authorize()
    if (!current.authorized) { authorization = current.reason; break }
    const { policy } = current
    if (!policy.allowedEditClasses.includes('body-replacement')) { authorization = 'edit-class-not-allowed'; break }
    // A new operation or a new policy revision is a new situation: the budget starts again.
    if (edit.lastResult && (edit.lastResult.operationId !== applyOperation.id || edit.lastResult.policyDigest !== policy.digest)) {
      edit.attempts = 0
      if (edit.state === 'retry-exhausted') edit.state = 'queued'
    }
    edit.retryBudget = policy.retryBudget
    if (edit.attempts >= policy.retryBudget + 1) { edit.state = 'retry-exhausted'; continue }
    if (!DISPATCHABLE.has(edit.state)) continue
    if (edit.lastAttemptAt !== null && nowMs - Date.parse(edit.lastAttemptAt) < retryIntervalMs) continue
    remaining -= 1
    let result
    try {
      result = normalizeApplyResult(await applyOperation.apply({
        edit: structuredClone(edit), policy: structuredClone(policy), policyDigest: policy.digest, idempotencyKey: edit.editId,
      }))
    } catch {
      result = { status: 'failed', code: 'apply-operation-threw' }
    }
    edit.attempts += 1
    edit.lastAttemptAt = now
    edit.lastResult = { ...result, operationId: applyOperation.id, policyDigest: policy.digest }
    if (result.status === 'applied') { edit.state = 'applied'; edit.closedAt = now }
    else if (edit.attempts >= policy.retryBudget + 1) edit.state = 'retry-exhausted'
    else edit.state = result.status === 'apply-unavailable' ? 'apply-unavailable' : 'apply-failed'
    dispatched.push({ editId: edit.editId, status: result.status, code: result.code, state: edit.state })
  }
  return { edits: next, dispatched, authorization }
}
