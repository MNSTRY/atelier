#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { firstString, parseArgs, resolveProjectConfig } from '../../project/config.mjs'
import { workspaceStateRoot } from './machine-settings.mjs'
import { RELEASE_CHANGED, resolveServiceWorkspace, runMaintenanceService } from './service.mjs'

// The process of the maintenance service. `start` runs it as a child; a unit
// installed at the operating-system level runs it with `--startup`.
//
//   --project=<absolute atelier.project.json>   required
//   --data-root=<absolute directory>            optional; otherwise the pointer, the overlay or the platform default
//   --workspace-id=<identifier>                 named by a login item: under `--startup`, where a refusal is recorded
//                                               when the project no longer leads to a workspace
//   --runtime-id=<identifier>                   given by `start`, so it can recognise the child it created
//   --interval-ms=<milliseconds>                optional
//   --startup                                   run by a login item; needs a consent that covers startup
//   --adapter=obsidian-cli                      the editor adapter; there is no default
//
// Without `--adapter` the process refuses before it listens or ticks: reaching
// a running app is a decision of whoever starts the service, never a default.
//
// Exit codes: 0 after a clean stop, and under `--startup` after a refusal too;
// 2 (EXIT_REFUSED) after a refusal otherwise; 75 (EXIT_RELEASE_CHANGED) under
// `--startup` once the package changed on disk; 1 after an error nobody typed.

// Reaching a real app happens here and nowhere else in the service: the
// production probe and the CLI transport are imported only once `--adapter`
// selected them. The editor adapter is constructed only for an app that meets
// the minimum version; below it, or when the version cannot be read, the
// factory refuses, the engine records that reason and nothing is published.
// The app is asked for its version only when a view is published, without
// blocking the service. An adapter qualified while no app ran carries that
// qualification and does not coordinate with an app that starts before the
// next qualification. The engine is told what the app looks like from the
// process table and the app's vault list alone (whether it runs, which vaults
// its list shows open), so a view that did not settle is tried again as soon
// as that changes, and the app is not asked anything to find out; the list is
// only read here.
const ADAPTERS = Object.freeze({
  'obsidian-cli': async () => {
    const [{ createObsidianCliAdapter, defaultObsidianProcessProbe }, { createProductionAppProbe }, { createQualifiedAdapterFactory }, { obsidianUserDataDir, readObsidianSettings }, { appStateSignature }] = await Promise.all([
      import('../../projection/obsidian/publication/transport.mjs'), import('./app-production-seams.mjs'), import('./app-capability.mjs'),
      import('../../projection/obsidian/publication/vault-list.mjs'), import('./app-registration.mjs'),
    ])
    const adapterFactory = createQualifiedAdapterFactory({ appProbe: createProductionAppProbe(), createAdapter: ({ qualification }) => createObsidianCliAdapter({ qualification }) })
    const userDataDir = obsidianUserDataDir()
    const observeApp = () => appStateSignature({ processes: defaultObsidianProcessProbe(), settings: userDataDir === null ? null : readObsidianSettings({ userDataDir }) })
    return {
      adapterFactory, engineOptions: { observeApp },
      appStatus: () => { const known = adapterFactory.lastQualification(); return known === null ? null : { outcome: known.outcome, reason: known.reason, version: known.version, floor: known.floor } },
    }
  },
})

import { createReleaseWatch, packageRootOfEntry } from './release-watch.mjs'
import { SERVICE_ENTRY_PATH } from './service-entry-path.mjs'
import { LAST_STARTUP_SCHEMA, openServiceLog, writeLastStartup } from './service-record.mjs'

export { SERVICE_ENTRY_PATH }
export const EXIT_REFUSED = 2
// A service a login item started exits with this code when the package it runs from changed on disk: its service
// manager restarts it (a non-zero exit), on the release now installed. EX_TEMPFAIL.
export const EXIT_RELEASE_CHANGED = 75

const printed = (entry) => { try { process.stdout.write(`${JSON.stringify(entry)}\n`) } catch { /* a closed log never ends the service */ } }

// The workspace of a service a login item started, when it can be found: where it keeps its log and records how its
// start ended. When the project no longer leads to one (it moved, its pointer is gone), the workspace the unit names by
// its data root and identity, if that exists; it is never created here. Null otherwise; a refusal is then printed
// only, into the unit's own output file.
function startupWorkspace({ loadProject, dataRoot, workspaceId, env = process.env, platform = process.platform }) {
  try {
    const workspace = resolveServiceWorkspace({ project: loadProject(), dataRoot, env, platform })
    if (workspace?.workspaceRoot) return workspace
  } catch { /* the workspace the unit names, below */ }
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || typeof workspaceId !== 'string') return null
  try {
    const root = workspaceStateRoot(path.resolve(dataRoot), workspaceId)
    return fs.lstatSync(root).isDirectory() ? { workspaceId, workspaceRoot: fs.realpathSync(root) } : null
  } catch { return null }
}

