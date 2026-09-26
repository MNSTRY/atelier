import fs from 'node:fs'
import path from 'node:path'
import { enclosingVaults, findVaultEntry, vaultRoute } from '../../projection/obsidian/publication/vault-list.mjs'
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
//     the minimum version, knows the vault as one of its vaults, was asked to
//     open it, answers for exactly this vault and has finished reading it.
//
// Nothing a person does by hand is needed on the way. The app is made to know
// the vault: through the app itself while it runs and answers, or, while no
// Obsidian runs, in the app's own vault list (app-registration.mjs). A view
// that the app kept from being published (an app that runs without the vault,
// or that could not be qualified) is published again once the app holds the
// vault, through the app, before the answer is given.
//
// Nothing here talks to an app or an operating system itself: `appProbe`,
// `registry` and `launcher` are injected, and there is no default for any.

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
  'launch-failed': { summary: 'the operating system or the app did not open this vault', next: 'run `obsidian open` again; if it fails the same way, start Obsidian with any vault open and open again' },
  'service-unavailable': { summary: 'the maintenance service of this workspace could not be started or reached as ours, or runs a later release than this command', next: 'see `obsidian service status`' },
  busy: { summary: 'the maintenance service runs but is in a long tick and did not answer in time', next: 'run `obsidian open` again in a moment; nothing was stopped or restarted' },
  disabled: { summary: 'the Obsidian integration is not enabled for this project, or this view is not configured', next: 'enable it in the project configuration' },
})

// A sub-state of pending edits, never an opening failure.
export const APPLY_UNAVAILABLE = 'apply-unavailable'

export function describeOutcome(code) {
  if (!Object.hasOwn(OPENING_OUTCOMES, code)) throw new TypeError(`unknown opening outcome: ${String(code)}`)
  return { outcome: code, ...OPENING_OUTCOMES[code] }
}

