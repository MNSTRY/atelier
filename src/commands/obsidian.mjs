#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import tty from 'node:tty'
import { fileURLToPath } from 'node:url'
import { AtelierDiagnosticError, resolveProjectConfig } from '../project/config.mjs'
import { ObsidianContractRefusal } from '../projection/obsidian/contracts.mjs'
import { applyPolicyDigest } from '../projection/obsidian/edits/policy.mjs'
import { MINIMUM_APP_VERSION } from '../runtime/obsidian/app-capability.mjs'
import { loadContributions } from '../runtime/obsidian/contributions.mjs'
import { isoTime } from '../runtime/obsidian/documents.mjs'
import { readObsidianEnablement } from '../runtime/obsidian/enablement.mjs'
import { ObsidianMaintenanceRefusal, refuse } from '../runtime/obsidian/errors.mjs'
import { BUILT_IN_OPERATIONS, UNAVAILABLE_APPLY_OPERATION, createObsidianRegistry } from '../runtime/obsidian/extension-points.mjs'
import { LIFECYCLE_PRIMITIVES, readServiceStatusDocument, requestServiceTick, runtimeRelease, serviceStatus, startService, stopService } from '../runtime/obsidian/lifecycle.mjs'
import {
  DECISIONS, ONLY_YOU_AUDIENCES, authorizeAutomaticApply, defaultMachineSettings, ensureWorkspaceIdentity, installApplyPolicy, localPointerPath, protectedRoots,
  readInstalledApplyPolicy, readMachineSettings, revokeApplyPolicy, withDecision, writeMachineSettings,
} from '../runtime/obsidian/machine-settings.mjs'
import {
  currentLoginItemPlan, installLoginItem, loginItemLabel, loginItemStarter, loginItemStatus, planLoginItem, projectNameOf, readLoginItemRecord, realNodePath,
  removeLoginItem, resolveLoginItemEntry, temporaryRoots,
} from '../runtime/obsidian/login-item.mjs'
import { APPLY_UNAVAILABLE, OPENING_OUTCOMES, OPENING_PRIMITIVES, REASON_NEXT, nextStep, openScopeForOracleTests, resolveScope, scopeReport } from '../runtime/obsidian/opening.mjs'
import { currentPluginChoice, writePluginChoice } from '../runtime/obsidian/plugin-choice.mjs'
import { pluginPresenceOf, turnPluginOnNext, withPluginReportedVersion } from '../runtime/obsidian/plugin-presence.mjs'
import { readServiceSettings } from '../runtime/obsidian/service-record.mjs'
import { resolveServiceWorkspace } from '../runtime/obsidian/service.mjs'
import { STARTUP_PLATFORMS, buildStartupAdapter, startupSearchPath } from '../runtime/obsidian/startup-adapters.mjs'
import { OBSIDIAN_SETTINGS_FILE, obsidianUserDataDir } from '../projection/obsidian/publication/vault-list.mjs'

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
  mode show | set manual|automatic     Whether queued edits wait for a person or are applied under the policy.
  policy show | install FILE | revoke  The private apply policy. Automatic mode needs an installed, active one.
  policy digest FILE                   The digest FILE has to carry to be installed. Reads FILE; writes nothing.
  service start [--consent-actor ID] [--adapter=${PRODUCTION_ADAPTER}]
  service status | stop                The owned maintenance service of this workspace.
  service unit --print [--adapter=${PRODUCTION_ADAPTER}]
                                       Print the login item (launchd agent, systemd user unit). Writes nothing.
  service unit --install [--consent-actor ID] [--adapter=${PRODUCTION_ADAPTER}]
                                       Install the login item: maintenance starts when you log in. macOS and Linux.
  service unit --remove                Remove the login item; the consent goes back to the service alone, and the
                                       service is started for this session only.
  open [--scope ID] [--consent-actor ID] [--allow-stale] [--adapter=${PRODUCTION_ADAPTER}]
                                       Start or reconnect maintenance, verify the view, add it to Obsidian and open it.
  uninstall                            Stop maintenance and remove the login item. Vaults, private state, the project
                                       file and Obsidian's vault list are kept, and where each is is printed.
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

