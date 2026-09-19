import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { AtelierDiagnosticError } from '../../../project/config.mjs'
import { publishPrivateFile } from '../../../project/durable-state.mjs'
import { ensureContainedPrivateDirectory, openRegularFileNoFollow, readRegularTextNoFollow, syncPrivateDirectory } from '../../../project/private-state.mjs'
import { canonicalJson, compareText, isoTime } from '../../../runtime/obsidian/documents.mjs'
import { readObsidianEnablement } from '../../../runtime/obsidian/enablement.mjs'
import { ObsidianMaintenanceRefusal } from '../../../runtime/obsidian/errors.mjs'
import { protectedRoots, readInstalledApplyPolicy, readLocalPointer, readMachineSettings, resolveDataRoot, workspaceStateRoot } from '../../../runtime/obsidian/machine-settings.mjs'
import { DEFAULT_ELIGIBILITY, createProductionSeams } from '../../../runtime/obsidian/pipeline.mjs'
import { OPEN_EDIT_STATES, createMaintenanceStateStore } from '../../../runtime/obsidian/state-store.mjs'
import { OBSIDIAN_EXT_KEY, ObsidianContractRefusal } from '../contracts.mjs'
import { readMarkdownLens } from '../materialize/byte-lens.mjs'
import { exchangeFiles, probeExchange } from '../publication/exchange.mjs'
import { createJournal, newJournalId } from '../recovery/journal.mjs'
import { recheckDisplacedFiles } from '../recovery/late-writer.mjs'
import { classifyCandidateFile, recordDisplaced, retireStagedFile } from '../recovery/restart.mjs'
import { PublicationRefusal, readFileBytes, sha256Digest } from '../recovery/store.mjs'
import { EditArbitrationRefusal } from './arbitrate.mjs'
import { isIdentifier } from './object-identity.mjs'
import { openObjectStore } from './object-store.mjs'
import { createEditObserverForOracleTests, editIdempotencyKey, observeEdit } from './observe.mjs'
import { decideApply } from './policy.mjs'

// Source apply: the one operation that writes an edit made in a vault back to
// its SOURCE file. A person's explicit Apply and an automatic policy call this
// same function; they differ only in who authorises (policy.mjs). Nothing else
// in this integration writes to a source file.
//
// The write is never a check followed by a rename: a program that saves the
// source between the two would lose its bytes. It is the publisher's atomic
// exchange, so whatever occupied the source path at the instant of the write
// is kept under the candidate's name and then looked at:
//
//    1  resolve the workspace, the pending edit, its view and its manifest
//    2  build the canonical graph now; the identity must still name the same
//       path of an enrolled repository, and that path must be a regular file
//       with one name, reached through no symbolic link, inside the repository,
//       outside every managed root and the git directory, and not git-ignored
//    3  read the source now; run the lens from the PRESERVED edit bytes (never
//       the live note) against it; record the observation of this edit and of
//       every other open edit of the same object
//    4  take the object lease; settle an earlier apply whose outcome is unknown
//    5  refuse, writing nothing: replay of an applied operation (answered from
//       the record), conflicted object, stale source, a lens refusal, a change
//       outside the authored body, the policy, a missing exchange, a volume
//       that differs from the source's
//    6  write-ahead apply record; candidate written and fsynced in a private
//       per-apply directory of the workspace state, on the source's volume
//    7  `apply-intent` recorded in the object store
//    8  the policy is read again from disk; then the exchange
//    9  displaced bytes == base: the old source stays retained as the backup,
//       with a receipt; the source is verified; `applied` is recorded
//       displaced bytes != base: a concurrent writer. The files are exchanged
//       BACK so its bytes return to the source path; what that displaces must
//       be our candidate, and anything else is kept too. `apply-refused`,
//       `concurrent-source-writer`, with every recovery reference
//   10  after a quiet period the backup is looked at again: a holder of the
//       old file may still write into it (`source-changed-after-apply`)
//
// The candidate lives in `<workspace state>/recovery/<applyId>/000000/`, the
// directory layout of the recovery store, and never in the repository working
// tree: a stray file there could be committed by somebody. That requires the
// workspace state and the source to share a volume, since an exchange cannot
// cross one; when they do not, the apply refuses `apply-volume-mismatch` and
// writes nothing.
//
// Nothing here runs a git command that writes (the one git call asks whether a
// path is ignored), creates a source file, follows a symbolic link, or touches
// any path of a repository other than the one source file. Results, events and
// errors hold identifiers, digests, store references, codes and numbers only.

const EXT = OBSIDIAN_EXT_KEY
export const SOURCE_APPLY_PROTOCOL_ID = 'source-apply-exchange/v1'
export const SOURCE_APPLY_RECORD_SCHEMA = 'atelier-obsidian-source-apply/v1'
export const SOURCE_APPLY_DIRECTORY = path.join('state', 'source-apply')
export const SOURCE_APPLY_OPERATION_ID = 'atelier.source-apply/v1'
export const DEFAULT_APPLY_QUIET_PERIOD_MS = 1500
export const DEFAULT_APPLY_RECHECK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const UNIT = 0

export const SOURCE_APPLY_STEPS = Object.freeze(['apply-record-written', 'candidate-written', 'intent-recorded', 'exchanged', 'exchanged-back', 'backup-recorded', 'applied-recorded', 'settled'])

export const SOURCE_APPLY_REFUSALS = Object.freeze([
  'integration-disabled', 'workspace-not-prepared', 'unknown-edit', 'foreign-workspace', 'edit-not-open', 'unknown-scope', 'manifest-unavailable', 'published-note-unavailable',
  'repository-not-enrolled', 'source-not-in-graph', 'source-moved', 'source-missing', 'source-symlink', 'source-not-regular-file', 'source-hard-linked', 'source-outside-repository',
  'source-inside-managed-root', 'source-inside-git-directory', 'source-git-ignored', 'source-ignore-state-unknown', 'sibling-edit-unobservable', 'lease-held', 'object-conflicted',
  'stale-source', 'edit-not-applicable', 'change-outside-authored-body', 'no-source-change', 'exchange-unavailable', 'apply-volume-mismatch', 'batch-bound-reached',
  'concurrent-source-writer', 'source-changed-during-apply', 'interrupted-before-exchange', 'apply-interrupted-needs-person', 'source-changed-after-apply',
])

// Refusals that say the source or the object is contested, not that this machine or this request cannot apply.
const CONFLICT_CODES = new Set(['object-conflicted', 'stale-source', 'concurrent-source-writer', 'source-changed-during-apply', 'apply-interrupted-needs-person'])

