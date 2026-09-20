import { createHash } from 'node:crypto'
import { OBSIDIAN_EXT_KEY, assertObsidianContract } from '../contracts.mjs'
import { sha256Digest } from '../materialize/byte-lens.mjs'
import { applyEditLens } from './regions.mjs'

// Observation: one pending edit record of the maintenance engine becomes one
// edit operation document.
//
// The order is fixed. First the immutable bytes: the edited note must already
// be retained in the recovery object store under its digest (the engine put it
// there before it queued the record), and the published note and the base
// source the edit is judged against are retained beside it. Only then is the
// edit classified. A crash between the two leaves every byte needed to
// classify again and no half-made operation. The live note in the vault is
// never read here: bytes that were not preserved cannot be replaced by
// whatever the note holds now.
//
// Nothing here writes to a source file or to a vault, and the document holds
// identities, digests, byte offsets, codes and store references only.

const EXT = OBSIDIAN_EXT_KEY
export const EDIT_LENS_VERSION = '1.0.0'

// The same edited bytes over the same base source of the same object are the
// same operation, from whichever view or generation they were observed.
export function editIdempotencyKey({ workspaceId, repoId, nodeId, baseSourceDigest, observedDigest }) {
  return `op-${createHash('sha256').update([workspaceId, repoId, nodeId, baseSourceDigest, observedDigest].join('\u0000')).digest('hex')}`
}

// How a lens outcome is carried by the closed operation contract. A change to
// front matter or to the link structure is content for a proposal, which a
// later step builds from the preserved bytes; a base that moved is a conflict;
// everything else the lens refuses is refused.
function classify(outcome) {
  if (outcome.kind === 'body-replacement') return { kind: 'body-replacement', state: 'pending' }
  if (outcome.code === 'unsupported-structural-edit' || outcome.code === 'unsupported-frontmatter-edit') return { kind: 'semantic-proposal', state: 'proposed' }
  if (outcome.code === 'stale-base') return { kind: 'body-replacement', state: 'conflicted' }
  return { kind: 'body-replacement', state: 'refused' }
}

function refusal(code, detail = {}) {
  return { kind: 'refusal', code, detail }
}

function readRetained(store, digest) {
  try {
    const bytes = store.readObject(digest)
    return sha256Digest(bytes) === digest ? bytes : null
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'recovery-object-corrupt') return null
    throw error
  }
}

export const EDIT_OBSERVATION_STEPS = Object.freeze({
  // Returns { edited, publishedRef, baseRef }; throws nothing for missing bytes.
  preserve({ store, edit, publishedNoteBytes, baseSourceBytes }) {
    const edited = readRetained(store, edit.observedDigest)
    if (edited === null) return { edited: null }
    return { edited, publishedRef: store.retainObject(publishedNoteBytes).ref, baseRef: store.retainObject(baseSourceBytes).ref }
  },
  classify: (input) => applyEditLens(input),
})

// `edit` is a pending edit record; `store` is the recovery store of its view;
// `manifest` is the generation manifest the record names. `publishedNoteBytes`
// is the publisher's retained baseline of the note and `baseSourceBytes` the
// source as it is now. `afterPreserved` is a seam between the two halves.
//
// Returns { operation, outcome }: the validated document and the lens result
// (the new source bytes stay in memory; this phase applies nothing).
export function createEditObserverForOracleTests(steps = EDIT_OBSERVATION_STEPS) {
  return function observeEdit({ edit, store, manifest, publishedNoteBytes, baseSourceBytes, afterPreserved = () => {} }) {
    for (const bytes of [publishedNoteBytes, baseSourceBytes]) if (!Buffer.isBuffer(bytes)) throw new TypeError('observation reads Buffers only')
    const { workspaceId, repoId, nodeId } = edit.identity
    const noteEntry = manifest.generationId === edit.generationId && manifest.scopeId === edit.scopeId
      ? manifest.notes.find((note) => note.repoId === repoId && note.nodeId === nodeId && note.path === edit.path)
      : undefined

    const preserved = steps.preserve({ store, edit, publishedNoteBytes, baseSourceBytes })
    afterPreserved()
    let outcome
    if (!preserved.edited) outcome = refusal('edit-bytes-missing', { observedDigest: edit.observedDigest })
    else if (!noteEntry) outcome = refusal('unknown-note')
    else outcome = steps.classify({ manifest, repoId, nodeId, publishedNoteBytes, editedNoteBytes: preserved.edited, baseSourceBytes })

    const baseSourceDigest = noteEntry?.ext?.[EXT]?.source?.rawDigest ?? sha256Digest(baseSourceBytes)
    const { kind, state } = classify(outcome)
    const operation = {
      schema: 'atelier-obsidian-edit-operation/v1',
      contractVersion: '1.0.0',
      editId: edit.editId,
      workspaceId,
      repoId,
      nodeId,
      origin: {
        scopeId: edit.scopeId,
        generationId: edit.generationId,
        ext: { [EXT]: { notePath: edit.path, baseNoteDigest: edit.baseNoteDigest, publishedNoteDigest: noteEntry?.noteDigest ?? null } },
      },
      kind,
      baseSourceDigest,
      observed: { digest: edit.observedDigest, byteLength: preserved.edited ? preserved.edited.length : 0, recoveryRef: edit.objectRef },
      idempotencyKey: editIdempotencyKey({ workspaceId, repoId, nodeId, baseSourceDigest, observedDigest: edit.observedDigest }),
      state,
      observedAt: edit.observedAt,
      ext: {
        [EXT]: {
          lensVersion: EDIT_LENS_VERSION,
          ...(preserved.edited ? { publishedNoteRef: preserved.publishedRef, baseSourceRef: preserved.baseRef } : {}),
          currentSourceDigest: sha256Digest(baseSourceBytes),
          ...(outcome.kind === 'body-replacement'
            ? { result: { newSourceDigest: outcome.newSourceDigest, newByteLength: outcome.newSourceBytes.length, changedRanges: outcome.changedRanges, unchanged: outcome.unchanged, generated: outcome.generated } }
            : { refusal: { code: outcome.code, detail: outcome.detail } }),
        },
      },
    }
    assertObsidianContract('edit-operation', operation)
    return { operation, outcome }
  }
}

export const observeEdit = createEditObserverForOracleTests()
