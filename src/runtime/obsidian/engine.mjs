import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { AtelierDiagnosticError } from '../../project/config.mjs'
import { OBSIDIAN_EXT_KEY, ObsidianContractRefusal, manifestLayoutVersion } from '../../projection/obsidian/contracts.mjs'
import { createCooperativeBudget } from '../../projection/obsidian/materialize/prepare-view.mjs'
import { PERSONAL_VALIDATION_PENDING, personalWorkspaceBindingOf, personalWorkspaceInputs, validatePersonalWorkspace } from '../../projection/obsidian/personal-workspace.mjs'
import { PROTOCOL_ID } from '../../projection/obsidian/publication/bridge-script.mjs'
import { PublicationRefusal, allocatedFolderState, hasCommittedGeneration, readVaultAllocation } from '../../projection/obsidian/recovery/store.mjs'
import { canonicalJson, compareText, isoTime } from './documents.mjs'
import { readObsidianEnablement } from './enablement.mjs'
import { ObsidianMaintenanceRefusal, refuse } from './errors.mjs'
import { createMaintenanceExtensions } from './extension-points.mjs'
import {
  assertOutsideRepositories, authorizeAutomaticApply, defaultMachineSettings, ensureWorkspaceIdentity, protectedRoots, readLocalPointer,
  readMachineSettings, resolveDataRoot, workspaceStateRoot, writeMachineSettings,
} from './machine-settings.mjs'
import { configKey, listConfigFiles, listSourceFiles, listVaultNotes, readFileFacts, reconcile, sha256Digest, sourceKey, vaultKey } from './observation.mjs'
import { dispatchAutomaticApply, heldPaths, layoutHeldPaths, observeVaultEdits, preserveInRecoveryStore, trustedNoteBases } from './pending-edits.mjs'
import { createProductionSeams, eligibilityFor } from './pipeline.mjs'
import { PLUGIN_FILES_WAIT_FOR_APP } from './plugin-presence.mjs'
import { ENGINE_LOCK_DIRECTORY, acquirePrivateGenerationLock, createAbandonmentProof } from './private-lock.mjs'
import { probeHealth } from './service-client.mjs'
import { FRESHNESS_SCHEMA, LATE_WRITERS_SCHEMA, createMaintenanceStateStore } from './state-store.mjs'
import { ensureVaultAllocation, projectDisplayName } from './vault-location.mjs'
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
// A view is prepared and published once more, whatever its state, on the
// next tick after `requestPreparation(scopeId)`: a one-shot request per view
// the project declared at the last tick (at most 64 wait before the first),
// which the service makes for a tick requested for that view over its
// listener (`open` requests its own). A view whose last publication did not
// settle (stale, updating, or refused as a publisher conflict) is also tried
// again without a request: at the full reconciliation; as soon as the app
// looks different from when it was last tried (`observeApp`, when given: an
// app that quit, started, or opened or closed a vault); and otherwise after a
// delay that doubles per attempt from `publicationRetryMs` up to the full
// reconciliation interval.
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
export const DEFAULT_PUBLICATION_RETRY_MS = 30 * 1000
export const DEFAULT_LATE_WRITER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const LATE_WRITER_EVERY_TICK_WINDOW_MS = 60 * 60 * 1000

// A refusal that means "someone else is publishing or editing here" rather
// than "this machine cannot publish".
const CONFLICT_REFUSALS = new Set(['publication-in-progress', 'generation-mismatch', 'editor-uncoordinated', 'vault-open-in-several-windows', 'state-mismatch'])
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
  // A view whose last attempt did not settle, between full reconciliations: again once a delay has passed that doubles
  // per attempt in a row, from `retryMs` up to `maxMs`, and at once when the app looks different from when it was last
  // tried. `appState()` answers what it looks like now, or null when that is not known.
  isRetryDue({ nowMs, unsettled, appState, retryMs, maxMs }) {
    if (unsettled === undefined) return false
    if (nowMs - unsettled.lastAttemptMs >= Math.min(maxMs, retryMs * 2 ** Math.min(unsettled.attempts - 1, 20))) return true
    const now = appState()
    return now !== null && now !== unsettled.appState
  },
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
// The code a view is refused with when its own vault cannot be placed: a typed refusal's, or `vault-location-unusable`
// for a file-system error there (a file in the way, no permission, a read-only volume). Null for anything else, which
// is a fault of the engine and stops the tick.
const viewRefusalCode = (error) => (isTypedRefusal(error) ? error.code : typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code) ? 'vault-location-unusable' : null)
const digestOfJson = (value) => sha256Digest(Buffer.from(canonicalJson(value)))
// The configuration a tick observes. A project bound to a personal workspace adds the person's authored manifest and
// overlay and its generation's record: a change to any of them is a configuration change, so every view is prepared
// again, asks the composition, and is refused at once when the generation no longer holds.
const configFilesOf = (project) => [...listConfigFiles(project), ...personalWorkspaceInputs(project).map((absolute) => ({ key: configKey(absolute), changeClass: 'config', absolute }))]

