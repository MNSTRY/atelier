import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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
  assert.equal(commandMap.size, 41)
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