// A reason whose next step is not its outcome's. With no vault open the app's
// command line answers nothing, its version included, so the version floor
// cannot be checked, and a vault the app does not know yet cannot be added
// through it, until a vault is open or the app is quit.
// `editor-uncoordinated` is the publisher stopping because an Obsidian that may
// hold this vault could not be coordinated with. There is no other publisher to
// wait for, and the cause is not known here: the app runs without this vault,
// or with it but its command line did not answer, or the process table was
// unknown (on Linux, any app that runs on a system Electron), or an app started
// while the view was published with the app closed. `open` makes the app hold
// the vault and publishes through it; every cause also clears once no such
// process runs.
const UNCOORDINATED = 'an Obsidian that may hold this vault could not be coordinated with, so publication stopped'
const QUIT = 'quit Obsidian (on Linux, also any app that runs on a system Electron)'
// Obsidian's settings file could not be used to add the vault while the app was quit: adding it through the app works instead.
const THROUGH_THE_APP = 'start Obsidian with any vault open, then open again: the vault is then added through the app'
export const REASON_NEXT = Object.freeze({
  'cli-turned-off': 'Obsidian\'s command line is turned off (the default of a new installation): turn it on in Obsidian under Settings > General > Advanced > Command line interface, then open again',
  'no-vault-open': 'open any vault in Obsidian, or quit Obsidian, then open again; open then adds this view\'s vault to Obsidian itself',
  'vault-open-cli-silent': 'Obsidian has this view\'s vault open, as Atelier\'s plugin in it shows, but its command line did not answer, so the vault can be neither found nor opened through it; make sure the command-line interface is turned on in Obsidian\'s settings, then open again',
  'editor-uncoordinated': `${UNCOORDINATED}; \`atelier obsidian open\` adds this view's vault to Obsidian and publishes through it, or ${QUIT}; it is retried automatically`,
  'obsidian-settings-missing': 'Obsidian has not run on this account yet: start it once (it creates its settings), then open again with it running or quit',
  'obsidian-settings-location-unknown': THROUGH_THE_APP,
  'obsidian-settings-unsafe': `Obsidian's settings file is a link or not a regular file, so it is not written; ${THROUGH_THE_APP}`,
  'obsidian-settings-not-owned': `Obsidian's settings file belongs to another user, so it is not written; ${THROUGH_THE_APP}`,
  'obsidian-settings-unreadable': `Obsidian's settings file cannot be read as JSON, so it is not written; ${THROUGH_THE_APP}`,
  'obsidian-settings-not-object': `Obsidian's settings file is not a JSON object, so it is not written; ${THROUGH_THE_APP}`,
  'obsidian-settings-unwritable': `Obsidian's settings directory cannot be written (space or permissions); ${THROUGH_THE_APP}`,
  'obsidian-settings-too-large': `with this view's vault, Obsidian's settings file would be larger than a settings file can be, so it is not written; ${THROUGH_THE_APP}`,
  'obsidian-sandboxed': `this Obsidian is a Flatpak or snap build, which keeps its vault list inside its sandbox, where Atelier does not write; ${THROUGH_THE_APP}`,
  'obsidian-settings-changed': 'Obsidian\'s settings file changed while the vault was being added, and nothing was written; open again',
  'app-may-be-running': 'Obsidian started while the vault was being added, and nothing was written; open again',
  'app-started-during-registration': 'Obsidian started just as this view\'s vault was added to its list and may not have read it; open again: a vault it missed is then added through it',
  'registration-not-read-back': 'this view\'s vault was added to Obsidian\'s settings file, but the file could not be read back to confirm it; open again',
  'addition-not-answered': 'Obsidian did not answer when asked to add this view\'s vault, and its vault list does not show it; open again, or quit Obsidian and open again',
  'app-did-not-list-its-vaults': 'Obsidian runs but did not answer with its vault list; open again, or quit Obsidian and open again',
  'app-refused-registration': 'Obsidian did not accept this view\'s vault folder as a vault; quit Obsidian and open again',
  'registration-not-verified': 'Obsidian answered, but its vault list does not show this view\'s vault; quit Obsidian and open again',
  'restarted-service-in-its-first-tick': 'the maintenance service ran an earlier release and was restarted on the installed one, which is still in its first tick; run `obsidian open` again in a moment',
  'service-outdated': 'the maintenance service runs an earlier release of Atelier that could not be replaced; run `atelier obsidian service stop`, then open again',
  'service-other-release': 'the maintenance service runs a later release of Atelier than this command, which never replaces a later release by itself; run `atelier obsidian service stop`, then open again, or open with the later release',
  'vault-open-in-several-windows': 'Obsidian\'s vault list marks this view\'s folder open under more than one entry (in another letter case, or through a link), so it may hold the vault in more than one window, and a publication coordinates with one window only; remove the extra entries from Obsidian\'s vault list (Obsidian keeps the last window it closed marked open, so closing windows does not clear this), then open again',
  'vault-inside-another-vault': 'Obsidian lists another vault at a folder that contains this view\'s vault; open never adds a vault inside another one, and never sends a call that could reach that vault instead: remove that vault from Obsidian\'s vault list, or keep Atelier\'s data root outside that folder, then open again',
})

// What `open` answers when it could not clear the refusal itself (the app held the vault and the publication still
// stopped, or no app answered to be asked): no step is left that open could take.
const AFTER_OPEN_NEXT = Object.freeze({
  'editor-uncoordinated': `${UNCOORDINATED}, and open could not clear it; ${QUIT} so the view is published, then open again`,
})

// The next step for an outcome and its reason; null for a code that is not an
// opening outcome. `afterOpen` says that the answer is `open`'s own, after it
// tried what it can.
export function nextStep(outcome, reason, { afterOpen = false } = {}) {
  if (typeof reason === 'string') {
    if (afterOpen && Object.hasOwn(AFTER_OPEN_NEXT, reason)) return AFTER_OPEN_NEXT[reason]
    if (Object.hasOwn(REASON_NEXT, reason)) return REASON_NEXT[reason]
  }
  return Object.hasOwn(OPENING_OUTCOMES, outcome) ? OPENING_OUTCOMES[outcome].next : null
}

