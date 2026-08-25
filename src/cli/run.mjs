import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_BRAND = Object.freeze({ command: 'atelier', displayName: 'MNSTRY Atelier', version: null })

export const commandMap = new Map([
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
  ['extension-pack', ['src/commands/extension-pack.mjs']],
  ['extension-pack:validate', ['src/commands/extension-pack.mjs', 'validate']],
  ['extension-pack:list', ['src/commands/extension-pack.mjs', 'list']],
  ['distribution', ['src/commands/distribution.mjs']],
  ['distribution:check', ['src/commands/distribution.mjs', 'check']],
  ['disclosure', ['src/commands/disclosure.mjs']],
  ['disclosure:check', ['src/commands/disclosure.mjs', 'check']],
  ['attestation', ['src/commands/attestation.mjs']],
  ['feedback', ['src/commands/feedback.mjs']],
  ['feedback:check', ['src/commands/feedback.mjs', 'check']],
  ['announcements', ['src/commands/announcements.mjs']],
  ['announcements:list', ['src/commands/announcements.mjs', 'list']],
  ['sync', ['src/commands/sync.mjs']],
])

function isDefaultBrand(brand) {
  return brand.command === DEFAULT_BRAND.command && brand.displayName === DEFAULT_BRAND.displayName
}

function validateBrand(brand) {
  if (!brand || typeof brand !== 'object') throw new Error('brand must be an object')
  if (typeof brand.command !== 'string' || !/^[a-z][a-z0-9-]*$/.test(brand.command)) {
    throw new Error(`brand.command must match /^[a-z][a-z0-9-]*$/: ${String(brand.command)}`)
  }
  if (typeof brand.displayName !== 'string' || brand.displayName.length === 0) {
    throw new Error('brand.displayName must be a non-empty string')
  }
  // Control characters (C0 including ESC, and DEL) in a display name can
  // forge or corrupt terminal output (ANSI injection), so they are rejected.
  // The message deliberately never echoes the offending value.
  if (/[\u0000-\u001f\u007f]/.test(brand.displayName)) {
    throw new Error('brand.displayName must not contain control characters')
  }
}

export function buildHelpText(brand = DEFAULT_BRAND, atelierVersion = null) {
  const header = isDefaultBrand(brand)
    ? `MNSTRY Atelier

Usage:
  atelier <command> [args]
  mnstry-atelier <command> [args]   # legacy alias
  mnstry atelier <command> [args]   # compatibility`
    : `${brand.displayName}
powered by MNSTRY Atelier ${atelierVersion}

Usage:
  ${brand.command} <command> [args]`
  return `${header}

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
  feedback --message TEXT         Write a local, never-sent feedback report.
  announcements list              List and verify MNSTRY announcements.
  sync enroll                     Explicitly enroll one repository for supervision.
  sync status                     Fully observe the enrolled repository.
  sync reconcile                  Fetch and perform only proven fast-forwards.
  sync plan                       Prepare one bounded, reviewable commit plan.
  sync commit                     Execute an exactly confirmed commit plan.
  sync run --once                 Run one full-state supervisor cycle.
  egress check                    Check extracted Atelier paths for forbidden egress.
  boundary check                  Enforce private/shared repo placement rules.
  boundary audit                  Report content-rule matches tree-wide without blocking.
  boundary install-hooks          Install staged/private-domain Git guards.
  promote                         Record a git.promote disclosure event.
  upgrade --dry-run               Plan a safe package/template upgrade.
  upgrade --apply                 Apply a branch-based reviewable upgrade.
  lock check|write                Verify or create atelier.lock.json.
  config check                    Validate project config.
  extension-pack validate         Validate declared extension packs.
  extension-pack list             List declared extension packs.
  distribution check              Check a distribution for MNSTRY attribution.
  disclosure check                Scan tracked or staged content for disclosure risks.

Attestation commands:
  attestation hash FILE           Print the canonical payload hash of a payload.
  attestation sign FILE           Sign an unsigned attestation with a signing key file.
  attestation verify FILE         Verify an attestation against a public key file.
  attestation keygen --key-id ID  Generate a signing key pair.

Commands whose usage names --project accept --project=PATH or --project PATH.
The project resolver also accepts --project-config=PATH and
MNSTRY_ATELIER_PROJECT_CONFIG=PATH; each command's own help is authoritative.
Machine-local repo paths belong in
.atelier-local/, atelier.local.json, or atelier.workspace.local.json.`
}

