import fs from 'node:fs'
import path from 'node:path'
import { AtelierDiagnosticError } from '../../../project/config.mjs'
import { compareText, isoTime } from '../../../runtime/obsidian/documents.mjs'
import { readObsidianEnablement } from '../../../runtime/obsidian/enablement.mjs'
import { ObsidianMaintenanceRefusal } from '../../../runtime/obsidian/errors.mjs'
import { OPEN_EDIT_STATES, createMaintenanceStateStore } from '../../../runtime/obsidian/state-store.mjs'
import { OBSIDIAN_EXT_KEY, ObsidianContractRefusal } from '../contracts.mjs'
import { SOURCE_APPLY_PRIMITIVES, SourceApplyRefusal, locateSource } from '../edits/apply.mjs'
import { EditArbitrationRefusal } from '../edits/arbitrate.mjs'
import { createEditObserverForOracleTests, editIdempotencyKey, observeEdit } from '../edits/observe.mjs'
import { decideApply } from '../edits/policy.mjs'
import { PublicationRefusal, readFileBytes, sha256Digest } from '../recovery/store.mjs'
import { PROPOSAL_BACKPRESSURE } from './backpressure.mjs'

// Observation on a tick: the part of a source apply that comes before its
// lease, for every open pending edit the object store does not know yet.
//
// In manual mode nothing on a tick applies, so until here a structural edit
// was recorded as `proposed` only after a person asked apply to look at it.
// Here the same observation runs on the tick itself, in manual and in
// automatic mode alike: the source is read now, the lens runs over the
// PRESERVED edit bytes (never the live note) against it, and the resulting
// operation is recorded in the object store exactly as an apply records it,
// through the same observer and the same store. A body replacement is recorded
// `pending` and left for apply, which is the only thing that writes a source;
// a structural edit is recorded `proposed`, and the adapter routes it in the
// same tick; a lens refusal is recorded `refused`; a base that moved on is
// recorded `conflicted`. Nothing here writes a source file or a vault, and
// nothing takes a lease.
//
// Quiet: the object store answers the same for an origin it already holds and
// appends nothing, and an edit it holds is not offered again. A refusal that
// comes before anything can be recorded (a source that is missing, a manifest
// that cannot be read, an object this machine may not see, a note that cannot
// be prepared again) is remembered in memory with its code and offered again
// only when the caller says so, which the engine does at its full
// reconciliation cadence, never on every tick. A bounded number of edits is
// looked at per tick, in the order they were observed, starting where the last
// tick stopped.

const EXT = OBSIDIAN_EXT_KEY
const GONE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])
const segment = (identifier) => identifier.replaceAll(':', '_')
const refuse = (code, detail) => { throw new SourceApplyRefusal(code, detail) }
const isTyped = (error) => error instanceof SourceApplyRefusal || error instanceof EditArbitrationRefusal || error instanceof PublicationRefusal || error instanceof ObsidianMaintenanceRefusal
  || error instanceof ObsidianContractRefusal || error instanceof AtelierDiagnosticError

// Observation of an edit whose base source is no longer the source: a conflict, decided without the lens. The same
// observer source apply uses for that case.
const STALE_OBSERVER = createEditObserverForOracleTests({
  preserve({ store, edit, baseSourceBytes }) {
    let edited = null
    try { edited = store.readObject(edit.observedDigest) } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'recovery-object-corrupt') throw error }
    return edited === null ? { edited: null } : { edited, publishedRef: undefined, baseRef: store.retainObject(baseSourceBytes).ref }
  },
  classify: () => ({ kind: 'refusal', code: 'stale-base', detail: {} }),
})

// One open, never through a symbolic link, and only of a regular file.
function readNoFollow(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' })
    return fs.readFileSync(descriptor)
  } finally { fs.closeSync(descriptor) }
}
const digestOrNull = (file) => { try { return sha256Digest(readNoFollow(file)) } catch { return null } }