// An editor adapter that `build` makes, synchronously or not, the first time the publisher calls it; a refusal of
// `build` is thrown from that call, and `refusal()` answers it afterwards.
function builtOnFirstUse(build) {
  let adapter = null
  let refused = null
  const built = () => (adapter ??= Promise.resolve().then(build).catch((error) => { refused = error; throw error }))
  return {
    refusal: () => refused,
    probe: async (input) => (await built()).probe(input),
    inspect: async (payload) => (await built()).inspect(payload),
    collect: async (payload) => (await built()).collect(payload),
    publish: async (payload) => (await built()).publish(payload),
  }
}
// The adapter a publication gets when the factory refused the app: it coordinates with nothing and never calls it.
function uncoordinatedAdapter(refusal) {
  const never = async () => { throw refusal }
  return { probe: async () => ({ state: 'uncoordinated', reason: `${refusal.code}: the installed Obsidian does not qualify, and nothing is published through it` }), inspect: never, collect: never, publish: never }
}
// Views a tick may be asked to prepare again, at most, before it runs.
const MAX_PREPARATION_REQUESTS = 64

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
    // Which notes may enter a view: what the machine settings decide at each tick (eligibilityFor), unless a test fixes it.
    watcherFactory = createNullWatcherFactory(), extensions = createMaintenanceExtensions(), eligibility: fixedEligibility = null,
    fullReconciliationIntervalMs = DEFAULT_FULL_RECONCILIATION_INTERVAL_MS, retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS, lateWriterWindowMs = DEFAULT_LATE_WRITER_WINDOW_MS,
    publicationRetryMs = DEFAULT_PUBLICATION_RETRY_MS, observeApp = null,
    // Reads the app's own vault list without asking the app (readAppVaultListForAllocation): { ok: true, vaults } with
    // the map id -> { path }, or { ok: false, code }. A folder for a new vault is never allocated inside a vault it
    // lists, nor under a name a vault it lists already has, nor while the list cannot be read.
    readAppVaultList = null,
    // Reads the app's own vault list from its file, without asking the app (unheld-evidence.mjs): { unlisted: true } only
    // when no list names a view's vault, a folder above it or one inside it. A view never published into its allocated
    // folder is then published even while an app runs that cannot be coordinated with, creating files only (the
    // publisher's `direct-unheld` path). An engine given no reader never takes that path.
    readUnheldEvidence = null,
    quietPeriodMs, lstat = fs.lstatSync, randomBytes, env = process.env, platform = process.platform,
    // A service names where it answers health, so a lock it leaves behind can be proven abandoned.
    lockOwner = null, lockProbe = probeHealth,
  } = options
  if (typeof loadProject !== 'function') throw new TypeError('the engine needs loadProject')
  if (typeof clock !== 'function') throw new TypeError('the engine needs an injected clock')
  // No default: the production adapter reaches a running app, and only the owner of the lifecycle may decide that.
  if (typeof adapterFactory !== 'function') throw new TypeError('the engine needs an adapterFactory')
  const production = createProductionSeams()
  const seams = { ...production, ...(options.seams ?? {}) }
  // A caller that replaced prepareView and left the cooperative preparation as it ships prepares views its own way: its
  // seam is used, synchronously, whether it handed in that one member or the production seams with that member replaced.
  if (seams.prepareView !== production.prepareView && seams.prepareViewCooperatively === production.prepareViewCooperatively) seams.prepareViewCooperatively = null
  const rules = { ...ENGINE_PRIMITIVES, ...primitives }
  // Optional local qualification telemetry. It has no authority to change a
  // tick's result, and records elapsed boundaries rather than a budget claim.
  const phaseTime = () => performance.timeOrigin + performance.now()
  const reportPhase = (phase, startedMs) => {
    try { seams.onPhase?.({ phase, startedMs, endedMs: phaseTime() }) } catch { /* telemetry never changes custody */ }
  }
  const measured = (phase, operation) => {
    const startedMs = phaseTime()
    try { return operation() } finally { reportPhase(phase, startedMs) }
  }

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
  // Views somebody asked to have prepared and published once more, at the next tick.
  const preparationRequests = new Set()
  // The views the project declared at the last tick; null before the first.
  let declaredScopes = null
  // Views whose last attempt did not settle, by scope: { attempts in a row, lastAttemptMs, appState then }. Kept in
  // memory only: a new engine attempts every view on its first tick.
  const unsettled = new Map()
  // Views kept current although publishing their committed generation again (a drifted plugin file) needed an app
  // that did not qualify: tried again on the same schedule as an unsettled view, and forgotten once one settles.
  const waitingForApp = new Map()
  const proveAbandoned = createAbandonmentProof({ probe: lockProbe })

  // Whether a view kept from publication by an app that does not qualify may still be published on the publisher's
  // `direct-unheld` path: never committed, its vault the folder allocated for it, and the app's list naming no folder
  // on the way. The publisher checks every condition again, under its locks.
  async function unheldMayApply(store, pointer) {
    if (typeof readUnheldEvidence !== 'function' || pointer !== null || store.vaultOrigin !== 'allocated') return false
    try { return (await readUnheldEvidence({ vaultRoot: store.vaultRoot }))?.unlisted === true } catch { return false }
  }

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
    // A view's vault can be allocated, made again or moved while the engine runs: the store follows its record. A
    // store is used again only while its allocated folder is still the one the record names; otherwise it is dropped,
    // and the store made in its place refuses, typed (vault-allocation-replaced, say), so a folder replaced while the
    // service runs, or a link put where it was, is never published into.
    const signature = JSON.stringify([workspaceRoot, workspaceId, repositoryRoots, readVaultAllocation({ workspaceRoot, workspaceId, scopeId: scope.scopeId })])
    const cached = stores.get(scope.scopeId)
    // A vault root that is gone (a folder under the data root the person removed, say) is looked for again too, so the
    // store made in its place says why rather than failing on the folder that is not there.
    if (cached?.signature === signature && fs.lstatSync(cached.store.vaultRoot, { throwIfNoEntry: false }) !== undefined) {
      try { cached.store.checkAllocatedVault?.(); return cached.store } catch (error) { if (!isTypedRefusal(error)) throw error }
    }
    stores.delete(scope.scopeId)
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
    // A request that arrives while this tick runs belongs to the next one.
    const requested = new Set(preparationRequests)
    preparationRequests.clear()
    // What the app looked like, asked at most once per tick and only when a decision needs it.
    let appState
    const appNow = () => {
      if (appState === undefined) { try { appState = typeof observeApp === 'function' ? observeApp() ?? null : null } catch { appState = null } }
      return appState
    }
    // An adapter built on a tick somebody asked for asks the app again instead of reusing an answer from before it changed.
    if (requested.size > 0) try { adapterFactory.forget?.() } catch { /* a factory that remembers nothing */ }
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
    // A loader may answer a promise (one that composes a personal workspace off
    // the event loop). A project bound to a personal workspace is loaded once:
    // what a generation holds is fixed, and an input that changed after the load
    // changes the validity key every build is checked against.
    if (project === null) {
      project = await loadProject()
      reconcile({ index, files: configFilesOf(project), prefix: CONFIG_PREFIX, full: true, lstat })
      if (personalWorkspaceBindingOf(project) === null) project = await loadProject()
    } else {
      const config = reconcile({ index, files: configFilesOf(project), prefix: CONFIG_PREFIX, full, hinted, lstat })
      if (config.changes.length > 0) {
        project = await loadProject()
        reconcile({ index, files: configFilesOf(project), prefix: CONFIG_PREFIX, full: true, lstat })
      }
    }
    const enablement = readObsidianEnablement(project)
    if (enablement.state === 'disabled') {
      stopWatching()
      declaredScopes = new Set()
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
    const eligibility = fixedEligibility ?? eligibilityFor({ machine, project })
    const stateStore = createMaintenanceStateStore({ workspaceRoot, workspaceId })
    known = { stateStore, maintenanceMode: machine.maintenanceMode }
    // Each view's vault: allocated now where this workspace decided its vaults live, when it has none and was never
    // published under the data root (vault-location.mjs). A view whose folder cannot be allocated is not prepared on
    // this tick, and its freshness says why; the other views go on.
    const allocationRefusals = new Map()
    if (machine.decisions.location !== null) {
      // The app's list, read once per tick and only when a view is about to be allocated. An engine given no reader
      // coordinates with no app, and knows no list. A list that cannot be read allocates nothing: the view says why,
      // and its folder is allocated at a later tick, once the list reads.
      let list = null
      const appList = async () => {
        if (typeof readAppVaultList !== 'function') return { ok: true, vaults: null }
        if (list === null) {
          let answer
          try { answer = await readAppVaultList() } catch { answer = null }
          list = answer?.ok === true ? { ok: true, vaults: answer.vaults ?? {} } : { ok: false, code: typeof answer?.code === 'string' ? answer.code : 'obsidian-settings-unreadable' }
        }
        return list
      }
      // The folders allocated to the views; a record that cannot be read refuses only its own view, below.
      const allocatedPaths = enablement.scopes.map((scope) => { try { return readVaultAllocation({ workspaceRoot, workspaceId, scopeId: scope.scopeId })?.path } catch { return undefined } }).filter((item) => typeof item === 'string')
      for (const scope of enablement.scopes) {
        try {
          let vaults = null
          // The list is read where a folder is about to be made: a first allocation, or an allocated folder that has gone.
          const record = readVaultAllocation({ workspaceRoot, workspaceId, scopeId: scope.scopeId })
          if (record === null ? !hasCommittedGeneration({ workspaceRoot, scopeId: scope.scopeId }) : allocatedFolderState(record) === 'missing') {
            const known = await appList()
            if (!known.ok) refuse('app-vault-list-unreadable', 'Obsidian\'s vault list could not be read, so no folder is allocated for this view yet; it is tried again at the next tick', { cause: known.code })
            vaults = known.vaults
          }
          ensureVaultAllocation({ workspaceRoot, workspaceId, scopeId: scope.scopeId, location: machine.decisions.location, projectName: projectDisplayName(project), repositoryRoots, vaults, allocatedPaths, now })
        } catch (error) {
          const code = viewRefusalCode(error)
          if (code === null) throw error
          allocationRefusals.set(scope.scopeId, code)
        }
      }
    }
    // Each view's store, on its own: one whose vault cannot be placed (a record naming a folder inside a repository,
    // say) is refused alone, and the other views go on.
    const scopes = []
    for (const scope of enablement.scopes) {
      if (allocationRefusals.has(scope.scopeId)) continue
      try { scopes.push({ scope, store: storeFor(scope, workspaceRoot, workspaceId, repositoryRoots) }) } catch (error) {
        const code = viewRefusalCode(error)
        if (code === null) throw error
        allocationRefusals.set(scope.scopeId, code)
      }
    }

    watch([
      ...(project.repos ?? []).filter((repo) => !repo.external && typeof repo.path === 'string').map((repo) => ({ id: `repo:${repo.name}`, path: repo.path, recursive: true, keyPrefix: sourceKey(repo.name, ''), keyOf: (relative) => sourceKey(repo.name, relative) })),
      ...scopes.map(({ scope, store }) => ({ id: `vault:${scope.scopeId}`, path: store.vaultRoot, recursive: true, keyPrefix: vaultKey(scope.scopeId, ''), keyOf: (relative) => vaultKey(scope.scopeId, relative) })),
      ...[...new Set(configFilesOf(project).map((file) => path.dirname(file.absolute)))].filter((directory) => fs.existsSync(directory))
        .map((directory) => ({ id: `config:${directory}`, path: directory, recursive: false, keyPrefix: CONFIG_PREFIX, keyOf: (relative) => configKey(path.join(directory, relative)) })),
    ])

    // 3. Vault notes: preserve, then queue. Compared with the bytes each note
    // was generated with, not with the previous look.
    const pending = stateStore.readPendingEdits()
    let edits = pending.edits
    const basesOf = new Map()
    const earlierLayout = new Set()
    for (const { scope, store } of scopes) {
      const { manifest, bases } = trustedNoteBases(store)
      basesOf.set(scope.scopeId, bases)
      if (!manifest) continue
      if (manifestLayoutVersion(manifest) === 1) earlierLayout.add(scope.scopeId)
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
    // source is written. What refused before anything was recorded is offered again on a full reconciliation only;
    // for a personal workspace, also on the tick after one whose graph was pending, which offers every earlier
    // refusal again.
    const proposalAdapter = extensions.get('proposal-adapter')
    // A personal workspace is never composed on this event loop by the adapter: its builds defer, as the engine's do.
    const adapterContext = () => ({ project, workspaceRoot, workspaceId, repositoryRoots, edits: structuredClone(edits), clock, env, deferPersonalValidation: true })
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
    const sources = measured('source-observation', () => reconcile({ index, files: listSourceFiles(project, { assets: observedAssets }), prefix: SOURCE_PREFIX, full, hinted, lstat }))
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
    declaredScopes = new Set(enablement.scopes.map((scope) => scope.scopeId))
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
    // The notes that keep a view in the vault layout they were published in (see layoutHeldPaths).
    const layoutHeldOf = (scopeId) => layoutHeldPaths(edits, scopeId, now)
    for (const { scope } of scopes) {
      const entry = entries.get(scope.scopeId)
      // A view that did not settle is tried again, not on every tick: see the head of this file.
      const retried = (RETRIED_STATES.has(entry.state)
        && (full || rules.isRetryDue({ nowMs, unsettled: unsettled.get(scope.scopeId), appState: appNow, retryMs: publicationRetryMs, maxMs: fullReconciliationIntervalMs })))
        || (waitingForApp.has(scope.scopeId) && rules.isRetryDue({ nowMs, unsettled: waitingForApp.get(scope.scopeId), appState: appNow, retryMs: publicationRetryMs, maxMs: fullReconciliationIntervalMs }))
      if (firstTick || unseen.has(scope.scopeId) || requested.has(scope.scopeId) || retried) invalidate(scope.scopeId, null)
      // A settled view still in the earlier vault layout is laid out again at the first tick where no note holds it.
      if (earlierLayout.has(scope.scopeId) && entry.state === 'current' && layoutHeldOf(scope.scopeId).length === 0) invalidate(scope.scopeId, null)
    }
    for (const change of changes) for (const { scope } of scopes) if (change.scopeId === undefined || change.scopeId === scope.scopeId) invalidate(scope.scopeId, change.changeClass)
    // A bound personal workspace is composed again, off the event loop, at every full reconciliation, whatever else is
    // being prepared: a cause outside its validity key can stop a generation holding without a file this engine
    // observes. Its views are prepared again only when the composition refuses, or confirms another key.
    let personalRefusal = null
    if (full && personalWorkspaceBindingOf(project) !== null) {
      const verdict = await validatePersonalWorkspace(project)
      if (verdict.ok !== true) personalRefusal = verdict.code
      if (verdict.ok !== true || verdict.changed) for (const { scope } of scopes) invalidate(scope.scopeId, null)
    }

    // Invalidation is durable before any work: a view is not reported current while it is being rebuilt.
    for (const [scopeId, classes] of attempt) entries.set(scopeId, { ...demote(entries.get(scopeId), 'stale', 'invalidated', now), changeClasses: [...classes].sort() })
    for (const [scopeId, code] of allocationRefusals) {
      entries.set(scopeId, demote(previous?.scopes.find((entry) => entry.scopeId === scopeId && entry.state !== 'disabled') ?? blankEntry(scopeId, now), 'stale', code, now))
    }
    for (const entry of previous?.scopes ?? []) if (!entries.has(entry.scopeId)) entries.set(entry.scopeId, demote(entry, 'disabled', 'scope-not-configured', now))
    const persist = () => stateStore.writeFreshness(freshnessDocument({ workspaceId, enablement: 'enabled', maintenanceMode: machine.maintenanceMode, now, entries }))
    persist()

    // 8. Rebuild and publish.
    if (attempt.size > 0) {
      // Cooperative preparation/publication can outlive the settings that
      // selected this tick. Reuse the existing configuration/personal-input
      // observation keys, machine settings and eligibility revision as the
      // fence; do not invent another selection authority.
      const bindings = configFilesOf(project).map(file => ({ ...file, digest: index.get(file.key)?.digest ?? null }))
      const machineDigest = digestOfJson(machine)
      const eligibilityRevision = String(eligibility.revision())
      const assertBindings = () => {
        if (bindings.some(file => (readFileFacts(file.absolute)?.digest ?? null) !== file.digest)
          || digestOfJson(readMachineSettings({ workspaceRoot, workspaceId })) !== machineDigest
          || String(eligibility.revision()) !== eligibilityRevision) {
          forceFull = true
          refuse('mixed-read', 'source selection or eligibility changed while a view was being prepared or published')
        }
      }
      let built = null
      try {
        if (personalRefusal !== null) refuse(personalRefusal, 'the personal workspace refused this generation; nothing is prepared from it', { source: 'personal-workspace' })
        // A personal workspace whose validity key is not confirmed yet is composed off the event loop, then built again.
        const build = () => seams.buildGraph({ project, eligibility, cache: graphCache, index, deferPersonalValidation: true })
        let graph
        try { graph = build() } catch (error) {
          if (error?.code !== PERSONAL_VALIDATION_PENDING) throw error
          const verdict = await validatePersonalWorkspace(project)
          if (verdict?.ok !== true) refuse(verdict?.code ?? 'personal-binding-unrecognized', 'the personal workspace refused this generation; nothing is prepared from it', { source: 'personal-workspace' })
          try { graph = build() } catch (again) {
            if (again?.code !== PERSONAL_VALIDATION_PENDING) throw again
            refuse('personal-graph-unconfirmed', 'the graph built for the personal workspace is not the one its composition built; nothing is prepared from it', { source: 'personal-workspace' })
          }
        }
        // The assets this graph lets a view copy are observed from now on, and hashed now so the snapshot pins
        // what observation saw. A withheld asset is not observed: its bytes can change no view.
        const formerAssetKeys = new Set(observedAssets.map((asset) => sourceKey(asset.repo, asset.path)))
        observedAssets = rules.observedAssetsOf(graph)
        const assetKeys = new Set(observedAssets.map((asset) => sourceKey(asset.repo, asset.path)))
        const settled = measured('graph-source-recheck', () => reconcile({ index, files: listSourceFiles(project, { assets: observedAssets }), prefix: SOURCE_PREFIX, full: false, lstat }))
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
        // The personal workspace refused the bound generation: the project is loaded again at the next tick, so a
        // loader that now binds another generation is followed.
        if (error.detail?.source === 'personal-workspace') project = null
      }
      for (const { scope, store } of built ? scopes.filter((item) => attempt.has(item.scope.scopeId)) : []) {
        const { scopeId } = scope
        const entry = entries.get(scopeId)
        // What this attempt found worth naming: notes and rules (see "Notes that were laid out anyway" in docs/obsidian-contract.md).
        let diagnostics = []
        const settle = (state, reason, extra = {}) => {
          const { diagnostics: _earlier, ...rest } = { ...entry, ...extra, state, reason, verified: extra.verified === true, checkedAt: now }
          entries.set(scopeId, diagnostics.length > 0 ? { ...rest, diagnostics } : rest)
        }
        try {
          const held = heldPaths(edits, scopeId)
          const prepared = await (seams.prepareViewCooperatively ?? seams.prepareView)({
            snapshot: built.snapshot, profile: built.profile, scope, persistentPathRegistry: stateStore.readPathRegistry(), priorManifest: store.readCurrentManifest(),
            existingSettings: null, clock, vaultRootBytes: Buffer.byteLength(store.vaultRoot, 'utf8'), cache: preparationCacheFor(scopeId),
            heldNotePaths: held, layoutHeldNotePaths: layoutHeldOf(scopeId), viewScopeIds: scopes.map((item) => item.scope.scopeId),
            scheduling: { guard: assertBindings },
          })
          assertBindings()
          stateStore.writePathRegistry(prepared.persistentPathRegistry)
          diagnostics = (prepared.manifest.ext?.[OBSIDIAN_EXT_KEY]?.diagnostics ?? []).slice(0, 100)
          const preparedGenerationId = prepared.manifest.generationId
          const trusted = () => store.readCurrent()
          const observed = new Map(held.map((notePath) => [notePath, rules.heldNoteDigest({ file: path.join(store.vaultRoot, notePath), indexed: index.get(vaultKey(scopeId, notePath))?.digest ?? null })]))
          const conflicts = rules.publicationConflicts({ prepared, held, bases: basesOf.get(scopeId) ?? new Map(), observed })
          if (conflicts.length > 0) {
            // Not even attempted: the prepared view would replace a note somebody edited.
            settle('held-for-your-edit', 'publication-withheld-for-your-edit', { generationId: trusted()?.generationId ?? null, preparedGenerationId, heldNotes: held })
            continue
          }
          settle('updating', 'publishing', { generationId: trusted()?.generationId ?? null, preparedGenerationId, heldNotes: held })
          persist()
          // A generation that is already the committed one needs no app: the publisher settles it after its own restart
          // recovery, before it would probe. Its adapter is then built only if the publisher asks for one, so an app
          // that cannot be qualified never makes a current view stale. Any other publication builds the adapter first,
          // and an app that does not qualify keeps the publisher from being reached at all.
          const lazy = trusted()?.generationId === preparedGenerationId ? builtOnFirstUse(() => adapterFactory({ store, scope })) : null
          // A view never published into its allocated folder is not kept from its first publication by an app that
          // does not qualify, while that app's list shows no entry for the folder: the publisher is reached with an
          // adapter that coordinates with nothing, and may take its `direct-unheld` path. Any other outcome is the
          // factory's refusal, as before.
          let heldBackBy = null
          let adapter = lazy
          if (adapter === null) {
            try { adapter = await adapterFactory({ store, scope }) } catch (error) {
              if (!isTypedRefusal(error) || !(await unheldMayApply(store, trusted()))) throw error
              heldBackBy = error
              adapter = uncoordinatedAdapter(error)
            }
          }
          let result
          try {
            const beforeCommit = async () => {
              const startedMs = phaseTime()
              try {
                const budget = createCooperativeBudget({ guard: assertBindings })
                budget.check()
                const selected = new Set(prepared.manifest.notes.map(note => note.nodeId))
                const attachments = new Set(prepared.manifest.attachments.map(item => {
                  const source = item.ext?.[OBSIDIAN_EXT_KEY]
                  return source?.kind === 'embedded-asset' ? sourceKey(source.repoId, source.assetPath) : null
                }))
                const nodes = built.snapshot.graph.nodes.filter(node => selected.has(node.id))
                const assets = (built.snapshot.graph.assets ?? []).filter(asset => attachments.has(sourceKey(asset.repo, asset.path)))
                const pins = new Map(built.snapshot.document.repositories.flatMap(repo => repo.files.map(file => [sourceKey(repo.repoId, file.path), file])))
                for (const source of [...nodes, ...assets]) {
                  await budget.checkpoint('commit-source-recheck')
                  const bytes = built.snapshot.readSource(source.repo, source.path)
                  const pin = pins.get(sourceKey(source.repo, source.path))
                  if (!pin || !Buffer.isBuffer(bytes) || bytes.length !== pin.byteLength || sha256Digest(bytes) !== pin.rawDigest) refuse('mixed-read', 'a selected source changed during publication; its generation is not committed')
                }
                budget.check()
              } finally { reportPhase('commit-source-recheck', startedMs) }
            }
            result = await seams.publishView({
              preparedView: prepared, protocolId: PROTOCOL_ID, expectedGeneration: trusted()?.generationId ?? null, recoveryStore: store, adapter, clock,
              ...(quietPeriodMs === undefined ? {} : { quietPeriodMs }),
              ...(typeof readUnheldEvidence === 'function' ? { unheldEvidence: readUnheldEvidence, platform } : {}),
              scheduling: { guard: assertBindings }, beforeCommit,
            })
            // Stopped before its commit for want of an app that coordinates: the app's refusal is what the person has to
            // act on, and `open` answers it before it would add the vault to the app.
            if (heldBackBy !== null && (result.state === 'refused' || (result.state === 'updating' && result.notes.some((note) => note.blocking && note.outcome === 'editor-uncoordinated')))) throw heldBackBy
          } catch (error) {
            // The publisher asked for the app only to publish the committed generation again (a plugin file drifted),
            // and the app did not qualify: nothing was written, and the committed generation is read back as it is.
            // The file is written at a later attempt, once the app qualifies.
            if (lazy === null || lazy.refusal() !== error || !isTypedRefusal(error) || trusted()?.generationId !== preparedGenerationId) throw error
            result = { state: 'committed', alreadyCommitted: true, notes: [], waitsForApp: true }
          }
          if (result.waitsForApp === true) waitingForApp.set(scopeId, { attempts: (waitingForApp.get(scopeId)?.attempts ?? 0) + 1, lastAttemptMs: nowMs, appState: appNow() })
          else waitingForApp.delete(scopeId)
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
            const { bases } = measured('publication-read-back', () => {
              const { manifest, bases } = trustedNoteBases(store)
              reconcile({ index, files: listVaultNotes({ scopeId, vaultRoot: store.vaultRoot, manifest }), prefix: vaultKey(scopeId, ''), full: true, lstat })
              return { bases }
            })
            basesOf.set(scopeId, bases)
            const differing = [...bases].filter(([notePath, base]) => index.get(vaultKey(scopeId, notePath))?.digest !== base.digest).map(([notePath]) => notePath).sort(compareText)
            const editedUnderPublisher = result.notes.some((note) => note.outcome === 'edit-kept' || note.changedAfterPublication === true)
            if (held.length > 0) settle('held-for-your-edit', 'edit-pending', { ...common, heldNotes: held })
            else if (differing.some((notePath) => (index.get(vaultKey(scopeId, notePath))?.digest ?? null) === null)) settle('stale', 'vault-note-missing', common)
            // Somebody wrote during the publication. The next tick preserves and queues it.
            else if (differing.length > 0 || editedUnderPublisher) settle('updating', 'read-back-differs', common)
            else if (common.generationId !== preparedGenerationId) settle('stale', 'committed-generation-differs', common)
            // Kept current while a plugin file waits for the app: the reason says so, and status shows it on the plugin line.
            else settle('current', result.waitsForApp === true ? PLUGIN_FILES_WAIT_FOR_APP : result.alreadyCommitted ? 'verified-by-read-back' : 'published-and-verified', { ...common, heldNotes: [], verified: true })
          }
        } catch (error) {
          if (!isTypedRefusal(error)) { settle('stale', 'publisher-error'); persist(); throw error }
          // A redaction refusal names the note and the rule it concerns, never the value.
          const where = error.code === 'redaction-failure' ? error.detail ?? {} : {}
          diagnostics = typeof where.rule === 'string' ? [{ code: error.code, rule: where.rule, ...(typeof where.notePath === 'string' ? { notePath: where.notePath } : {}), ...(typeof where.filePath === 'string' ? { filePath: where.filePath } : {}) }] : []
          settle('stale', error.code)
          if (REREAD_CODES.has(error.code)) forceFull = true
        }
      }
    }
    persist()
    for (const scopeId of attempt.keys()) {
      const settled = !RETRIED_STATES.has(entries.get(scopeId).state)
      if (settled) unsettled.delete(scopeId)
      else unsettled.set(scopeId, { attempts: (unsettled.get(scopeId)?.attempts ?? 0) + 1, lastAttemptMs: nowMs, appState: appNow() })
    }
    for (const scopeId of [...unsettled.keys()]) if (!entries.has(scopeId) || entries.get(scopeId).state === 'disabled') unsettled.delete(scopeId)
    for (const scopeId of [...waitingForApp.keys()]) if (entries.get(scopeId)?.state !== 'current') waitingForApp.delete(scopeId)
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
    // The next tick that starts prepares and publishes this view once more, whatever its state. A view this
    // project does not declare is ignored then.
    // A view the project declared at the last tick (before the first, any view), and at most MAX_PREPARATION_REQUESTS
    // of them; whether the request was taken.
    requestPreparation(scopeId) {
      if (typeof scopeId !== 'string' || scopeId === '' || (declaredScopes !== null && !declaredScopes.has(scopeId))) return false
      if (!preparationRequests.has(scopeId) && preparationRequests.size >= MAX_PREPARATION_REQUESTS) return false
      preparationRequests.add(scopeId)
      return true
    },
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