export function buildCommandHelpText(command, brand = DEFAULT_BRAND) {
  const c = brand.command
  const help = {
    init: `Usage: ${c} init [--template private-domain|shared-project|sample-workspace|distribution] [--target DIR] [--actor ID]

Creates tracked starter files and an Atelier lockfile. It does not install hooks unless asked separately. An unrecognized --template exits 1 and writes nothing; omit --template for the blank scaffold.`,
    adopt: `Usage: ${c} adopt [--profile single-repo|private-domain|shared-project|multi-repo|monorepo|control-workspace] [--target DIR] [--yes]

Creates or checks a tracked atelier.project.json for an existing workspace and writes machine-local path bindings only to ignored local overlay files.`,
    setup: `Usage: ${c} setup --yes [--project ./atelier.project.json]

Ensures ignored local Atelier state exists, verifies ignore coverage, and records unambiguous local repo path bindings.`,
    doctor: `Usage: ${c} doctor [--project ./atelier.project.json] [--fix] [--dry-run]

Reports project config, local overlay, and repo boundary readiness. --fix only repairs ignored local state.`,
    boundary: `Usage: ${c} boundary check|push-check|audit|install-hooks [--project ./atelier.project.json] [--staged] [--source=working-tree|head]

check --staged judges the staged diff. push-check reads pre-push ref updates on stdin and judges only the pushed range. audit scans the working tree by default and reports without blocking; --source=head selects the committed snapshot.`,
    graph: `Usage: ${c} graph [--check] [--project ./atelier.project.json]

Builds or checks the project knowledge graph from tracked sources plus ignored local path bindings.`,
    readiness: `Usage:
  ${c} readiness [--check] [--project ./atelier.project.json]
  ${c} readiness protocols [--json]
  ${c} readiness journey [--project ./atelier.project.json]
  ${c} readiness run mnstry.readiness:offer-map [--answers answers.json] [--project ./atelier.project.json]
  ${c} readiness packet [--project ./atelier.project.json]
  ${c} readiness export --dry-run [--project ./atelier.project.json]

Runs the bundled MNSTRY readiness pack claim-first. Protocol state and packet drafts stay in ignored .atelier-local/readiness/ unless explicitly materialized by a reviewed future flow.`,
    'extension-pack': `Usage:
  ${c} extension-pack validate [--json] [--project ./atelier.project.json]
  ${c} extension-pack list [--json] [--project ./atelier.project.json]

Loads every extension pack declared under ext["mnstry.atelier"].extensionPacks in the tracked project config and reports one line per pack. Packs load additively alongside the bundled MNSTRY protocols and can never replace them. list is the default subcommand.`,
    distribution: `Usage: ${c} distribution check [--target DIR] [--pack DIR]

Checks a distribution package for the required MNSTRY attribution markers. Blocking: the distribution README.md byte check, and a CLI probe that EXECUTES the target's declared bin with --version (spawned with the current Node, cwd set to the target — only run this against distributions you trust) and requires the attribution in its output; a target that looks like a distribution but declares no probe-able bin, or ships a malformed package.json, is also blocking. The extension-pack manifest attribution key is advisory and reported only. The normative wording lives in TRADEMARKS.md under "Required attribution"; see also docs/attestation.md and docs/distributions.md.`,
    disclosure: `Usage: ${c} disclosure check [--root DIR] [--staged] [--denylist FILE | --structural-only] [--fail-on-binary] [--untrusted]

Scans Git-tracked files, or staged index blobs with --staged, without following symlinks. A private denylist is required by default and must be supplied through ATELIER_DENYLIST_JSON, --denylist, or ignored .atelier-local/disclosure-denylist.json. --structural-only is the explicit no-denylist lane. --untrusted suppresses finding details.`,
    attestation: `Usage:
  ${c} attestation hash <payload.json>
  ${c} attestation sign <attestation.json> [--key FILE] [--out FILE]
  ${c} attestation verify <attestation.json> --public-key FILE [--payload FILE] [--json]
  ${c} attestation keygen --key-id ID [--algorithm ed25519|es256] [--out FILE]

Records and checks admission decisions. hash prints the canonical payload hash (RFC 8785 JCS, SHA-256). sign reads the local signing key file. verify reads a public key file and exits 1 when it judges the attestation invalid. keygen writes the signing key file mode 0600 on POSIX, refuses to overwrite, and prints only the public key document.`,
    feedback: `Usage:
  ${c} feedback create --message TEXT | --message-file PATH [--context FILE] [--include-gates]
  ${c} feedback check FILE

Assembles a local feedback report under ignored .atelier-local/feedback/ (mode 0600 on POSIX), scanned with the support-bundle banned key and value patterns before writing; any match refuses the write naming pattern label and location only. Files given to --message-file and --context must be valid UTF-8 text of at most 262144 bytes. The scan is a backstop, not clearance: read the whole report before sharing it. The kit has no send path — sharing the file is always the user's own explicit act.`,
    announcements: `Usage: ${c} announcements list [--dir DIR] [--public-key FILE] | verify <file> [--public-key FILE] [--json] | show <file> [--public-key FILE]

MNSTRY announcements are a pull-only channel: signed JSON documents under announcements/ in the repository. The trust anchor is always the committed MNSTRY key, or one you pass explicitly with --public-key; --dir changes only where documents are read from and never which key verifies them. Every run names the key and keyId it used. The kit never fetches anything — receiving announcements is the git pull you chose to run, and show refuses to print a body whose signature does not verify.`,
    sync: `Usage:
  ${c} sync enroll --repo DIR [--project atelier.project.json] [--git ABSOLUTE_PATH]
  ${c} sync status --repo DIR
  ${c} sync reconcile --repo DIR [--retries 3]
  ${c} sync run --repo DIR [--once] [--interval 30]
  ${c} sync plan --repo DIR --path FILE [--path FILE] --message TEXT [--publish]
  ${c} sync commit --repo DIR --operation ID --confirm ID
  ${c} sync pause|freeze|resume --repo DIR
  ${c} sync trace --repo DIR

Enrolls exactly one repository and keeps Git plus readable files authoritative. Reconciliation observes the complete repository every cycle and performs only fast-forward updates. Commit creation is a two-phase user-confirmed operation: plan shows one bounded change set, and commit refuses unless the repository is unchanged and --confirm exactly repeats the operation id. No semantic conflict resolution, force operation, browser apply endpoint, telemetry, or desktop shell is present.`,
  }
  return help[command] || `Usage: ${c} ${command} [args]\n\nRun ${c} --help for the command list.`
}

