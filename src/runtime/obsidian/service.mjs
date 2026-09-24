import { randomBytes as cryptoRandomBytes } from 'node:crypto'
import fs from 'node:fs'
import { AtelierDiagnosticError } from '../../project/config.mjs'
import { ObsidianContractRefusal } from '../../projection/obsidian/contracts.mjs'
import { prepareView as productionPrepareView } from '../../projection/obsidian/materialize/index.mjs'
import { preparePluginFiles } from '../../projection/obsidian/plugin-bridge/bundle.mjs'
import { publishView as productionPublishView } from '../../projection/obsidian/publication/publisher.mjs'
import { isoTime } from './documents.mjs'
import { createMaintenanceEngine } from './engine.mjs'
import { ObsidianMaintenanceRefusal, refuse } from './errors.mjs'
import { assertOutsideRepositories, protectedRoots, readLocalPointer, resolveDataRoot, workspaceStateRoot } from './machine-settings.mjs'
import { createPluginChannel, createPluginSessions, ensurePluginBearer, pluginPresence } from './plugin-channel.mjs'
import { confirmPluginEntry, currentPluginChoice, decidePluginChoice, vaultFilePresent, viewVaultRoot } from './plugin-choice.mjs'
import { isProcessAlive } from './private-lock.mjs'
import { probeHealth } from './service-client.mjs'
import {
  SERVICE_ERROR_SCHEMA, executableIdentity, readLastServiceError, readServiceRecord, readServiceSettings, removeServiceRecord, serviceNameFor, servicePaths,
  writeLastServiceError, writeServiceRecord,
} from './service-record.mjs'
import { createServiceServer } from './service-server.mjs'
import { OPEN_EDIT_STATES, createMaintenanceStateStore } from './state-store.mjs'
import { DEFAULT_MAX_BACKOFF_MS, DEFAULT_TICK_INTERVAL_MS, createTickLoop } from './tick-loop.mjs'
import { createFsWatcherFactory } from './watchers.mjs'

// The maintenance service of one workspace, inside one process.
//
//   resolve the workspace -> read this machine's service settings -> refuse if
//   another runtime of this workspace answers -> listen on the literal
//   loopback address -> write the owner-only record -> tick on an interval
//
// It listens before its first tick and until after its last, and it removes
// its record before it stops listening, so a record whose address refuses
// connections never belongs to a working service.
//
// The service owns a process and a listener and nothing else. Every write to
// a vault, to recovery or to staging is the engine's and the publisher's. On
// shutdown the tick in flight is allowed to finish; nothing is swept, and a
// publication that was cut short is settled by the publisher's own restart
// recovery on a later tick, never by deleting what it left behind.
//
// It also holds the plugin channel (plugin-channel.mjs). Every view it
// prepares carries Atelier's plugin, whose data file names this listener and
// the view's bearer, unless the person turned the plugin off in that vault
// (plugin-choice.mjs): then the entry is left alone and only the plugin files
// that are still there are kept current. A plugin that holds a view open is
// reported by status and tells the adapter factory the app version it runs in.
//
// `adapterFactory` has no default here either: whoever starts the service
// decides whether it may reach a running app.

export const SERVICE_STATUS_SCHEMA = 'atelier-obsidian-service-status/v1'
export const DEFAULT_SHUTDOWN_GRACE_MS = 30 * 1000

// Where a workspace keeps its private state, without creating an identity.
export function resolveServiceWorkspace({ project, dataRoot, env = process.env, platform = process.platform, create = false }) {
  const pointer = readLocalPointer(project)
  if (pointer === null) return null
  const requested = workspaceStateRoot(resolveDataRoot({ dataRoot, pointer, project, env, platform }), pointer.workspaceId)
  assertOutsideRepositories({ managedRoot: requested, repositoryRoots: protectedRoots(project) })
  if (create) fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
  else if (!fs.existsSync(requested)) return { workspaceId: pointer.workspaceId, workspaceRoot: null }
  return { workspaceId: pointer.workspaceId, workspaceRoot: fs.realpathSync(requested) }
}

const isTyped = (error) => error instanceof ObsidianMaintenanceRefusal || error instanceof AtelierDiagnosticError || error instanceof ObsidianContractRefusal
const errorCode = (error) => (typeof error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(error.code) ? error.code : 'untyped-error')
const errorName = (error) => (typeof error?.name === 'string' ? error.name.slice(0, 64) : 'Error')

// Where a rename over a file somebody is reading can fail for a moment (Windows), the one record write is tried again.
async function writeRecordPatiently(input) {
  for (let attempt = 0; ; attempt += 1) {
    try { return writeServiceRecord(input) } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    }
  }
}

