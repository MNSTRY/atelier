#!/usr/bin/env node
// A launching command for tests: starts the maintenance service detached,
// prints what `start` returned and exits. The service has to outlive it.
//
//   --stop-before-exit   a launcher whose service ends with it, which the
//                        survival oracle has to notice
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { firstString, parseArgs, resolveProjectConfig } from '../../../src/project/config.mjs'
import { startService, stopService } from '../../../src/runtime/obsidian/lifecycle.mjs'

const args = parseArgs(process.argv.slice(2))
const configPath = firstString(args.project)
const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...env } = process.env
const lifecycle = {
  loadProject: () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: path.dirname(configPath), env, writeLocalState: false }),
  dataRoot: firstString(args['data-root']),
  env,
}
const result = await startService({
  ...lifecycle,
  entryPath: path.join(path.dirname(fileURLToPath(import.meta.url)), 'service-entry.mjs'),
  consent: { actor: 'test-launcher', coverage: 'service' },
  intervalMs: 3_600_000,
  detached: true,
})
if (args['stop-before-exit'] === true) await stopService(lifecycle)
process.stdout.write(`${JSON.stringify({ state: result.state, started: result.started, runtimeId: result.record?.runtimeId ?? null, pid: result.record?.pid ?? null })}\n`)