export class SourceApplyRefusal extends Error {
  constructor(code, detail = {}) {
    super(code)
    this.name = 'SourceApplyRefusal'
    this.code = code
    this.detail = detail
  }
}
const ApplyRefusal = SourceApplyRefusal
const refuse = (code, detail) => { throw new ApplyRefusal(code, detail) }
const isTyped = (error) => error instanceof ApplyRefusal || error instanceof EditArbitrationRefusal || error instanceof PublicationRefusal || error instanceof ObsidianMaintenanceRefusal
  || error instanceof ObsidianContractRefusal || error instanceof AtelierDiagnosticError
const segment = (identifier) => identifier.replaceAll(':', '_')
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
// What a path answers when another program removed or replaced it, or a directory on the way to it, since it was last
// looked at. Between the check of a path and the intent every such answer is a typed refusal, never an exception.
const GONE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP'])
const lstatOrNull = (file) => { try { return fs.lstatSync(file, { throwIfNoEntry: false }) ?? null } catch (error) { if (GONE.has(error.code)) return null; throw error } }

// One open, never through a symbolic link, and only of a regular file. A source can be replaced by another program
// at any moment, so nothing is assumed about the file between two calls: the mode comes from the same descriptor as
// the bytes.
function readNoFollow(file, { withMode = false } = {}) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' })
    const bytes = fs.readFileSync(descriptor)
    return withMode ? { bytes, mode: stat.mode & 0o777 } : bytes
  } finally { fs.closeSync(descriptor) }
}

// The digest of the file, null when nothing is there, 'unreadable' when what is there is not a regular file: whatever
// that is, it is not bytes this module knows.
function digestOrNull(file) {
  try { return sha256Digest(readNoFollow(file)) } catch (error) {
    if (error.code === 'ENOENT') return null
    if (['ELOOP', 'EISDIR', 'EINVAL', 'ENOTDIR', 'EMLINK'].includes(error.code)) return 'unreadable'
    throw error
  }
}
const presentOf = (digest) => (digest === 'unreadable' ? null : digest)

// ---------------------------------------------------------------------------
// The decisions the oracles of test/obsidian-edits.test.mjs are sensitive to.
// Production always uses these; the tests substitute deliberately broken ones
// through createSourceApplyForOracleTests to prove that each oracle can fail.
// ---------------------------------------------------------------------------

export const SOURCE_APPLY_PRIMITIVES = Object.freeze({
  // The edited bytes are the ones preserved when the edit was observed, never the note as it is now.
  editedBytes: ({ store, edit }) => store.readObject(edit.observedDigest),
  // One decision function for both modes; automatic mode reads the installed policy from disk inside it.
  decide: decideApply,
  // Asked a second time, immediately before the exchange.
  decideAgain: true,
  // Puts the candidate at the source path and keeps whatever was there, under the candidate's name.
  commit: ({ candidatePath, sourcePath, exchange }) => exchange(candidatePath, sourcePath),
  // A concurrent writer's bytes go back to the source path.
  exchangeBack: ({ candidatePath, sourcePath, exchange }) => exchange(candidatePath, sourcePath),
  // The displaced source is moved to its recovery name, never removed.
  keepDisplaced: ({ from, to }) => { fs.renameSync(from, to); syncPrivateDirectory(path.dirname(to)) },
  // Whether git ignores the path: true, false, or null when git cannot say.
  isGitIgnored({ repositoryRoot, relative, env = process.env }) {
    const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('GIT_')))
    const result = spawnSync('git', ['-C', repositoryRoot, 'check-ignore', '-q', '--', relative], { env: { ...clean, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'ignore', timeout: 8000 })
    return result.status === 0 ? true : result.status === 1 ? false : null
  },
})

// Observation of an edit whose base source is no longer the source: a conflict, decided without the lens.
const STALE_OBSERVER = createEditObserverForOracleTests({
  preserve({ store, edit, baseSourceBytes }) {
    let edited = null
    try { edited = store.readObject(edit.observedDigest) } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'recovery-object-corrupt') throw error }
    return edited === null ? { edited: null } : { edited, publishedRef: undefined, baseRef: store.retainObject(baseSourceBytes).ref }
  },
  classify: () => ({ kind: 'refusal', code: 'stale-base', detail: {} }),
})

// ---------------------------------------------------------------------------
// Where the source is
// ---------------------------------------------------------------------------

// The absolute path of the one file an apply may write, or a typed refusal. Every directory on the way is a real
// directory and the leaf is a regular file with a single name; nothing is created and nothing is followed.
function locateSource({ project, repoId, relative, managedRoots, isGitIgnored, env }) {
  const repo = (project.repos ?? []).find((item) => item.name === repoId && !item.external && typeof item.path === 'string')
  if (!repo) refuse('repository-not-enrolled')
  const parts = typeof relative === 'string' ? relative.split('/') : []
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..') || path.isAbsolute(relative) || relative.includes('\\')) refuse('source-outside-repository')
  if (parts[0] === '.git') refuse('source-inside-git-directory')
  let repositoryRoot
  try { repositoryRoot = fs.realpathSync.native(repo.path) } catch { refuse('repository-not-enrolled', { cause: 'root-unreadable' }) }
  let current = repositoryRoot
  parts.forEach((part, index) => {
    current = path.join(current, part)
    const stat = lstatOrNull(current)
    if (stat === null) refuse('source-missing')
    if (stat.isSymbolicLink()) refuse('source-symlink')
    if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) refuse(index < parts.length - 1 ? 'source-missing' : 'source-not-regular-file')
    // Another name for the same file would keep the old bytes after an exchange, silently.
    if (index === parts.length - 1 && stat.nlink > 1) refuse('source-hard-linked')
  })
  let real
  try { real = fs.realpathSync.native(current) } catch { refuse('source-missing') }
  if (!inside(repositoryRoot, real) || real === repositoryRoot) refuse('source-outside-repository')
  for (const managedRoot of managedRoots) {
    let managed
    try { managed = fs.realpathSync.native(managedRoot) } catch { continue }
    if (inside(managed, real)) refuse('source-inside-managed-root')
  }
  const ignored = isGitIgnored({ repositoryRoot, relative, env })
  if (ignored === true) refuse('source-git-ignored')
  if (ignored !== false) refuse('source-ignore-state-unknown')
  return { absolute: real, repositoryRoot }
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

