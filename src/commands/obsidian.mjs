#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
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
import { LIFECYCLE_PRIMITIVES, readServiceStatusDocument, serviceStatus, startService, stopService } from '../runtime/obsidian/lifecycle.mjs'
import {
  authorizeAutomaticApply, defaultMachineSettings, ensureWorkspaceIdentity, installApplyPolicy, protectedRoots, readInstalledApplyPolicy, readMachineSettings,
  revokeApplyPolicy, writeMachineSettings,
} from '../runtime/obsidian/machine-settings.mjs'
import { APPLY_UNAVAILABLE, OPENING_OUTCOMES, OPENING_PRIMITIVES, nextStep, openScopeForOracleTests, resolveScope, scopeReport } from '../runtime/obsidian/opening.mjs'
import { serviceNameFor, servicePaths } from '../runtime/obsidian/service-record.mjs'
import { resolveServiceWorkspace } from '../runtime/obsidian/service.mjs'
import { buildStartupAdapter } from '../runtime/obsidian/startup-adapters.mjs'

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
// (`appProbe`, `launcher`, `service`). A caller passes them. The production
// seams are constructed only when this module runs as the real command-line
// entry (`production: true`) AND `--adapter=obsidian-cli` was given, the same
// explicit rule the service entry has; there is no default.

