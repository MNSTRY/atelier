#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { firstString, parseArgs, resolveProjectConfig } from '../../project/config.mjs'
import { runMaintenanceService } from './service.mjs'

// The process of the maintenance service. `start` runs it as a child; a unit
// installed at the operating-system level runs it with `--startup`.
//
//   --project=<absolute atelier.project.json>   required
//   --data-root=<absolute directory>            optional; otherwise the pointer, the overlay or the platform default
//   --runtime-id=<identifier>                   given by `start`, so it can recognise the child it created
//   --interval-ms=<milliseconds>                optional
//   --startup                                   run by an operating-system unit; needs a consent that covers startup
//   --adapter=obsidian-cli                      the editor adapter; there is no default
//
// Without `--adapter` the process refuses before it listens or ticks: reaching
// a running app is a decision of whoever starts the service, never a default.

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
    // The app's own vault list, read and never written, so a new vault's folder is never allocated inside a vault it
    // lists nor under a name one of its vaults has.
    const readAppVaultList = () => { if (userDataDir === null) return null; const settings = readObsidianSettings({ userDataDir }); return settings.ok ? settings.vaults : null }
    return {
      adapterFactory, engineOptions: { observeApp, readAppVaultList },
      appStatus: () => { const known = adapterFactory.lastQualification(); return known === null ? null : { outcome: known.outcome, reason: known.reason, version: known.version, floor: known.floor } },
    }
  },
})

import { SERVICE_ENTRY_PATH } from './service-entry-path.mjs'

export { SERVICE_ENTRY_PATH }
export const EXIT_REFUSED = 2

const log = (entry) => { try { process.stdout.write(`${JSON.stringify(entry)}\n`) } catch { /* a closed log never ends the service */ } }

// The common body of a service process: run, end cleanly on a signal, exit 0
// after a clean stop and EXIT_REFUSED when the service refused to run.
export async function runServiceProcess(options) {
  try {
    const service = await runMaintenanceService({ log, ...options })
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { void service.shutdown(`signal-${signal}`) })
    await service.done
    // Everything durable is on disk by now; nothing left over may keep a stopped service's PID alive.
    process.exit(0)
  } catch (error) {
    log({ at: new Date().toISOString(), event: 'refused', code: error?.code ?? 'untyped-error', message: String(error?.message ?? error) })
    process.exitCode = typeof error?.code === 'string' ? EXIT_REFUSED : 1
  }
}

export function serviceOptionsFromArgv(argv, { env = process.env } = {}) {
  const args = parseArgs(argv)
  const configPath = firstString(args.project)
  if (!configPath || !path.isAbsolute(configPath)) throw Object.assign(new Error('--project must be the absolute path of a project configuration'), { code: 'service-arguments-invalid' })
  const dataRoot = firstString(args['data-root']) ?? undefined
  const intervalMs = args['interval-ms'] === undefined ? undefined : Number(args['interval-ms'])
  if (intervalMs !== undefined && (!Number.isInteger(intervalMs) || intervalMs < 1)) throw Object.assign(new Error('--interval-ms must be a positive integer'), { code: 'service-arguments-invalid' })
  return {
    loadProject: () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: path.dirname(configPath), env, writeLocalState: false }),
    ...(dataRoot === undefined ? {} : { dataRoot }), ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(firstString(args['runtime-id']) ? { runtimeId: firstString(args['runtime-id']) } : {}),
    startup: args.startup === true, adapter: firstString(args.adapter),
  }
}

const invokedDirectly = (() => { try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()

if (invokedDirectly) {
  let options = null
  try {
    options = serviceOptionsFromArgv(process.argv.slice(2))
    if (!options.adapter || !Object.hasOwn(ADAPTERS, options.adapter)) throw Object.assign(new Error('no editor adapter was selected; pass --adapter explicitly'), { code: 'service-adapter-not-selected' })
  } catch (error) {
    log({ at: new Date().toISOString(), event: 'refused', code: error.code ?? 'untyped-error', message: error.message })
    process.exitCode = EXIT_REFUSED
    options = null
  }
  if (options) {
    const { adapter, ...rest } = options
    const [{ loadContributions }, { createObsidianRegistry }] = await Promise.all([import('./contributions.mjs'), import('./extension-points.mjs')])
    const registry = createObsidianRegistry({ contributions: await loadContributions() })
    const { engineOptions, ...seams } = await ADAPTERS[adapter]()
    await runServiceProcess({ ...rest, entryPath: SERVICE_ENTRY_PATH, ...seams, engineOptions: { ...engineOptions, extensions: registry.extensions } })
  }
}
