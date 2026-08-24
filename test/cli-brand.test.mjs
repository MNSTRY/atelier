import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeSampleProject } from './helpers/sample-project.mjs'

import {
  DEFAULT_BRAND,
  commandMap,
  buildHelpText,
  buildCommandHelpText,
  buildVersionText,
  runCli,
} from '../src/cli/run.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

const DEFAULT_HELP_TEXT = `MNSTRY Atelier

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
  feedback --message TEXT         Write a local, never-sent feedback report.
  announcements list              List and verify MNSTRY announcements.
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

const LOOMWORKS = Object.freeze({ command: 'loomworks', displayName: 'Loomworks Studio', version: '1.4.0' })

test('default-brand help text is byte-identical to the pinned banner', () => {
  assert.equal(buildHelpText(DEFAULT_BRAND, VERSION), DEFAULT_HELP_TEXT)
})

test('default-brand version text is the bare package version', () => {
  assert.equal(buildVersionText(DEFAULT_BRAND, VERSION), VERSION)
})

test('command map exposes the dispatch table for introspection', () => {
  assert.equal(commandMap instanceof Map, true)
  assert.deepEqual(commandMap.get('init'), ['src/commands/init.mjs'])
  assert.equal(commandMap.size, 52)
})

test('command map dispatches the white-label commands to their own modules', () => {
  assert.deepEqual(commandMap.get('extension-pack'), ['src/commands/extension-pack.mjs'])
  assert.deepEqual(commandMap.get('extension-pack:validate'), ['src/commands/extension-pack.mjs', 'validate'])
  assert.deepEqual(commandMap.get('extension-pack:list'), ['src/commands/extension-pack.mjs', 'list'])
  assert.deepEqual(commandMap.get('distribution'), ['src/commands/distribution.mjs'])
  assert.deepEqual(commandMap.get('distribution:check'), ['src/commands/distribution.mjs', 'check'])
  assert.deepEqual(commandMap.get('disclosure'), ['src/commands/disclosure.mjs'])
  assert.deepEqual(commandMap.get('disclosure:check'), ['src/commands/disclosure.mjs', 'check'])
  assert.deepEqual(commandMap.get('attestation'), ['src/commands/attestation.mjs'])
  // manifest keeps its historical config.mjs target.
  assert.deepEqual(commandMap.get('manifest'), ['src/commands/config.mjs'])
})

test('branded help leads with the wrapper name then required attribution and drops alias lines', () => {
  const help = buildHelpText(LOOMWORKS, VERSION)
  const lines = help.split('\n')
  assert.equal(lines[0], 'Loomworks Studio')
  assert.equal(lines[1], `powered by MNSTRY Atelier ${VERSION}`)
  assert.match(help, /^ {2}loomworks <command> \[args\]$/m)
  assert.doesNotMatch(help, /mnstry-atelier <command>/)
  assert.doesNotMatch(help, /legacy alias/)
  assert.doesNotMatch(help, /# compatibility/)
  assert.match(help, /bundled MNSTRY readiness protocols/)
})

test('branded version text carries derived MNSTRY attribution', () => {
  const text = buildVersionText(LOOMWORKS, VERSION)
  assert.match(text, /powered by MNSTRY Atelier/)
  assert.match(text, /^Loomworks Studio 1\.4\.0/)
  assert.match(text, new RegExp(`powered by MNSTRY Atelier ${VERSION.replace(/[.+]/g, '\\$&')}$`))
  const noVersion = buildVersionText({ ...LOOMWORKS, version: null }, VERSION)
  assert.equal(noVersion, `Loomworks Studio ${VERSION} — powered by MNSTRY Atelier ${VERSION}`)
})

test('branded command help substitutes the wrapper command name', () => {
  assert.match(buildCommandHelpText('init', LOOMWORKS), /^Usage: loomworks init/)
  assert.match(buildCommandHelpText('graph', LOOMWORKS), /^Usage: loomworks graph/)
  const fallback = buildCommandHelpText('promote', LOOMWORKS)
  assert.match(fallback, /^Usage: loomworks promote \[args\]/)
  assert.match(fallback, /Run loomworks --help for the command list\./)
  assert.match(buildCommandHelpText('init', DEFAULT_BRAND), /^Usage: atelier init/)
})

test('invalid brands are rejected before any dispatch', async () => {
  await assert.rejects(() => runCli({ argv: ['--help'], brand: { command: 'Bad Name', displayName: 'X' } }))
  await assert.rejects(() => runCli({ argv: ['--help'], brand: { command: 'ok', displayName: '' } }))
})

// N9: control characters in displayName enable ANSI/terminal injection
// (forged banners, cursor games), so validateBrand rejects C0, DEL, and ESC
// outright — and the error message never echoes the offending value.
test('brands with control characters in displayName are rejected', async () => {
  const hostile = [
    'Evil\u001b[2J\u001b[HStudio', // ESC: clears the screen, forges a banner
    'Line\nBreak',
    'Null\u0000Byte',
    'Del\u007fete',
    'Bell\u0007',
  ]
  for (const displayName of hostile) {
    await assert.rejects(
      () => runCli({ argv: ['--help'], brand: { command: 'ok', displayName } }),
      (error) => /control characters/.test(error.message) && !error.message.includes(displayName),
      `displayName ${JSON.stringify(displayName)} must be rejected without being echoed`,
    )
  }
  // Ordinary punctuation and non-ASCII display names stay accepted.
  const out = []
  const code = await runCli({
    argv: ['--version'],
    brand: { command: 'ok', displayName: 'Ateliér — Straße & Co.', version: '1.0.0' },
    stdout: (line) => out.push(line),
  })
  assert.equal(code, 0)
  assert.match(out[0], /^Ateliér — Straße & Co\. 1\.0\.0/)
})

test('runCli renders branded help through injected writers without spawning', async () => {
  const out = []
  const err = []
  const code = await runCli({
    argv: ['--help'],
    brand: LOOMWORKS,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  assert.equal(code, 0)
  assert.equal(err.length, 0)
  assert.equal(out.length, 1)
  assert.match(out[0], /^Loomworks Studio\npowered by MNSTRY Atelier /)
})

test('runCli reports unknown commands with the wrapper display name', async () => {
  const out = []
  const err = []
  const code = await runCli({
    argv: ['definitely-not-a-command'],
    brand: LOOMWORKS,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  })
  assert.equal(code, 1)
  assert.deepEqual(err, ['Unknown Loomworks Studio command: definitely-not-a-command'])
  assert.match(out[0], /^Loomworks Studio/)
})

// The tests below dispatch through bin/atelier.mjs, so they prove the
// commandMap entry, the normalizeArgs splice, and the spawned module agree —
// the unit tests above only exercise the builders.
const BIN = path.join(ROOT, 'bin', 'atelier.mjs')
const PACK_FIXTURES = path.join(ROOT, 'fixtures', 'atelier-extension-pack')

function runBin(args, { cwd = ROOT, env = process.env } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' })
}

test('expected project failures are typed, actionable, and stack-free by default', (t) => {
  const sample = makeSampleProject(t)
  const missingArtifact = runBin(['project', '--project', sample.config], { cwd: sample.dir })
  assert.equal(missingArtifact.status, 2)
  assert.match(missingArtifact.stderr, /^\[artifact-missing\]/m)
  assert.match(missingArtifact.stderr, /Next: Run atelier graph/)
  assert.doesNotMatch(missingArtifact.stderr, /\n\s+at /)

  fs.writeFileSync(sample.config, '{ malformed\n')
  const malformed = runBin(['graph', '--project', sample.config], { cwd: sample.dir })
  assert.equal(malformed.status, 2)
  assert.match(malformed.stderr, /^\[project-config-json-invalid\]/m)
  assert.match(malformed.stderr, /Next: Repair the JSON syntax/)
  assert.doesNotMatch(malformed.stderr, /\n\s+at /)

  const debug = runBin(['graph', '--project', sample.config], {
    cwd: sample.dir,
    env: { ...process.env, ATELIER_DEBUG: '1' },
  })
  assert.equal(debug.status, 2)
  assert.match(debug.stderr, /AtelierDiagnosticError/)
  assert.match(debug.stderr, /\n\s+at /)
})

test('extension-pack validate dispatches to the extension-pack module', (t) => {
  const sample = makeSampleProject(t)
  fs.mkdirSync(path.join(sample.dir, 'packs', 'protocols'), { recursive: true })
  fs.copyFileSync(
    path.join(PACK_FIXTURES, 'valid', 'sample-pack.v1.json'),
    path.join(sample.dir, 'packs', 'sample.readiness.v1.json'),
  )
  fs.copyFileSync(
    path.join(PACK_FIXTURES, 'valid', 'protocols', 'contract-gate.v1.json'),
    path.join(sample.dir, 'packs', 'protocols', 'contract-gate.v1.json'),
  )
  const config = JSON.parse(fs.readFileSync(sample.config, 'utf8'))
  config.ext = {
    'mnstry.atelier': {
      extensionPacks: [
        { id: 'sample.readiness', version: 'v1', path: 'packs/sample.readiness.v1.json', enabled: true },
      ],
    },
  }
  fs.writeFileSync(sample.config, `${JSON.stringify(config, null, 2)}\n`)

  const result = runBin(['extension-pack', 'validate', '--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^sample\.readiness ok \(v1, 1 protocol, unlocked\)$/m)
})

test('distribution --help renders the command help without dispatching', () => {
  const result = runBin(['distribution', '--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Usage: atelier distribution check \[--target DIR\] \[--pack DIR\]/)
  assert.match(result.stdout, /TRADEMARKS\.md/)
})

// The attestation module prints its own usage and exits 0 for a bare
// invocation; only an unrecognized subcommand is a usage error (exit 2).
test('attestation with no subcommand prints usage through the CLI', () => {
  const result = runBin(['attestation'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^Usage: atelier attestation <subcommand>/)
  assert.match(result.stdout, /signing key file/)
  assert.doesNotMatch(result.stdout, /secret/i)
  assert.equal(runBin(['attestation', 'frobnicate']).status, 2)
})

test('the default help lists the white-label commands and the attestation stanza', () => {
  const help = runBin(['--help']).stdout
  assert.match(help, /^ {2}extension-pack validate {9}Validate declared extension packs\.$/m)
  assert.match(help, /^ {2}extension-pack list {13}List declared extension packs\.$/m)
  assert.match(help, /^ {2}distribution check {14}Check a distribution for MNSTRY attribution\.$/m)
  assert.match(help, /^ {2}disclosure check {16}Scan tracked or staged content for disclosure risks\.$/m)
  assert.match(help, /^Attestation commands:$/m)
  assert.match(help, /^ {2}attestation keygen --key-id ID {2}Generate a signing key pair\.$/m)
})

test('init command help lists the distribution template and the rejection rule', () => {
  const result = runBin(['init', '--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--template private-domain\|shared-project\|sample-workspace\|distribution/)
  assert.match(result.stdout, /An unrecognized --template exits 1 and writes nothing/)
})

test('runCli default-brand help and version match the pinned defaults', async () => {
  const out = []
  const helpCode = await runCli({ argv: [], stdout: (line) => out.push(line) })
  assert.equal(helpCode, 0)
  assert.equal(out[0], DEFAULT_HELP_TEXT)
  const versionOut = []
  const versionCode = await runCli({ argv: ['--version'], stdout: (line) => versionOut.push(line) })
  assert.equal(versionCode, 0)
  assert.deepEqual(versionOut, [VERSION])
})