// The decisions the opening oracles are sensitive to; tests substitute broken ones to prove the oracles can fail.
export const OPENING_PRIMITIVES = Object.freeze({
  // The freshness states that are their own outcome.
  outcomeOfState: (state) => (['updating', 'held-for-your-edit', 'publisher-conflict', 'disabled'].includes(state) ? state : null),
  // Whether a persisted `current` may be believed after reading the vault back.
  readBackAgrees: ({ entry, verification }) => verification.readable && verification.generationId === entry.preparedGenerationId && verification.intact,
  // Whether the app may be shown this vault at all.
  appQualifies: (qualification) => qualification.outcome === 'qualified',
  // Whether a view that is not current was kept from publication by the app: then making the app hold the vault
  // and asking for the view again can make it current. A vault open in several windows is asked for again once one
  // window is left; while more are open, open names them instead.
  keptByApp: (view) => ['publisher-conflict', 'stale-readable', 'not-prepared'].includes(view.outcome) && ['editor-uncoordinated', 'vault-open-in-several-windows', 'app-version-unsupported'].includes(view.reason),
})

const segment = (identifier) => identifier.replaceAll(':', '_')
const STORE_AREAS = (scopeId) => [['vaults', segment(scopeId)], ['state', 'manifests', segment(scopeId)], ['state', 'journals', segment(scopeId)], ['state', 'locks'], ['recovery', 'objects'], ['staging']]

// Reads the trusted pointer of a view and every note of its vault. Read-only:
// the store is only constructed when everything it would create already exists.
// `vaultRoot` is the folder the store publishes this view into, whenever the
// store could be constructed, even before a first generation.
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
  if (!trusted.pointer || !trusted.manifest) return { ...unreadable('no-trusted-generation'), vaultRoot: store.vaultRoot }
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
    scopeId, ...describeOutcome(outcome), next: nextStep(outcome, reason), reason,
    freshness: entry === null ? null : { state: entry.state, reason: entry.reason, verified: entry.verified, generationId: entry.generationId, preparedGenerationId: entry.preparedGenerationId, heldNoteCount: entry.heldNotes.length, retainedEdits: entry.retainedEdits, checkedAt: entry.checkedAt },
    readBack: { readable: verification.readable, reason: verification.reason, generationId: verification.generationId, intact: verification.intact, noteCount: verification.noteCount, differing: verification.differing, missing: verification.missing },
    pendingEdits: pendingSummary(stateStore, scopeId, applyAvailable),
    // Notes of the view worth naming, and the rule concerned; see "Notes that were laid out anyway" in docs/obsidian-contract.md.
    ...(entry?.diagnostics ? { diagnostics: entry.diagnostics } : {}),
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
// After a launch: the app is still starting, or still opening the vault it was asked for.
const NOT_UP_YET = new Set(['version-unknown', 'no-vault-open'])
const REGISTRY_OPERATIONS = ['listThroughApp', 'registerThroughApp', 'readSettings', 'registerInSettings']

const attempt = async (operation) => { try { return await operation() } catch { return null } }

