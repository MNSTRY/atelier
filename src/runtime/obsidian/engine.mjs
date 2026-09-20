import fs from 'node:fs'
import path from 'node:path'
import { AtelierDiagnosticError } from '../../project/config.mjs'
import { OBSIDIAN_EXT_KEY, ObsidianContractRefusal } from '../../projection/obsidian/contracts.mjs'
import { PROTOCOL_ID } from '../../projection/obsidian/publication/bridge-script.mjs'
import { PublicationRefusal } from '../../projection/obsidian/recovery/store.mjs'
import { canonicalJson, compareText, isoTime } from './documents.mjs'
import { readObsidianEnablement } from './enablement.mjs'
import { ObsidianMaintenanceRefusal } from './errors.mjs'
import { createMaintenanceExtensions } from './extension-points.mjs'
import {
  assertOutsideRepositories, authorizeAutomaticApply, defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, readLocalPointer,
  readMachineSettings, resolveDataRoot, workspaceStateRoot, writeMachineSettings,
} from './machine-settings.mjs'
import { configKey, listConfigFiles, listSourceFiles, listVaultNotes, readFileFacts, reconcile, sha256Digest, sourceKey, vaultKey } from './observation.mjs'
import { dispatchAutomaticApply, heldPaths, observeVaultEdits, preserveInRecoveryStore, trustedNoteBases } from './pending-edits.mjs'
import { DEFAULT_ELIGIBILITY, createProductionSeams } from './pipeline.mjs'
import { ENGINE_LOCK_DIRECTORY, acquirePrivateGenerationLock, createAbandonmentProof } from './private-lock.mjs'
import { probeHealth } from './service-client.mjs'
import { FRESHNESS_SCHEMA, LATE_WRITERS_SCHEMA, createMaintenanceStateStore } from './state-store.mjs'
import { createNullWatcherFactory } from './watchers.mjs'

// The maintenance engine. One explicit `tick()`; no timer, no process, no
// listener. Whoever owns the lifecycle calls it.
//
// A tick, in order:
//
//   1. load the project when its configuration changed; read typed enablement
//   2. look at every vault note; preserve and queue what somebody edited
//   3. when a proposal adapter is registered: it observes the open edits the
//      object store does not know yet and records what each is, in manual and
//      in automatic mode alike, writing no source; automatic mode only:
//      dispatch queued edits through the apply operation; then hand the
//      pending edits to the proposal adapter
//   4. look at displaced files again for writes that arrived late
//   5. look at sources, configuration, scopes and eligibility; decide by digest
//   6. for each invalidated view: canonical graph -> source snapshot ->
//      prepareView -> publishView, unless that would replace a held note
//   7. persist the freshness of every view
//
// From the moment a workspace is resolved until the tick ends, the tick holds
// the workspace's private engine lock, so two engines (a service and a
// foreground command, or two services) never tick one workspace together. An
// engine that finds the lock held writes nothing and reports `busy`.
//
// The engine writes private state and recovery objects. It writes into a
// vault only by calling publishView, never touches `staging/` or a journal's
// recovery directory, and never writes a source file: in manual mode nothing
// on a tick can, and in automatic mode only the registered apply operation.

export const DEFAULT_FULL_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000
export const DEFAULT_RETRY_INTERVAL_MS = 60 * 1000
export const DEFAULT_LATE_WRITER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const LATE_WRITER_EVERY_TICK_WINDOW_MS = 60 * 60 * 1000

// A refusal that means "someone else is publishing or editing here" rather
// than "this machine cannot publish".
const CONFLICT_REFUSALS = new Set(['publication-in-progress', 'generation-mismatch', 'editor-uncoordinated', 'state-mismatch'])
const EDIT_OUTCOMES = new Set(['disk-changed', 'editor-edit'])
const RETRIED_STATES = new Set(['stale', 'updating', 'publisher-conflict'])
// A file changed or went away under a tick: everything is hashed again on the next one.
const REREAD_CODES = new Set(['mixed-read', 'source-not-in-snapshot'])
const SOURCE_PREFIX = 'source\u0000'
const CONFIG_PREFIX = configKey('')