export function buildVersionText(brand = DEFAULT_BRAND, atelierVersion = null) {
  if (isDefaultBrand(brand)) return `${atelierVersion}`
  return `${brand.displayName} ${brand.version ?? atelierVersion} — powered by MNSTRY Atelier ${atelierVersion}`
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
  if (args[0] === 'extension-pack' && args[1] === 'validate') args.splice(0, 2, 'extension-pack:validate')
  if (args[0] === 'extension-pack' && args[1] === 'list') args.splice(0, 2, 'extension-pack:list')
  if (args[0] === 'distribution' && args[1] === 'check') args.splice(0, 2, 'distribution:check')
  if (args[0] === 'disclosure' && args[1] === 'check') args.splice(0, 2, 'disclosure:check')
  if (args[0] === 'support' && args[1] === 'bundle') args.splice(0, 2, 'support:bundle')
  if (args[0] === 'support:bundle' && args[1] === '--dry-run') args.splice(1, 1)
  return { help: false, args }
}

export async function runCli({
  argv,
  env = process.env,
  cwd = process.cwd(),
  brand = DEFAULT_BRAND,
  stdout = console.log,
  stderr = console.error,
}) {
  validateBrand(brand)
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
  const atelierVersion = packageJson.version

  const normalized = normalizeArgs(argv)
  if (normalized.help) {
    stdout(buildHelpText(brand, atelierVersion))
    return 0
  }
  if (normalized.version) {
    stdout(buildVersionText(brand, atelierVersion))
    return 0
  }

  const [command, ...rest] = normalized.args
  if (rest[0] === '--help' || rest[0] === '-h') {
    stdout(buildCommandHelpText(command, brand))
    return 0
  }
  const target = commandMap.get(command)
  if (!target) {
    stderr(`Unknown ${brand.displayName} command: ${command}`)
    stdout(buildHelpText(brand, atelierVersion))
    return 1
  }

  const [script, ...prefixArgs] = target
  const scriptPath = path.join(packageRoot, script)
  const executorPath = path.join(packageRoot, 'src', 'cli', 'execute-command.mjs')
  if (!fs.existsSync(scriptPath)) {
    stderr(`${brand.displayName} command is not available in this package install: ${command}`)
    return 1
  }

  const result = spawnSync(process.execPath, [executorPath, scriptPath, ...prefixArgs, ...rest], {
    cwd,
    stdio: 'inherit',
    env: {
      ...env,
      MNSTRY_ATELIER_PACKAGE_ROOT: packageRoot,
    },
  })

  if (result.error) {
    stderr(result.error.message)
    return 1
  }
  return result.status ?? 0
}