export async function runMaintenanceService(options = {}) {
  const {
    loadProject, dataRoot, adapterFactory, entryPath, runtimeId = `rt-${cryptoRandomBytes(16).toString('hex')}`, startup = false,
    intervalMs = DEFAULT_TICK_INTERVAL_MS, maxBackoffMs = Math.max(DEFAULT_MAX_BACKOFF_MS, intervalMs), shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
    clock = () => new Date(), log = () => {}, pid = process.pid, randomBytes = cryptoRandomBytes, env = process.env, platform = process.platform,
    engineOptions = {}, createEngine = createMaintenanceEngine,
    // What the adapter factory last learned about the installed app, when it qualifies one. Codes and versions only.
    appStatus = null,
  } = options
  if (typeof loadProject !== 'function') throw new TypeError('the service needs loadProject')
  if (typeof adapterFactory !== 'function') throw new TypeError('the service needs an adapterFactory')
  if (typeof entryPath !== 'string') throw new TypeError('the service needs the path of its entry module')

  const workspace = resolveServiceWorkspace({ project: loadProject(), dataRoot, env, platform })
  if (!workspace?.workspaceRoot) refuse('service-workspace-not-prepared', 'this workspace has no private state yet; `start` prepares it')
  const { workspaceId, workspaceRoot } = workspace
  const settings = readServiceSettings({ workspaceRoot, workspaceId })
  if (settings === null) refuse('service-settings-absent', 'this machine recorded no loopback port and no consent for this workspace')
  // A unit installed at the operating-system level runs only under a consent that covers it.
  if (startup && settings.consent.coverage !== 'service-and-startup') refuse('startup-consent-absent', 'the recorded consent covers the service, not operating-system startup')
  const { host, port } = settings

  // Another runtime of this workspace that proves itself is never displaced. A malformed record refuses here.
  const existing = readServiceRecord({ workspaceRoot, workspaceId })
  if (existing && existing.runtimeId !== runtimeId && isProcessAlive(existing.pid)) {
    const answer = await probeHealth({ host: existing.host, port: existing.port })
    if (answer.kind === 'health' && answer.body.runtimeId === existing.runtimeId && answer.body.pid === existing.pid) refuse('service-already-running', 'another runtime of this workspace answers health', { runtimeId: existing.runtimeId, pid: existing.pid })
  }

  const executable = executableIdentity(entryPath)
  const startedAt = isoTime(clock)
  const identity = { serviceName: serviceNameFor(workspaceId), workspaceId, runtimeId, pid, host, port, executableDigest: executable.digest, startedAt }
  const bearer = randomBytes(32).toString('base64url')
  const stateStore = createMaintenanceStateStore({ workspaceRoot, workspaceId })
  // Session identities live in memory only and are always random, whatever `randomBytes` the service was given.
  const pluginSessions = createPluginSessions()

  let stopping = false
  let consecutiveFailures = 0
  let lastTick = null
  let settleDone
  const done = new Promise((resolve) => { settleDone = resolve })

  // Every prepared view carries the plugin with this listener's address and the view's bearer, as the person's choice
  // for that vault allows: the choice is read, and recorded when the vault shows it changed, from the community plugin
  // list as it is now, and those very bytes travel with the view. A bearer or a choice that cannot be kept leaves that
  // view without the plugin for this tick; the view itself is prepared as ever.
  const pluginFor = (scopeId) => {
    try {
      const vaultRoot = viewVaultRoot(workspaceRoot, scopeId)
      const { choice, community } = decidePluginChoice({ workspaceRoot, workspaceId, scopeId, vaultRoot, clock })
      const off = choice.state === 'off'
      const plugin = preparePluginFiles({ channel: { host, port }, scopeId, bearer: ensurePluginBearer({ workspaceRoot, workspaceId, scopeId, randomBytes, clock }), onlyIfPresent: off })
      // Turned off: the files still there are kept current; a folder the person removed is not made again.
      const files = off ? plugin.files.filter((file) => vaultFilePresent(vaultRoot, file.path)) : plugin.files
      const kept = new Set(files.map((file) => file.path))
      const unreadable = community.file.state === 'unreadable'
      return {
        files, ownership: { ...plugin.ownership, files: plugin.ownership.files.filter((entry) => kept.has(entry.path)) },
        community: off || unreadable ? { entry: 'withheld', reason: off ? 'turned-off-in-this-vault' : 'list-unreadable' } : { entry: 'owned', existing: community.file.bytes },
      }
    } catch (error) {
      log({ at: isoTime(clock), event: 'plugin-not-prepared', code: errorCode(error), name: errorName(error) })
      return null
    }
  }
  const prepareWithPlugin = (input) => (engineOptions.seams?.prepareView ?? productionPrepareView)({ ...input, plugin: pluginFor(input.scope.scopeId) })
  // An entry offered to a vault and now in place is confirmed: from then on, a list without it is the person's decision.
  const publishAndConfirm = async (input) => {
    const result = await (engineOptions.seams?.publishView ?? productionPublishView)(input)
    try { confirmPluginEntry({ workspaceRoot, workspaceId, scopeId: input.recoveryStore.scopeId, result, clock }) } catch (error) {
      log({ at: isoTime(clock), event: 'plugin-entry-not-confirmed', code: errorCode(error), name: errorName(error) })
    }
    return result
  }
  // The app version a live plugin reports counts as checked for the view it holds open, while one launch of the plugin
  // alone holds it: with two apps holding the vault, which one the command-line tool reaches is unknown.
  const pluginReportOf = (scopeId) => { const report = pluginSessions.report(scopeId); return report?.instances === 1 ? report : null }
  const pluginAwareAdapterFactory = (input) => adapterFactory({ ...input, pluginReport: typeof input?.scope?.scopeId === 'string' ? pluginReportOf(input.scope.scopeId) : null })
  const engine = createEngine({
    watcherFactory: createFsWatcherFactory(), ...engineOptions, seams: { ...(engineOptions.seams ?? {}), prepareView: prepareWithPlugin, publishView: publishAndConfirm },
    loadProject, dataRoot, adapterFactory: pluginAwareAdapterFactory, clock, env, platform, lockOwner: { host, port, runtimeId },
  })

  const recordIsOurs = () => {
    try { const record = readServiceRecord({ workspaceRoot, workspaceId }); return record !== null && record.runtimeId === runtimeId && record.pid === pid } catch { return false }
  }

  function recordOutcome(outcome) {
    const at = isoTime(clock)
    consecutiveFailures = outcome.consecutiveFailures
    if (outcome.ok) {
      lastTick = { at, state: outcome.report.state, reason: outcome.report.reason ?? outcome.report.refusal?.code ?? null }
      const previous = readLastServiceError({ workspaceRoot, workspaceId })
      if (previous && previous.resolvedAt === null) writeLastServiceError({ workspaceRoot, workspaceId, document: { ...previous, consecutiveFailures: 0, resolvedAt: at } })
      return
    }
    lastTick = { at, state: 'failed', reason: errorCode(outcome.error) }
    // The message may carry a path or a title: it goes to the private log and nowhere else.
    log({ at, event: 'tick-failed', code: errorCode(outcome.error), name: errorName(outcome.error), message: String(outcome.error?.message ?? outcome.error), consecutiveFailures })
    let previous = null
    try { previous = readLastServiceError({ workspaceRoot, workspaceId }) } catch { previous = null }
    writeLastServiceError({ workspaceRoot, workspaceId, document: { schema: SERVICE_ERROR_SCHEMA, workspaceId, runtimeId, code: errorCode(outcome.error), name: errorName(outcome.error), at, consecutiveFailures, totalFailures: (previous?.totalFailures ?? 0) + 1, resolvedAt: null } })
  }

  const loop = createTickLoop({
    intervalMs, maxBackoffMs, onOutcome: recordOutcome,
    async tick() {
      // The service runs only while its record names it: a replaced or removed record ends it, cleanly.
      if (!recordIsOurs()) { void shutdown('record-no-longer-names-this-runtime'); return { state: 'stopping', reason: 'record-no-longer-names-this-runtime' } }
      return engine.tick()
    },
  })

  const summary = (report) => ({ state: report.state, reason: report.reason ?? report.refusal?.code ?? null, scopes: (report.scopes ?? []).map(({ scopeId, state, reason, verified }) => ({ scopeId, state, reason, verified })) })

  function freshnessSummary() {
    let document
    try { document = stateStore.readFreshness() } catch (error) { if (isTyped(error)) return { readable: false, code: error.code }; throw error }
    if (document === null) return null
    const { enablement, maintenanceMode, lastTickAt, lastFullReconciliationAt } = document
    // Counts, never the held paths: a note path carries a title.
    const scopes = document.scopes.map(({ scopeId, state, reason, verified, generationId, preparedGenerationId, heldNotes, retainedEdits, checkedAt }) => ({ scopeId, state, reason, verified, generationId, preparedGenerationId, heldNoteCount: heldNotes.length, retainedEdits, checkedAt }))
    return { readable: true, enablement, maintenanceMode, lastTickAt, lastFullReconciliationAt, scopes }
  }

  const healthStatus = () => (stopping ? 'stopped' : consecutiveFailures > 0 ? 'degraded' : 'healthy')

  // One view as the plugin is told about it: its freshness entry with held notes counted, and its open pending edits.
  function pluginStatusOf(scopeId) {
    let entry = null
    try { entry = stateStore.readFreshness()?.scopes.find((item) => item.scopeId === scopeId) ?? null } catch (error) { if (!isTyped(error)) throw error; return { view: null, pendingEdits: null } }
    let open = null
    try { open = stateStore.readPendingEdits().edits.filter((edit) => edit.scopeId === scopeId && OPEN_EDIT_STATES.includes(edit.state)).length } catch (error) { if (!isTyped(error)) throw error }
    const view = entry === null ? null : {
      state: entry.state, reason: entry.reason, verified: entry.verified, generationId: entry.generationId, preparedGenerationId: entry.preparedGenerationId,
      heldNoteCount: entry.heldNotes.length, retainedEdits: entry.retainedEdits, checkedAt: entry.checkedAt,
    }
    return { view, pendingEdits: open === null ? null : { open } }
  }
  const pluginChannel = createPluginChannel({ workspaceRoot, workspaceId, runtimeId, sessions: pluginSessions, statusOf: pluginStatusOf, serviceStatus: healthStatus })
  const server = createServiceServer({
    identity, bearer,
    operations: {
      healthStatus,
      status() {
        let lastError = null
        try { lastError = readLastServiceError({ workspaceRoot, workspaceId }) } catch (error) { if (!isTyped(error)) throw error; lastError = { unreadable: error.code } }
        if (lastError?.schema) { const { schema: _schema, workspaceId: _workspace, ...shown } = lastError; lastError = shown }
        return {
          schema: SERVICE_STATUS_SCHEMA, service: { ...identity, status: healthStatus() }, loop: loop.state(), lastTick, lastError, freshness: freshnessSummary(),
          plugins: pluginPresence({ sessions: pluginSessions, scopeIds: [...pluginChannel.bearers().keys()], entryOf: (scopeId) => currentPluginChoice({ workspaceRoot, workspaceId, scopeId }).state }),
          ...(typeof appStatus === 'function' ? { app: appStatus() } : {}),
        }
      },
      async tick() {
        const outcome = await loop.tickNow()
        if (outcome.stopped) return { ok: false, stopped: true }
        return outcome.ok ? { ok: true, ...summary(outcome.report) } : { ok: false, error: { code: errorCode(outcome.error), name: errorName(outcome.error) } }
      },
      stop: () => shutdown('stop-requested'),
      plugin: (command, request) => pluginChannel.handle(command, request),
    },
  })

  let shuttingDown = null
  function shutdown(reason) {
    if (shuttingDown) return shuttingDown
    stopping = true
    shuttingDown = (async () => {
      log({ at: isoTime(clock), event: 'stopping', reason })
      // The tick in flight finishes, within the grace period. Past it the process ends anyway: the publisher journals every step.
      let timer
      await Promise.race([loop.stop(), new Promise((resolve) => { timer = setTimeout(resolve, shutdownGraceMs) })])
      clearTimeout(timer)
      try { engine.stop() } catch { /* watchers only */ }
      // Drafts, pending edits, recovery and staging stay exactly as they are. Only the generated record goes, and before the listener does.
      try { removeServiceRecord({ workspaceRoot, workspaceId, runtimeId, pid }) } catch { /* a record that cannot be removed is reported stale later */ }
      await server.close()
      log({ at: isoTime(clock), event: 'stopped', reason })
      settleDone({ reason })
      return { reason }
    })()
    return shuttingDown
  }

  try {
    await server.listen()
  } catch (error) {
    try { engine.stop() } catch { /* nothing was watched yet */ }
    if (error.code === 'EADDRINUSE') refuse('service-port-occupied', 'something else listens on the recorded loopback port; it is never taken over', { host, port })
    throw error
  }
  try {
    await writeRecordPatiently({
      workspaceRoot, workspaceId,
      record: {
        schema: 'atelier-obsidian-service-state/v1', contractVersion: '1.0.0', workspaceId, serviceName: identity.serviceName, host, port, runtimeId, pid,
        executable: { path: executable.path, digest: executable.digest, ext: { runner: process.execPath } }, stateLocation: servicePaths(workspaceRoot).stateLocation,
        health: { status: 'healthy', checkedAt: startedAt }, consent: settings.consent, ext: { bearer },
      },
    })
  } catch (error) {
    await server.close()
    throw error
  }
  log({ at: startedAt, event: 'started', runtimeId, pid, host, port, startup })
  loop.start()
  return { identity, workspaceRoot, tickNow: () => loop.tickNow(), shutdown, done }
}
