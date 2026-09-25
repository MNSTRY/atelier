#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tty from 'node:tty'
import { fileURLToPath } from 'node:url'
import { AtelierDiagnosticError, resolveProjectConfig } from '../project/config.mjs'
import { ObsidianContractRefusal } from '../projection/obsidian/contracts.mjs'
import { applyPolicyDigest } from '../projection/obsidian/edits/policy.mjs'
import { MINIMUM_APP_VERSION, inspectApp } from '../runtime/obsidian/app-capability.mjs'
import { loadContributions } from '../runtime/obsidian/contributions.mjs'
import { isoTime } from '../runtime/obsidian/documents.mjs'
import { readObsidianEnablement } from '../runtime/obsidian/enablement.mjs'
import { ObsidianMaintenanceRefusal, refuse } from '../runtime/obsidian/errors.mjs'
import { BUILT_IN_OPERATIONS, UNAVAILABLE_APPLY_OPERATION, createObsidianRegistry } from '../runtime/obsidian/extension-points.mjs'
import { LIFECYCLE_PRIMITIVES, readServiceStatusDocument, requestServiceTick, serviceStatus, startService, stopService } from '../runtime/obsidian/lifecycle.mjs'
import {
  DECISIONS, ONLY_YOU_AUDIENCES, authorizeAutomaticApply, defaultMachineSettings, ensureWorkspaceIdentity, installApplyPolicy, protectedRoots,
  readInstalledApplyPolicy, readMachineSettings, revokeApplyPolicy, withDecision, writeMachineSettings,
} from '../runtime/obsidian/machine-settings.mjs'
import { APPLY_UNAVAILABLE, OPENING_OUTCOMES, OPENING_PRIMITIVES, REASON_NEXT, nextStep, openScopeForOracleTests, resolveScope, scopeReport } from '../runtime/obsidian/opening.mjs'
import { currentPluginChoice, writePluginChoice } from '../runtime/obsidian/plugin-choice.mjs'
import { pluginPresenceOf, turnPluginOnNext, withPluginReportedVersion } from '../runtime/obsidian/plugin-presence.mjs'
import { readServiceSettings, serviceNameFor, servicePaths } from '../runtime/obsidian/service-record.mjs'
import { resolveServiceWorkspace } from '../runtime/obsidian/service.mjs'
import { buildStartupAdapter } from '../runtime/obsidian/startup-adapters.mjs'
import { checkVaultParent, projectDisplayName, vaultFolderName } from '../runtime/obsidian/vault-location.mjs'
import { hasCommittedGeneration, vaultRootFor } from '../projection/obsidian/recovery/store.mjs'
import { obsidianSandboxedBuild, obsidianUserDataDir, readObsidianSettings } from '../projection/obsidian/publication/vault-list.mjs'

// `atelier obsidian <operation>`: status, views, audiences, apply policy, the
// owned maintenance service, and opening a view.
//
// Noninteractive: every input is an argument, nothing is ever asked. With
// `--json` exactly one JSON document is printed on stdout, for a refusal too.
//
// Exit codes: 0 done (for `open`: the view is current and open); 1 an error
// nobody typed; 2 a typed refusal or a usage error; 3 the operation ran and
// its answer is not success (any opening outcome but `current`, a service
// that did not start, a stop that was refused).
//
// Reaching the installed app or the operating system goes through seams
// (`appProbe`, `launcher`, `registry`, `service`). A caller passes them. The production
// seams are constructed only when this module runs as the real command-line
// entry (`production: true`) AND the adapter was selected: `--adapter=obsidian-cli`
// given now, or given once before and remembered in this workspace's machine
// settings (`selectAdapter`). A remembered adapter is never used under the test
// runner. There is no default.
//
// What a person decided is remembered per workspace on this machine
// (`atelier obsidian settings` shows it). The first start of the maintenance
// service records who allowed it: `--consent-actor ID`, or, for a person at a
// terminal, their account's name (`isInteractive`).

export const COMMAND_SCHEMA = 'atelier-obsidian-command/v1'
export const EXIT = Object.freeze({ ok: 0, error: 1, refused: 2, notSuccess: 3 })
export { BUILT_IN_OPERATIONS }
const PRODUCTION_ADAPTER = 'obsidian-cli'
const MAX_POLICY_BYTES = 64 * 1024
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const USAGE = `Usage: atelier obsidian <operation> [--project atelier.project.json] [--data-root DIR] [--json] [--no-input]

  status                               Enablement, machine settings, service and per-view freshness. Read-only.
  settings                             What this machine remembers for this workspace, and how to change it. Read-only.
  scope list | scope show ID           The views this project declares. Read-only.
  audience show | set me|A,B | clear   The audiences this machine lets into a view (private; none by default).
                                       \`me\` is only you: every audience but sensitive, which is added by name.
  location show | set DIR [--allow-synced-location]
                                       Where this workspace's vaults live, as "<project> (<view>)"; each is allocated
                                       there at its first publication. A vault published already stays where it is.
  mode show | set manual|automatic     Whether queued edits wait for a person or are applied under the policy.
  policy show | install FILE | revoke  The private apply policy. Automatic mode needs an installed, active one.
  policy digest FILE                   The digest FILE has to carry to be installed. Reads FILE; writes nothing.
  service start [--consent-actor ID] [--adapter=${PRODUCTION_ADAPTER}]
  service status | stop                The owned maintenance service of this workspace.
  service unit --print [--adapter=${PRODUCTION_ADAPTER}]
                                       Print an operating-system startup unit. Writes and installs nothing.
  open [--scope ID] [--consent-actor ID] [--allow-stale] [--adapter=${PRODUCTION_ADAPTER}]
                                       Start or reconnect maintenance, verify the view, add it to Obsidian and open it.
  plugin show [--scope ID]             Whether Atelier's plugin is on in a view's vault, and whether it holds it open.
  plugin on [--scope ID] [--adapter=${PRODUCTION_ADAPTER}]
                                       Offer Atelier's plugin again in a vault where it was turned off; a running
                                       service publishes the view at once (with --adapter, one of an earlier release
                                       is replaced first).

Reaching the installed app needs --adapter=${PRODUCTION_ADAPTER} once for a workspace; it is remembered after that.
The first start of the maintenance service records who allows it: --consent-actor ID, or, for a person at a terminal,
their account's name. --no-input, --json, a CI environment or ATELIER_NONINTERACTIVE=1 mean no person is at a terminal.

Contributed operations, registered by the modules shipped under src/runtime/obsidian/contributions/:
  apply list | show EDIT | run EDIT [--actor ID] | recover
                                       Pending edits, and the explicit apply of one of them to its source file.
  conflicts [ID]                       The shared conflict state of edited objects. Read-only.
  apply-policy create FILE | show | revoke
                                       Build, digest and install an apply policy from a JSON request; show it; revoke it.
  selection resolve ID | persist ID [allow-empty] | show ID | list
                                       The exact selected set of a declared view; persisted in Atelier state.
  proposals list | show OPERATION      Structural edits routed as copy-only proposals. Read-only.
\`status\` lists the operations this command registered under "operations".

Opening outcomes: ${Object.keys(OPENING_OUTCOMES).join(', ')}.
Pending edits additionally report ${APPLY_UNAVAILABLE} while no apply operation is registered.
Minimum Obsidian version: ${MINIMUM_APP_VERSION}.
Exit codes: 0 done; 1 internal error; 2 refusal or usage; 3 ran, and the answer is not success.`