// Makes the app know this vault as one of its vaults, by the state it is in:
//
//   - answering its command line (it gave its version): its own list is read;
//     a vault it does not list is added and opened through the app, and read
//     back from its list (findVaultEntry);
//   - running with no vault open: its command line answers nothing, and its
//     settings file is the running app's, so it is only read: a vault it lists
//     is opened by path, and one it does not list is `no-vault-open`. So is an
//     app whose version only Atelier's plugin reported: its command line gave
//     none, so nothing is asked through it, and a vault its settings do not
//     show is `vault-open-cli-silent` (the plugin shows the vault open);
//   - not running: the vault is added to its settings file, which is written
//     only while no Obsidian runs (registerVaultInObsidianSettings). An app
//     that started just after that write may have read its list before it, and
//     would then not find the vault by path: that is answered, never launched.
//
// A vault inside a folder the list has as a vault already is never added
// (`vault-inside-another-vault`): the app would show its notes in that vault
// too, and a call run in its folder would reach that vault.
//
// { ok: true, path, how, vaults } with the path the app knows the vault by and
// the list it was found in, or { ok: false, reason }.
//
// The window the app opens for an added vault takes the next command-line
// call while it may still be loading, and can then answer that a command
// does not exist yet: the list is asked again, a bounded number of times,
// before an addition counts as not verified.
const VERIFY_ATTEMPTS = 10
async function ensureAppKnowsVault({ registry, observation, vaultRoot, sleep, pollMs }) {
  const inside = (vaults) => enclosingVaults({ vaults, vaultRoot }).length > 0
  if (observation.noVaultOpen === true) {
    const settings = await attempt(() => registry.readSettings())
    const vaults = settings?.ok === true ? settings.vaults : null
    const entry = findVaultEntry(vaults, vaultRoot)
    if (entry) return { ok: true, path: entry.path, how: 'listed', vaults }
    return { ok: false, reason: inside(vaults) ? 'vault-inside-another-vault' : observation.fromPlugin === true ? 'vault-open-cli-silent' : 'no-vault-open' }
  }
  if (observation.answering === true) {
    const listed = await attempt(() => registry.listThroughApp())
    if (listed?.answered !== true) return { ok: false, reason: listed?.reason === 'no-vault-open' ? 'no-vault-open' : 'app-did-not-list-its-vaults' }
    const known = findVaultEntry(listed.vaults, vaultRoot)
    if (known) return { ok: true, path: known.path, how: 'listed', vaults: listed.vaults }
    if (inside(listed.vaults)) return { ok: false, reason: 'vault-inside-another-vault' }
    const asked = await attempt(() => registry.registerThroughApp({ vaultRoot }))
    if (asked?.answered !== true && asked?.reason === 'no-vault-open') return { ok: false, reason: 'no-vault-open' }
    if (asked?.answered === true && asked.result !== true) return { ok: false, reason: 'app-refused-registration' }
    // An addition that was not answered (a call that timed out, say) may still have been made: the list tells.
    for (let attempts = 1; ; attempts += 1) {
      const again = await attempt(() => registry.listThroughApp())
      const added = again?.answered === true ? findVaultEntry(again.vaults, vaultRoot) : null
      if (added) return { ok: true, path: added.path, how: 'added-through-app', vaults: again.vaults }
      if (attempts >= VERIFY_ATTEMPTS) return { ok: false, reason: asked?.answered === true ? 'registration-not-verified' : 'addition-not-answered' }
      await sleep(pollMs)
    }
  }
  const written = await attempt(() => registry.registerInSettings({ vaultRoot }))
  if (written === null) return { ok: false, reason: 'obsidian-settings-unwritable' }
  if (written.ok !== true) return { ok: false, reason: typeof written.code === 'string' ? written.code : 'obsidian-settings-unwritable' }
  if (written.confirmed !== true) return { ok: false, reason: written.reason === 'registration-not-read-back' ? 'registration-not-read-back' : 'app-started-during-registration' }
  return { ok: true, path: written.entry.path, how: written.registered === 'already' ? 'listed' : 'added-to-settings', vaults: written.vaults }
}