// The service's own log, bounded as under `start`, which hands a child that same file. Under a login item the output
// goes to the unit's file instead, which nothing bounds; it keeps only what happens before this log is open.
function workspaceLog(workspaceRoot) {
  let descriptor
  try { descriptor = openServiceLog(workspaceRoot).descriptor } catch { return printed }
  return (entry) => { try { fs.writeSync(descriptor, `${JSON.stringify(entry)}\n`) } catch { /* a closed log never ends the service */ } }
}

function recordStartup(workspace, { at, outcome, code }) {
  if (workspace === null) return
  try { writeLastStartup({ ...workspace, document: { schema: LAST_STARTUP_SCHEMA, workspaceId: workspace.workspaceId, at, outcome, code } }) } catch { /* reported by the log only */ }
}

// The common body of a service process: run, end cleanly on a signal, exit 0
// after a clean stop and EXIT_REFUSED when the service refused to run.
//
// Started by a login item (`startup`), it logs into its workspace's bounded
// service log, records how the start ended (`last-startup.json`), exits 0 on
// a refusal as well, so the service manager does not start it again every
// minute over something that does not change by itself, and exits
// EXIT_RELEASE_CHANGED after the tick that found another release on disk.
// Anything else that ends it (an error nobody typed, a signal) is a crash,
// and the manager restarts it after its throttle.
export async function runServiceProcess(options) {
  const startup = options.startup === true
  const workspace = startup ? startupWorkspace(options) : null
  const log = workspace === null ? printed : workspaceLog(workspace.workspaceRoot)
  try {
    const service = await runMaintenanceService({ log, invokedAs: process.argv[1], ...options })
    if (startup) recordStartup(workspace, { at: new Date().toISOString(), outcome: 'started', code: null })
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void service.shutdown(`signal-${signal}`) })
    const { reason } = await service.done
    // Everything durable is on disk by now; nothing left over may keep a stopped service's PID alive.
    process.exit(reason === RELEASE_CHANGED ? EXIT_RELEASE_CHANGED : 0)
  } catch (error) {
    const at = new Date().toISOString()
    const code = typeof error?.code === 'string' ? error.code : null
    log({ at, event: 'refused', code: code ?? 'untyped-error', message: String(error?.message ?? error) })
    if (startup && code !== null) { recordStartup(workspace, { at, outcome: 'refused', code }); process.exitCode = 0; return }
    process.exitCode = code !== null ? EXIT_REFUSED : 1
  }
}

// The release a service a login item started runs, read through the path it was started by (`argv[1]`), so an
// upgrade, or a linked install pointed elsewhere, is seen. Null when that package cannot be read.
function watchRelease(invokedAs) {
  const root = packageRootOfEntry(invokedAs) ?? packageRootOfEntry(SERVICE_ENTRY_PATH)
  if (root === null) return null
  try { return createReleaseWatch({ root }) } catch { return null }
}

export function serviceOptionsFromArgv(argv, { env = process.env } = {}) {
  const args = parseArgs(argv)
  const configPath = firstString(args.project)
  if (!configPath || !path.isAbsolute(configPath)) throw Object.assign(new Error('--project must be the absolute path of a project configuration'), { code: 'service-arguments-invalid' })
  const dataRoot = firstString(args['data-root']) ?? undefined
  const workspaceId = firstString(args['workspace-id']) ?? undefined
  const intervalMs = args['interval-ms'] === undefined ? undefined : Number(args['interval-ms'])
  if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs < 1)) throw Object.assign(new Error('--interval-ms must be a positive integer'), { code: 'service-arguments-invalid' })
  return {
    loadProject: () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: path.dirname(configPath), env, writeLocalState: false }),
    ...(dataRoot === undefined ? {} : { dataRoot }), ...(workspaceId === undefined ? {} : { workspaceId }), ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(firstString(args['runtime-id']) ? { runtimeId: firstString(args['runtime-id']) } : {}),
    startup: args.startup === true, adapter: firstString(args.adapter),
  }
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()

if (invokedDirectly) {
  const argv = process.argv.slice(2)
  // Before anything else is loaded, so the release it notes is the one this process loads.
  const releaseWatch = argv.includes('--startup') ? watchRelease(process.argv[1]) : null
  let options = null
  try {
    options = serviceOptionsFromArgv(argv)
    if (!options.adapter || !Object.hasOwn(ADAPTERS, options.adapter)) throw Object.assign(new Error('no editor adapter was selected; pass --adapter explicitly'), { code: 'service-adapter-not-selected' })
  } catch (error) {
    printed({ at: new Date().toISOString(), event: 'refused', code: error.code ?? 'untyped-error', message: error.message })
    // Under a login item arguments that do not work never will: it ends cleanly, and is not started again every minute.
    process.exitCode = argv.includes('--startup') ? 0 : EXIT_REFUSED
    options = null
  }
  if (options) {
    const { adapter, ...rest } = options
    const [{ loadContributions }, { createObsidianRegistry }] = await Promise.all([import('./contributions.mjs'), import('./extension-points.mjs')])
    const registry = createObsidianRegistry({ contributions: await loadContributions() })
    const { engineOptions, ...seams } = await ADAPTERS[adapter]()
    await runServiceProcess({ ...rest, entryPath: SERVICE_ENTRY_PATH, ...seams, engineOptions: { ...engineOptions, extensions: registry.extensions }, releaseWatch })
  }
}