// The decisions the oracles in test/obsidian-maintenance.test.mjs are
// sensitive to. Production always uses these; the tests substitute
// deliberately broken ones through createMaintenanceEngineForOracleTests to
// prove that each oracle can fail.
export const ENGINE_PRIMITIVES = Object.freeze({
  // Edited bytes reach the recovery object store before a record is queued.
  preserve: preserveInRecoveryStore,
  // Read from disk on every call, immediately before each dispatch.
  authorize: authorizeAutomaticApply,
  // Only automatic mode ever reaches the apply operation.
  dispatchAllowed: (maintenanceMode) => maintenanceMode === 'automatic',
  // Every file is hashed, whatever its stat says, at least this often.
  isFullReconciliationDue: ({ nowMs, lastFullMs, intervalMs }) => lastFullMs === null || nowMs - lastFullMs >= intervalMs,
  // The embedded assets observed beside the walk: those the last built graph lets a view copy, and no withheld one.
  observedAssetsOf: (graph) => (graph.assets ?? []).filter((asset) => asset.eligible === true).map(({ repo, path: assetPath }) => ({ repo, path: assetPath })),
  // One engine per workspace at a time, across processes.
  acquireEngineLock: acquirePrivateGenerationLock,
  // The registered proposal adapter observes the open edits on every tick, so a structural edit is recorded as
  // proposed and routed without anybody asking apply to look at it.
  observeEdits: (proposalAdapter) => typeof proposalAdapter.observe === 'function',
  // Held notes that this prepared view would replace, create over or remove. A held note that already holds exactly
  // the bytes this view would publish is none of those: its edit reached the source, the source was prepared again,
  // and publishing changes nothing of the person's. The publisher reads the note again and settles it as already
  // current only while it still holds those bytes; the next look then finds the note at its base and closes the edit.
  // `observed` holds what `heldNoteDigest` answered for each held note immediately before this call.
  publicationConflicts({ prepared, held, bases, observed = new Map() }) {
    const candidates = new Map(prepared.files.map((file) => [file.path, file.digest]))
    return held.filter((notePath) => {
      if (candidates.has(notePath) && observed.get(notePath) === candidates.get(notePath)) return false
      return bases.has(notePath) ? candidates.get(notePath) !== bases.get(notePath).digest : candidates.has(notePath)
    })
  },
  // What a held note holds at the moment of that decision: one read of the file, now. The observation index is not
  // asked (`indexed` is its answer, for the mutation control): its entry was taken earlier in the tick, behind a stat
  // comparison, and the person may have typed since. A note that cannot be read answers null, and the hold stays.
  heldNoteDigest({ file }) {
    try { return readFileFacts(file)?.digest ?? null } catch { return null }
  },
})

const isTypedRefusal = (error) => error instanceof ObsidianMaintenanceRefusal || error instanceof AtelierDiagnosticError || error instanceof ObsidianContractRefusal || error instanceof PublicationRefusal
const digestOfJson = (value) => sha256Digest(Buffer.from(canonicalJson(value)))

function journalTime(journalId) {
  const match = /^journal-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})-/.exec(journalId)
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6], +match[7]) : null
}

// Unfinished journals always; finished ones while they are recent. A journal
// whose time cannot be read is treated as recent.
function journalsToRecheck(store, { nowMs, full, windowMs }) {
  let names
  try { names = fs.readdirSync(store.journalsRoot).sort() } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return names.filter((name) => {
    if (!fs.existsSync(path.join(store.journalsRoot, name, 'header.json'))) return false
    if (!fs.existsSync(path.join(store.journalsRoot, name, 'closed.json'))) return true
    const at = journalTime(name)
    return at === null || nowMs - at <= (full ? windowMs : Math.min(windowMs, LATE_WRITER_EVERY_TICK_WINDOW_MS))
  })
}