export function createSourceApplyForOracleTests(primitives = SOURCE_APPLY_PRIMITIVES) {
  const rules = { ...SOURCE_APPLY_PRIMITIVES, ...primitives }

  // `loadProject`, `dataRoot`, `env`, `platform` and `clock` are what the engine and the command are given.
  // `crash(step)` is the crash seam; `beforeExchange()` runs after the intent is durable and before the policy is
  // read again, so a test can land a writer or a revocation exactly there; `leasePid` lets a test hold a lease as a
  // process that is gone; `extraManagedRoots` adds managed roots to the ones the workspace has.
  return function createSourceApply(context = {}) {
    const {
      loadProject, dataRoot, env = process.env, platform = process.platform, clock = () => new Date(), eligibility = DEFAULT_ELIGIBILITY,
      quietPeriodMs = DEFAULT_APPLY_QUIET_PERIOD_MS, recheckWindowMs = DEFAULT_APPLY_RECHECK_WINDOW_MS, exchangeOptions = {},
      crash = () => {}, beforeExchange = async () => {}, leasePid, extraManagedRoots = [],
    } = context
    if (typeof loadProject !== 'function') throw new TypeError('source apply needs loadProject')
    const seams = { ...createProductionSeams(), ...(context.seams ?? {}) }
    const exchange = (from, to) => exchangeFiles(from, to, exchangeOptions)

    // -- the workspace ------------------------------------------------------

    function openWorkspace() {
      const project = loadProject()
      const enablement = readObsidianEnablement(project)
      if (enablement.state !== 'enabled') refuse('integration-disabled', { reason: enablement.reason })
      const pointer = readLocalPointer(project)
      if (pointer === null) refuse('workspace-not-prepared')
      const requested = workspaceStateRoot(resolveDataRoot({ dataRoot, pointer, project, env, platform }), pointer.workspaceId)
      let workspaceRoot
      try { workspaceRoot = fs.realpathSync(requested) } catch (error) { if (GONE.has(error.code)) refuse('workspace-not-prepared'); throw error }
      const { workspaceId } = pointer
      const repositoryRoots = protectedRoots(project)
      const machine = readMachineSettings({ workspaceRoot, workspaceId })
      if (machine === null) refuse('workspace-not-prepared')
      const stores = new Map()
      const workspace = {
        project, enablement, workspaceRoot, workspaceId, repositoryRoots, machine,
        stateStore: createMaintenanceStateStore({ workspaceRoot, workspaceId }),
        objects: openObjectStore({ stateRoot: workspaceRoot, workspaceId, repositoryRoots, clock }),
        storeOf(scopeId) {
          if (!stores.has(scopeId)) stores.set(scopeId, seams.createRecoveryStore({ workspaceRoot, workspaceId, scopeId, repositoryRoots }))
          return stores.get(scopeId)
        },
        recordsDir: () => ensureContainedPrivateDirectory({ workspaceRoot, directory: path.join(workspaceRoot, SOURCE_APPLY_DIRECTORY), label: 'source apply records' }),
      }
      return workspace
    }

    // The canonical graph as it is now, and the corpus profile of this machine. Built once per call.
    function currentCorpus(workspace) {
      workspace.corpus ??= {
        graph: seams.buildGraph({ project: workspace.project, eligibility }),
        profile: seams.profileFor({ project: workspace.project, workspaceId: workspace.workspaceId, audienceAllow: workspace.machine.audienceAllow }),
      }
      return workspace.corpus
    }

    // The immutable manifest of one generation of one view. The current one when it is that generation; otherwise
    // the stored file, whose name carries the generation and the head of its digest.
    function manifestOf(workspace, scopeId, generationId) {
      const store = workspace.storeOf(scopeId)
      const current = store.readCurrentManifest()
      if (current?.generationId === generationId) return current
      const directory = path.join(workspace.workspaceRoot, 'state', 'manifests', segment(scopeId))
      let names = []
      try { names = fs.readdirSync(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const name of names.filter((item) => item.startsWith(`${segment(generationId)}--`) && item.endsWith('.json')).sort()) {
        let bytes
        try { bytes = readFileBytes(path.join(directory, name)) } catch (error) { if (GONE.has(error.code)) continue; throw error }
        if (name !== `${segment(generationId)}--${sha256Digest(bytes).slice(7, 19)}.json`) continue
        const manifest = JSON.parse(bytes.toString('utf8'))
        if (manifest.generationId === generationId && manifest.scopeId === scopeId) return manifest
      }
      return null
    }

    // The note exactly as it was published, which the lens needs to tell generated bytes from authored ones. The
    // publisher keeps no copy of a note it created, so the note is prepared again from the sources as they are now
    // and used only when it has the digest the manifest recorded; a retained object of that digest serves as well.
    function publishedNoteOf(workspace, { scope, manifest, noteEntry }) {
      const store = workspace.storeOf(scope.scopeId)
      try { return store.readObject(noteEntry.noteDigest) } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'recovery-object-corrupt') throw error }
      workspace.prepared ??= new Map()
      if (!workspace.prepared.has(scope.scopeId)) {
        let files = []
        try {
          const { graph, profile } = currentCorpus(workspace)
          const snapshot = seams.captureSnapshot({ project: workspace.project, graph, workspaceId: workspace.workspaceId, index: new Map(), configDigest: manifest.ext?.[EXT]?.configDigest ?? `sha256:${'0'.repeat(64)}`, capturedAt: isoTime(clock) })
          files = seams.prepareView({ snapshot, profile, scope, persistentPathRegistry: workspace.stateStore.readPathRegistry(), priorManifest: manifest, existingSettings: null, clock, vaultRootBytes: Buffer.byteLength(store.vaultRoot, 'utf8') }).files
        } catch (error) { if (!isTyped(error) && !GONE.has(error?.code)) throw error }
        workspace.prepared.set(scope.scopeId, files)
      }
      const file = workspace.prepared.get(scope.scopeId).find((item) => item.path === noteEntry.path && item.digest === noteEntry.noteDigest)
      return file ? file.bytes : null
    }

    // Everything about one pending edit that does not need the lease.
    function resolveEdit(workspace, edit) {
      const { repoId, nodeId } = edit.identity
      const scope = workspace.enablement.scopes.find((item) => item.scopeId === edit.scopeId)
      if (!scope) refuse('unknown-scope')
      const manifest = manifestOf(workspace, edit.scopeId, edit.generationId)
      const noteEntry = manifest?.notes.find((note) => note.repoId === repoId && note.nodeId === nodeId && note.path === edit.path)
      if (!noteEntry) refuse('manifest-unavailable')
      const recorded = noteEntry.ext?.[EXT]?.source
      const baseSourceDigest = recorded?.rawDigest
      if (typeof baseSourceDigest !== 'string') refuse('manifest-unavailable')
      return { scope, manifest, noteEntry, recorded, baseSourceDigest, idempotencyKey: editIdempotencyKey({ workspaceId: workspace.workspaceId, repoId, nodeId, baseSourceDigest, observedDigest: edit.observedDigest }) }
    }

    // Runs the lens for one pending edit against `sourceBytes` and records the observation. The live note is never read.
    function observe(workspace, edit, resolved, sourceBytes, sourceFile = null) {
      const store = workspace.storeOf(edit.scopeId)
      // The object store of the view, with the edited bytes supplied by the rule under test.
      const reading = { ...store, readObject: (digest) => (digest === edit.observedDigest ? rules.editedBytes({ store, edit, workspace }) : store.readObject(digest)) }
      let observed
      if (sha256Digest(sourceBytes) !== resolved.baseSourceDigest) {
        // The source moved on. The lens has nothing to say about it, and the note as it was published cannot be
        // prepared again from a source that changed, so the conflict is recorded without either. The source as it
        // is now is retained beside the edit.
        observed = STALE_OBSERVER({ edit, manifest: resolved.manifest, publishedNoteBytes: Buffer.alloc(0), baseSourceBytes: sourceBytes, store: reading })
        delete observed.operation.ext[EXT].publishedNoteRef
      } else {
        const publishedNoteBytes = publishedNoteOf(workspace, resolved)
        // Preparing the note reads the source again: a source that changed since it was read here is a stale source.
        if (publishedNoteBytes === null && sourceFile !== null && digestOrNull(sourceFile) !== sha256Digest(sourceBytes)) refuse('stale-source', { cause: 'changed-while-reading' })
        if (publishedNoteBytes === null) refuse('published-note-unavailable')
        observed = observeEdit({ edit, manifest: resolved.manifest, publishedNoteBytes, baseSourceBytes: sourceBytes, store: reading })
      }
      workspace.objects.observe(observed.operation, { presentSourceDigest: sha256Digest(sourceBytes) })
      return observed
    }

    // -- results ------------------------------------------------------------

    const resultOf = (edit, status, code, extra = {}) => ({
      status, code, editId: edit?.editId ?? null, repoId: edit?.identity.repoId ?? null, nodeId: edit?.identity.nodeId ?? null, ...extra,
    })
    const refusalResult = (edit, error, extra = {}) => resultOf(edit, CONFLICT_CODES.has(error.code) ? 'conflict' : 'refused', error.code, { ...extra, ...(error.detail && Object.keys(error.detail).length > 0 ? { detail: error.detail } : {}) })
    const replayOf = (edit, outcome, code) => resultOf(edit, 'applied', code, {
      replayed: true, idempotencyKey: outcome.idempotencyKey, oldSourceDigest: outcome.oldSourceDigest, newSourceDigest: outcome.newSourceDigest, actor: outcome.actor, policy: outcome.policy,
      applyId: outcome.applyId, backupRef: outcome.backupRef,
    })

    // -- apply records: what was begun, written before anything else ---------

    const recordFile = (workspace, applyId, suffix = '') => path.join(workspace.recordsDir(), `${segment(applyId)}${suffix}.json`)
    function readJson(file) { try { return JSON.parse(readRegularTextNoFollow(file)) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
    function settleRecord(workspace, applyId, outcome) {
      try { publishPrivateFile(recordFile(workspace, applyId, '.settled'), canonicalJson({ schema: SOURCE_APPLY_RECORD_SCHEMA, applyId, ...outcome, settledAt: isoTime(clock) })) } catch (error) { if (error.code !== 'EEXIST') throw error }
    }
    function listRecords(workspace) {
      let names = []
      try { names = fs.readdirSync(path.join(workspace.workspaceRoot, SOURCE_APPLY_DIRECTORY)).sort() } catch (error) { if (error.code !== 'ENOENT') throw error }
      const settled = new Set(names.filter((name) => name.endsWith('.settled.json')).map((name) => name.slice(0, -'.settled.json'.length)))
      return names.filter((name) => name.endsWith('.json') && !name.endsWith('.settled.json') && !name.startsWith('.')).map((name) => {
        const record = readJson(path.join(workspace.workspaceRoot, SOURCE_APPLY_DIRECTORY, name))
        return record?.schema === SOURCE_APPLY_RECORD_SCHEMA && isIdentifier(record.applyId) ? { record, settled: settled.has(name.slice(0, -'.json'.length)) } : null
      }).filter(Boolean)
    }

    // The displaced source stays where the exchange left it, under its recovery name, with a receipt that binds the
    // digest it had. A closed journal of this protocol makes the maintenance engine look at it again on later ticks.
    function keepBackup(workspace, record, { from, digestAtMove }) {
      const store = workspace.storeOf(record.scopeId)
      let target = store.displacedPath(record.applyId, UNIT)
      for (let index = 1; lstatOrNull(target) !== null; index += 1) target = store.displacedPath(record.applyId, UNIT, `displaced-${index}.bin`)
      rules.keepDisplaced({ from, to: target })
      const recorded = recordDisplaced({ store, journalId: record.applyId, unit: UNIT, notePath: null, displacedPath: target, baseDigest: record.baseSourceDigest, at: isoTime(clock), digestAtMove })
      try {
        createJournal(store, { journalId: record.applyId, protocolId: SOURCE_APPLY_PROTOCOL_ID, expectedGeneration: record.generationId, targetGeneration: record.generationId, clock, detail: { kind: 'source-apply' } }).close()
      } catch (error) { if (error.code !== 'EEXIST') throw error }
      return recorded.displacedRef
    }

    // Removes the file at the candidate path only when it is our candidate; anything else is kept, with a receipt.
    function retireCandidate(workspace, record) {
      const store = workspace.storeOf(record.scopeId)
      const result = retireStagedFile({ store, journalId: record.applyId, unit: UNIT, stagedPath: store.exchangeCandidatePath(record.applyId, UNIT), candidateDigest: record.newSourceDigest })
      return result.capturedPaths.map((capturedPath) => recordDisplaced({ store, journalId: record.applyId, unit: UNIT, notePath: null, displacedPath: capturedPath, baseDigest: record.baseSourceDigest, at: isoTime(clock) }).displacedRef)
    }

    // -- settling an apply whose outcome is unknown, from digests only -------

    // Caller holds the lease of the object. Returns the result that was decided, or null when nothing is known yet.
    function settleInterrupted(workspace, lease, record, state) {
      const store = workspace.storeOf(record.scopeId)
      const known = state.applyOutcomes.findLast((outcome) => outcome.applyId === record.applyId)
      const intent = state.intent?.applyId === record.applyId ? state.intent : null
      const candidatePath = store.exchangeCandidatePath(record.applyId, UNIT)
      const finish = (outcome) => { settleRecord(workspace, record.applyId, outcome); return outcome }
      if (known) {
        const refs = retireCandidate(workspace, record)
        return finish({ status: known.status, code: known.code, recoveryRefs: refs })
      }
      if (intent === null) {
        // No intent is durable, so the exchange was never called: whatever is at the candidate path was never a source.
        const refs = retireCandidate(workspace, record)
        return finish({ status: 'refused', code: 'interrupted-before-exchange', recoveryRefs: refs })
      }
      let sourceDigest = null
      try {
        const located = locateSource({ project: workspace.project, repoId: record.repoId, relative: record.sourcePath, managedRoots: [workspace.workspaceRoot, ...extraManagedRoots], isGitIgnored: rules.isGitIgnored, env })
        sourceDigest = digestOrNull(located.absolute)
      } catch (error) { if (!(error instanceof ApplyRefusal)) throw error }
      const refused = (code, disposition, recoveryRefs = []) => {
        workspace.objects.recordRefused(lease, { idempotencyKey: record.idempotencyKey, code, presentSourceDigest: presentOf(sourceDigest), disposition, applyId: record.applyId, policy: intent.policy, ...(recoveryRefs.length > 0 ? { recoveryRefs } : {}) })
        return finish({ status: CONFLICT_CODES.has(code) ? 'conflict' : 'refused', code, recoveryRefs })
      }
      const applied = (backupRef) => {
        workspace.objects.recordApplied(lease, { idempotencyKey: record.idempotencyKey, oldSourceDigest: record.baseSourceDigest, newSourceDigest: record.newSourceDigest, actor: intent.actor, policy: intent.policy, applyId: record.applyId, backupRef })
        return finish({ status: 'applied', code: 'applied-after-restart', backupRef })
      }
      const atCandidate = classifyCandidateFile({ file: lstatOrNull(candidatePath)?.isFile() ? candidatePath : null, candidateDigest: record.newSourceDigest })
      if (atCandidate === 'generated-candidate') return refused('interrupted-before-exchange', 'retained', retireCandidate(workspace, record))
      if (atCandidate === 'displaced-bytes') {
        // The exchange happened and the move to the recovery name did not.
        const digestAtMove = digestOrNull(candidatePath)
        const backupRef = keepBackup(workspace, record, { from: candidatePath, digestAtMove })
        return digestAtMove === record.baseSourceDigest && sourceDigest === record.newSourceDigest ? applied(backupRef) : refused('apply-interrupted-needs-person', 'conflicted', [backupRef])
      }
      const receipt = store.listReceipts(record.applyId).find((item) => item.role === 'displaced' && item.unit === UNIT)
      const displaced = store.displacedPath(record.applyId, UNIT)
      if (receipt || lstatOrNull(displaced) !== null) {
        const backupRef = receipt?.displacedRef ?? recordDisplaced({ store, journalId: record.applyId, unit: UNIT, notePath: null, displacedPath: displaced, baseDigest: record.baseSourceDigest, at: isoTime(clock) }).displacedRef
        const digestAtMove = receipt?.digestAtMove ?? digestOrNull(displaced)
        return digestAtMove === record.baseSourceDigest && sourceDigest === record.newSourceDigest ? applied(backupRef) : refused('apply-interrupted-needs-person', 'conflicted', [backupRef])
      }
      const refs = retireCandidate(workspace, record)
      return sourceDigest === record.baseSourceDigest ? refused('interrupted-before-exchange', 'retained', refs) : refused('apply-interrupted-needs-person', 'conflicted', refs)
    }

    // -- one apply ------------------------------------------------------------

    async function applyOne(workspace, request) {
      const pending = workspace.stateStore.readPendingEdits()
      const edit = pending.edits.find((item) => item.editId === request.editId)
      if (!edit) return resultOf(null, 'refused', 'unknown-edit', { editId: typeof request.editId === 'string' ? request.editId.slice(0, 64) : null })
      let lease = null
      let crashed = false
      const seam = (step, detail) => { try { crash(step, detail) } catch (error) { crashed = true; throw error } }
      try {
        if (edit.identity.workspaceId !== workspace.workspaceId) refuse('foreign-workspace')
        const identity = { repoId: edit.identity.repoId, nodeId: edit.identity.nodeId }

        // Whether this machine may see the object is asked first, of the canonical graph as it is now, before the
        // manifest, the record of the object or the source path is looked at. An object that is withheld and one that
        // is absent get this one answer, with nothing read and nothing recorded, so no later answer (a moved or
        // deleted source, an earlier apply, a missing manifest) can tell a caller which of the two it is.
        const { graph, profile } = currentCorpus(workspace)
        const decideWith = (editClass, attempts) => rules.decide({ request, workspace: { workspaceRoot: workspace.workspaceRoot, workspaceId: workspace.workspaceId }, graph, profile, object: identity, editClass, attempts })
        const visibility = decideWith('body-replacement', [])
        if (!visibility.allowed && visibility.code === 'object-not-visible') refuse('object-not-visible')

        const resolved = resolveEdit(workspace, edit)
        const key = resolved.idempotencyKey

        // A repeated request, or a retry after a lost reply, is answered from the record and writes nothing.
        const before = workspace.objects.stateOf(identity)
        const replay = (state) => {
          const entry = state.operations.find((item) => item.idempotencyKey === key)
          if (entry?.state === 'applied') return replayOf(edit, state.applyOutcomes.findLast((outcome) => outcome.status === 'applied' && outcome.idempotencyKey === key), 'already-applied')
          if (entry?.state === 'superseded' && entry.reason === 'already-applied') {
            const by = state.applyOutcomes.findLast((outcome) => outcome.status === 'applied' && outcome.idempotencyKey === entry.by)
            if (by) return replayOf(edit, by, 'already-applied-by-equal-edit')
          }
          return null
        }
        if (before.intent === null && replay(before)) return replay(before)
        if (!OPEN_EDIT_STATES.includes(edit.state) && before.intent === null) refuse('edit-not-open', { state: edit.state })
        const attemptsIn = (state) => state.applyOutcomes.filter((outcome) => outcome.status === 'refused' && outcome.idempotencyKey === key && outcome.policy?.mode === 'automatic').map((outcome) => ({ policyDigest: outcome.policy.policyDigest }))

        // The source, now. A visible object is in the graph; the first check stands for a decision that says otherwise.
        const node = graph.nodes.find((item) => item.repo === identity.repoId && item.id === identity.nodeId)
        if (!node) refuse('source-not-in-graph')
        if (node.path !== resolved.recorded.path) refuse('source-moved')
        // A retry budget that the record says is spent is known before anything is read: it appends nothing at all.
        const early = decideWith('body-replacement', attemptsIn(before))
        if (!early.allowed && early.code === 'retry-budget-exhausted') refuse(early.code, early.detail)
        const vaultRoots = workspace.enablement.scopes.map((scope) => workspace.storeOf(scope.scopeId).vaultRoot)
        const located = locateSource({ project: workspace.project, repoId: identity.repoId, relative: node.path, managedRoots: [workspace.workspaceRoot, ...vaultRoots, ...extraManagedRoots], isGitIgnored: rules.isGitIgnored, env })
        let source
        try { source = readNoFollow(located.absolute, { withMode: true }) } catch (error) { refuse(error.code === 'ENOENT' ? 'source-missing' : error.code === 'ELOOP' ? 'source-symlink' : 'source-not-regular-file') }
        const { bytes: sourceBytes, mode: sourceMode } = source
        const sourceDigest = sha256Digest(sourceBytes)

        // This edit and every other open edit of the object are observed before anything is decided, so a divergent
        // edit made in another view makes the object conflicted before any source is written.
        const observed = observe(workspace, edit, resolved, sourceBytes, located.absolute)
        for (const sibling of pending.edits.filter((item) => item.editId !== edit.editId && OPEN_EDIT_STATES.includes(item.state) && item.identity.repoId === identity.repoId && item.identity.nodeId === identity.nodeId)) {
          try { observe(workspace, sibling, resolveEdit(workspace, sibling), sourceBytes) } catch (error) {
            if (!(error instanceof ApplyRefusal)) throw error
            refuse('sibling-edit-unobservable', { cause: error.code })
          }
        }

        const acquired = await workspace.objects.acquireLease(identity, leasePid === undefined ? {} : { pid: leasePid })
        if (!acquired.acquired) refuse('lease-held', { reason: acquired.reason, needsPerson: acquired.needsPerson })
        lease = acquired.lease
        let state = acquired.object

        // An earlier apply of this object whose outcome is unknown is settled first, from what is on disk.
        if (state.intent !== null) {
          const interrupted = listRecords(workspace).find((item) => item.record.applyId === state.intent.applyId)?.record
          if (!interrupted) refuse('apply-interrupted-needs-person', { cause: 'apply-record-missing' })
          settleInterrupted(workspace, lease, interrupted, state)
          state = workspace.objects.stateOf(identity)
          if (replay(state)) return replay(state)
        }

        const attempts = attemptsIn(state)
        const decideNow = () => decideWith(observed.operation.kind, attempts)
        let decision = null
        // Recorded under the lease. A manual request that would only repeat the last recorded refusal records nothing
        // more; an automatic one is counted every time, and its count is bounded by the retry budget.
        const recordRefusal = (code, { disposition = 'retained', presentSourceDigest = sourceDigest, applyId, recoveryRefs = [] } = {}) => {
          const last = state.applyOutcomes.findLast((outcome) => outcome.idempotencyKey === key)
          const repeated = request.mode === 'manual' && last?.status === 'refused' && last.code === code && last.presentSourceDigest === presentSourceDigest && applyId === undefined
          const entry = state.operations.find((item) => item.idempotencyKey === key)
          if (repeated || !entry || !['pending', 'conflicted'].includes(entry.state)) return
          workspace.objects.recordRefused(lease, { idempotencyKey: key, code, presentSourceDigest, disposition, applyId, policy: decision?.allowed ? decision.policy : undefined, ...(recoveryRefs.length > 0 ? { recoveryRefs } : {}) })
        }
        const refuseRecorded = (code, options = {}, detail = {}) => { recordRefusal(code, options); refuse(code, detail) }

        decision = decideNow()
        if (!decision.allowed && decision.code === 'retry-budget-exhausted') refuse(decision.code, decision.detail)

        const entry = state.operations.find((item) => item.idempotencyKey === key)
        if (sourceDigest !== resolved.baseSourceDigest) refuseRecorded('stale-source', { disposition: 'conflicted' })
        if (state.state === 'conflicted' || entry?.state === 'conflicted') refuseRecorded('object-conflicted', { disposition: 'conflicted' }, { reason: entry?.reason ?? null })
        if (observed.outcome.kind !== 'body-replacement' || entry?.state !== 'pending') refuseRecorded('edit-not-applicable', {}, { cause: observed.outcome.code ?? entry?.state ?? null })
        const { newSourceBytes, newSourceDigest, changedRanges } = observed.outcome
        const bodyStart = readMarkdownLens(sourceBytes).body.start
        if (changedRanges.some((range) => range.start < bodyStart || range.newStart < bodyStart) || !newSourceBytes.subarray(0, bodyStart).equals(sourceBytes.subarray(0, bodyStart)) || newSourceDigest !== entry.newSourceDigest) {
          refuseRecorded('change-outside-authored-body', { disposition: 'refused' })
        }
        if (changedRanges.length === 0 || newSourceDigest === sourceDigest) refuseRecorded('no-source-change', { disposition: 'refused' })
        if (!decision.allowed) refuseRecorded(decision.code, {}, decision.detail)

        // The candidate's directory, on the volume of the source, with an exchange that works there.
        const store = workspace.storeOf(edit.scopeId)
        const recoveryRoot = store.resolve('recovery')
        const volumeOf = (directory, code) => { try { return fs.statSync(directory).dev } catch (error) { if (GONE.has(error.code)) refuse(code, { cause: 'changed-while-applying' }); throw error } }
        if (volumeOf(recoveryRoot, 'workspace-not-prepared') !== volumeOf(path.dirname(located.absolute), 'source-missing')) refuseRecorded('apply-volume-mismatch')
        const probe = probeExchange({ directory: store.exchangeProbeDir(), ...exchangeOptions })
        if (!probe.supported) refuseRecorded('exchange-unavailable', {}, { cause: probe.code })

        // Write-ahead: the apply record, then the candidate, then the intent.
        const applyId = newJournalId(clock)
        const record = {
          schema: SOURCE_APPLY_RECORD_SCHEMA, applyId, workspaceId: workspace.workspaceId, repoId: identity.repoId, nodeId: identity.nodeId, editId: edit.editId, scopeId: edit.scopeId, generationId: edit.generationId,
          idempotencyKey: key, sourcePath: node.path, baseSourceDigest: sourceDigest, newSourceDigest, mode: request.mode, actor: decision.actor, policy: decision.policy, at: isoTime(clock),
        }
        publishPrivateFile(recordFile(workspace, applyId), canonicalJson(record))
        seam('apply-record-written', { applyId })
        const unitDir = store.unitDir(applyId, UNIT)
        const candidatePath = store.exchangeCandidatePath(applyId, UNIT)
        const descriptor = openRegularFileNoFollow(candidatePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, sourceMode)
        try { fs.writeFileSync(descriptor, newSourceBytes); fs.fchmodSync(descriptor, sourceMode); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
        syncPrivateDirectory(unitDir)
        if (digestOrNull(candidatePath) !== newSourceDigest) throw new Error('the candidate read back differs from the bytes written')
        seam('candidate-written', { applyId })

        workspace.objects.recordIntent(lease, { idempotencyKey: key, expectedSourceDigest: sourceDigest, newSourceDigest, actor: decision.actor, policy: decision.policy, applyId })
        seam('intent-recorded', { applyId })
        const abandon = (code, options = {}, detail = {}) => {
          const refs = [...retireCandidate(workspace, record), ...(options.recoveryRefs ?? [])]
          workspace.objects.recordRefused(lease, { idempotencyKey: key, code, presentSourceDigest: options.presentSourceDigest ?? null, disposition: options.disposition ?? 'retained', applyId, policy: decision.policy, ...(refs.length > 0 ? { recoveryRefs: refs } : {}) })
          settleRecord(workspace, applyId, { status: CONFLICT_CODES.has(code) ? 'conflict' : 'refused', code, recoveryRefs: refs })
          return refuse(code, { ...detail, applyId, ...(refs.length > 0 ? { recoveryRefs: refs } : {}) })
        }

        await beforeExchange({ applyId, editId: edit.editId, mode: request.mode })
        // Revoked, paused or replaced since it was decided: nothing is written.
        if (rules.decideAgain) { const again = decideNow(); if (!again.allowed) abandon(again.code, {}, again.detail) }

        try { rules.commit({ candidatePath, sourcePath: located.absolute, exchange }) } catch (error) {
          if (!isTyped(error) && error?.name !== 'ExchangeRefusal') throw error
          abandon('exchange-unavailable', { presentSourceDigest: presentOf(digestOrNull(located.absolute)) }, { cause: error.code })
        }
        seam('exchanged', { applyId })

        // What the exchange displaced is the truth about what the source was at that instant.
        const displacedDigest = digestOrNull(candidatePath)
        if (displacedDigest === sourceDigest) {
          syncPrivateDirectory(path.dirname(located.absolute))
          const backupRef = keepBackup(workspace, record, { from: candidatePath, digestAtMove: displacedDigest })
          seam('backup-recorded', { applyId })
          const written = digestOrNull(located.absolute)
          if (written !== newSourceDigest) {
            // Somebody wrote the source again already. The old source and the candidate are both retained.
            const kept = store.retainObject(newSourceBytes).ref
            workspace.objects.recordRefused(lease, { idempotencyKey: key, code: 'source-changed-during-apply', presentSourceDigest: presentOf(written), disposition: 'conflicted', applyId, policy: decision.policy, recoveryRefs: [backupRef, kept] })
            settleRecord(workspace, applyId, { status: 'conflict', code: 'source-changed-during-apply', recoveryRefs: [backupRef, kept] })
            refuse('source-changed-during-apply', { applyId, recoveryRefs: [backupRef, kept] })
          }
          workspace.objects.recordApplied(lease, { idempotencyKey: key, oldSourceDigest: sourceDigest, newSourceDigest, actor: decision.actor, policy: decision.policy, applyId, backupRef })
          seam('applied-recorded', { applyId })
          settleRecord(workspace, applyId, { status: 'applied', code: 'applied', backupRef })
          seam('settled', { applyId })
          workspace.objects.releaseLease(lease)
          lease = null
          if (quietPeriodMs > 0) await sleep(quietPeriodMs)
          const lateWriters = recheckBackups(workspace, [record])
          return resultOf(edit, 'applied', lateWriters.length > 0 ? 'source-changed-after-apply' : 'applied', {
            replayed: false, idempotencyKey: key, oldSourceDigest: sourceDigest, newSourceDigest, actor: decision.actor, policy: decision.policy, applyId, backupRef,
            ...(lateWriters.length > 0 ? { lateWriters } : {}),
          })
        }

        // A writer got in between the read and the exchange. Its bytes are at the candidate path: they go back.
        // An immutable copy is kept first, so the bytes have a receipt whatever happens to the file next.
        const theirs = displacedDigest !== null && displacedDigest !== 'unreadable' ? store.retainObject(readNoFollow(candidatePath)).ref : null
        try { rules.exchangeBack({ candidatePath, sourcePath: located.absolute, exchange }) } catch (error) {
          if (error?.name !== 'ExchangeRefusal') throw error
          // The files could not be exchanged back. Nothing is guessed: what is on disk is kept and settled from digests.
          const settled = settleInterrupted(workspace, lease, record, workspace.objects.stateOf(identity))
          refuse(settled.code, { applyId, recoveryRefs: [...(settled.recoveryRefs ?? []), ...(theirs ? [theirs] : [])] })
        }
        seam('exchanged-back', { applyId })
        syncPrivateDirectory(path.dirname(located.absolute))
        return abandon('concurrent-source-writer', { disposition: 'conflicted', presentSourceDigest: presentOf(digestOrNull(located.absolute)), recoveryRefs: theirs ? [theirs] : [] })
      } catch (error) {
        if (crashed || !isTyped(error)) throw error
        return refusalResult(edit, error)
      } finally {
        // A crashed process releases nothing.
        if (lease !== null && !crashed) try { workspace.objects.releaseLease(lease) } catch { /* the next holder proves this one gone */ }
      }
    }

    // -- late writers ---------------------------------------------------------

    function recheckBackups(workspace, records) {
      const findings = []
      for (const scopeId of [...new Set(records.map((record) => record.scopeId))]) {
        const journalIds = records.filter((record) => record.scopeId === scopeId).map((record) => record.applyId)
        for (const finding of recheckDisplacedFiles({ store: workspace.storeOf(scopeId), journalIds, clock })) {
          if (finding.code !== 'late-writer-captured') continue
          const record = records.find((item) => item.applyId === finding.journalId)
          findings.push({ code: 'source-changed-after-apply', applyId: finding.journalId, editId: record.editId, repoId: record.repoId, nodeId: record.nodeId, backupRef: finding.displacedRef, digestAtMove: finding.digestAtMove, observedDigest: finding.observedDigest, objectRef: finding.objectRef })
        }
      }
      return findings
    }

    const guarded = async (run) => {
      let workspace
      try { workspace = openWorkspace() } catch (error) { if (!isTyped(error)) throw error; return { workspace: null, refusal: error } }
      return { workspace, value: await run(workspace) }
    }

    return {
      id: SOURCE_APPLY_OPERATION_ID,

      // request: { editId, mode: 'manual' | 'automatic', actor?, policyDigest? }
      async apply(request) {
        const { workspace, refusal, value } = await guarded((opened) => applyOne(opened, { ...request }))
        return workspace === null ? refusalResult(null, refusal, { editId: typeof request?.editId === 'string' ? request.editId.slice(0, 64) : null }) : value
      },

      // Several edits under one request. In automatic mode at most `maxBatchSize` of them are attempted; the rest
      // are refused `batch-bound-reached` and nothing is written for them.
      async applyBatch({ editIds, ...request }) {
        const results = []
        let bound = Infinity
        for (const editId of editIds) {
          if (results.filter((result) => result.code !== 'batch-bound-reached').length >= bound) { results.push(resultOf(null, 'refused', 'batch-bound-reached', { editId })); continue }
          const { workspace, refusal, value } = await guarded((opened) => {
            // Read again for every edit: a policy replaced in the middle of a batch bounds the rest of it.
            if (request.mode === 'automatic') bound = installedBatchBound(opened)
            return applyOne(opened, { ...request, editId })
          })
          results.push(workspace === null ? refusalResult(null, refusal, { editId }) : value)
        }
        return results
      },

      // Settles every apply that was begun and never finished. Decided from digests on disk; safe to run again.
      async recover() {
        const { workspace, refusal, value } = await guarded(async (opened) => {
          const report = []
          for (const { record, settled } of listRecords(opened)) {
            if (settled) continue
            const identity = { repoId: record.repoId, nodeId: record.nodeId }
            // Every record is settled on its own: an object whose log or store cannot be read is reported by its
            // code, left exactly as it is, and keeps no other interrupted apply waiting.
            let lease = null
            try {
              const acquired = await opened.objects.acquireLease(identity, leasePid === undefined ? {} : { pid: leasePid })
              if (!acquired.acquired) { report.push({ applyId: record.applyId, editId: record.editId, status: 'refused', code: 'lease-held' }); continue }
              lease = acquired.lease
              const outcome = settleInterrupted(opened, lease, record, acquired.object)
              report.push({ applyId: record.applyId, editId: record.editId, repoId: record.repoId, nodeId: record.nodeId, ...outcome })
            } catch (error) {
              if (!isTyped(error)) throw error
              report.push({ applyId: record.applyId, editId: record.editId, repoId: record.repoId, nodeId: record.nodeId, status: 'refused', code: error.code })
            } finally {
              if (lease !== null) try { opened.objects.releaseLease(lease) } catch (error) { if (!isTyped(error)) throw error }
            }
          }
          return report
        })
        return workspace === null ? { recovered: [], refusal: { code: refusal.code } } : { recovered: value }
      },

      // Looks again at every backup of a recent apply. A holder of the old file can write later still: repeat it.
      async recheck() {
        const { workspace, value } = await guarded((opened) => {
          const nowMs = Date.parse(isoTime(clock))
          return recheckBackups(opened, listRecords(opened).map((item) => item.record).filter((record) => nowMs - Date.parse(record.at) <= recheckWindowMs))
        })
        return workspace === null ? [] : value
      },

      // Pending and conflicted operations: identities, states and codes. No note text, title or path.
      async list() {
        const { workspace, refusal, value } = await guarded((opened) => {
          const objects = new Map(opened.objects.list().objects.filter((item) => item.repoId !== null).map((item) => [`${item.repoId}\u0000${item.nodeId}`, item]))
          return opened.stateStore.readPendingEdits().edits.filter((edit) => OPEN_EDIT_STATES.includes(edit.state)).sort((left, right) => compareText(left.observedAt, right.observedAt) || compareText(left.editId, right.editId)).map((edit) => {
            const object = objects.get(`${edit.identity.repoId}\u0000${edit.identity.nodeId}`) ?? null
            return { editId: edit.editId, repoId: edit.identity.repoId, nodeId: edit.identity.nodeId, scopeId: edit.scopeId, state: edit.state, observedAt: edit.observedAt, attempts: edit.attempts, lastCode: edit.lastResult?.code ?? null,
              object: object === null ? null : { state: object.state, code: object.code ?? null, operations: (object.operations ?? []).map(({ idempotencyKey, kind, state, reason }) => ({ idempotencyKey, kind, state, reason })) } }
          })
        })
        if (workspace === null) throw refusal
        return value
      },

      async show(editId) {
        const { workspace, refusal, value } = await guarded((opened) => {
          const edit = opened.stateStore.readPendingEdits().edits.find((item) => item.editId === editId)
          if (!edit) refuse('unknown-edit')
          const identity = { repoId: edit.identity.repoId, nodeId: edit.identity.nodeId }
          const state = opened.objects.stateOf(identity)
          let key = null
          try { key = resolveEdit(opened, edit).idempotencyKey } catch (error) { if (!(error instanceof ApplyRefusal)) throw error }
          const entry = state.operations.find((item) => item.idempotencyKey === key) ?? null
          const records = listRecords(opened).map((item) => item.record).filter((record) => record.editId === editId)
          return {
            editId, ...identity, scopeId: edit.scopeId, generationId: edit.generationId, state: edit.state, observedAt: edit.observedAt, observedDigest: edit.observedDigest, objectRef: edit.objectRef,
            object: { state: state.state, sourceDigest: state.sourceDigest, outcomeUnknown: state.intent !== null },
            operation: entry === null ? null : { idempotencyKey: entry.idempotencyKey, kind: entry.kind, state: entry.state, reason: entry.reason, baseSourceDigest: entry.baseSourceDigest, newSourceDigest: entry.newSourceDigest },
            outcomes: state.applyOutcomes.filter((outcome) => outcome.idempotencyKey === key),
            lateWriters: recheckBackups(opened, records),
          }
        })
        if (workspace === null) throw refusal
        return value
      },
    }

    // Without a readable policy there is no bound to apply here; every edit is then refused by the decision itself.
    function installedBatchBound(workspace) {
      try { return readInstalledApplyPolicy({ workspaceRoot: workspace.workspaceRoot, workspaceId: workspace.workspaceId })?.maxBatchSize ?? Infinity } catch (error) { if (!isTyped(error)) throw error; return Infinity }
    }
  }
}

export const createSourceApply = createSourceApplyForOracleTests()
