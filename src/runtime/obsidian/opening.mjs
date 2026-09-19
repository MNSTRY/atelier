import fs from 'node:fs'
import path from 'node:path'
import { createRecoveryStore as createStore, readFileBytes, sha256Digest } from '../../projection/obsidian/recovery/store.mjs'
import { inspectApp, qualifyApp } from './app-capability.mjs'
import { readObsidianEnablement } from './enablement.mjs'
import { ObsidianMaintenanceRefusal, refuse } from './errors.mjs'
import { UNAVAILABLE_APPLY_OPERATION } from './extension-points.mjs'
import { LIFECYCLE_PRIMITIVES, requestServiceTick, serviceStatus, startService } from './lifecycle.mjs'
import { protectedRoots } from './machine-settings.mjs'
import { trustedNoteBases } from './pending-edits.mjs'
import { resolveServiceWorkspace } from './service.mjs'
import { OPEN_EDIT_STATES, createMaintenanceStateStore } from './state-store.mjs'

// Opening a view, and saying honestly how fresh it is.
//
// Every answer is one of the typed outcomes below. Only `current` is success,
// and it means all of:
//
//   - the owned maintenance service is healthy and ran a tick after this
//     request, so the generation it prepared comes from the present sources;
//   - the persisted freshness of the view says `current`, which the state
//     store only accepts for a verified generation equal to the prepared one;
//   - read back here, independently: the trusted pointer of the view names
//     that same generation and every note in the vault has the bytes that
//     generation was published with;
//   - the installed app is present, has its command-line capability, meets
//     the minimum version, was asked to open the vault, answers for exactly
//     this vault and has finished reading it.
//
// Nothing here talks to an app or an operating system itself: `appProbe` and
// `launcher` are injected, and there is no default for either.

export const OPENING_OUTCOMES = Object.freeze({
  current: { summary: 'the vault is the present generation, verified by read-back, and the app has it open', next: 'nothing to do' },
  updating: { summary: 'maintenance is publishing or has not finished; the vault is not confirmed current', next: 'run `obsidian open` again in a moment' },
  'held-for-your-edit': { summary: 'a note you edited is preserved and held; the view is not republished over it', next: 'apply or withdraw the pending edit, then open again' },
  'stale-readable': { summary: 'a last good vault exists and can be read, but it is not proven to be the present generation', next: 'see `obsidian status` for the reason; `obsidian open --allow-stale` opens it as it is' },
  'not-prepared': { summary: 'no generation of this view has been published yet', next: 'see `obsidian status` for the reason' },
  'app-missing': { summary: 'no Obsidian installation was found', next: 'install Obsidian, then open again' },
  'app-version-unsupported': { summary: 'the installed Obsidian is below the minimum supported version, or its version cannot be read', next: 'update Obsidian, then open again' },
  'app-cli-unavailable': { summary: 'the installed Obsidian has no usable command-line capability', next: 'enable the command-line interface in Obsidian, then open again' },
  indexing: { summary: 'the app answered for this vault but has not finished reading it', next: 'wait for Obsidian to finish indexing, then open again' },
  'publisher-conflict': { summary: 'another publisher or an uncoordinated editor holds this vault', next: 'close the other publisher or let it finish; it is retried automatically' },
  'launch-failed': { summary: 'the operating system or the app did not open this vault', next: 'open the vault folder in Obsidian once by hand, then open again' },
  'service-unavailable': { summary: 'the maintenance service of this workspace could not be started or reached as ours', next: 'see `obsidian service status`' },
  busy: { summary: 'the maintenance service runs but is in a long tick and did not answer in time', next: 'run `obsidian open` again in a moment; nothing was stopped or restarted' },
  disabled: { summary: 'the Obsidian integration is not enabled for this project, or this view is not configured', next: 'enable it in the project configuration' },
})

// A sub-state of pending edits, never an opening failure.
export const APPLY_UNAVAILABLE = 'apply-unavailable'

export function describeOutcome(code) {
  if (!Object.hasOwn(OPENING_OUTCOMES, code)) throw new TypeError(`unknown opening outcome: ${String(code)}`)
  return { outcome: code, ...OPENING_OUTCOMES[code] }
}