export function createMaintenanceEngineForOracleTests(options = {}, primitives = ENGINE_PRIMITIVES) {
  const {
    loadProject, dataRoot, adapterFactory, clock,
    watcherFactory = createNullWatcherFactory(), extensions = createMaintenanceExtensions(), eligibility = DEFAULT_ELIGIBILITY,
    fullReconciliationIntervalMs = DEFAULT_FULL_RECONCILIATION_INTERVAL_MS, retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS, lateWriterWindowMs = DEFAULT_LATE_WRITER_WINDOW_MS,
    quietPeriodMs, lstat = fs.lstatSync, randomBytes, env = process.env, platform = process.platform,
    // A service names where it answers health, so a lock it leaves behind can be proven abandoned.
    lockOwner = null, lockProbe = probeHealth,
  } = options
  if (typeof loadProject !== 'function') throw new TypeError('the engine needs loadProject')
  if (typeof clock !== 'function') throw new TypeError('the engine needs an injected clock')
  // No default: the production adapter reaches a running app, and only the owner of the lifecycle may decide that.
  if (typeof adapterFactory !== 'function') throw new TypeError('the engine needs an adapterFactory')
  const seams = { ...createProductionSeams(), ...(options.seams ?? {}) }
  const rules = { ...ENGINE_PRIMITIVES, ...primitives }

  const index = new Map()
  const hintedKeys = new Set()
  const hintedPrefixes = new Set()
  const stores = new Map()
  // One graph file cache, and one preparation cache per scope, kept for the engine's lifetime. Derived state only:
  // each is reused under a content digest or dependency key that proves the cached value equal to a fresh one, and a
  // dropped cache costs a full build or preparation, never a wrong one.
  const graphCache = seams.createGraphCache?.() ?? null
  const preparationCaches = new Map()
  const preparationCacheFor = (scopeId) => {
    if (!preparationCaches.has(scopeId)) preparationCaches.set(scopeId, seams.createPreparationCache?.() ?? null)
    return preparationCaches.get(scopeId)
  }
  let project = null
  let observedAssets = []
  let semantic = null
  let lastFullMs = null
  let forceFull = false
  let firstTick = true
  let running = false
  let watching = { signature: null, handle: null }
  let known = null // { stateStore, maintenanceMode } once a workspace has been resolved
  let heldLock = null
  const proveAbandoned = createAbandonmentProof({ probe: lockProbe })

  async function takeLock(workspaceRoot, workspaceId) {
    if (heldLock) return { acquired: true }
    const lock = await rules.acquireEngineLock({
      workspaceRoot, directory: path.join(workspaceRoot, ENGINE_LOCK_DIRECTORY), workspaceId, purpose: 'maintenance-engine', service: lockOwner, clock, proveAbandoned,
    })
    if (lock.acquired) heldLock = lock
    return lock
  }

  function dropLock() {
    const lock = heldLock
    heldLock = null
    lock?.release()
  }

  function onWatcherEvent(roots, { rootId, relative }) {
    const root = roots.find((item) => item.id === rootId)
    if (!root) return
    if (relative === null || relative === undefined) hintedPrefixes.add(root.keyPrefix)
    else hintedKeys.add(root.keyOf(relative))
  }

  function watch(roots) {
    const signature = JSON.stringify(roots.map((root) => [root.id, root.path]))
    if (watching.signature === signature) return
    stopWatching()
    watching = { signature, handle: watcherFactory({ roots: roots.map(({ id, path: rootPath, recursive }) => ({ id, path: rootPath, recursive })), onEvent: (event) => onWatcherEvent(roots, event) }) }
  }

  function stopWatching() {
    try { watching.handle?.close() } finally { watching = { signature: null, handle: null } }
  }

  function storeFor(scope, workspaceRoot, workspaceId, repositoryRoots) {
    const signature = JSON.stringify([workspaceRoot, workspaceId, repositoryRoots])
    const cached = stores.get(scope.scopeId)
    if (cached?.signature === signature) return cached.store
    const store = seams.createRecoveryStore({ workspaceRoot, workspaceId, scopeId: scope.scopeId, repositoryRoots })
    stores.set(scope.scopeId, { signature, store })
    return store
  }

  function freshnessDocument({ workspaceId, enablement, maintenanceMode, now, entries }) {
    return {
      schema: FRESHNESS_SCHEMA, workspaceId, enablement, maintenanceMode, lastTickAt: now,
      lastFullReconciliationAt: lastFullMs === null ? null : new Date(lastFullMs).toISOString(), scopes: [...entries.values()],
    }
  }

  function readPreviousFreshness(stateStore) {
    // Derived state: a document that does not validate is rebuilt, not trusted.
    try { return stateStore.readFreshness() } catch (error) { if (isTypedRefusal(error)) return null; throw error }
  }

  const blankEntry = (scopeId, now) => ({ scopeId, state: 'stale', reason: 'not-yet-published', generationId: null, preparedGenerationId: null, verified: false, heldNotes: [], changeClasses: [], retainedEdits: 0, checkedAt: now })
  const demote = (entry, state, reason, now) => ({ ...entry, state, reason, verified: false, checkedAt: now })

  // Persists "refused" or "disabled" over whatever is known, and only when a workspace already has state.
  async function persistOutcome({ enablement, state, reason, now, scopeIds = [] }) {
    if (!known) {
      let pointer = null
      try { pointer = project ? readLocalPointer(project) : null } catch { pointer = null }
      if (!pointer) return
      let root
      try { root = workspaceStateRoot(resolveDataRoot({ dataRoot, pointer, project, env, platform }), pointer.workspaceId) } catch { return }
      const stateStore = createMaintenanceStateStore({ workspaceRoot: root, workspaceId: pointer.workspaceId })
      if (!stateStore.exists()) return
      known = { stateStore: createMaintenanceStateStore({ workspaceRoot: fs.realpathSync(root), workspaceId: pointer.workspaceId }), maintenanceMode: 'manual' }
    }
    // Another engine is ticking this workspace: its state is not ours to write.
    if (!(await takeLock(known.stateStore.workspaceRoot, known.stateStore.workspaceId)).acquired) return
    const previous = readPreviousFreshness(known.stateStore)
    const entries = new Map()
    for (const entry of previous?.scopes ?? []) entries.set(entry.scopeId, demote(entry, state, reason, now))
    for (const scopeId of scopeIds) if (!entries.has(scopeId)) entries.set(scopeId, demote(blankEntry(scopeId, now), state, reason, now))
    known.stateStore.writeFreshness(freshnessDocument({ workspaceId: known.stateStore.workspaceId, enablement, maintenanceMode: known.maintenanceMode, now, entries }))
  }

  async function runTick() {
    const now = isoTime(clock)
    const nowMs = Date.parse(now)
    const full = firstTick || forceFull || rules.isFullReconciliationDue({ nowMs, lastFullMs, intervalMs: fullReconciliationIntervalMs })
    const changes = []
    // The hints collected so far belong to this tick; one that arrives while it runs belongs to the next.
    const tickKeys = new Set(hintedKeys)
    const tickPrefixes = [...hintedPrefixes]
    hintedKeys.clear()
    hintedPrefixes.clear()
    const hinted = (key) => tickKeys.has(key) || tickPrefixes.some((prefix) => key.startsWith(prefix))

    // 1. Project and enablement. The digests are seeded before the project is
    // loaded for good, so the loaded project is never older than the index.
    if (project === null) {
      project = loadProject()
      reconcile({ index, files: listConfigFiles(project), prefix: CONFIG_PREFIX, full: true, lstat })
      project = loadProject()
    } else {
      const config = reconcile({ index, files: listConfigFiles(project), prefix: CONFIG_PREFIX, full, hinted, lstat })
      if (config.changes.length > 0) {
        project = loadProject()
        reconcile({ index, files: listConfigFiles(project), prefix: CONFIG_PREFIX, full: true, lstat })
      }
    }
    const enablement = readObsidianEnablement(project)
    if (enablement.state === 'disabled') {
      stopWatching()
      await persistOutcome({ enablement: 'disabled', state: 'disabled', reason: enablement.reason, now, scopeIds: enablement.scopes.map((scope) => scope.scopeId) })
      semantic = null
      firstTick = true
      return { state: 'disabled', reason: enablement.reason, full, changes: [], scopes: [], pendingEdits: [], dispatched: [], lateWriters: [] }
    }

    // 2. Identity and machine settings, outside every repository.
    const pointer = ensureWorkspaceIdentity({ project, ...(randomBytes ? { randomBytes } : {}) })
    const { workspaceId } = pointer
    const requestedRoot = workspaceStateRoot(resolveDataRoot({ dataRoot, pointer, project, env, platform }), workspaceId)
    const repositoryRoots = protectedRoots(project)
    assertOutsideRepositories({ managedRoot: requestedRoot, repositoryRoots })
    fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 })
    const workspaceRoot = fs.realpathSync(requestedRoot)
    const lock = await takeLock(workspaceRoot, workspaceId)
    if (!lock.acquired) return { state: 'busy', reason: 'engine-lock-held', lock: { reason: lock.reason, holder: lock.holder ?? null }, changes: [], scopes: [], pendingEdits: [], dispatched: [], lateWriters: [] }
    const machine = readMachineSettings({ workspaceRoot, workspaceId })
      ?? writeMachineSettings({ workspaceRoot, workspaceId, repositoryRoots, settings: defaultMachineSettings({ workspaceId, updatedAt: now }) })
    const stateStore = createMaintenanceStateStore({ workspaceRoot, workspaceId })
    known = { stateStore, maintenanceMode: machine.maintenanceMode }
    const scopes = enablement.scopes.map((scope) => ({ scope, store: storeFor(scope, workspaceRoot, workspaceId, repositoryRoots) }))

    watch([
      ...(project.repos ?? []).filter((repo) => !repo.external && typeof repo.path === 'string').map((repo) => ({ id: `repo:${repo.name}`, path: repo.path, recursive: true, keyPrefix: sourceKey(repo.name, ''), keyOf: (relative) => sourceKey(repo.name, relative) })),
      ...scopes.map(({ scope, store }) => ({ id: `vault:${scope.scopeId}`, path: store.vaultRoot, recursive: true, keyPrefix: vaultKey(scope.scopeId, ''), keyOf: (relative) => vaultKey(scope.scopeId, relative) })),
      ...[...new Set(listConfigFiles(project).map((file) => path.dirname(file.absolute)))].filter((directory) => fs.existsSync(directory))
        .map((directory) => ({ id: `config:${directory}`, path: directory, recursive: false, keyPrefix: CONFIG_PREFIX, keyOf: (relative) => configKey(path.join(directory, relative)) })),
    ])

    // 3. Vault notes: preserve, then queue. Compared with the bytes each note
    // was generated with, not with the previous look.
    const pending = stateStore.readPendingEdits()
    let edits = pending.edits
    const basesOf = new Map()
    for (const { scope, store } of scopes) {
      const { manifest, bases } = trustedNoteBases(store)
      basesOf.set(scope.scopeId, bases)
      if (!manifest) continue
      const vault = reconcile({ index, files: listVaultNotes({ scopeId: scope.scopeId, vaultRoot: store.vaultRoot, manifest }), prefix: vaultKey(scope.scopeId, ''), full, hinted, lstat })
      const digestOf = (notePath) => index.get(vaultKey(scope.scopeId, notePath))?.digest ?? null
      const observed = observeVaultEdits({ store, workspaceId, scopeId: scope.scopeId, manifest, bases, digestOf, edits, now, preserve: rules.preserve })
      edits = observed.edits
      // A note that has gone is restored by the publisher; its disappearance is a change, once.
      if (observed.events.length > 0 || vault.changes.some((change) => change.kind === 'removed')) changes.push({ changeClass: 'vault-note', scopeId: scope.scopeId })
    }
    stateStore.writePendingEdits({ ...pending, edits })

    // Observation. The registered proposal adapter is handed a copy of the pending edits and observes the open ones
    // the object store does not know yet, a bounded number per tick: each is classified from its preserved bytes
    // against the source as it is now and recorded as what it is, in manual and in automatic mode alike, and no
    // source is written. What refused before anything was recorded is offered again on a full reconciliation only.
    const proposalAdapter = extensions.get('proposal-adapter')
    const adapterContext = () => ({ project, workspaceRoot, workspaceId, repositoryRoots, edits: structuredClone(edits), clock, env })
    let observed = null
    if (proposalAdapter !== null && rules.observeEdits(proposalAdapter)) {
      try { observed = await proposalAdapter.observe(adapterContext(), { retryRefused: full }) } catch { observed = { adapterId: proposalAdapter.id, failed: 'proposal-adapter-threw' } }
    }

    // 4. Automatic apply, through the registered operation only.
    let dispatched = []
    if (rules.dispatchAllowed(machine.maintenanceMode)) {
      const outcome = await dispatchAutomaticApply({
        edits, applyOperation: extensions.applyOperation(), now, nowMs, retryIntervalMs,
        authorize: () => rules.authorize({ workspaceRoot, workspaceId }),
      })
      edits = outcome.edits
      dispatched = outcome.dispatched
      stateStore.writePendingEdits({ ...pending, edits })
    }

    // Structural edits. The registered proposal adapter is handed the pending edits once per tick and decides by its
    // own record which of them it has not settled; it creates copy-only proposals and writes no source and no vault.
    // Without one registered nothing is handed anywhere, and an adapter that throws changes nothing else of the tick.
    let proposals = null
    if (proposalAdapter !== null) {
      try { proposals = await proposalAdapter.propose(adapterContext()) } catch { proposals = { adapterId: proposalAdapter.id, failed: 'proposal-adapter-threw' } }
    }

    // 5. Late writers. The publisher looks twice per publication; a holder can write later still.
    const lateWriters = []
    const lateDocument = stateStore.readLateWriters()
    const knownFindings = new Set(lateDocument.findings.map((item) => `${item.scopeId}\u0000${item.journalId}\u0000${item.unit}\u0000${item.observedDigest}`))
    for (const { scope, store } of scopes) {
      const journalIds = journalsToRecheck(store, { nowMs, full, windowMs: lateWriterWindowMs })
      if (journalIds.length === 0) continue
      for (const finding of seams.recheckDisplacedFiles({ store, journalIds, clock })) {
        if (finding.code !== 'late-writer-captured') continue
        const key = `${scope.scopeId}\u0000${finding.journalId}\u0000${finding.unit}\u0000${finding.observedDigest}`
        if (knownFindings.has(key)) continue
        knownFindings.add(key)
        lateWriters.push({ scopeId: scope.scopeId, journalId: finding.journalId, unit: finding.unit, notePath: finding.notePath ?? null, digestAtMove: finding.digestAtMove ?? null, observedDigest: finding.observedDigest, objectRef: finding.objectRef, detectedAt: now })
      }
    }
    if (lateWriters.length > 0) {
      const findings = [...lateDocument.findings, ...lateWriters].sort((left, right) => compareText(left.detectedAt, right.detectedAt) || compareText(left.journalId, right.journalId) || left.unit - right.unit || compareText(left.observedDigest, right.observedDigest))
      stateStore.writeLateWriters({ schema: LATE_WRITERS_SCHEMA, workspaceId, findings })
    }

    // 6. Sources, settings, scopes, eligibility.
    const sources = reconcile({ index, files: listSourceFiles(project, { assets: observedAssets }), prefix: SOURCE_PREFIX, full, hinted, lstat })
    for (const change of sources.changes) changes.push({ changeClass: change.changeClass })
    const { scopes: _declared, ...settingsWithoutScopes } = enablement.settings
    // What the configuration says apart from this integration's own member: a change to the member alone is an
    // ext-settings or a scope change, and a scope change invalidates that scope only.
    const { [OBSIDIAN_EXT_KEY]: _member, ...otherExt } = project.config.ext ?? {}
    const nextSemantic = {
      config: digestOfJson({ document: { ...project.config, ext: otherExt }, files: [...index].filter(([key]) => key.startsWith(CONFIG_PREFIX) && key !== configKey(project.configPath)).map(([key, entry]) => [key.slice(CONFIG_PREFIX.length), entry.digest]) }),
      settings: digestOfJson(settingsWithoutScopes),
      scopes: new Map(enablement.scopes.map((scope) => [scope.scopeId, digestOfJson(scope)])),
      eligibility: digestOfJson({ audienceAllow: [...machine.audienceAllow].sort(), revision: String(eligibility.revision()) }),
    }
    if (semantic) {
      if (semantic.config !== nextSemantic.config) changes.push({ changeClass: 'config' })
      if (semantic.settings !== nextSemantic.settings) changes.push({ changeClass: 'ext-settings' })
      if (semantic.eligibility !== nextSemantic.eligibility) changes.push({ changeClass: 'eligibility' })
      for (const [scopeId, digest] of nextSemantic.scopes) if (semantic.scopes.get(scopeId) !== digest) changes.push({ changeClass: 'scope', scopeId })
    }
    if (full) { lastFullMs = nowMs; forceFull = false }

    // 7. Which views are invalid.
    const previous = readPreviousFreshness(stateStore)
    const entries = new Map()
    const unseen = new Set()
    for (const { scope } of scopes) {
      const carried = previous?.scopes.find((entry) => entry.scopeId === scope.scopeId && entry.state !== 'disabled')
      if (!carried) unseen.add(scope.scopeId)
      entries.set(scope.scopeId, carried ?? blankEntry(scope.scopeId, now))
    }
    const attempt = new Map()
    const invalidate = (scopeId, changeClass) => attempt.set(scopeId, new Set([...(attempt.get(scopeId) ?? []), ...(changeClass ? [changeClass] : [])]))
    for (const { scope } of scopes) {
      const entry = entries.get(scope.scopeId)
      // A view that did not settle is tried again at the full reconciliation cadence, not on every tick.
      if (firstTick || unseen.has(scope.scopeId) || (full && RETRIED_STATES.has(entry.state))) invalidate(scope.scopeId, null)
    }
    for (const change of changes) for (const { scope } of scopes) if (change.scopeId === undefined || change.scopeId === scope.scopeId) invalidate(scope.scopeId, change.changeClass)

    // Invalidation is durable before any work: a view is not reported current while it is being rebuilt.
    for (const [scopeId, classes] of attempt) entries.set(scopeId, { ...demote(entries.get(scopeId), 'stale', 'invalidated', now), changeClasses: [...classes].sort() })
    for (const entry of previous?.scopes ?? []) if (!entries.has(entry.scopeId)) entries.set(entry.scopeId, demote(entry, 'disabled', 'scope-not-configured', now))
    const persist = () => stateStore.writeFreshness(freshnessDocument({ workspaceId, enablement: 'enabled', maintenanceMode: machine.maintenanceMode, now, entries }))
    persist()

    // 8. Rebuild and publish.
    if (attempt.size > 0) {
      let built = null
      try {
        const graph = seams.buildGraph({ project, eligibility, cache: graphCache })
        // The assets this graph lets a view copy are observed from now on, and hashed now so the snapshot pins
        // what observation saw. A withheld asset is not observed: its bytes can change no view.
        const formerAssetKeys = new Set(observedAssets.map((asset) => sourceKey(asset.repo, asset.path)))
        observedAssets = rules.observedAssetsOf(graph)
        const assetKeys = new Set(observedAssets.map((asset) => sourceKey(asset.repo, asset.path)))
        const settled = reconcile({ index, files: listSourceFiles(project, { assets: observedAssets }), prefix: SOURCE_PREFIX, full: false, lstat })
        // An asset newly observed, or one no longer embedded, is the list changing. Anything else that moved since this tick looked at the sources moved while the graph was being read.
        if (settled.changes.some((change) => !(change.kind === 'added' && assetKeys.has(change.key)) && !(change.kind === 'removed' && formerAssetKeys.has(change.key) && !assetKeys.has(change.key)))) throw new ObsidianMaintenanceRefusal('mixed-read', 'a source changed while the canonical graph was being built')
        const configDigest = digestOfJson([...index].filter(([key]) => key.startsWith(CONFIG_PREFIX)).map(([key, entry]) => [path.basename(key.slice(CONFIG_PREFIX.length)), entry.digest]))
        built = {
          snapshot: seams.captureSnapshot({ project, graph, workspaceId, index, configDigest, capturedAt: now }),
          profile: seams.profileFor({ project, workspaceId, audienceAllow: machine.audienceAllow }),
        }
      } catch (error) {
        if (!isTypedRefusal(error)) throw error
        for (const scopeId of attempt.keys()) entries.set(scopeId, demote(entries.get(scopeId), 'stale', error.code, now))
        if (REREAD_CODES.has(error.code)) forceFull = true
      }
      for (const { scope, store } of built ? scopes.filter((item) => attempt.has(item.scope.scopeId)) : []) {
        const { scopeId } = scope
        const entry = entries.get(scopeId)
        const settle = (state, reason, extra = {}) => entries.set(scopeId, { ...entry, ...extra, state, reason, verified: extra.verified === true, checkedAt: now })
        try {
          const prepared = seams.prepareView({
            snapshot: built.snapshot, profile: built.profile, scope, persistentPathRegistry: stateStore.readPathRegistry(), priorManifest: store.readCurrentManifest(),
            existingSettings: null, clock, vaultRootBytes: Buffer.byteLength(store.vaultRoot, 'utf8'), cache: preparationCacheFor(scopeId),
          })
          stateStore.writePathRegistry(prepared.persistentPathRegistry)
          const preparedGenerationId = prepared.manifest.generationId
          const trusted = () => store.readCurrent()
          const held = heldPaths(edits, scopeId)
          const observed = new Map(held.map((notePath) => [notePath, rules.heldNoteDigest({ file: path.join(store.vaultRoot, notePath), indexed: index.get(vaultKey(scopeId, notePath))?.digest ?? null })]))
          const conflicts = rules.publicationConflicts({ prepared, held, bases: basesOf.get(scopeId) ?? new Map(), observed })
          if (conflicts.length > 0) {
            // Not even attempted: the prepared view would replace a note somebody edited.
            settle('held-for-your-edit', 'publication-withheld-for-your-edit', { generationId: trusted()?.generationId ?? null, preparedGenerationId, heldNotes: held })
            continue
          }
          settle('updating', 'publishing', { generationId: trusted()?.generationId ?? null, preparedGenerationId, heldNotes: held })
          persist()
          const result = await seams.publishView({
            preparedView: prepared, protocolId: PROTOCOL_ID, expectedGeneration: trusted()?.generationId ?? null, recoveryStore: store, adapter: adapterFactory({ store, scope }), clock,
            ...(quietPeriodMs === undefined ? {} : { quietPeriodMs }),
          })
          const pointerNow = trusted()
          const common = { generationId: pointerNow?.generationId ?? null, preparedGenerationId, retainedEdits: pointerNow?.retained?.length ?? 0 }
          if (result.state === 'refused') {
            settle(CONFLICT_REFUSALS.has(result.refusal.code) ? 'publisher-conflict' : 'stale', result.refusal.code, { ...common, heldNotes: held })
          } else if (result.state === 'updating') {
            const blocking = result.notes.filter((note) => note.blocking)
            const byEdit = blocking.length > 0 && blocking.every((note) => EDIT_OUTCOMES.has(note.outcome))
            settle(byEdit ? 'held-for-your-edit' : 'publisher-conflict', blocking[0]?.outcome ?? 'publication-incomplete', { ...common, heldNotes: [...new Set([...held, ...blocking.filter((note) => EDIT_OUTCOMES.has(note.outcome)).map((note) => note.path)])].sort(compareText) })
          } else {
            // Read back: every note of the committed generation, by digest.
            const { manifest, bases } = trustedNoteBases(store)
            basesOf.set(scopeId, bases)
            reconcile({ index, files: listVaultNotes({ scopeId, vaultRoot: store.vaultRoot, manifest }), prefix: vaultKey(scopeId, ''), full: true, lstat })
            const differing = [...bases].filter(([notePath, base]) => index.get(vaultKey(scopeId, notePath))?.digest !== base.digest).map(([notePath]) => notePath).sort(compareText)
            const editedUnderPublisher = result.notes.some((note) => note.outcome === 'edit-kept' || note.changedAfterPublication === true)
            if (held.length > 0) settle('held-for-your-edit', 'edit-pending', { ...common, heldNotes: held })
            else if (differing.some((notePath) => (index.get(vaultKey(scopeId, notePath))?.digest ?? null) === null)) settle('stale', 'vault-note-missing', common)
            // Somebody wrote during the publication. The next tick preserves and queues it.
            else if (differing.length > 0 || editedUnderPublisher) settle('updating', 'read-back-differs', common)
            else if (common.generationId !== preparedGenerationId) settle('stale', 'committed-generation-differs', common)
            else settle('current', result.alreadyCommitted ? 'verified-by-read-back' : 'published-and-verified', { ...common, heldNotes: [], verified: true })
          }
        } catch (error) {
          if (!isTypedRefusal(error)) { settle('stale', 'publisher-error'); persist(); throw error }
          settle('stale', error.code)
          if (REREAD_CODES.has(error.code)) forceFull = true
        }
      }
    }
    persist()
    semantic = nextSemantic
    firstTick = false
    return {
      state: 'ticked', full, workspaceId, maintenanceMode: machine.maintenanceMode,
      changes: changes.map((change) => ({ ...change })), scopes: [...entries.values()].sort((left, right) => compareText(left.scopeId, right.scopeId)),
      pendingEdits: edits.filter((edit) => edit.closedAt === null).map(({ editId, scopeId, path: notePath, state }) => ({ editId, scopeId, path: notePath, state })),
      dispatched, lateWriters, ...(observed === null ? {} : { observed }), ...(proposals === null ? {} : { proposals }),
    }
  }

  return {
    extensions,
    async tick() {
      if (running) return { state: 'busy' }
      running = true
      try {
        return await runTick()
      } catch (error) {
        if (!isTypedRefusal(error)) throw error
        // Fail closed: nothing is published under a refusal, and every known view says why.
        try { await persistOutcome({ enablement: 'refused', state: 'stale', reason: error.code, now: isoTime(clock) }) } catch { /* the refusal itself is still reported */ }
        project = null
        semantic = null
        firstTick = true
        return { state: 'refused', refusal: { code: error.code, message: error.message, detail: error.detail ?? {} }, changes: [], scopes: [], pendingEdits: [], dispatched: [], lateWriters: [] }
      } finally {
        try { dropLock() } finally { running = false }
      }
    },
    stop() { stopWatching() },
  }
}

// Production entry point: the production primitives, always.
export function createMaintenanceEngine(options = {}) {
  return createMaintenanceEngineForOracleTests(options, ENGINE_PRIMITIVES)
}
