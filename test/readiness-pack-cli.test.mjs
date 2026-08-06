import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { makeSampleProject } from './helpers/sample-project.mjs'

// Regression guard for the CLI registry wiring of `readiness packet` and
// `readiness export --dry-run` (commit 67df521). The runtime tests call
// buildTenantPacket/buildReadinessExportDryRun with an explicit registry, so
// they stay green if the command layer stops passing one; these tests spawn
// the command module itself and only pass while the CLI is pack-aware.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = path.join(ROOT, 'src', 'commands', 'readiness.mjs')
const PACK_FIXTURES = path.join(ROOT, 'fixtures', 'atelier-extension-pack', 'valid')
const PACK_PROTOCOL_ID = 'sample.readiness:contract-gate'
const PACK_BLOCKER = `readiness-incomplete:${PACK_PROTOCOL_ID}`

// Temp workspace whose tracked config declares the committed sample.readiness
// pack with a required gate. Recipe mirrors packProject in
// test/readiness-protocol-runtime.test.mjs (copied on purpose — that file is
// owned by a parallel change).
function packProject(t) {
  const sample = makeSampleProject(t)
  const packDoc = JSON.parse(fs.readFileSync(path.join(PACK_FIXTURES, 'sample-pack.v1.json'), 'utf8'))
  packDoc.protocols[0].gate = 'required'
  fs.mkdirSync(path.join(sample.dir, 'packs', 'protocols'), { recursive: true })
  fs.writeFileSync(path.join(sample.dir, 'packs', 'sample.readiness.v1.json'), `${JSON.stringify(packDoc, null, 2)}\n`)
  fs.copyFileSync(
    path.join(PACK_FIXTURES, 'protocols', 'contract-gate.v1.json'),
    path.join(sample.dir, 'packs', 'protocols', 'contract-gate.v1.json')
  )
  const config = JSON.parse(fs.readFileSync(sample.config, 'utf8'))
  config.ext = {
    'mnstry.atelier': {
      extensionPacks: [{ id: 'sample.readiness', version: 'v1', path: 'packs/sample.readiness.v1.json', enabled: true }],
    },
  }
  fs.writeFileSync(sample.config, `${JSON.stringify(config, null, 2)}\n`)
  return sample
}

// The command module is invoked directly (not through the CLI dispatcher),
// with the package-root env the dispatcher would set.
function run(args, { cwd }) {
  return spawnSync(process.execPath, [COMMAND, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT },
  })
}

test('readiness packet from the CLI carries the pack contribution under ext', (t) => {
  const sample = packProject(t)
  const result = run(['packet', `--project=${sample.config}`], { cwd: sample.dir })

  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.packet.schema, 'mnstry.tenant-readiness-packet@v1')

  const extensionPacks = output.packet.ext?.['mnstry.atelier']?.extensionPacks
  assert.ok(Array.isArray(extensionPacks) && extensionPacks.length > 0,
    'packet.ext["mnstry.atelier"].extensionPacks must be non-empty when the workspace declares a pack')
  assert.equal(extensionPacks[0].id, 'sample.readiness')
  assert.equal(extensionPacks[0].protocols[0].protocolId, PACK_PROTOCOL_ID)
  assert.ok(output.packet.exportBlockers.includes(PACK_BLOCKER))
})

test('readiness export --dry-run from the CLI carries the pack-specific blocker', (t) => {
  const sample = packProject(t)
  const result = run(['export', '--dry-run', `--project=${sample.config}`], { cwd: sample.dir })

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schema, 'mnstry.readiness-export-dry-run@v1')
  assert.equal(report.worstOperationStatus, 'blocked')
  assert.ok(report.blockers.includes(PACK_BLOCKER),
    'an unfinished required pack protocol must block the export dry-run from the command line')
  assert.notEqual(report.tenantPacket.ext['mnstry.atelier'].extensionPacks.length, 0)
})