// The decisions the opening oracles are sensitive to; tests substitute broken ones to prove the oracles can fail.
export const OPENING_PRIMITIVES = Object.freeze({
  // The freshness states that are their own outcome.
  outcomeOfState: (state) => (['updating', 'held-for-your-edit', 'publisher-conflict', 'disabled'].includes(state) ? state : null),
  // Whether a persisted `current` may be believed after reading the vault back.
  readBackAgrees: ({ entry, verification }) => verification.readable && verification.generationId === entry.preparedGenerationId && verification.intact,
  // Whether the app may be shown this vault at all.
  appQualifies: (qualification) => qualification.outcome === 'qualified',
})

const segment = (identifier) => identifier.replaceAll(':', '_')
const STORE_AREAS = (scopeId) => [['vaults', segment(scopeId)], ['state', 'manifests', segment(scopeId)], ['state', 'journals', segment(scopeId)], ['state', 'locks'], ['recovery', 'objects'], ['staging']]

// Reads the trusted pointer of a view and every note of its vault. Read-only:
// the store is only constructed when everything it would create already exists.
export function readBackTrustedGeneration({ workspaceRoot, workspaceId, scopeId, repositoryRoots, createRecoveryStore = createStore }) {
  const unreadable = (reason) => ({ readable: false, reason, generationId: null, intact: false, noteCount: 0, differing: 0, missing: 0 })
  if (!STORE_AREAS(scopeId).every((parts) => fs.existsSync(path.join(workspaceRoot, ...parts)))) return unreadable('no-published-vault')
  let store
  let trusted
  try {
    store = createRecoveryStore({ workspaceRoot, workspaceId, scopeId, repositoryRoots })
    trusted = { pointer: store.readCurrent(), ...trustedNoteBases(store) }
  } catch (error) {
    if (typeof error?.code === 'string') return unreadable(error.code)
    throw error
  }
  if (!trusted.pointer || !trusted.manifest) return unreadable('no-trusted-generation')
  let differing = 0
  let missing = 0
  for (const [notePath, base] of trusted.bases) {
    let bytes
    try { bytes = readFileBytes(path.join(store.vaultRoot, ...notePath.split('/'))) } catch (error) {
      if (error.code === 'ENOENT') { missing += 1; continue }
      return unreadable(error.code ?? 'vault-unreadable')
    }
    if (sha256Digest(bytes) !== base.digest) differing += 1
  }
  return { readable: true, reason: 'read-back', generationId: trusted.pointer.generationId, intact: differing === 0 && missing === 0, noteCount: trusted.bases.size, differing, missing, vaultRoot: store.vaultRoot }
}

function pendingSummary(stateStore, scopeId, applyAvailable) {
  const open = stateStore.readPendingEdits().edits.filter((edit) => edit.scopeId === scopeId && OPEN_EDIT_STATES.includes(edit.state))
  const byState = Object.fromEntries(OPEN_EDIT_STATES.map((state) => [state, open.filter((edit) => edit.state === state).length]))
  // Said whenever no apply operation exists, not only after a dispatch found that out.
  return { open: open.length, byState, apply: applyAvailable ? 'available' : APPLY_UNAVAILABLE }
}

// The honest freshness of one view, from persisted state plus a read-back.
// `serviceState` is the proven lifecycle state; a persisted `current` is not
// repeated as `current` while nothing proves maintenance is looking.
export function scopeReport({ workspace, scopeId, repositoryRoots, serviceState, applyAvailable = false, freshness = undefined, createRecoveryStore }, rules = OPENING_PRIMITIVES) {
  const stateStore = createMaintenanceStateStore(workspace)
  let document = freshness
  let unreadableCode = null
  if (document === undefined) {
    try { document = stateStore.readFreshness() } catch (error) { if (!(error instanceof ObsidianMaintenanceRefusal)) throw error; document = null; unreadableCode = error.code }
  }
  const entry = document?.scopes.find((item) => item.scopeId === scopeId) ?? null
  const verification = readBackTrustedGeneration({ ...workspace, scopeId, repositoryRoots, ...(createRecoveryStore ? { createRecoveryStore } : {}) })
  const lastGood = verification.readable ? 'stale-readable' : 'not-prepared'
  let outcome
  let reason
  if (entry === null) { outcome = lastGood; reason = unreadableCode ?? 'no-freshness-recorded' }
  else if (rules.outcomeOfState(entry.state) !== null) { outcome = rules.outcomeOfState(entry.state); reason = entry.reason }
  else if (entry.state !== 'current') { outcome = lastGood; reason = entry.reason }
  else if (!rules.readBackAgrees({ entry, verification })) {
    // Notes that differ are an edit the engine has not looked at yet; a pointer that differs is another generation.
    const edited = verification.readable && verification.generationId === entry.preparedGenerationId
    outcome = edited ? 'updating' : lastGood
    reason = edited ? 'vault-differs-from-trusted-generation' : verification.readable ? 'trusted-generation-differs' : verification.reason
  } else if (serviceState !== 'healthy') { outcome = 'stale-readable'; reason = serviceState === 'busy' ? 'maintenance-busy-not-rechecked' : 'maintenance-not-running' }
  else { outcome = 'current'; reason = entry.reason }
  return {
    scopeId, ...describeOutcome(outcome), reason,
    freshness: entry === null ? null : { state: entry.state, reason: entry.reason, verified: entry.verified, generationId: entry.generationId, preparedGenerationId: entry.preparedGenerationId, heldNoteCount: entry.heldNotes.length, retainedEdits: entry.retainedEdits, checkedAt: entry.checkedAt },
    readBack: { readable: verification.readable, reason: verification.reason, generationId: verification.generationId, intact: verification.intact, noteCount: verification.noteCount, differing: verification.differing, missing: verification.missing },
    pendingEdits: pendingSummary(stateStore, scopeId, applyAvailable),
    vaultRoot: verification.vaultRoot ?? null,
  }
}