// The immutable manifest of one generation of one view: the current one when it is that generation, else the stored
// file, whose name carries the generation and the head of its digest. `workspace` answers `recoveryOf(scopeId)`.
export function manifestOf(workspace, scopeId, generationId) {
  const current = workspace.recoveryOf(scopeId).readCurrentManifest()
  if (current?.generationId === generationId) return current
  const directory = path.join(workspace.workspaceRoot, 'state', 'manifests', segment(scopeId))
  let names = []
  try { names = fs.readdirSync(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const name of names.filter((item) => item.startsWith(`${segment(generationId)}--`) && item.endsWith('.json')).sort()) {
    let bytes
    try { bytes = readFileBytes(path.join(directory, name)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (name !== `${segment(generationId)}--${sha256Digest(bytes).slice(7, 19)}.json`) continue
    const manifest = JSON.parse(bytes.toString('utf8'))
    if (manifest.generationId === generationId && manifest.scopeId === scopeId) return manifest
  }
  return null
}

// The retained bytes of that digest, or null when the store does not hold them intact.
export function retained(store, digest) {
  if (typeof digest !== 'string') return null
  try { const bytes = store.readObject(digest); return sha256Digest(bytes) === digest ? bytes : null } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'recovery-object-corrupt') return null
    throw error
  }
}

// The operation the object store recorded for this edit, or null.
export function recordedOperationOf(objects, edit) {
  return objects.stateOf({ repoId: edit.identity.repoId, nodeId: edit.identity.nodeId }).operations.find((entry) => entry.origins.some((origin) => origin.editId === edit.editId && origin.scopeId === edit.scopeId)) ?? null
}

// `seams` prepare a view again when the published note is not retained; `isGitIgnored` and `gitDirectory` are what
// git is asked through; `bounds.maxObservedPerTick` is how many edits one tick looks at.
export function createTickObservation(options = {}) {
  const { seams, isGitIgnored = SOURCE_APPLY_PRIMITIVES.isGitIgnored, gitDirectory = SOURCE_APPLY_PRIMITIVES.gitDirectory, bounds = PROPOSAL_BACKPRESSURE } = options
  if (!seams || typeof seams.captureSnapshot !== 'function' || typeof seams.prepareView !== 'function') throw new TypeError('tick observation needs the seams that prepare a view')
  // Edits whose operation the object store holds: a cache, losing it costs one read of an object. And edits whose
  // observation refused before anything could be recorded, with the code.
  const recorded = new Set()
  const unobservable = new Map()
  let cursor = 0

  // Everything about one pending edit that the manifest of its view says.
  function resolveEdit(workspace, edit) {
    const { repoId, nodeId } = edit.identity
    const scope = readObsidianEnablement(workspace.project).scopes.find((item) => item.scopeId === edit.scopeId)
    if (!scope) refuse('unknown-scope')
    const manifest = manifestOf(workspace, edit.scopeId, edit.generationId)
    const noteEntry = manifest?.notes.find((note) => note.repoId === repoId && note.nodeId === nodeId && note.path === edit.path)
    if (!noteEntry) refuse('manifest-unavailable')
    const source = noteEntry.ext?.[EXT]?.source
    if (typeof source?.rawDigest !== 'string' || typeof source?.path !== 'string') refuse('manifest-unavailable')
    return { scope, manifest, noteEntry, recorded: source, baseSourceDigest: source.rawDigest, idempotencyKey: editIdempotencyKey({ workspaceId: workspace.workspaceId, repoId, nodeId, baseSourceDigest: source.rawDigest, observedDigest: edit.observedDigest }) }
  }

  // The note exactly as it was published, which the lens needs to tell generated bytes from authored ones. The
  // publisher keeps no copy of a note it created, so the note is prepared again from the sources as they are now and
  // used only when it has the digest the manifest recorded; a retained object of that digest serves as well.
  function publishedNoteOf(workspace, { scope, manifest, noteEntry }, now) {
    const store = workspace.recoveryOf(scope.scopeId)
    const kept = retained(store, noteEntry.noteDigest)
    if (kept) return kept
    workspace.prepared ??= new Map()
    if (!workspace.prepared.has(scope.scopeId)) {
      let files = []
      try {
        const { graph, profile } = workspace.corpus()
        const snapshot = seams.captureSnapshot({ project: workspace.project, graph, workspaceId: workspace.workspaceId, index: new Map(), configDigest: manifest.ext?.[EXT]?.configDigest ?? `sha256:${'0'.repeat(64)}`, capturedAt: now })
        const persistentPathRegistry = createMaintenanceStateStore({ workspaceRoot: workspace.workspaceRoot, workspaceId: workspace.workspaceId }).readPathRegistry()
        files = seams.prepareView({ snapshot, profile, scope, persistentPathRegistry, priorManifest: manifest, existingSettings: null, clock: workspace.clock, vaultRootBytes: Buffer.byteLength(store.vaultRoot, 'utf8') }).files
      } catch (error) { if (!isTyped(error) && !GONE.has(error?.code)) throw error }
      workspace.prepared.set(scope.scopeId, files)
    }
    const file = workspace.prepared.get(scope.scopeId).find((item) => item.path === noteEntry.path && item.digest === noteEntry.noteDigest)
    return file ? file.bytes : null
  }

  // One edit, in the order of an apply up to its lease. Returns what was recorded; throws a typed refusal.
  function observeOne(workspace, edit, now) {
    if (edit.identity.workspaceId !== workspace.workspaceId) refuse('foreign-workspace')
    const identity = { repoId: edit.identity.repoId, nodeId: edit.identity.nodeId }
    const known = recordedOperationOf(workspace.objects(), edit)
    if (known) return { code: 'already-observed', kind: known.kind, operationState: known.state, idempotencyKey: known.idempotencyKey }

    // Whether this machine may see the object is asked first, of the canonical graph as it is now, before the
    // manifest, the record of the object or the source path is looked at: an object that is withheld and one that
    // is absent get this one answer, with nothing read and nothing recorded.
    const { graph, profile } = workspace.corpus()
    const visibility = decideApply({ request: { editId: edit.editId, mode: 'manual' }, workspace: { workspaceRoot: workspace.workspaceRoot, workspaceId: workspace.workspaceId }, graph, profile, object: identity, editClass: 'body-replacement', attempts: [] })
    if (!visibility.allowed && visibility.code === 'object-not-visible') refuse('object-not-visible')
    const resolved = resolveEdit(workspace, edit)
    const node = graph.nodes.find((item) => item.repo === identity.repoId && item.id === identity.nodeId)
    if (!node) refuse('source-not-in-graph')
    if (node.path !== resolved.recorded.path) refuse('source-moved')

    // The source, now: the one file of an enrolled repository the manifest names, reached through no link.
    const vaultRoots = readObsidianEnablement(workspace.project).scopes.map((scope) => workspace.recoveryOf(scope.scopeId).vaultRoot)
    const located = locateSource({ project: workspace.project, repoId: identity.repoId, relative: node.path, managedRoots: [workspace.workspaceRoot, ...vaultRoots], isGitIgnored, gitDirectory, env: workspace.env ?? process.env })
    let sourceBytes
    try { sourceBytes = readNoFollow(located.absolute) } catch (error) { refuse(error.code === 'ENOENT' ? 'source-missing' : error.code === 'ELOOP' ? 'source-symlink' : 'source-not-regular-file') }
    const sourceDigest = sha256Digest(sourceBytes)

    // The lens over the preserved bytes, or the conflict when the source moved on; then the record, through the store.
    const store = workspace.recoveryOf(edit.scopeId)
    let observed
    if (sourceDigest !== resolved.baseSourceDigest) {
      observed = STALE_OBSERVER({ edit, manifest: resolved.manifest, publishedNoteBytes: Buffer.alloc(0), baseSourceBytes: sourceBytes, store })
      delete observed.operation.ext[EXT].publishedNoteRef
    } else {
      const publishedNoteBytes = publishedNoteOf(workspace, resolved, now)
      // Preparing the note reads the source again: a source that changed since it was read here is a stale source.
      if (publishedNoteBytes === null && digestOrNull(located.absolute) !== sourceDigest) refuse('stale-source', { cause: 'changed-while-reading' })
      if (publishedNoteBytes === null) refuse('published-note-unavailable')
      observed = observeEdit({ edit, manifest: resolved.manifest, publishedNoteBytes, baseSourceBytes: sourceBytes, store })
    }
    const result = workspace.objects().observe(observed.operation, { presentSourceDigest: sourceDigest })
    return { code: result.appended ? 'observed' : 'already-observed', kind: observed.operation.kind, operationState: result.operation?.state ?? observed.operation.state, idempotencyKey: observed.operation.idempotencyKey }
  }

  // `workspace` is the opened workspace of the adapter; `edits` the pending edit records, open and closed;
  // `retryRefused` offers the edits whose observation refused earlier once more. Returns one entry per edit looked
  // at: { editId, repoId, nodeId, status: 'observed' | 'refused', code, kind?, operationState?, idempotencyKey? }.
  return function observePendingEdits(workspace, { edits, retryRefused = false }) {
    if (retryRefused) unobservable.clear()
    const now = isoTime(workspace.clock)
    const candidates = edits.filter((edit) => edit.closedAt === null && OPEN_EDIT_STATES.includes(edit.state) && !recorded.has(edit.editId) && !unobservable.has(edit.editId))
      .sort((left, right) => compareText(left.observedAt, right.observedAt) || compareText(left.editId, right.editId))
    const start = candidates.length === 0 ? 0 : cursor % candidates.length
    const looked = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, bounds.maxObservedPerTick)
    cursor = candidates.length > bounds.maxObservedPerTick ? start + looked.length : 0
    const observed = []
    for (const edit of looked) {
      const entry = { editId: edit.editId, repoId: edit.identity.repoId, nodeId: edit.identity.nodeId }
      try {
        const outcome = observeOne(workspace, edit, now)
        recorded.add(edit.editId)
        observed.push({ ...entry, status: 'observed', ...outcome })
      } catch (error) {
        if (!isTyped(error)) throw error
        unobservable.set(edit.editId, error.code)
        observed.push({ ...entry, status: 'refused', code: error.code })
      }
    }
    return observed
  }
}
