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
  ['setup', ['src/commands/setup.mjs', 'setup']],
  ['adopt', ['src/commands/setup.mjs', 'adopt']],
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
  ['doctor', ['src/commands/setup.mjs', 'doctor']],
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
  ['boundary:push-check', ['src/commands/boundary.mjs', 'push-check']],
  ['boundary:audit', ['src/commands/boundary.mjs', 'audit']],
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
  atelier <command> [args]
  mnstry-atelier <command> [args]   # legacy alias
  mnstry atelier <command> [args]   # compatibility

Core commands:
  init                            Create a blank-slate project from a template.
  adopt                           Add Atelier to an existing repo/workspace.
  setup --yes                     Repair ignored local machine state.
  graph [--check]                 Build or check the knowledge graph.
  project [--check]               Build or check the workspace projection.
  build [--check]                 Build or check a realm portal.
  dev                             Run the local Atelier sidecar.
  readiness [--check]             Build or check readiness.
  readiness protocols             List bundled MNSTRY readiness protocols.
  readiness journey               Show the MNSTRY tenant-readiness journey.
  readiness run PROTOCOL_ID       Run a claim-first readiness protocol.
  readiness packet                Generate an ignored tenant-readiness draft.
  readiness export --dry-run      Preview readiness export blockers.
  generated check                 Run terminal generated-artifact freshness.
  context flow ...                Resolve session-bound harness context.
  export --dry-run FILE           Validate atelier-export@v1 dry-run artifact.
  support bundle --dry-run        Preview a no-send support bundle.
  egress check                    Check extracted Atelier paths for forbidden egress.
  boundary check                  Enforce private/shared repo placement rules.
  boundary audit                  Report content-rule matches tree-wide without blocking.
  boundary install-hooks          Install staged/private-domain Git guards.
  promote                         Record a git.promote disclosure event.
  upgrade --dry-run               Plan a safe package/template upgrade.
  upgrade --apply                 Apply a branch-based reviewable upgrade.
  lock check|write                Verify or create atelier.lock.json.
  config check                    Validate project config.

Every project-aware command accepts --project-config=PATH or
MNSTRY_ATELIER_PROJECT_CONFIG=PATH. Machine-local repo paths belong in
.atelier-local/, atelier.local.json, or atelier.workspace.local.json.`)
}

function printCommandHelp(command) {
  const help = {
    init: `Usage: atelier init [--template private-domain|shared-project|sample-workspace] [--target DIR] [--actor ID]

Creates tracked starter files and an Atelier lockfile. It does not install hooks unless asked separately.`,
    adopt: `Usage: atelier adopt [--profile single-repo|private-domain|shared-project|multi-repo|monorepo|control-workspace] [--target DIR] [--yes]

Creates or checks a tracked atelier.project.json for an existing workspace and writes machine-local path bindings only to ignored local overlay files.`,
    setup: `Usage: atelier setup --yes [--project ./atelier.project.json]

Ensures ignored local Atelier state exists, verifies ignore coverage, and records unambiguous local repo path bindings.`,
    doctor: `Usage: atelier doctor [--project ./atelier.project.json] [--fix] [--dry-run]

Reports project config, local overlay, and repo boundary readiness. --fix only repairs ignored local state.`,
    boundary: `Usage: atelier boundary check|push-check|audit|install-hooks [--project ./atelier.project.json] [--staged]

check --staged judges the staged diff. push-check reads pre-push ref updates on stdin and judges only the pushed range. audit scans the whole tree and reports without blocking, so an accepted usage never strands unrelated work.`,
    graph: `Usage: atelier graph [--check] [--project ./atelier.project.json]

Builds or checks the project knowledge graph from tracked sources plus ignored local path bindings.`,
    readiness: `Usage:
  atelier readiness [--check] [--project ./atelier.project.json]
  atelier readiness protocols [--json]
  atelier readiness journey [--project ./atelier.project.json]
  atelier readiness run mnstry.readiness:offer-map [--answers answers.json] [--project ./atelier.project.json]
  atelier readiness packet [--project ./atelier.project.json]
  atelier readiness export --dry-run [--project ./atelier.project.json]

Runs the bundled MNSTRY readiness pack claim-first. Protocol state and packet drafts stay in ignored .atelier-local/readiness/ unless explicitly materialized by a reviewed future flow.`,
  }
  console.log(help[command] || `Usage: atelier ${command} [args]\n\nRun atelier --help for the command list.`)
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
  if (args[0] === 'boundary' && args[1] === 'push-check') args.splice(0, 2, 'boundary:push-check')
  if (args[0] === 'boundary' && args[1] === 'audit') args.splice(0, 2, 'boundary:audit')
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
if (rest[0] === '--help' || rest[0] === '-h') {
  printCommandHelp(command)
  process.exit(0)
}
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