const FLAGS = Object.freeze({
  json: 'flag', 'allow-stale': 'flag', print: 'flag', install: 'flag', remove: 'flag', help: 'flag', 'no-input': 'flag', project: 'value', 'project-config': 'value',
  'data-root': 'value', scope: 'value', 'consent-actor': 'value', actor: 'value', adapter: 'value', 'wait-ms': 'value',
})

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
  location: null,
  loginItem: '`atelier obsidian service unit --install` starts maintenance at login; `service unit --remove` stops that',
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
  'startup-platform-unqualified': 'a login item is offered on macOS and Linux; `atelier obsidian open` starts maintenance when you open a view',
  'startup-platform-unsupported': 'a login item is offered on macOS and Linux; `atelier obsidian open` starts maintenance when you open a view',
  'login-item-needs-installed-package': 'install @mnstry/atelier in the project (`npm i -D @mnstry/atelier`), then run the command there',
  'login-item-home-mismatch': 'run the command in your own session, with HOME set to your home directory',
  'real-login-item-under-test': 'a test passes its own service manager',
  'login-item-unavailable': 'no service manager of your session answered (on Linux: systemd --user); `atelier obsidian open` starts maintenance when you open a view',
  'login-item-install-failed': 'see `atelier obsidian status`; `atelier obsidian service unit --install` tries again',
  'login-item-remove-failed': 'see `atelier obsidian status`; `atelier obsidian service unit --remove` tries again',
  'login-item-file-unsafe': 'the login item\'s file is a link or not a regular file and is left alone; remove it by hand, then try again',
  'invalid-login-item': 'the login item record in private state does not validate; inspect it, remove it, then install the login item again',
})

// The login item of `status`, in words.
function loginItemWords(item, platform) {
  if (item.installed === null) return `unreadable (${item.reason})`
  if (item.installed === false) return 'off'
  const where = item.file
  if (item.programPresent === false) return `installed, but the Node or the package it runs is gone, so it cannot start: install @mnstry/atelier in the project, then \`atelier obsidian service unit --install\`, or remove it with \`service unit --remove\`; ${where}`
  return {
    loaded: `on (${item.running ? 'running' : 'loaded'}); ${where}`,
    'switched-off': `installed, ${platform === 'darwin' ? 'switched off in System Settings' : 'disabled'}; it does not start at login; ${where}`,
    'file-missing': `installed, but its file is gone: it does not start at login; \`atelier obsidian service unit --install\` puts it back; ${where}`,
    'not-loaded': `installed, not loaded by the service manager; it starts at the next login; ${where}`,
  }[item.state] ?? `installed; ${where}`
}

// What a start through the login item adds to the answer of `service start` and `open`.
function loginItemLines(item) {
  if (item === undefined || item === null) return []
  return [
    ...(item.refreshed === true ? ['login item refreshed: its unit is written as it would be now, and loaded again'] : []),
    ...(item.via === 'child' ? [`the login item did not start the service (${item.reason}); it was started for this session only`] : []),
  ]
}

// A start's answer in words: started, replaced, or already running, and which release when that is why it was kept.
function serviceWords(result) {
  if (result.replaced === 'outdated' && result.started) return `${result.state} (restarted: the service of an earlier release was replaced)`
  if (result.started) return `${result.state} (started)`
  if (result.alreadyRunning) {
    if (result.release === 'later') return `${result.state} (already running, a later release; it is not replaced by this one)`
    if (result.release === 'outdated') return `${result.state} (already running, an earlier release, not replaced: ${result.reason})`
    return `${result.state} (already running)`
  }
  return `${result.state} (${result.reason})`
}