export function resolveScope(enablement, requested) {
  const scopeId = requested ?? enablement.defaultScopeId ?? enablement.scopes[0]?.scopeId ?? null
  if (scopeId === null) refuse('unknown-scope', 'this project declares no view to open')
  if (!enablement.scopes.some((scope) => scope.scopeId === scopeId)) refuse('unknown-scope', 'no declared view has this identity', { scopeId: String(scopeId).slice(0, 128) })
  return scopeId
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const READABLE = new Set(['stale-readable', 'held-for-your-edit', 'updating', 'publisher-conflict'])

// Starts or reconnects the owned service, asks it for a tick, reads the view
// back, qualifies the app, has the vault opened and reports one outcome.
export async function openScopeForOracleTests(options = {}, rules = OPENING_PRIMITIVES, lifecycleRules = LIFECYCLE_PRIMITIVES) {
  const {
    loadProject, dataRoot, scopeId: requestedScope, appProbe, launcher, service = {}, consent, allowStale = false, extensions = null,
    tickTimeoutMs = 120 * 1000, appWaitMs = 30 * 1000, appPollMs = 500, sleep = defaultSleep, monotonic = () => Date.now(),
    env = process.env, platform = process.platform, probeTimeoutMs,
  } = options
  if (typeof loadProject !== 'function') throw new TypeError('open needs loadProject')
  // No defaults: reaching an app or the operating system is a decision of the entry that composes this.
  if (typeof appProbe?.inspect !== 'function' || typeof appProbe?.vaultState !== 'function') throw new TypeError('open needs an injected appProbe')
  if (typeof launcher?.open !== 'function') throw new TypeError('open needs an injected launcher')
  if (typeof service.entryPath !== 'string') throw new TypeError('open needs the service entry it may start')

  const project = loadProject()
  const enablement = readObsidianEnablement(project)
  const applyAvailable = extensions !== null && extensions.applyOperation() !== UNAVAILABLE_APPLY_OPERATION
  const finish = (outcome, extra = {}) => ({ ok: outcome === 'current', ...describeOutcome(outcome), launched: false, ...extra })
  if (enablement.state === 'disabled') return finish('disabled', { reason: enablement.reason, scopeId: requestedScope ?? null })
  const scopeId = resolveScope(enablement, requestedScope)
  const lifecycle = { loadProject, dataRoot, env, platform, ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }) }

  // 1. The owned service: reconnect, or start. Never adopt, never replace.
  let status = await serviceStatus(lifecycle, lifecycleRules)
  if (status.state === 'busy') return finish('busy', { scopeId, reason: status.reason, service: { state: status.state } })
  if (status.state !== 'healthy') {
    let started
    try {
      started = await startService({ ...lifecycle, detached: true, ...service, ...(consent === undefined ? {} : { consent }) }, lifecycleRules)
    } catch (error) {
      if (!(error instanceof ObsidianMaintenanceRefusal)) throw error
      return finish('service-unavailable', { scopeId, reason: error.code, service: { state: status.state } })
    }
    if (started.state === 'busy') return finish('busy', { scopeId, reason: started.reason, service: { state: 'busy', started: started.started } })
    if (started.state !== 'healthy') return finish('service-unavailable', { scopeId, reason: started.reason ?? started.state, service: { state: started.state } })
    status = started
  }

  // 2. A tick that starts after this request, bounded.
  const asked = await requestServiceTick({ ...lifecycle, tickTimeoutMs }, lifecycleRules)
  const serviceShown = { state: asked.state, runtimeId: status.record?.runtimeId ?? null }
  if (asked.state === 'busy') return finish('busy', { scopeId, reason: asked.reason, service: serviceShown })
  if (!asked.requested) return finish('service-unavailable', { scopeId, reason: asked.reason, service: serviceShown })
  const workspace = resolveServiceWorkspace({ project, dataRoot, env, platform })
  const report = (freshnessOverride) => scopeReport({ workspace, scopeId, repositoryRoots: protectedRoots(project), serviceState: 'healthy', applyAvailable, ...(freshnessOverride === undefined ? {} : { freshness: freshnessOverride }) }, rules)
  let view = report()
  const tick = asked.pending ? null : asked.tick
  if (asked.pending && view.outcome === 'current') view = { ...view, ...describeOutcome('updating'), reason: 'tick-still-running' }
  else if (!asked.pending && tick?.state === 'busy') return finish('busy', { scopeId, reason: 'engine-lock-held', service: serviceShown })
  else if (!asked.pending && (tick === null || tick.ok !== true || tick.state !== 'ticked') && view.outcome === 'current') {
    // The tick after this request did not complete: what was current before is not proven current now.
    view = { ...view, ...describeOutcome('stale-readable'), reason: `tick-${tick?.state ?? tick?.error?.code ?? 'unanswered'}` }
  }
  const common = { scopeId, reason: view.reason, service: serviceShown, freshness: view.freshness, readBack: view.readBack, pendingEdits: view.pendingEdits }
  if (view.outcome !== 'current' && !(allowStale && READABLE.has(view.outcome) && view.readBack.readable)) return finish(view.outcome, common)

  // 3. The app, before anything is launched.
  const before = qualifyApp(await inspectApp(appProbe), { requireVersion: false })
  const app = (qualification) => ({ outcome: qualification.outcome, reason: qualification.reason, version: qualification.version, floor: qualification.floor })
  if (!rules.appQualifies(before)) return finish(before.outcome, { ...common, reason: before.reason, app: app(before) })

  // 4. Launch, then wait, bounded, for the app to answer for exactly this vault.
  let launch
  try { launch = await launcher.open({ vaultRoot: view.vaultRoot }) } catch { launch = { launched: false, reason: 'launcher-threw' } }
  if (launch?.launched !== true) return finish('launch-failed', { ...common, reason: typeof launch?.reason === 'string' ? launch.reason : 'launcher-refused', app: app(before) })
  const deadline = monotonic() + appWaitMs
  let after = before
  let vault = { answered: false, indexReady: false }
  for (;;) {
    after = qualifyApp(await inspectApp(appProbe), { requireVersion: true })
    // A running app below the floor is final; an app that has not come up yet is asked again.
    if (!rules.appQualifies(after) && after.reason !== 'version-unknown') return finish(after.outcome, { ...common, launched: true, reason: after.reason, app: app(after) })
    if (rules.appQualifies(after)) {
      try { vault = await appProbe.vaultState({ vaultRoot: view.vaultRoot }) } catch { vault = { answered: false, indexReady: false } }
      if (vault?.answered === true && vault.indexReady === true) break
    }
    if (monotonic() >= deadline) break
    await sleep(appPollMs)
  }
  if (!rules.appQualifies(after)) return finish(after.outcome, { ...common, launched: true, reason: after.reason, app: app(after) })
  if (vault?.answered !== true) return finish('launch-failed', { ...common, launched: true, reason: 'app-did-not-answer-for-this-vault', app: app(after) })
  if (vault.indexReady !== true) return finish('indexing', { ...common, launched: true, reason: 'metadata-cache-not-ready', app: app(after) })

  // 5. Still what was verified? The launch took time.
  if (view.outcome !== 'current') return finish(view.outcome, { ...common, launched: true, app: app(after) })
  const again = report()
  if (again.outcome !== 'current') return finish(again.outcome, { ...common, launched: true, reason: again.reason, freshness: again.freshness, readBack: again.readBack, app: app(after) })
  return finish('current', { ...common, launched: true, app: app(after) })
}

// Production entry point: the production decisions, always.
export function openScope(options = {}) {
  return openScopeForOracleTests(options, OPENING_PRIMITIVES, LIFECYCLE_PRIMITIVES)
}