// Starts or reconnects the owned service, asks it for a tick, reads the view
// back, qualifies the app, makes the app know the vault, has it opened, asks
// again for a view the app kept from being published, and reports one outcome.
export async function openScopeForOracleTests(options = {}, rules = OPENING_PRIMITIVES, lifecycleRules = LIFECYCLE_PRIMITIVES) {
  const {
    loadProject, dataRoot, scopeId: requestedScope, appProbe, launcher, registry, service = {}, consent, allowStale = false, extensions = null,
    tickTimeoutMs = 120 * 1000, appWaitMs = 30 * 1000, appPollMs = 500, sleep = defaultSleep, monotonic = () => Date.now(),
    env = process.env, platform = process.platform, probeTimeoutMs,
  } = options
  if (typeof loadProject !== 'function') throw new TypeError('open needs loadProject')
  // No defaults: reaching an app or the operating system is a decision of the entry that composes this.
  if (typeof appProbe?.inspect !== 'function' || typeof appProbe?.vaultState !== 'function') throw new TypeError('open needs an injected appProbe')
  if (typeof launcher?.open !== 'function') throw new TypeError('open needs an injected launcher')
  if (!REGISTRY_OPERATIONS.every((name) => typeof registry?.[name] === 'function')) throw new TypeError('open needs an injected registry')
  if (typeof service.entryPath !== 'string') throw new TypeError('open needs the service entry it may start')

  const project = loadProject()
  const enablement = readObsidianEnablement(project)
  const applyAvailable = extensions !== null && extensions.applyOperation() !== UNAVAILABLE_APPLY_OPERATION
  const finish = (outcome, extra = {}) => {
    const { afterOpen = false, ...shown } = extra
    return { ok: outcome === 'current', ...describeOutcome(outcome), next: nextStep(outcome, shown.reason, { afterOpen }), launched: false, ...shown }
  }
  if (enablement.state === 'disabled') return finish('disabled', { reason: enablement.reason, scopeId: requestedScope ?? null })
  const scopeId = resolveScope(enablement, requestedScope)
  const lifecycle = { loadProject, dataRoot, env, platform, ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }) }

  // 1. The owned service: reconnect, or start. Never adopt; a runtime of ours is replaced only when it runs an earlier
  //    release, under the consent already recorded, when a tick is asked of it (requestServiceTick).
  let status = await serviceStatus(lifecycle, lifecycleRules)
  if (status.state === 'busy') return finish('busy', { scopeId, reason: status.reason, service: { state: status.state } })
  // How a login item took part in starting the service (started through it, refreshed, or not used and why).
  let loginItem = null
  if (status.state !== 'healthy') {
    let started
    try {
      started = await startService({ ...lifecycle, detached: true, ...service, ...(consent === undefined ? {} : { consent }) }, lifecycleRules)
    } catch (error) {
      if (!(error instanceof ObsidianMaintenanceRefusal)) throw error
      return finish('service-unavailable', { scopeId, reason: error.code, service: { state: status.state } })
    }
    loginItem = started.loginItem ?? null
    const item = loginItem === null ? {} : { loginItem }
    if (started.state === 'busy') return finish('busy', { scopeId, reason: started.reason, service: { state: 'busy', started: started.started, ...item } })
    if (started.state !== 'healthy') return finish('service-unavailable', { scopeId, reason: started.reason ?? started.state, service: { state: started.state, ...item } })
    status = started
  }
  let runtimeId = status.record?.runtimeId ?? null
  let restarted = null
  const workspace = resolveServiceWorkspace({ project, dataRoot, env, platform })
  const report = (freshnessOverride) => scopeReport({ workspace, scopeId, repositoryRoots: protectedRoots(project), serviceState: 'healthy', applyAvailable, ...(freshnessOverride === undefined ? {} : { freshness: freshnessOverride }) }, rules)

  // A tick that starts after this request, bounded, which prepares and publishes this view once more, and the view as
  // it left it. { view, serviceShown } or { answer }.
  const tickAndReport = async () => {
    const asked = await requestServiceTick({ ...lifecycle, tickTimeoutMs, scopeId, service }, lifecycleRules)
    if (asked.restarted) restarted = asked.restarted
    if (typeof asked.runtimeId === 'string') runtimeId = asked.runtimeId
    const serviceShown = { state: asked.state, runtimeId, ...(restarted === null ? {} : { restarted }), ...(loginItem === null ? {} : { loginItem }) }
    if (asked.state === 'busy') return { answer: { outcome: 'busy', extra: { scopeId, reason: asked.reason, service: serviceShown } } }
    if (!asked.requested) return { answer: { outcome: 'service-unavailable', extra: { scopeId, reason: asked.reason, service: serviceShown } } }
    let view = report()
    const tick = asked.pending ? null : asked.tick
    if (asked.pending && view.outcome === 'current') view = { ...view, ...describeOutcome('updating'), reason: 'tick-still-running' }
    else if (!asked.pending && tick?.state === 'busy') return { answer: { outcome: 'busy', extra: { scopeId, reason: 'engine-lock-held', service: serviceShown } } }
    else if (!asked.pending && (tick === null || tick.ok !== true || tick.state !== 'ticked') && view.outcome === 'current') {
      // The tick after this request did not complete: what was current before is not proven current now.
      view = { ...view, ...describeOutcome('stale-readable'), reason: `tick-${tick?.state ?? tick?.error?.code ?? 'unanswered'}` }
    }
    return { view, serviceShown }
  }
  const shownOf = (view, serviceShown) => ({ scopeId, reason: view.reason, service: serviceShown, freshness: view.freshness, readBack: view.readBack, pendingEdits: view.pendingEdits })

  // 2. The view, after a tick.
  const first = await tickAndReport()
  if (first.answer) return finish(first.answer.outcome, first.answer.extra)
  let { view } = first
  let common = shownOf(view, first.serviceShown)
  // A view the app kept from being published goes on: the app is made to hold the vault, and the view asked for again.
  const readable = allowStale && READABLE.has(view.outcome) && view.readBack.readable
  const keptByApp = view.outcome !== 'current' && rules.keptByApp(view)
  if (view.outcome !== 'current' && !readable && !keptByApp) return finish(view.outcome, common)

  // 3. The app, before anything is launched. With no vault open it answers nothing; a vault it already lists can still be opened by path.
  const before = qualifyApp(await inspectApp(appProbe), { requireVersion: false })
  const app = (qualification) => ({ outcome: qualification.outcome, reason: qualification.reason, version: qualification.version, floor: qualification.floor })
  const noVaultOpen = before.reason === 'no-vault-open'
  if (!rules.appQualifies(before) && !noVaultOpen) {
    // No app answered and none is known to run (a process table that could not be read, on Linux any app on a system
    // Electron): for a view that app kept, the view's own reason says what to do.
    if (keptByApp && !readable && before.running !== true && before.version === null) return finish(view.outcome, { ...common, app: app(before), afterOpen: true })
    return finish(before.outcome, { ...common, reason: before.reason, app: app(before) })
  }

  // 4. The app knows this vault as one of its vaults: the folder the view is published into, wherever that is. Every
  //    call about it then reaches it and no other vault: in its folder, or by its id when a vault listed at a folder
  //    above it would take a call run there.
  const { vaultRoot } = view
  if (typeof vaultRoot !== 'string') return finish('not-prepared', { ...common, reason: 'no-vault-folder', app: app(before) })
  // A version Atelier's plugin reported is not the command line answering (withPluginReportedVersion).
  const fromPlugin = before.versionSource === 'plugin'
  const known = await ensureAppKnowsVault({ registry, observation: { answering: typeof before.version === 'string' && !fromPlugin, noVaultOpen: noVaultOpen || fromPlugin, fromPlugin }, vaultRoot, sleep, pollMs: appPollMs })
  // An app that answered its version and then closed its last vault window is one with no vault open; one that holds
  // this vault open but whose command line does not answer has no usable command line.
  if (!known.ok) return finish(known.reason === 'no-vault-open' ? 'app-version-unsupported' : known.reason === 'vault-open-cli-silent' ? 'app-cli-unavailable' : 'launch-failed', { ...common, reason: known.reason, app: app(before) })
  const registration = { how: known.how }
  const route = vaultRoute({ vaults: known.vaults, vaultRoot })
  // Open in several windows, one per entry of the list that names its folder: each holds the vault, and a publication
  // coordinates with one only. Nothing is launched; the entries are named.
  if (route.how === 'duplicated') return finish('publisher-conflict', { ...common, reason: 'vault-open-in-several-windows', duplicates: route.entries, app: app(before), registration })
  if (route.how !== 'folder' && route.how !== 'id') return finish('launch-failed', { ...common, reason: route.how === 'ambiguous' ? 'vault-inside-another-vault' : 'registration-not-verified', app: app(before), registration })

  // 5. Launch, then wait, bounded, for the app to answer for exactly this vault.
  let launch
  // A quit app is started plainly and handed the vault once it answers, so the vaults its list flags open come back
  // (launch-plan.mjs).
  // The id only where the route found it reaches this vault first (another vault's folder name may equal an id);
  // otherwise the vault's own path, which the app matches exactly since the folder is listed.
  const target = route.how === 'id' ? { vaultId: route.id, vaultPath: known.path } : { vaultPath: known.path }
  try { launch = await launcher.open({ vaultRoot: known.path, ...target, appRunning: before.running === true }) } catch { launch = { launched: false, reason: 'launcher-threw' } }
  if (launch?.launched !== true) return finish('launch-failed', { ...common, reason: typeof launch?.reason === 'string' ? launch.reason : 'launcher-refused', app: app(before), registration })
  const deadline = monotonic() + appWaitMs
  let after = before
  let vault = { answered: false, indexReady: false }
  for (;;) {
    after = qualifyApp(await inspectApp(appProbe), { requireVersion: true })
    // A running app below the floor is final; an app that has not come up yet, or not yet opened a vault, is asked again.
    if (!rules.appQualifies(after) && !NOT_UP_YET.has(after.reason)) return finish(after.outcome, { ...common, launched: true, reason: after.reason, app: app(after), registration })
    if (rules.appQualifies(after)) {
      try { vault = await appProbe.vaultState({ vaultRoot, route }) } catch { vault = { answered: false, indexReady: false } }
      if (vault?.answered === true && vault.indexReady === true) break
      // Only the command line answers for a vault. An app whose version still only Atelier's plugin reports gives no
      // answer there, and waiting changes nothing: its command line is what is missing, not a launch.
      if (vault?.answered !== true && after.versionSource === 'plugin') return finish('app-cli-unavailable', { ...common, launched: true, reason: 'vault-open-cli-silent', app: app(after), registration })
    }
    if (monotonic() >= deadline) break
    await sleep(appPollMs)
  }
  if (!rules.appQualifies(after)) return finish(after.outcome, { ...common, launched: true, reason: after.reason, app: app(after), registration })
  if (vault?.answered !== true) return finish('launch-failed', { ...common, launched: true, reason: 'app-did-not-answer-for-this-vault', app: app(after), registration })
  if (vault.indexReady !== true) return finish('indexing', { ...common, launched: true, reason: 'metadata-cache-not-ready', app: app(after), registration })

  // 6. The app holds the vault now: a view it kept from being published is asked for again, and published through it.
  if (keptByApp) {
    const second = await tickAndReport()
    if (second.answer) return finish(second.answer.outcome, { ...second.answer.extra, launched: true, app: app(after), registration })
    view = second.view
    common = shownOf(view, second.serviceShown)
    if (view.outcome !== 'current') return finish(view.outcome, { ...common, launched: true, app: app(after), registration, afterOpen: true })
  }

  // 7. Still what was verified? The launch took time.
  if (view.outcome !== 'current') return finish(view.outcome, { ...common, launched: true, app: app(after), registration })
  const again = report()
  if (again.outcome !== 'current') return finish(again.outcome, { ...common, launched: true, reason: again.reason, freshness: again.freshness, readBack: again.readBack, app: app(after), registration })
  return finish('current', { ...common, launched: true, app: app(after), registration })
}

// Production entry point: the production decisions, always.
export function openScope(options = {}) {
  return openScopeForOracleTests(options, OPENING_PRIMITIVES, LIFECYCLE_PRIMITIVES)
}
