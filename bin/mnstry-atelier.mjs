#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

const commandMap = new Map([
  ['contract', ['src/check-atelier-export-contract.mjs']],
  ['init', ['src/commands/init.mjs']],
  ['export', ['src/validate-atelier-export-dry-run.mjs']],
  ['export:dry-run', ['src/validate-atelier-export-dry-run.mjs']],
  ['dry-run', ['src/validate-atelier-export-dry-run.mjs']],
  ['graph', ['src/commands/graph.mjs']],
  ['project', ['src/commands/project.mjs']],
  ['build', ['src/commands/project.mjs']],
  ['dev', ['src/commands/server.mjs']],
  ['server', ['src/commands/server.mjs']],
  ['readiness', ['src/commands/readiness.mjs']],
  ['generated', ['src/commands/readiness.mjs', '--check']],
  ['generated:check', ['src/commands/readiness.mjs', '--check']],
  ['doctor', ['src/commands/config.mjs']],
  ['context', ['src/commands/context.mjs']],
  ['resolve', ['src/commands/context.mjs', 'resolve']],
  ['capabilities', ['src/commands/context.mjs', 'capabilities']],
  ['proposal', ['src/commands/context.mjs', 'proposal']],
  ['support', ['src/commands/support.mjs']],
  ['support:bundle', ['src/commands/support.mjs']],
  ['egress', ['src/commands/egress.mjs']],
  ['egress:check', ['src/commands/egress.mjs']],
  ['boundary', ['src/commands/boundary.mjs']],
  ['boundary:check', ['src/commands/boundary.mjs', 'check']],
  ['boundary:doctor', ['src/commands/boundary.mjs', 'doctor']],
  ['boundary:install-hooks', ['src/commands/boundary.mjs', 'install-hooks']],
  ['promote', ['src/commands/promote.mjs']],
  ['upgrade', ['src/commands/upgrade.mjs']],
  ['lock', ['src/commands/lock.mjs']],
  ['lock:check', ['src/commands/lock.mjs', 'check']],
  ['lock:write', ['src/commands/lock.mjs', 'write']],
  ['analysis', ['src/commands/analysis.mjs']],
  ['analyze', ['src/commands/analysis.mjs']],
  ['config', ['src/commands/config.mjs']],
  ['config:check', ['src/commands/config.mjs']],
  ['manifest', ['src/commands/config.mjs']],
  ['extension-pack', ['src/commands/config.mjs']],
])

function printHelp() {
  console.log(`MNSTRY Atelier

Usage:
  mnstry atelier <command> [args]
  mnstry-atelier <command> [args]

Core commands:
  graph [--check]                 Build or check the knowledge graph.
  project [--check]               Build or check the workspace projection.
  build [--check]                 Build or check a realm portal.
  dev                             Run the local Atelier sidecar.
  readiness [--check]             Build or check readiness.
  generated check                 Run terminal generated-artifact freshness.
  context flow ...                Resolve session-bound harness context.
  export --dry-run FILE           Validate atelier-export@v1 dry-run artifact.
  support bundle --dry-run        Preview a no-send support bundle.
  egress check                    Check extracted Atelier paths for forbidden egress.
  boundary check                  Enforce private/shared repo placement rules.
  boundary install-hooks          Install staged/private-domain Git guards.
  promote                         Record a git.promote disclosure event.
  upgrade --dry-run               Plan a safe package/template upgrade.
  upgrade --apply                 Apply a branch-based reviewable upgrade.
  lock check|write                Verify or create atelier.lock.json.
  config check                    Validate project config.

Every project-aware command accepts --project-config=PATH or
MNSTRY_ATELIER_PROJECT_CONFIG=PATH.`)
}

function normalizeArgs(argv) {
  const args = [...argv]
  if (args[0] === 'atelier') args.shift()
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return { help: true, args }
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') return { version: true, args }

  if (args[0] === 'export' && args[1] === '--dry-run') args.splice(0, 2, 'export:dry-run')
  if (args[0] === 'generated' && args[1] === 'check') args.splice(0, 2, 'generated:check')
  if (args[0] === 'egress' && args[1] === 'check') args.splice(0, 2, 'egress:check')
  if (args[0] === 'boundary' && args[1] === 'check') args.splice(0, 2, 'boundary:check')
  if (args[0] === 'boundary' && args[1] === 'doctor') args.splice(0, 2, 'boundary:doctor')
  if (args[0] === 'boundary' && args[1] === 'install-hooks') args.splice(0, 2, 'boundary:install-hooks')
  if (args[0] === 'lock' && args[1] === 'check') args.splice(0, 2, 'lock:check')
  if (args[0] === 'lock' && args[1] === 'write') args.splice(0, 2, 'lock:write')
  if (args[0] === 'config' && args[1] === 'check') args.splice(0, 2, 'config:check')
  if (args[0] === 'support' && args[1] === 'bundle') args.splice(0, 2, 'support:bundle')
  if (args[0] === 'support:bundle' && args[1] === '--dry-run') args.splice(1, 1)
  return { help: false, args }
}

const normalized = normalizeArgs(process.argv.slice(2))
if (normalized.help) {
  printHelp()
  process.exit(0)
}
if (normalized.version) {
  console.log(packageJson.version)
  process.exit(0)
}

const [command, ...rest] = normalized.args
const target = commandMap.get(command)
if (!target) {
  console.error(`Unknown MNSTRY Atelier command: ${command}`)
  printHelp()
  process.exit(1)
}

const [script, ...prefixArgs] = target
const scriptPath = path.join(packageRoot, script)
if (!fs.existsSync(scriptPath)) {
  console.error(`MNSTRY Atelier command is not available in this package install: ${command}`)
  process.exit(1)
}

const result = spawnSync(process.execPath, [scriptPath, ...prefixArgs, ...rest], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: {
    ...process.env,
    MNSTRY_ATELIER_PACKAGE_ROOT: packageRoot,
  },
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 0)