export const COMMAND_SCHEMA = 'atelier-obsidian-command/v1'
export const EXIT = Object.freeze({ ok: 0, error: 1, refused: 2, notSuccess: 3 })
export { BUILT_IN_OPERATIONS }
const PRODUCTION_ADAPTER = 'obsidian-cli'
const MAX_POLICY_BYTES = 64 * 1024
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const USAGE = `Usage: atelier obsidian <operation> [--project atelier.project.json] [--data-root DIR] [--json]

  status                               Enablement, machine settings, service and per-view freshness. Read-only.
  scope list | scope show ID           The views this project declares. Read-only.
  audience show | set A,B | clear      The audiences this machine lets into a view (private; none by default).
  mode show | set manual|automatic     Whether queued edits wait for a person or are applied under the policy.
  policy show | install FILE | revoke  The private apply policy. Automatic mode needs an installed, active one.
  policy digest FILE                   The digest FILE has to carry to be installed. Reads FILE; writes nothing.
  service start [--consent-actor ID] --adapter=${PRODUCTION_ADAPTER}
  service status | stop                The owned maintenance service of this workspace.
  service unit --print --adapter=${PRODUCTION_ADAPTER}
                                       Print an operating-system startup unit. Writes and installs nothing.
  open [--scope ID] [--consent-actor ID] [--allow-stale] --adapter=${PRODUCTION_ADAPTER}
                                       Start or reconnect maintenance, verify the view, open it in Obsidian.

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

const FLAGS = Object.freeze({ json: 'flag', 'allow-stale': 'flag', print: 'flag', help: 'flag', project: 'value', 'project-config': 'value', 'data-root': 'value', scope: 'value', 'consent-actor': 'value', actor: 'value', adapter: 'value', 'wait-ms': 'value' })

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
  'app-adapter-not-selected': `pass --adapter=${PRODUCTION_ADAPTER} to let this command reach the installed app`,
  'startup-consent-required': 'pass --consent-actor ID to record who allows the maintenance service to run',
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

    const serviceSeam = async () => {
      if (seams !== null) { if (typeof seams.service?.entryPath !== 'string') refuse('seams-required', 'the service seam names the entry this command may start'); return seams.service }
      if (flags.adapter !== PRODUCTION_ADAPTER) refuse('app-adapter-not-selected', 'no editor adapter was selected; a service that reaches the installed app is never a default')
      const { SERVICE_ENTRY_PATH } = await import('../runtime/obsidian/service-entry-path.mjs')
      return { entryPath: SERVICE_ENTRY_PATH, entryArgs: [`--adapter=${PRODUCTION_ADAPTER}`] }
    }
    const appSeams = async () => {
      if (seams !== null) return { appProbe: seams.appProbe, launcher: seams.launcher }
      if (flags.adapter !== PRODUCTION_ADAPTER) refuse('app-adapter-not-selected', 'no editor adapter was selected; reaching the installed app is never a default')
      const { createProductionAppSeams } = await import('../runtime/obsidian/app-production-seams.mjs')
      return createProductionAppSeams({ env, platform })
    }

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
    const consent = flags['consent-actor'] === undefined ? undefined : { actor: flags['consent-actor'], coverage: 'service' }
    const shownMachine = (machine, workspace) => {
      const settings = machine ?? { maintenanceMode: 'manual', audienceAllow: [], applyPolicy: null }
      const automatic = workspace === null ? { authorized: false, reason: 'machine-settings-absent' } : authorizeAutomaticApply(workspace)
      return { maintenanceMode: settings.maintenanceMode, audienceAllow: settings.audienceAllow, applyPolicy: settings.applyPolicy, automaticApply: { authorized: automatic.authorized, reason: automatic.reason } }
    }
    const applyShown = { available: applyAvailable, state: applyAvailable ? 'available' : APPLY_UNAVAILABLE, operationId: registry.extensions.applyOperation().id }
    const [, sub, value] = positionals

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
            const { vaultRoot: _vault, summary: _summary, ...report } = scopeReport({ workspace, scopeId, repositoryRoots: protectedRoots(project), serviceState: service.state, applyAvailable }, openingRules)
            return enablement.state === 'disabled' ? { ...report, outcome: 'disabled', reason: enablement.reason, next: OPENING_OUTCOMES.disabled.next } : report
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
            `service: ${service.state} (${service.reason ?? 'no reason'})${app ? `; app ${app.outcome} (${app.reason})` : ''}`,
            ...(app?.next ? [`Next for the app: ${app.next}`] : []),
            `apply: ${applyShown.state}`,
            ...scopes.map((scope) => `view ${scope.scopeId}: ${scope.outcome} (${scope.reason})${scope.pendingEdits?.open ? `; ${scope.pendingEdits.open} pending edit(s), apply ${scope.pendingEdits.apply}` : ''}`),
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
          const { audienceAllow } = shownMachine(machineOf(workspace), workspace)
          return { exit: EXIT.ok, document: { audienceAllow }, human: [audienceAllow.join(', ') || 'no audience is allowed: every view is empty'] }
        }
        if (sub !== 'set' && sub !== 'clear') refuse('usage', 'audience show | audience set A,B | audience clear')
        const audienceAllow = sub === 'clear' ? [] : String(value ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
        if (sub === 'set' && audienceAllow.length === 0) refuse('usage', 'audience set needs at least one audience; `audience clear` allows none')
        if (audienceAllow.some((item) => !AUDIENCE.test(item)) || new Set(audienceAllow).size !== audienceAllow.length || audienceAllow.length > 64) refuse('invalid-audience', 'audiences are distinct identifiers, at most 64')
        const { workspace, repositoryRoots, now } = writable()
        const current = machineOf(workspace) ?? defaultMachineSettings({ workspaceId: workspace.workspaceId, updatedAt: now })
        const changed = JSON.stringify(current.audienceAllow) !== JSON.stringify(audienceAllow)
        writeMachineSettings({ ...workspace, repositoryRoots, settings: { ...current, audienceAllow, updatedAt: now } })
        // The engine compares a digest of these on every tick: a change invalidates every view at the next one.
        return { exit: EXIT.ok, document: { audienceAllow, changed, takesEffect: 'next-tick' }, human: [`audiences: ${audienceAllow.join(', ') || 'none'}; views are rebuilt at the next tick`] }
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
          const result = shown(await startService({ ...lifecycle, detached: true, ...seam, ...(consent === undefined ? {} : { consent }) }, lifecycleRules))
          const running = result.state === 'healthy' || result.state === 'busy'
          return { exit: running ? EXIT.ok : EXIT.notSuccess, document: { service: result }, human: [result.state === 'busy' ? 'running, and busy in a long tick; nothing was started beside it' : `${result.state}${result.started ? ' (started)' : result.alreadyRunning ? ' (already running)' : ` (${result.reason})`}`] }
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
        const result = await openScopeForOracleTests({
          ...lifecycle, ...(await appSeams()), service: seam, scopeId: flags.scope, consent, allowStale: flags['allow-stale'] === true, extensions: registry.extensions,
          ...(flags['wait-ms'] === undefined ? {} : { tickTimeoutMs: Number(flags['wait-ms']) || undefined }), ...(options.open ?? {}),
        }, openingRules, lifecycleRules)
        const { ok: _ok, ...document } = result
        return { exit: result.ok ? EXIT.ok : EXIT.notSuccess, document, human: [`${result.outcome}: ${result.summary}${result.reason ? ` (${result.reason})` : ''}`, `Next: ${result.next}`, ...(result.pendingEdits?.open ? [`${result.pendingEdits.open} pending edit(s); apply ${result.pendingEdits.apply}`] : [])] }
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
