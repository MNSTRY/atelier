#!/usr/bin/env node
// A launching process for AP-03 (G15 terminal closure): starts the owned
// maintenance service detached through the runtime's own `startService`,
// prints what it saw as one JSON line and exits. The service has to outlive
// it; the orchestrator that spawned this process proves that afterwards.
//
//   --project=FILE --data-root=DIR --entry=PATH [--entry-args=ARG,ARG]
//   --consent-actor=ID [--interval-ms=N]
//
// Nothing here reaches an app: the entry and its arguments decide that, and
// the production entry needs `--adapter=obsidian-cli` to be passed to it.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { firstString, parseArgs, resolveProjectConfig } from '../../../src/project/config.mjs'
import { startService } from '../../../src/runtime/obsidian/lifecycle.mjs'

export async function launchAndReport(argv, { env = process.env, write = (line) => process.stdout.write(line) } = {}) {
  const args = parseArgs(argv)
  const configPath = firstString(args.project)
  const entryPath = firstString(args.entry)
  const actor = firstString(args['consent-actor'])
  if (!configPath || !path.isAbsolute(configPath) || !entryPath || !actor) throw Object.assign(new Error('--project, --entry and --consent-actor are required'), { code: 'launcher-usage' })
  const { MNSTRY_ATELIER_PROJECT_CONFIG: _config, MNSTRY_ATELIER_LOCAL_CONFIG: _overlay, ...cleanEnv } = env
  const entryArgs = typeof args['entry-args'] === 'string' ? args['entry-args'].split(',').filter((item) => item !== '') : []
  const intervalMs = args['interval-ms'] === undefined ? undefined : Number(args['interval-ms'])
  const dataRoot = firstString(args['data-root'])
  const { child: _child, ...result } = await startService({
    loadProject: () => resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: path.dirname(configPath), env: cleanEnv, writeLocalState: false }),
    ...(dataRoot ? { dataRoot } : {}), env: cleanEnv, entryPath, entryArgs, consent: { actor, coverage: 'service' }, detached: true, ...(intervalMs === undefined ? {} : { intervalMs }),
  })
  const report = { launcherPid: process.pid, state: result.state, started: result.started, alreadyRunning: result.alreadyRunning ?? false, runtimeId: result.record?.runtimeId ?? null, pid: result.record?.pid ?? null, reason: result.reason ?? null }
  write(`${JSON.stringify(report)}\n`)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchAndReport(process.argv.slice(2)).then((report) => { process.exitCode = report.state === 'healthy' || report.state === 'busy' ? 0 : 3 }, (error) => { process.stdout.write(`${JSON.stringify({ error: error.code ?? 'launcher-failed', message: String(error.message) })}\n`); process.exitCode = 2 })
}