const FLAGS = Object.freeze({ json: 'flag', 'allow-stale': 'flag', print: 'flag', help: 'flag', 'no-input': 'flag', 'allow-synced-location': 'flag', project: 'value', 'project-config': 'value', 'data-root': 'value', scope: 'value', 'consent-actor': 'value', actor: 'value', adapter: 'value', 'wait-ms': 'value' })

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

// Which adapter this run may use, or a typed refusal. Pure. `flag` is --adapter as given; `remembered` is the adapter
// this workspace's machine settings remember (or null); `production` says this module runs as the real command-line
// entry. A remembered adapter is used only by the real entry, and never under the test runner: a test that reaches an
// app names the adapter, and runs where no app of the developer's can be reached.
export function selectAdapter({ flag, remembered = null, production = false, env = process.env } = {}) {
  if (flag !== undefined) {
    if (flag !== PRODUCTION_ADAPTER) refuse('app-adapter-not-selected', `no editor adapter is called ${String(flag).slice(0, 40)}; the only one is ${PRODUCTION_ADAPTER}`)
    return { adapter: PRODUCTION_ADAPTER, source: 'flag' }
  }
  if (remembered === PRODUCTION_ADAPTER && production === true) {
    if (env.NODE_TEST_CONTEXT !== undefined) refuse('remembered-adapter-under-test', 'a remembered adapter is never used under the test runner; pass the seams, or the adapter explicitly')
    return { adapter: PRODUCTION_ADAPTER, source: 'remembered' }
  }
  return refuse('app-adapter-not-selected', 'no editor adapter was selected; reaching the installed app is never a default')
}

// Whether a person is at a terminal: nothing says otherwise, and both standard input and output are one. Pure.
// `terminal` is `{ stdin, stdout }`, each true when that stream is a terminal.
export function isInteractive({ flags = {}, env = process.env, terminal = { stdin: false, stdout: false } } = {}) {
  if (flags.json === true || flags['no-input'] === true) return false
  if (env.ATELIER_NONINTERACTIVE === '1') return false
  if (typeof env.CI === 'string' && env.CI !== '' && env.CI !== 'false' && env.CI !== '0') return false
  return terminal.stdin === true && terminal.stdout === true
}

// The account's name as an actor identifier, or null when it is not one.
export const accountActor = (username) => (typeof username === 'string' && IDENTIFIER.test(username) ? username : null)

// How each remembered answer is changed; null where no command changes it.
const DECISION_CHANGES = Object.freeze({
  audience: '`atelier obsidian audience set me|A,B` decides who may see the vaults again',
  location: '`atelier obsidian location set DIR` decides where the vaults of views not published yet live',
  loginItem: null,
  adapter: null,
  consent: '`atelier obsidian service stop`, then `service start --consent-actor ID`, records another actor',
})
const SOURCE_WORDS = Object.freeze({ question: 'answered at a terminal', command: 'given on the command line', defaults: 'the defaults', v1: 'set before this release' })

// One remembered answer in words, with when and how it was given.
function decisionWords(name, decision, audienceAllow = []) {
  if (decision === null) return name === 'audience' && audienceAllow.length === 0 ? 'not decided; no audience is allowed, so every view is empty' : 'not decided'
  const what = name === 'audience'
    ? `${decision.choice === 'only-you' ? `only you (${audienceAllow.join(', ')})` : audienceAllow.length === 0 ? 'no audience: every view is empty' : audienceAllow.join(', ')}; notes without a classification ${decision.unclassified}`
    : name === 'location' ? decision.parent : decision.choice
  return `${what} (${SOURCE_WORDS[decision.via]}, ${decision.decidedAt}${decision.decidedBy === null ? '' : `, by ${decision.decidedBy}`})`
}

function decisionSummary(decisions) {
  const words = {
    audience: (decision) => `who may see ${decision.choice === 'only-you' ? 'only you' : 'a list of audiences'}`,
    location: (decision) => `vaults in ${decision.parent}`,
    loginItem: (decision) => `start at login ${decision.choice}`,
    adapter: (decision) => `app through ${decision.choice}`,
  }
  const decided = DECISIONS.filter((name) => decisions[name] !== null)
  return decided.length === 0 ? 'nothing yet' : decided.map((name) => words[name](decisions[name])).join('; ')
}

function accountName() {
  try { return os.userInfo().username } catch { return null }
}

function parse(argv) {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h') { flags.help = true; continue }
    if (!arg.startsWith('--')) { positionals.push(arg); continue }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2)
    if (!Object.hasOwn(FLAGS, name)) refuse('usage', `unknown option --${name}`)
    if (FLAGS[name] === 'flag') { if (inline !== undefined) refuse('usage', `--${name} takes no value`); flags[name] = true; continue }
    const value = inline ?? argv[index += 1]
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) refuse('usage', `--${name} needs a value`)
    flags[name] = value
  }
  return { positionals, flags }
}

const isTyped = (error) => error instanceof ObsidianMaintenanceRefusal || error instanceof AtelierDiagnosticError || error instanceof ObsidianContractRefusal
const plainMessage = (error) => String(error.message ?? '').replace(new RegExp(`^${error.code}: `), '')
const NEXT = Object.freeze({
  usage: 'run `atelier obsidian --help`',
  'seams-required': 'pass the seams, or run the real command-line entry',
  'app-adapter-not-selected': `pass --adapter=${PRODUCTION_ADAPTER} to let this command reach the installed app; it is remembered for this workspace`,
  'remembered-adapter-under-test': `a test passes its own seams, or --adapter=${PRODUCTION_ADAPTER} with a HOME that leads to no app of the developer's`,
  'startup-consent-required': 'pass --consent-actor ID to record who allows the maintenance service to run (at a terminal, your account\'s name is recorded)',
  'automatic-mode-refused': 'install an active automatic policy with `obsidian policy install FILE`',
  [APPLY_UNAVAILABLE]: 'no apply operation is registered on this command; edits stay preserved and queued',
  'policy-digest-mismatch': 'set the "digest" member of the file to the expected digest (`obsidian policy digest FILE` prints it), then install again',
  disabled: 'declare the Obsidian settings in the project configuration',
})