// What `status` suggests after the login item did not start the service.
const LOGIN_ITEM_NEXT = Object.freeze({
  'startup-consent-absent': 'install it again with `atelier obsidian service unit --install --consent-actor ID`',
  'service-port-occupied': 'something else answers on the recorded port; see `atelier obsidian service status`',
  'service-settings-absent': 'install it again with `atelier obsidian service unit --install --consent-actor ID`',
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
    // The entry this command may start, and its arguments.
    const entrySeam = async () => {
      if (seams !== null) { if (typeof seams.service?.entryPath !== 'string') refuse('seams-required', 'the service seam names the entry this command may start'); return seams.service }
      chooseAdapter()
      const { SERVICE_ENTRY_PATH } = await import('../runtime/obsidian/service-entry-path.mjs')
      return { entryPath: SERVICE_ENTRY_PATH, entryArgs: [`--adapter=${PRODUCTION_ADAPTER}`] }
    }
    // The service manager of a login item: the caller's (`serviceManager`, or `seams.serviceManager`), or, for the real
    // command-line entry only, the production one, which refuses under the test runner and for a HOME that is not the
    // account's own. Without `required`, null where none can be had.
    const managerSeam = async ({ required = true } = {}) => {
      const given = options.serviceManager ?? seams?.serviceManager ?? null
      if (given !== null) return given
      if (seams !== null || production !== true) { if (required) refuse('seams-required', 'no service manager was passed for the login item'); return null }
      try {
        const { createProductionServiceManager } = await import('../runtime/obsidian/service-manager-production.mjs')
        return createProductionServiceManager({ platform, env })
      } catch (error) {
        if (!required && isTyped(error)) return null
        throw error
      }
    }
    const nodePath = () => options.nodePath ?? realNodePath()
    // The service seam: once this workspace has a login item, the service is started through its manager, running the
    // entry the item names; a unit that differs from what would be written now is written again on the way.
    const serviceSeam = async () => {
      const entry = await entrySeam()
      const { project, workspace } = readable()
      let record = null
      try { record = workspace === null ? null : readLoginItemRecord(workspace) } catch (error) { if (!isTyped(error)) throw error }
      if (record === null) return entry
      const manager = await managerSeam({ required: false })
      if (manager === null) return entry
      const plan = currentLoginItemPlan({ record, project, workspaceRoot: workspace.workspaceRoot, dataRoot, platform, ownEntry: entry.entryPath, entryArgs: entry.entryArgs ?? [], nodePath: nodePath() })
      // An item that names an entry that is gone, with nothing to refresh it to from here, cannot start anything.
      if (plan === null && !fs.existsSync(record.program.entry)) return entry
      return { ...entry, entryPath: plan?.program.entry ?? record.program.entry, loginItem: loginItemStarter({ workspace, manager, record, plan, clock }) }
    }
    const appSeams = async () => {
      if (seams !== null) return { appProbe: seams.appProbe, launcher: seams.launcher, registry: seams.registry }
      chooseAdapter()
      const { createProductionAppSeams } = await import('../runtime/obsidian/app-production-seams.mjs')
      return createProductionAppSeams({ env, platform })
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
    // With a login item installed, the service is started through it, so the consent covers startup too, or the item's
    // own start would be refused (`seam.loginItem`).
    const consentOfThisRun = (seam = null) => {
      const coverage = seam?.loginItem ? 'service-and-startup' : 'service'
      if (flags['consent-actor'] !== undefined) return { consent: { actor: flags['consent-actor'], coverage }, source: 'flag' }
      if (!interactive) return { consent: undefined, source: null }
      const { workspace } = readable()
      if (workspace !== null && readServiceSettings(workspace) !== null) return { consent: undefined, source: null }
      const actor = accountActor(account())
      // `derived`: the start records it only while no consent is recorded, checked again under the start lock.
      return actor === null ? { consent: undefined, source: null } : { consent: { actor, coverage, derived: true }, source: 'account' }
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

    // The login item's text as `--install` would write it now. Writes nothing and asks no service manager.
    const printUnit = async () => {
      const { project, workspace } = readable()
      if (workspace === null) refuse('service-workspace-not-prepared', 'this workspace has no private state yet; `service start` prepares it')
      const entry = await entrySeam()
      const record = readLoginItemRecord(workspace)
      const temporary = temporaryRoots()
      const { entryPath } = resolveLoginItemEntry({ project, ownEntry: entry.entryPath, temporary })
      const label = record?.label ?? loginItemLabel({ platform, projectName: projectNameOf(project), workspaceId: workspace.workspaceId })
      const { platform: unitPlatform, kind, fileName, text } = planLoginItem({
        platform, project, workspaceRoot: workspace.workspaceRoot, dataRoot, label, entryPath, entryArgs: entry.entryArgs ?? [], nodePath: nodePath(),
        searchPath: record?.searchPath ?? startupSearchPath(env.PATH, { temporary }),
      })
      return { exit: EXIT.ok, document: { unit: { platform: unitPlatform, kind, fileName, text }, installed: record !== null, note: 'the service runs under this unit only with a recorded consent that covers startup; `service unit --install` records one' }, human: [text] }
    }
    // Who allows the service to run at login, for `--install`: --consent-actor; else, for a person at a terminal, the
    // actor this workspace already recorded (its coverage is raised to startup), or the account's name when none is.
    // Asking for the login item at a terminal is that person's consent to it. A program names its actor.
    const startupConsent = () => {
      if (flags['consent-actor'] !== undefined) return { actor: flags['consent-actor'] }
      if (!interactive) return undefined
      const { workspace } = readable()
      const recorded = workspace === null ? null : readServiceSettings(workspace)
      const actor = recorded?.consent.actor ?? accountActor(account())
      return actor === null ? undefined : { actor }
    }
    // Installs the login item, then starts the service through it (launchd has usually started it already).
    const installUnit = async () => {
      configured()
      if (!STARTUP_PLATFORMS.includes(platform)) buildStartupAdapter({ platform })
      const entry = await entrySeam()
      const manager = await managerSeam()
      const consent = startupConsent()
      // A service of an earlier release still running would make the unit's own first start refuse (another runtime
      // answers): it is stopped as its owner stops it once the consent is recorded, just before the unit is loaded.
      let replaced = null
      const beforeInstall = async ({ entryPath }) => {
        if (runtimeRelease(await serviceStatus(lifecycle, lifecycleRules), entryPath) !== 'outdated') return
        if ((await stopService(lifecycle, lifecycleRules)).stopped) replaced = 'outdated'
      }
      const installed = await installLoginItem({
        loadProject, dataRoot, env, platform, manager, ownEntry: entry.entryPath, entryArgs: entry.entryArgs ?? [], nodePath: nodePath(), pathValue: env.PATH, clock, beforeInstall,
        ...(consent === undefined ? {} : { consent }),
      })
      if (!installed.installed) {
        // The earlier release was stopped for nothing: the installed one runs in its place for this session.
        const service = replaced === null ? null : (({ child: _child, ...result }) => result)(await startService({ ...lifecycle, detached: true, ...entry, replaceOutdated: true }, lifecycleRules))
        return {
          exit: EXIT.notSuccess, document: { loginItem: installed, ...(service === null ? {} : { service: { ...service, replaced } }) },
          human: [`login item not installed: ${installed.reason}${installed.message ? ` (${installed.message})` : ''}`, `Next: ${NEXT[installed.reason] ?? 'see `atelier obsidian status`'}`, ...(service === null ? [] : [`service: ${serviceWords({ ...service, replaced })}`])],
        }
      }
      const remembered = rememberLoginItem('on')
      const adapterRemembered = rememberAdapter(consent?.actor)
      const seam = await serviceSeam()
      const started = (({ child: _child, ...result }) => result)(await startService({ ...lifecycle, detached: true, ...seam, replaceOutdated: true }, lifecycleRules))
      const service = replaced === null || started.replaced !== undefined ? started : { ...started, replaced }
      const running = service.state === 'healthy' || service.state === 'busy'
      return {
        exit: running ? EXIT.ok : EXIT.notSuccess, document: { loginItem: installed, service, rememberedNow: { loginItem: remembered ? 'on' : null, adapter: adapterRemembered } },
        human: [
          `login item installed: ${installed.file}`, `it runs ${installed.entry.path}${installed.entry.source === 'project' ? ', the package installed in this project' : ''}`,
          ...(platform === 'darwin' ? ['macOS lists it as "node" under Login Items & Extensions, and may say "Background Items Added"'] : []),
          `service: ${serviceWords(service)}`, ...loginItemLines(service.loginItem),
          ...(consent !== undefined && flags['consent-actor'] === undefined ? [`Maintenance at login is allowed by ${consent.actor}; recorded for this workspace.`] : []),
          ...rememberedLines({ adapterRemembered, consent: { source: null } }),
        ],
      }
    }
    // Removes the login item. A service it ran is stopped as its manager unloads it, and is started again at once as a
    // process of its own for this session, under the consent now recorded (the service alone), so the vaults stay fresh
    // until the person logs out. That start needs the adapter, given or remembered; without it, `open` starts it.
    const removeUnit = async () => {
      if (!STARTUP_PLATFORMS.includes(platform)) buildStartupAdapter({ platform })
      const manager = await managerSeam()
      const removed = await removeLoginItem({ loadProject, dataRoot, env, platform, manager, clock })
      const failed = removed.removed !== true && removed.reason !== undefined && removed.reason !== 'workspace-not-prepared'
      if (failed) return { exit: EXIT.notSuccess, document: { loginItem: removed }, human: [`login item not removed: ${removed.reason}${removed.message ? ` (${removed.message})` : ''}`, `Next: ${NEXT[removed.reason] ?? 'see `atelier obsidian status`'}`] }
      const remembered = removed.reason === 'workspace-not-prepared' ? false : rememberLoginItem('off')
      let service = null
      if (removed.removed === true) {
        let entry = null
        try { entry = await entrySeam() } catch (error) { if (!isTyped(error)) throw error; service = { state: 'stopped', started: false, reason: error.code } }
        if (entry !== null) {
          try { service = (({ child: _child, ...result }) => result)(await startService({ ...lifecycle, detached: true, ...entry, replaceOutdated: true }, lifecycleRules)) } catch (error) {
            if (!isTyped(error)) throw error
            service = { state: 'stopped', started: false, reason: error.code }
          }
        }
      }
      service ??= await serviceStatus(lifecycle, lifecycleRules)
      const running = ['healthy', 'busy'].includes(service.state)
      return {
        exit: EXIT.ok, document: { loginItem: removed, service: { state: service.state, reason: service.reason ?? null, started: service.started === true }, rememberedNow: { loginItem: remembered ? 'off' : null } },
        human: [
          removed.removed ? `login item removed: ${removed.file}` : 'no login item was installed', 'the consent now covers the service alone',
          `service: ${service.state}${running ? (service.started ? ' (started for this session only; it does not start at login)' : '') : `${service.reason ? ` (${service.reason})` : ''}; \`atelier obsidian open\` starts it again`}`,
        ],
      }
    }
    // The person's answer to "start at login?", remembered for this workspace as the `loginItem` decision of its machine
    // settings, given on the command line. By whom: the actor named, else a person at a terminal by the account's name,
    // else nobody known. Answers whether it wrote; an answer already remembered is not written again.
    const rememberLoginItem = (choice) => {
      if (readable().enablement.reason === 'not-configured') return false
      const { workspace, repositoryRoots, now } = writable()
      const current = machineOf(workspace) ?? defaultMachineSettings({ workspaceId: workspace.workspaceId, updatedAt: now })
      if (current.decisions.loginItem?.choice === choice) return false
      const decidedBy = flags['consent-actor'] ?? (interactive ? accountActor(account()) : null)
      const decided = withDecision(current, 'loginItem', { choice }, { decidedAt: now, decidedBy, via: 'command' })
      writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...decided, updatedAt: now } })
      return true
    }
    // Where what `uninstall` keeps is: the vaults, the private state, the project file and Obsidian's vault list.
    const keptLocations = (project, workspace) => {
      const vaultsDirectory = workspace === null ? null : path.join(workspace.workspaceRoot, 'vaults')
      let vaults = []
      try { vaults = vaultsDirectory === null ? [] : fs.readdirSync(vaultsDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(vaultsDirectory, entry.name)).sort() } catch { vaults = [] }
      const userDataDir = obsidianUserDataDir({ platform, env })
      return { vaults, privateState: workspace?.workspaceRoot ?? null, projectFile: project.configPath ?? null, pointer: project.configPath ? localPointerPath(project) : null, obsidianList: userDataDir === null ? null : path.join(userDataDir, OBSIDIAN_SETTINGS_FILE) }
    }

    const operations = {
      async status() {
        const { project, enablement, workspace, workspaceId } = readable()
        const service = enablement.reason === 'not-configured' ? { state: 'stopped', reason: 'not-configured' } : await serviceStatus(lifecycle, lifecycleRules)
        const running = service.state === 'healthy' ? (await readServiceStatusDocument(lifecycle, lifecycleRules)).document : null
        // What the service last learned about the app, and what a person can do about it.
        const app = running?.app ? { ...running.app, next: running.app.outcome === 'qualified' ? null : nextStep(running.app.outcome, running.app.reason) } : null
        // The login item: its record, what its manager says (asked only when one is recorded), and how its last start ended.
        const item = workspace === null ? { installed: false, lastStartup: null } : await loginItemStatus({ workspace, manager: () => managerSeam({ required: false }) })
        const refusedAtLogin = item.lastStartup?.outcome === 'refused' && item.lastStartup.code !== 'service-already-running' && !['healthy', 'busy'].includes(service.state) ? item.lastStartup.code : null
        const loginItem = { ...item, didNotStart: refusedAtLogin, next: refusedAtLogin === null ? null : LOGIN_ITEM_NEXT[refusedAtLogin] ?? NEXT[refusedAtLogin] ?? 'see `atelier obsidian service status`, and the private log it names' }
        const scopes = workspace === null
          ? enablement.scopes.map(({ scopeId }) => ({ scopeId, outcome: enablement.state === 'disabled' ? 'disabled' : 'not-prepared', reason: enablement.state === 'disabled' ? enablement.reason : 'workspace-not-prepared' }))
          : enablement.scopes.map(({ scopeId }) => {
            const { vaultRoot: _vault, summary: _summary, ...report } = scopeReport({ workspace, scopeId, repositoryRoots: protectedRoots(project), serviceState: service.state, applyAvailable }, openingRules)
            const plugin = pluginView(running, workspace, scopeId)
            return enablement.state === 'disabled' ? { ...report, outcome: 'disabled', reason: enablement.reason, next: OPENING_OUTCOMES.disabled.next, plugin } : { ...report, plugin }
          })
        const document = {
          enablement: { state: enablement.state, reason: enablement.reason, defaultScopeId: enablement.defaultScopeId }, workspace: { workspaceId, prepared: workspace !== null },
          machine: shownMachine(machineOf(workspace), workspace), apply: applyShown,
          service: { state: service.state, reason: service.reason ?? null, address: service.address ?? null, runtimeId: service.record?.runtimeId ?? null, pid: service.record?.pid ?? null, lastTick: running?.lastTick ?? null, lastError: running?.lastError ?? null, app },
          loginItem, app: { probed: false, minimumVersion: MINIMUM_APP_VERSION }, scopes, extensions: registry.extensions.describe(), operations: registry.operations.describe(),
        }
        return {
          exit: EXIT.ok, document,
          human: [
            `obsidian: ${enablement.state} (${enablement.reason}); mode ${document.machine.maintenanceMode}; audiences ${document.machine.audienceAllow.join(', ') || 'none'}`,
            `remembered: ${decisionSummary(document.machine.decisions)}`,
            `service: ${service.state} (${service.reason ?? 'no reason'})${app ? `; app ${app.outcome} (${app.reason})` : ''}`,
            ...(app?.next ? [`Next for the app: ${app.next}`] : []),
            `login item: ${loginItemWords(loginItem, platform)}`,
            ...(refusedAtLogin === null ? [] : [`the login item did not start the service: ${refusedAtLogin}`, `Next: ${loginItem.next}`]),
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
          const consent = consentOfThisRun(seam)
          const adapterRemembered = rememberAdapter(consent.consent?.actor)
          const result = shown(await startService({ ...lifecycle, detached: true, ...seam, replaceOutdated: true, ...(consent.consent === undefined ? {} : { consent: consent.consent }) }, lifecycleRules))
          const recorded = consentRecorded(consent)
          const running = result.state === 'healthy' || result.state === 'busy'
          return {
            exit: running ? EXIT.ok : EXIT.notSuccess,
            document: { service: result, rememberedNow: { adapter: adapterRemembered, consentActor: recorded.source === 'account' ? recorded.consent.actor : null } },
            human: [
              result.state === 'busy' && !result.started ? 'running, and busy in a long tick; nothing was started beside it' : serviceWords(result),
              ...(result.release === 'later' ? [`Next: ${REASON_NEXT['service-other-release']}`] : []),
              ...rememberedLines({ adapterRemembered, consent: recorded }), ...loginItemLines(result.loginItem),
            ],
          }
        }
        if (sub === 'stop') {
          const result = await stopService(lifecycle, lifecycleRules)
          return { exit: result.refused ? EXIT.notSuccess : EXIT.ok, document: { service: result }, human: [result.refused ? `not stopped: ${result.state} (${result.reason})${result.retry ? '; ask again in a moment' : ''}` : result.stopped ? 'stopped' : `nothing to stop (${result.reason})`] }
        }
        if (sub !== 'unit' || [flags.print, flags.install, flags.remove].filter((flag) => flag === true).length !== 1) refuse('usage', 'service start | status | stop | unit --print | unit --install | unit --remove')
        if (flags.install === true) return installUnit()
        if (flags.remove === true) return removeUnit()
        return printUnit()
      },

      async open() {
        const seam = await serviceSeam()
        const app = await appSeams()
        const { appProbe } = app
        const consent = consentOfThisRun(seam)
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
            ...loginItemLines(result.service?.loginItem), ...(result.duplicates ? [`open in Obsidian as: ${result.duplicates.map((entry) => entry.path).join(', ')}`] : []), ...(result.pendingEdits?.open ? [`${result.pendingEdits.open} pending edit(s); apply ${result.pendingEdits.apply}`] : []),
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

      // Maintenance of this workspace ends here: the login item goes first, so its manager does not start the service
      // again, then the proven service stops. Everything a person made or may want back stays, and is named.
      async uninstall() {
        const project = loadProject()
        let workspace = null
        try { const found = resolveServiceWorkspace({ project, dataRoot, env, platform }); workspace = found?.workspaceRoot ? found : null } catch (error) { if (!isTyped(error)) throw error }
        const record = workspace === null ? null : readLoginItemRecord(workspace)
        const item = record === null ? { removed: false, reason: 'not-installed' } : await removeLoginItem({ loadProject, dataRoot, env, platform, manager: await managerSeam(), clock })
        const service = workspace === null ? { state: 'stopped', stopped: false, refused: false, reason: 'workspace-not-prepared' } : await stopService(lifecycle, lifecycleRules)
        const kept = keptLocations(project, workspace)
        const itemGone = item.removed === true || item.reason === 'not-installed' || item.reason === 'workspace-not-prepared'
        const serviceGone = service.stopped === true || service.state === 'stopped'
        const remembered = workspace !== null && itemGone ? rememberLoginItem('off') : false
        return {
          exit: itemGone && serviceGone ? EXIT.ok : EXIT.notSuccess,
          document: { loginItem: item, service, kept, rememberedNow: { loginItem: remembered ? 'off' : null } },
          human: [
            `login item: ${item.removed ? `removed (${item.file})` : item.reason === 'not-installed' || item.reason === 'workspace-not-prepared' ? 'none was installed' : `not removed (${item.reason})`}`,
            `service: ${service.stopped ? 'stopped' : service.refused ? `not stopped: ${service.state} (${service.reason})` : `not running (${service.reason})`}`,
            ...(itemGone && serviceGone ? [] : [`Next: ${!itemGone ? NEXT[item.reason] ?? 'run `atelier obsidian uninstall` again' : service.retry ? 'run `atelier obsidian uninstall` again in a moment' : 'see `atelier obsidian service status`'}`]),
            'Kept as they are:',
            ...kept.vaults.map((vault) => `  vault           ${vault}`),
            ...(kept.privateState === null ? [] : [`  private state   ${kept.privateState}`]),
            `  project file    ${kept.projectFile ?? '(none)'}; its Obsidian settings stay`,
            ...(kept.obsidianList === null ? [] : [`  Obsidian's list ${kept.obsidianList}; the vaults stay in it`]),
          ],
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