// The decisions the command's oracles are sensitive to are those of opening and of the lifecycle; tests substitute
// broken ones here to prove the oracles can fail. `runObsidianCommand` always uses the production ones.
export async function runObsidianCommandForOracleTests(options = {}, rules = {}) {
  const openingRules = rules.opening ?? OPENING_PRIMITIVES
  const lifecycleRules = rules.lifecycle ?? LIFECYCLE_PRIMITIVES
  const {
    argv = [], seams = null, production = false, env = process.env, cwd = process.cwd(), platform = process.platform, clock = () => new Date(),
    stdout = (text) => process.stdout.write(`${text}\n`), stderr = (text) => process.stderr.write(`${text}\n`), contributions = null, contributionsDirectory,
    // Whether standard input and output are terminals, and the name of the account this runs as. A test injects both;
    // under the test runner the process's own terminal is never looked at.
    terminal = env.NODE_TEST_CONTEXT === undefined ? { stdin: tty.isatty(0), stdout: tty.isatty(1) } : { stdin: false, stdout: false },
    account = accountName,
    // The home folder a location is read against (`~/`) and checked for sync clients; a test names its own.
    homedir = env.NODE_TEST_CONTEXT === undefined ? os.homedir() : null,
  } = options
  let json = argv.includes('--json')
  let operationName = null
  const emit = ({ exit, document, human }) => {
    const complete = { schema: COMMAND_SCHEMA, ok: exit === EXIT.ok, operation: operationName, ...document }
    if (json) stdout(JSON.stringify(complete, null, 2))
    else for (const line of human ?? [JSON.stringify(complete, null, 2)]) (exit === EXIT.ok ? stdout : stderr)(line)
    return exit
  }
  try {
    const { positionals, flags } = parse(argv)
    json = flags.json === true
    operationName = positionals[0] ?? null
    if (flags.help === true || operationName === null || operationName === 'help') { operationName = 'help'; return emit({ exit: EXIT.ok, document: { usage: USAGE }, human: [USAGE] }) }
    // Nothing runs without a decision about the seams: a caller that forgot them never falls through to a real app.
    if (seams === null && production !== true) refuse('seams-required', 'no seams were passed and this is not the real command-line entry')

    const dataRoot = flags['data-root'] === undefined ? options.dataRoot : path.resolve(cwd, flags['data-root'])
    const configFlag = flags.project ?? flags['project-config']
    const loadProject = options.loadProject ?? (() => resolveProjectConfig({ argv: configFlag === undefined ? [] : [`--project=${path.resolve(cwd, configFlag)}`], cwd, env, writeLocalState: false }))
    const registry = createObsidianRegistry({ reservedOperations: BUILT_IN_OPERATIONS, contributions: contributions ?? await loadContributions(contributionsDirectory === undefined ? {} : { directory: contributionsDirectory }) })
    const applyAvailable = registry.extensions.applyOperation() !== UNAVAILABLE_APPLY_OPERATION
    const lifecycle = { loadProject, dataRoot, env, platform, ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }) }

    // The adapter of this run: given now, or remembered by this workspace (read only when the real entry has no flag).
    const chooseAdapter = () => selectAdapter({ flag: flags.adapter, remembered: flags.adapter === undefined && production === true ? rememberedAdapter() : null, production, env })
    const serviceSeam = async () => {
      if (seams !== null) { if (typeof seams.service?.entryPath !== 'string') refuse('seams-required', 'the service seam names the entry this command may start'); return seams.service }
      chooseAdapter()
      const { SERVICE_ENTRY_PATH } = await import('../runtime/obsidian/service-entry-path.mjs')
      return { entryPath: SERVICE_ENTRY_PATH, entryArgs: [`--adapter=${PRODUCTION_ADAPTER}`] }
    }
    const appSeams = async () => {
      if (seams !== null) return { appProbe: seams.appProbe, launcher: seams.launcher, registry: seams.registry }
      chooseAdapter()
      const { createProductionAppSeams } = await import('../runtime/obsidian/app-production-seams.mjs')
      return createProductionAppSeams({ env, platform })
    }
    // The app's vault list, read only, for a check of where vaults may live: through the app when it runs and answers,
    // else from its settings file. { source: 'app' | 'file' | 'none', vaults } ('none': the app never ran here), or
    // { source: 'unread', vaults: null, reason }. The app is reached only with the adapter (given or remembered, or the
    // caller's seams); without it, only the file is read, and never under the test runner.
    const appVaultList = async () => {
      const quietly = async (read) => { try { return await read() } catch { return null } }
      const reach = seams !== null ? seams : adapterSelected() ? await appSeams() : null
      const registry = reach?.registry ?? null
      if (registry !== null && reach.appProbe !== undefined) {
        const seen = await inspectApp(reach.appProbe)
        if (seen.running === true && typeof seen.version === 'string') {
          const listed = await quietly(() => registry.listThroughApp())
          if (listed?.answered === true) return { source: 'app', vaults: listed.vaults }
        }
      }
      const settings = registry !== null ? await quietly(() => registry.readSettings())
        : env.NODE_TEST_CONTEXT !== undefined ? { ok: false, code: 'app-vault-list-under-test' }
          : obsidianSandboxedBuild({ platform, env }) !== null ? { ok: false, code: 'obsidian-sandboxed' }
            : readObsidianSettings({ userDataDir: obsidianUserDataDir({ platform, env }) })
      if (settings?.ok === true) return { source: 'file', vaults: settings.vaults ?? {} }
      if (settings?.code === 'obsidian-settings-missing') return { source: 'none', vaults: {} }
      return { source: 'unread', vaults: null, reason: typeof settings?.code === 'string' ? settings.code : 'obsidian-settings-unreadable' }
    }
    // Whether this run may reach the installed app: --adapter given, or remembered by the workspace for the real entry.
    const adapterSelected = () => { try { chooseAdapter(); return true } catch (error) { if (isTyped(error)) return false; throw error } }
    // Atelier's plugin as the running service sees it, for one view. A vault that turned it off says so from its own list
    // and the private record too, whether or not the service runs.
    const pluginView = (running, workspace, scopeId) => {
      const presence = pluginPresenceOf(running, scopeId)
      if (presence.present || workspace === null || currentPluginChoice({ ...workspace, scopeId }).state !== 'off') return presence
      return { present: false, reason: 'turned-off-in-this-vault', next: turnPluginOnNext(scopeId) }
    }
    const pluginOf = async (scopeId) => pluginPresenceOf((await readServiceStatusDocument(lifecycle, lifecycleRules)).document, scopeId)
    const pluginLine = (plugin) => (plugin.present ? `; plugin present (Obsidian ${plugin.appVersion})` : plugin.reason === 'turned-off-in-this-vault' ? '; plugin turned off in this vault' : `; plugin not present (${plugin.reason})`)

    const configured = () => {
      const project = loadProject()
      const enablement = readObsidianEnablement(project)
      if (enablement.reason === 'not-configured') refuse('disabled', 'this project declares no Obsidian settings')
      return { project, enablement }
    }
    // Private state of this workspace, created on demand for an operation that writes it.
    const writable = () => {
      const { project, enablement } = configured()
      ensureWorkspaceIdentity({ project, ...(dataRoot === undefined ? {} : { dataRoot }) })
      const workspace = resolveServiceWorkspace({ project, dataRoot, env, platform, create: true })
      return { project, enablement, workspace, repositoryRoots: protectedRoots(project), now: isoTime(clock) }
    }
    const readable = () => {
      const project = loadProject()
      const enablement = readObsidianEnablement(project)
      const workspace = enablement.reason === 'not-configured' ? null : resolveServiceWorkspace({ project, dataRoot, env, platform })
      return { project, enablement, workspace: workspace?.workspaceRoot ? workspace : null, workspaceId: workspace?.workspaceId ?? null }
    }
    const machineOf = (workspace) => (workspace === null ? null : readMachineSettings(workspace))
    const rememberedAdapter = () => machineOf(readable().workspace)?.decisions.adapter?.choice ?? null
    const interactive = isInteractive({ flags, env, terminal })
    // Who allows the maintenance service to run, for a start this run may make: --consent-actor; else, for a person at a
    // terminal and only while this workspace has no consent recorded, their account's name. A derived consent never
    // replaces a recorded one. `source` says which.
    const consentOfThisRun = () => {
      if (flags['consent-actor'] !== undefined) return { consent: { actor: flags['consent-actor'], coverage: 'service' }, source: 'flag' }
      if (!interactive) return { consent: undefined, source: null }
      const { workspace } = readable()
      if (workspace !== null && readServiceSettings(workspace) !== null) return { consent: undefined, source: null }
      const actor = accountActor(account())
      // `derived`: the start records it only while no consent is recorded, checked again under the start lock.
      return actor === null ? { consent: undefined, source: null } : { consent: { actor, coverage: 'service', derived: true }, source: 'account' }
    }
    // --adapter, given to an operation that starts or reaches the service of an enabled project, is remembered the first
    // time: the workspace is prepared and the decision written before anything starts, so no later run needs the flag.
    // Answers whether this run remembered it.
    // Remembering never stands in the way of the operation: a workspace that cannot be prepared refuses the operation
    // itself, which says so in its own terms.
    const rememberAdapter = (decidedBy) => {
      if (flags.adapter !== PRODUCTION_ADAPTER) return false
      try {
        if (readable().enablement.state !== 'enabled') return false
        const { workspace, repositoryRoots, now } = writable()
        const current = machineOf(workspace) ?? defaultMachineSettings({ workspaceId: workspace.workspaceId, updatedAt: now })
        if (current.decisions.adapter?.choice === PRODUCTION_ADAPTER) return false
        const decided = withDecision(current, 'adapter', { choice: PRODUCTION_ADAPTER }, { decidedAt: now, decidedBy: decidedBy ?? accountActor(account()), via: 'command' })
        writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...decided, updatedAt: now } })
        return true
      } catch (error) {
        if (isTyped(error)) return false
        throw error
      }
    }
    // What a run that starts or reaches the service says about what it remembered, in the document and in words.
    const rememberedLines = ({ adapterRemembered, consent }) => [
      ...(consent.source === 'account' ? [`The maintenance service is allowed by ${consent.consent.actor}, this account; recorded for this workspace.`] : []),
      ...(adapterRemembered ? [`Remembered for this workspace: the app is reached through ${PRODUCTION_ADAPTER}; --adapter is not needed again.`] : []),
    ]
    const shownMachine = (machine, workspace) => {
      const settings = machine ?? defaultMachineSettings({ workspaceId: workspace?.workspaceId ?? 'ws-unprepared', updatedAt: isoTime(clock) })
      const automatic = workspace === null ? { authorized: false, reason: 'machine-settings-absent' } : authorizeAutomaticApply(workspace)
      return {
        maintenanceMode: settings.maintenanceMode, audienceAllow: settings.audienceAllow, applyPolicy: settings.applyPolicy, automaticApply: { authorized: automatic.authorized, reason: automatic.reason },
        decisions: settings.decisions,
      }
    }
    // After a run that may have started the service: whether the consent it derived is the one now recorded.
    const consentRecorded = (consent) => {
      if (consent.source !== 'account') return consent
      const { workspace } = readable()
      const recorded = workspace === null ? null : readServiceSettings(workspace)
      return recorded?.consent.actor === consent.consent.actor ? consent : { consent: undefined, source: null }
    }
    const applyShown = { available: applyAvailable, state: applyAvailable ? 'available' : APPLY_UNAVAILABLE, operationId: registry.extensions.applyOperation().id }
    const [, sub, value] = positionals

    // Where a view's vault is, or will be: { path, origin }. A view the next tick will place is shown where it would go,
    // if that name is still free then (`to-be-allocated`).
    const vaultWhere = (workspace, scopeId, decided, projectName) => {
      if (workspace === null) return { path: null, origin: 'workspace-not-prepared' }
      const found = vaultRootFor({ ...workspace, scopeId })
      if (found.origin === 'legacy-data-root' && decided !== null && !hasCommittedGeneration({ ...workspace, scopeId })) {
        return { path: path.join(decided.parent, vaultFolderName({ projectName, scopeId })), origin: 'to-be-allocated' }
      }
      return { path: found.path, origin: found.origin }
    }

    const operations = {
      async status() {
        const { project, enablement, workspace, workspaceId } = readable()
        const service = enablement.reason === 'not-configured' ? { state: 'stopped', reason: 'not-configured' } : await serviceStatus(lifecycle, lifecycleRules)
        const running = service.state === 'healthy' ? (await readServiceStatusDocument(lifecycle, lifecycleRules)).document : null
        // What the service last learned about the app, and what a person can do about it.
        const app = running?.app ? { ...running.app, next: running.app.outcome === 'qualified' ? null : nextStep(running.app.outcome, running.app.reason) } : null
        const scopes = workspace === null
          ? enablement.scopes.map(({ scopeId }) => ({ scopeId, outcome: enablement.state === 'disabled' ? 'disabled' : 'not-prepared', reason: enablement.state === 'disabled' ? enablement.reason : 'workspace-not-prepared' }))
          : enablement.scopes.map(({ scopeId }) => {
            const { vaultRoot: _vault, summary: _summary, ...found } = scopeReport({ workspace, scopeId, repositoryRoots: protectedRoots(project), serviceState: service.state, applyAvailable }, openingRules)
            // A view whose vault the next tick allocates elsewhere says where, not the data root it will not use.
            const report = found.vault?.origin === 'legacy-data-root' ? { ...found, vault: vaultWhere(workspace, scopeId, machineOf(workspace)?.decisions.location ?? null, projectDisplayName(project)) } : found
            const plugin = pluginView(running, workspace, scopeId)
            return enablement.state === 'disabled' ? { ...report, outcome: 'disabled', reason: enablement.reason, next: OPENING_OUTCOMES.disabled.next, plugin } : { ...report, plugin }
          })
        const document = {
          enablement: { state: enablement.state, reason: enablement.reason, defaultScopeId: enablement.defaultScopeId }, workspace: { workspaceId, prepared: workspace !== null },
          machine: shownMachine(machineOf(workspace), workspace), apply: applyShown,
          service: { state: service.state, reason: service.reason ?? null, address: service.address ?? null, runtimeId: service.record?.runtimeId ?? null, pid: service.record?.pid ?? null, lastTick: running?.lastTick ?? null, lastError: running?.lastError ?? null, app },
          app: { probed: false, minimumVersion: MINIMUM_APP_VERSION }, scopes, extensions: registry.extensions.describe(), operations: registry.operations.describe(),
        }
        return {
          exit: EXIT.ok, document,
          human: [
            `obsidian: ${enablement.state} (${enablement.reason}); mode ${document.machine.maintenanceMode}; audiences ${document.machine.audienceAllow.join(', ') || 'none'}`,
            `remembered: ${decisionSummary(document.machine.decisions)}`,
            `service: ${service.state} (${service.reason ?? 'no reason'})${app ? `; app ${app.outcome} (${app.reason})` : ''}`,
            ...(app?.next ? [`Next for the app: ${app.next}`] : []),
            `apply: ${applyShown.state}`,
            ...scopes.flatMap((scope) => [
              `view ${scope.scopeId}: ${scope.outcome} (${scope.reason})${scope.pendingEdits?.open ? `; ${scope.pendingEdits.open} pending edit(s), apply ${scope.pendingEdits.apply}` : ''}${scope.plugin ? pluginLine(scope.plugin) : ''}`,
              ...(scope.plugin?.next ? [`  Next for the plugin: ${scope.plugin.next}`] : []),
              ...(scope.diagnostics ?? []).map((item) => `  ${item.notePath ?? item.filePath ?? item.assetPath ?? item.nodeId ?? ''}: ${item.code}${item.rule ? ` (${item.rule})` : ''}`),
            ]),
          ],
        }
      },

      // What this machine remembers for this workspace, and how each answer is changed. Read-only.
      async settings() {
        const { workspace, workspaceId } = readable()
        const { audienceAllow, decisions } = shownMachine(machineOf(workspace), workspace)
        const service = workspace === null ? null : readServiceSettings(workspace)
        const consent = service === null ? null : service.consent
        const document = { workspace: { workspaceId, prepared: workspace !== null }, decisions, audienceAllow, consent, change: DECISION_CHANGES }
        return {
          exit: EXIT.ok, document,
          human: [
            `who may see: ${decisionWords('audience', decisions.audience, audienceAllow)}`,
            `where vaults live: ${decisionWords('location', decisions.location)}`,
            `start at login: ${decisionWords('loginItem', decisions.loginItem)}`,
            `reaching the app: ${decisionWords('adapter', decisions.adapter)}`,
            `maintenance allowed by: ${consent === null ? 'nobody yet' : `${consent.actor} (${consent.coverage}, since ${consent.grantedAt})`}`,
            ...Object.values(DECISION_CHANGES).filter((change) => change !== null).map((change) => `Change: ${change}`),
          ],
        }
      },

      // Where this workspace's vaults live. Deciding it places the vaults of views not published yet; a vault published
      // already, under the data root or where an earlier decision placed it, stays where it is.
      async location() {
        const where = vaultWhere
        const views = (project, enablement, workspace, decided) => enablement.scopes.map(({ scopeId }) => ({ scopeId, ...where(workspace, scopeId, decided, projectDisplayName(project)) }))
        const lines = (list) => list.map((view) => `view ${view.scopeId}: ${view.path ?? 'no vault yet'} (${view.origin})`)
        if (sub === 'show' || sub === undefined) {
          const { project, enablement, workspace } = readable()
          const { decisions } = shownMachine(machineOf(workspace), workspace)
          const shown = views(project, enablement, workspace, decisions.location)
          return { exit: EXIT.ok, document: { location: decisions.location, views: shown }, human: [`where vaults live: ${decisionWords('location', decisions.location)}`, ...lines(shown)] }
        }
        if (sub !== 'set' || value === undefined) refuse('usage', 'location show | location set DIR [--allow-synced-location]')
        // `~/` is read against the home folder, which a shell does not do after `--x=`; under the test runner a home
        // folder is only ever one the test named.
        const tilde = value === '~' || value.startsWith('~/')
        if (tilde && typeof homedir !== 'string') refuse('real-vault-location-under-test', 'a location under the home folder is never used under the test runner; name an absolute folder')
        const parent = tilde ? path.join(homedir, value.slice(1)) : path.resolve(cwd, value)
        const { project, enablement, workspace, repositoryRoots, now } = writable()
        const allocatedPaths = enablement.scopes.map(({ scopeId }) => vaultRootFor({ ...workspace, scopeId })).filter((found) => found.origin === 'allocated').map((found) => found.path)
        // A folder inside, or holding, a vault the app lists is refused now; when the list cannot be read, it is checked
        // again, and has to be read, before any vault is allocated there.
        const list = await appVaultList()
        const warnings = checkVaultParent({ parent, workspaceRoot: workspace.workspaceRoot, repositoryRoots, vaults: list.vaults, allocatedPaths, allowSynced: flags['allow-synced-location'] === true, homedir: homedir ?? undefined, platform })
        const appVaultListShown = { source: list.source, ...(list.reason === undefined ? {} : { reason: list.reason }) }
        const current = machineOf(workspace) ?? defaultMachineSettings({ workspaceId: workspace.workspaceId, updatedAt: now })
        const decided = withDecision(current, 'location', { parent }, { decidedAt: now, decidedBy: accountActor(account()), via: 'command' })
        writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...decided, updatedAt: now } })
        const placed = views(project, enablement, workspace, decided.decisions.location)
        return {
          exit: EXIT.ok, document: { location: decided.decisions.location, warnings, appVaultList: appVaultListShown, views: placed, takesEffect: 'next-tick' },
          human: [
            `where vaults live: ${parent}; a view's vault is allocated there at its first publication, as "${projectDisplayName(project)} (<view>)"`,
            ...(warnings.synced === null ? [] : [`Warning: ${warnings.synced} keeps this folder in step with other machines.`]),
            ...(warnings.protected === null ? [] : [`Warning: macOS asks before Obsidian or the maintenance service may read your ${warnings.protected} folder.`]),
            ...(list.source === 'unread' ? [`Obsidian's vault list could not be read (${list.reason}); no vault is allocated there until it can be, and it is checked again then.`] : []),
            ...lines(placed),
          ],
        }
      },

      async scope() {
        const { enablement } = readable()
        if (sub === 'list' || sub === undefined) return { exit: EXIT.ok, document: { defaultScopeId: enablement.defaultScopeId, scopes: enablement.scopes }, human: enablement.scopes.map((scope) => `${scope.scopeId}\t${scope.mode}${scope.scopeId === enablement.defaultScopeId ? '\tdefault' : ''}`) }
        if (sub !== 'show' || value === undefined) refuse('usage', 'scope list | scope show ID')
        const scope = enablement.scopes.find((item) => item.scopeId === resolveScope(enablement, value))
        return { exit: EXIT.ok, document: { scope }, human: [JSON.stringify(scope, null, 2)] }
      },

      async audience() {
        if (sub === 'show' || sub === undefined) {
          const { workspace } = readable()
          const { audienceAllow, decisions } = shownMachine(machineOf(workspace), workspace)
          return { exit: EXIT.ok, document: { audienceAllow, choice: decisions.audience?.choice ?? null, unclassified: decisions.audience?.unclassified ?? 'withheld' }, human: [decisionWords('audience', decisions.audience, audienceAllow)] }
        }
        if (sub !== 'set' && sub !== 'clear') refuse('usage', 'audience show | audience set me|A,B | audience clear')
        const named = sub === 'clear' ? [] : String(value ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
        if (sub === 'set' && named.length === 0) refuse('usage', 'audience set needs at least one audience; `audience clear` allows none')
        if (named.some((item) => !AUDIENCE.test(item)) || new Set(named).size !== named.length || named.length > 64) refuse('invalid-audience', 'audiences are distinct identifiers, at most 64')
        // `me` stands for "only you". Named beside other audiences, it adds its own to theirs, and the list is the person's own choice.
        const audienceAllow = [...new Set(named.flatMap((item) => (item === 'me' ? ONLY_YOU_AUDIENCES : [item])))]
        const choice = named.length === 1 && named[0] === 'me' ? 'only-you' : 'custom'
        const { workspace, repositoryRoots, now } = writable()
        const current = machineOf(workspace) ?? defaultMachineSettings({ workspaceId: workspace.workspaceId, updatedAt: now })
        const changed = JSON.stringify(current.audienceAllow) !== JSON.stringify(audienceAllow)
        // Notes without a classification stay withheld: no release shows them yet.
        const decided = withDecision({ ...current, audienceAllow }, 'audience', { choice, unclassified: 'withheld' }, { decidedAt: now, decidedBy: accountActor(account()), via: 'command' })
        writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...decided, updatedAt: now } })
        // The engine compares a digest of these on every tick: a change invalidates every view at the next one.
        return {
          exit: EXIT.ok, document: { audienceAllow, choice, unclassified: 'withheld', changed, takesEffect: 'next-tick' },
          human: [`audiences: ${choice === 'only-you' ? `only you (${audienceAllow.join(', ')})` : audienceAllow.join(', ') || 'none'}; notes without a classification withheld; views are rebuilt at the next tick`],
        }
      },

      async mode() {
        if (sub === 'show' || sub === undefined) {
          const { workspace } = readable()
          const { maintenanceMode, automaticApply } = shownMachine(machineOf(workspace), workspace)
          return { exit: EXIT.ok, document: { maintenanceMode, automaticApply, apply: applyShown }, human: [`${maintenanceMode}; automatic apply ${automaticApply.authorized ? 'authorized' : `not authorized (${automaticApply.reason})`}; apply ${applyShown.state}`] }
        }
        if (sub !== 'set' || !['manual', 'automatic'].includes(value)) refuse('usage', 'mode show | mode set manual|automatic')
        const { workspace, repositoryRoots, now } = writable()
        const current = machineOf(workspace) ?? writeMachineSettings({ ...workspace, repositoryRoots, settings: defaultMachineSettings({ workspaceId: workspace.workspaceId, updatedAt: now }) })
        if (value === 'automatic') {
          const would = authorizeAutomaticApply({ ...workspace, assumeAutomatic: true })
          if (!would.authorized) refuse('automatic-mode-refused', 'automatic mode needs an installed, matching, active automatic policy; nothing was changed', { reason: would.reason })
        }
        writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...current, maintenanceMode: value, updatedAt: now } })
        return { exit: EXIT.ok, document: { maintenanceMode: value, apply: applyShown }, human: [`mode: ${value}${value === 'automatic' && !applyAvailable ? `; every apply reports ${APPLY_UNAVAILABLE} while no apply operation is registered` : ''}`] }
      },

      async policy() {
        if (sub === 'show' || sub === undefined) {
          const { workspace } = readable()
          const policy = workspace === null ? null : readInstalledApplyPolicy(workspace)
          const { applyPolicy, automaticApply } = shownMachine(machineOf(workspace), workspace)
          return { exit: EXIT.ok, document: { installed: policy !== null, reference: applyPolicy, policy, automaticApply }, human: [policy === null ? 'no apply policy is installed' : `${policy.policyId} v${policy.version} ${policy.mode} ${policy.status}; automatic apply ${automaticApply.authorized ? 'authorized' : `not authorized (${automaticApply.reason})`}`] }
        }
        const readPolicyFile = () => {
          if (value === undefined) refuse('usage', `policy ${sub} FILE`)
          const file = path.resolve(cwd, value)
          try {
            if (fs.statSync(file).size > MAX_POLICY_BYTES) refuse('invalid-apply-policy', 'the policy file is larger than a policy can be')
            return JSON.parse(fs.readFileSync(file, 'utf8'))
          } catch (error) {
            if (error instanceof ObsidianMaintenanceRefusal) throw error
            return refuse('invalid-apply-policy', 'the policy file cannot be read as JSON', { cause: error.code ?? 'not-json' })
          }
        }
        if (sub === 'digest') {
          // Read-only: the digest of the canonical form of FILE, for a person or an agent to fill in. Nothing is installed.
          const policy = readPolicyFile()
          if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) refuse('invalid-apply-policy', 'a policy is a JSON object')
          const digest = applyPolicyDigest(policy)
          const carried = typeof policy.digest === 'string' ? policy.digest : null
          return { exit: EXIT.ok, document: { digest, carried, matches: carried === digest }, human: [digest, carried === digest ? 'the file carries this digest' : 'set the "digest" member of the file to this value, then run `policy install FILE`'] }
        }
        if (sub === 'install') {
          const policy = readPolicyFile()
          const { workspace, repositoryRoots, now } = writable()
          // Validated against the frozen contract, its digest verified, and stored owner-only beside the machine settings, outside every repository and vault.
          installApplyPolicy({ ...workspace, policy, repositoryRoots, updatedAt: now, digestOf: applyPolicyDigest })
          return { exit: EXIT.ok, document: { installed: true, reference: { policyId: policy.policyId, version: policy.version, digest: policy.digest }, status: policy.status, mode: policy.mode }, human: [`installed ${policy.policyId} v${policy.version} (${policy.mode}, ${policy.status}); the maintenance mode is unchanged`] }
        }
        if (sub !== 'revoke') refuse('usage', 'policy show | policy install FILE | policy digest FILE | policy revoke')
        const { workspace, repositoryRoots, now } = writable()
        const result = revokeApplyPolicy({ ...workspace, repositoryRoots, updatedAt: now })
        return { exit: EXIT.ok, document: { revoked: result.revoked, reason: result.reason, maintenanceMode: 'manual' }, human: [result.revoked ? 'revoked; no queued edit is applied from now on, and the mode is manual' : 'no apply policy was installed'] }
      },

      async service() {
        const shown = ({ child: _child, ...result }) => result
        if (sub === 'status' || sub === undefined) {
          const status = await serviceStatus(lifecycle, lifecycleRules)
          return { exit: EXIT.ok, document: { service: status }, human: [`${status.state} (${status.reason})`] }
        }
        if (sub === 'start') {
          configured()
          const seam = await serviceSeam()
          const consent = consentOfThisRun()
          const adapterRemembered = rememberAdapter(consent.consent?.actor)
          const result = shown(await startService({ ...lifecycle, detached: true, ...seam, ...(consent.consent === undefined ? {} : { consent: consent.consent }) }, lifecycleRules))
          const recorded = consentRecorded(consent)
          const running = result.state === 'healthy' || result.state === 'busy'
          return {
            exit: running ? EXIT.ok : EXIT.notSuccess,
            document: { service: result, rememberedNow: { adapter: adapterRemembered, consentActor: recorded.source === 'account' ? recorded.consent.actor : null } },
            human: [
              result.state === 'busy' ? 'running, and busy in a long tick; nothing was started beside it' : `${result.state}${result.started ? ' (started)' : result.alreadyRunning ? ' (already running)' : ` (${result.reason})`}`,
              ...rememberedLines({ adapterRemembered, consent: recorded }),
            ],
          }
        }
        if (sub === 'stop') {
          const result = await stopService(lifecycle, lifecycleRules)
          return { exit: result.refused ? EXIT.notSuccess : EXIT.ok, document: { service: result }, human: [result.refused ? `not stopped: ${result.state} (${result.reason})${result.retry ? '; ask again in a moment' : ''}` : result.stopped ? 'stopped' : `nothing to stop (${result.reason})`] }
        }
        if (sub !== 'unit' || flags.print !== true) refuse('usage', 'service start | status | stop | unit --print (installing a startup unit is not offered here)')
        const { project, workspace } = readable()
        if (workspace === null) refuse('service-workspace-not-prepared', 'this workspace has no private state yet; `service start` prepares it')
        const seam = await serviceSeam()
        // Pure text from the builder. Nothing is written, installed or handed to a service manager.
        const unit = buildStartupAdapter({
          platform, label: serviceNameFor(workspace.workspaceId), nodePath: process.execPath, entryPath: seam.entryPath, logPath: servicePaths(workspace.workspaceRoot).log,
          args: [`--project=${project.configPath}`, ...(dataRoot === undefined ? [] : [`--data-root=${dataRoot}`]), ...(seam.entryArgs ?? [])],
        })
        return { exit: EXIT.ok, document: { unit, installed: false, note: 'running this unit needs a recorded consent that covers operating-system startup' }, human: [unit.text] }
      },

      async open() {
        const seam = await serviceSeam()
        const app = await appSeams()
        const { appProbe } = app
        const consent = consentOfThisRun()
        const adapterRemembered = rememberAdapter(consent.consent?.actor)
        // The view whose plugin may report the app version; an unknown one is refused by open itself.
        const requested = () => { try { return resolveScope(readObsidianEnablement(loadProject()), flags.scope) } catch { return null } }
        const result = await openScopeForOracleTests({
          ...lifecycle, ...app,
          appProbe: typeof appProbe?.inspect === 'function' && typeof appProbe?.vaultState === 'function' ? withPluginReportedVersion(appProbe, async () => { const scopeId = requested(); return scopeId === null ? null : pluginOf(scopeId) }) : appProbe,
          service: seam, scopeId: flags.scope, consent: consent.consent, allowStale: flags['allow-stale'] === true, extensions: registry.extensions,
          ...(flags['wait-ms'] === undefined ? {} : { tickTimeoutMs: Number(flags['wait-ms']) || undefined }), ...(options.open ?? {}),
        }, openingRules, lifecycleRules)
        const recorded = consentRecorded(consent)
        const { ok: _ok, ...opened } = result
        const plugin = typeof result.scopeId === 'string' ? await pluginOf(result.scopeId) : null
        const rememberedNow = { adapter: adapterRemembered, consentActor: recorded.source === 'account' ? recorded.consent.actor : null }
        const document = plugin === null ? { ...opened, rememberedNow } : { ...opened, plugin, rememberedNow }
        return {
          exit: result.ok ? EXIT.ok : EXIT.notSuccess, document,
          human: [
            `${result.outcome}: ${result.summary}${result.reason ? ` (${result.reason})` : ''}${plugin ? pluginLine(plugin) : ''}`, `Next: ${result.next}`, ...(result.service?.restarted ? [`service: restarted (${result.service.restarted})`] : []),
            ...(result.duplicates ? [`open in Obsidian as: ${result.duplicates.map((entry) => entry.path).join(', ')}`] : []), ...(result.pendingEdits?.open ? [`${result.pendingEdits.open} pending edit(s); apply ${result.pendingEdits.apply}`] : []),
            ...rememberedLines({ adapterRemembered, consent: recorded }),
          ],
        }
      },

      // Atelier's plugin in the vault of a view: the person's choice (as recorded, or as the vault shows it before the next
      // publication records it), and whether a plugin holds the vault open. `on` records a request and asks a running
      // maintenance service for a tick that names the view, whose publication brings the entry and the plugin files back;
      // with no service running, the view's next publication does.
      async plugin() {
        if (sub !== undefined && sub !== 'show' && sub !== 'on') refuse('usage', 'plugin show [--scope ID] | plugin on [--scope ID]')
        if (sub === 'on') {
          const { enablement, workspace } = writable()
          const scopeId = resolveScope(enablement, flags.scope)
          const choice = writePluginChoice({ ...workspace, scopeId, state: 'requested', reason: 'requested-by-command', clock })
          // The request is recorded either way; a service that cannot be asked leaves it to the view's next publication.
          // With the installed entry to start (`--adapter`, given or remembered), a service of an earlier release still running after an upgrade
          // is replaced before its tick, under the consent already recorded, as `open` does; without it, it is reported.
          const replaceable = seams !== null || adapterSelected()
          let asked
          try { asked = await requestServiceTick({ ...lifecycle, scopeId, ...(replaceable ? { service: await serviceSeam() } : {}) }, lifecycleRules) } catch (error) { if (!isTyped(error)) throw error; asked = { requested: false, reason: error.code } }
          const view = asked.tick?.scopes?.find((scope) => scope.scopeId === scopeId) ?? null
          const takesEffect = view?.state === 'current' ? 'published' : asked.pending === true || view?.state === 'updating' ? 'publishing' : 'next-publication'
          const service = {
            asked: asked.requested === true, reason: asked.reason ?? asked.state ?? null, ...(asked.restarted ? { restarted: asked.restarted } : {}),
            ...(view === null ? {} : { view: { state: view.state, reason: view.reason } }),
          }
          const human = takesEffect === 'published'
            ? `view ${scopeId}: Atelier's plugin is requested and back: the maintenance service published the view again with its entry and its files; Obsidian runs it from the next time it opens the vault`
            : takesEffect === 'publishing'
              ? `view ${scopeId}: Atelier's plugin is requested; the maintenance service is publishing the view again, which brings its entry and its files back`
              : `view ${scopeId}: Atelier's plugin is requested; its entry and its files come back with the view's next publication (the next change at its sources, or when the maintenance service next starts)${service.asked ? ` (the service's tick: ${view ? `${view.state}, ${view.reason}` : service.reason})` : ''}`
          // A service this command could not ask: one of an earlier release it may replace (with `--adapter`), and one of a
          // later release it never replaces, which gets open's next step.
          const next = service.reason === 'service-outdated'
            ? `the running maintenance service is of an earlier release; run \`atelier obsidian plugin on --scope ${scopeId} --adapter=${PRODUCTION_ADAPTER}\` to replace it`
            : service.reason === 'service-other-release' ? REASON_NEXT['service-other-release'] : null
          return { exit: EXIT.ok, document: { scopeId, choice, takesEffect, service, ...(next === null ? {} : { next }) }, human: [human, ...(service.restarted ? [`service: restarted (${service.restarted})`] : []), ...(next === null ? [] : [`  Next: ${next}`])] }
        }
        const { enablement, workspace } = readable()
        const scopeIds = flags.scope === undefined ? enablement.scopes.map((scope) => scope.scopeId) : [resolveScope(enablement, flags.scope)]
        const service = enablement.reason === 'not-configured' ? { state: 'stopped' } : await serviceStatus(lifecycle, lifecycleRules)
        const running = service.state === 'healthy' ? (await readServiceStatusDocument(lifecycle, lifecycleRules)).document : null
        const plugins = scopeIds.map((scopeId) => ({
          scopeId, choice: workspace === null ? { state: 'undecided', reason: null, since: null } : currentPluginChoice({ ...workspace, scopeId }), presence: pluginView(running, workspace, scopeId),
        }))
        return {
          exit: EXIT.ok, document: { plugins },
          human: plugins.flatMap(({ scopeId, choice, presence }) => [`view ${scopeId}: plugin ${choice.state}${choice.pending ? ' (as the vault shows it; recorded at the view\'s next publication)' : ''}${pluginLine(presence)}`, ...(presence.next ? [`  Next: ${presence.next}`] : [])]),
        }
      },

      // The placeholder that answers when no contribution registered an apply operation; the shipped source-apply contribution replaces it.
      async apply() {
        return refuse(APPLY_UNAVAILABLE, 'no apply operation is registered; pending edits stay preserved and queued', { operationId: registry.extensions.applyOperation().id })
      },
    }

    const contributed = registry.operations.get(operationName)
    if (contributed === null && !Object.hasOwn(operations, operationName)) refuse('usage', `unknown operation: ${String(operationName).slice(0, 40)}`)
    // One option table serves every operation. No built-in operation has a use for an actor, and a contributed one takes
    // it only when it declares so (`options: ['actor']`); the apply operation then decides which of its verbs takes it.
    if (flags.actor !== undefined && !(Array.isArray(contributed?.options) && contributed.options.includes('actor'))) refuse('usage', '--actor belongs to `apply run`; this operation does not take it')
    const result = contributed !== null
      ? await contributed.run({ args: positionals.slice(1), flags: { ...flags }, registry, loadProject, dataRoot, env, platform, clock, readable, writable })
      : await operations[operationName]()
    if (result === null || typeof result !== 'object' || !Number.isInteger(result.exit) || result.document === null || typeof result.document !== 'object') refuse('invalid-extension', 'an operation answers { exit, document, human }')
    return emit(result)
  } catch (error) {
    if (!isTyped(error)) {
      if (env.ATELIER_DEBUG === '1') stderr(error?.stack ?? String(error))
      return emit({ exit: EXIT.error, document: { error: { code: 'internal-error', message: 'the command failed without a typed reason', next: 'rerun with ATELIER_DEBUG=1 to see the stack locally' } }, human: ['[internal-error] the command failed without a typed reason', 'Next: rerun with ATELIER_DEBUG=1 to see the stack locally'] })
    }
    const next = NEXT[error.code] ?? error.hint ?? 'see `atelier obsidian status`'
    return emit({ exit: EXIT.refused, document: { error: { code: error.code, message: plainMessage(error), next, detail: error.detail ?? {} } }, human: [`[${error.code}] ${plainMessage(error)}`, `Next: ${next}`] })
  }
}

// Production entry point: the production decisions, always.
export function runObsidianCommand(options = {}) {
  return runObsidianCommandForOracleTests(options, {})
}

export default runObsidianCommand

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (invokedDirectly) process.exitCode = await runObsidianCommand({ argv: process.argv.slice(2), production: true })
