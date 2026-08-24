import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { computePackDigest } from '../src/extension-packs/loader.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const COMMAND = path.join(ROOT, 'src', 'commands', 'extension-pack.mjs')
const PACK_FIXTURES = path.join(ROOT, 'fixtures', 'atelier-extension-pack')
const VALID_PACK = path.join(PACK_FIXTURES, 'valid', 'sample-pack.v1.json')
const VALID_PROTOCOL = path.join(PACK_FIXTURES, 'valid', 'protocols', 'contract-gate.v1.json')
const EXT_NAMESPACE = 'mnstry.atelier'

// The command module is invoked directly (not through the CLI dispatcher),
// with the package-root env the dispatcher would set.
function run(args, { cwd = ROOT } = {}) {
  return spawnSync(process.execPath, [COMMAND, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, MNSTRY_ATELIER_PACKAGE_ROOT: ROOT },
  })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function entryFor(id, overrides = {}) {
  return { id, version: 'v1', path: `packs/${id}.v1.json`, enabled: true, ...overrides }
}

// Builds a temp project whose tracked config declares extension packs. Files
// are copied from committed fixtures ({ from, to }).
function packProject(t, { entries = null, files = [], overlay = null, lock = null } = {}) {
  const sample = makeSampleProject(t)
  for (const file of files) {
    const target = path.join(sample.dir, file.to)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(file.from, target)
  }
  if (entries !== null) {
    const config = readJson(sample.config)
    config.ext = { [EXT_NAMESPACE]: { extensionPacks: entries } }
    writeJson(sample.config, config)
  }
  if (overlay) writeJson(path.join(sample.dir, 'atelier.local.json'), overlay)
  if (lock) writeJson(path.join(sample.dir, 'atelier.lock.json'), lock)
  return sample
}

function validPackFiles() {
  return [
    { from: VALID_PACK, to: 'packs/sample.readiness.v1.json' },
    { from: VALID_PROTOCOL, to: 'packs/protocols/contract-gate.v1.json' },
  ]
}

test('validate reports a valid pack as ok and exits 0', (t) => {
  const sample = packProject(t, { entries: [entryFor('sample.readiness')], files: validPackFiles() })
  const result = run(['validate', '--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^sample\.readiness ok \(v1, 1 protocol, unlocked\)$/m)
})

test('validate --json emits the report schema with digest and protocol count', (t) => {
  const sample = packProject(t, { entries: [entryFor('sample.readiness')], files: validPackFiles() })
  const result = run(['validate', '--json', '--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schema, 'mnstry.atelier-extension-pack-report@v1')
  assert.equal(report.ok, true)
  assert.equal(report.packs.length, 1)
  const pack = report.packs[0]
  assert.equal(pack.id, 'sample.readiness')
  assert.equal(pack.status, 'ok')
  assert.equal(pack.enabled, true)
  assert.equal(pack.version, 'v1')
  assert.equal(pack.protocolCount, 1)
  assert.equal(pack.lock, 'unlocked')
  // Log-safety: emitted paths are config-relative, never machine-local
  // absolute paths (same rationale as distribution.mjs output).
  assert.equal(path.isAbsolute(pack.path), false)
  assert.equal(pack.path, 'packs/sample.readiness.v1.json')
  const rawBytes = fs.readFileSync(path.join(sample.dir, 'packs/sample.readiness.v1.json'))
  const protocolBytes = fs.readFileSync(path.join(sample.dir, 'packs/protocols/contract-gate.v1.json'))
  assert.equal(pack.digest, computePackDigest(rawBytes, [protocolBytes]))
  assert.deepEqual(pack.errors, [])
  assert.deepEqual(pack.warnings, [])
})

test('list is the default subcommand and prints one block per pack', (t) => {
  const sample = packProject(t, { entries: [entryFor('sample.readiness')], files: validPackFiles() })
  const result = run(['--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^sample\.readiness$/m)
  assert.match(result.stdout, /^ {2}version: v1$/m)
  assert.match(result.stdout, /^ {2}enabled: yes$/m)
  // Config-relative path in text output too; absolute paths never appear.
  assert.match(result.stdout, /^ {2}path: packs\/sample\.readiness\.v1\.json$/m)
  assert.match(result.stdout, /^ {2}digest: sha256:[0-9a-f]{64}$/m)
  assert.match(result.stdout, /^ {2}protocols: 1$/m)
  assert.match(result.stdout, /^ {2}lock: unlocked$/m)
})

test('validate marks a broken pack as error, prints the reason indented, and exits 1', (t) => {
  const sample = packProject(t, {
    entries: [entryFor('sample.invalid')],
    files: [{ from: path.join(PACK_FIXTURES, 'invalid', 'redefines-runtime-term.v1.json'), to: 'packs/sample.invalid.v1.json' }],
  })
  const result = run(['validate', '--project', sample.config])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /^sample\.invalid error$/m)
  assert.match(result.stdout, /^ {2}error: .*redefines reserved mnstry runtime term$/m)
})

test('list --json reports a broken enabled pack with ok false and exits 1', (t) => {
  const sample = packProject(t, {
    entries: [entryFor('sample.invalid')],
    files: [{ from: path.join(PACK_FIXTURES, 'invalid', 'redefines-runtime-term.v1.json'), to: 'packs/sample.invalid.v1.json' }],
  })
  const result = run(['list', '--json', '--project', sample.config])
  assert.equal(result.status, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schema, 'mnstry.atelier-extension-pack-list@v1')
  assert.equal(report.ok, false)
  assert.equal(report.packs[0].status, 'error')
  assert.equal(report.packs[0].digest, null)
})

test('a config-disabled pack is skipped and does not fail validate', (t) => {
  const sample = packProject(t, { entries: [entryFor('sample.readiness', { enabled: false })] })
  const result = run(['validate', '--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^sample\.readiness skipped \(disabled-in-config\)$/m)
})

test('an overlay-disabled pack is skipped and listed as not enabled', (t) => {
  const sample = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: validPackFiles(),
    overlay: {
      schema: 'mnstry.atelier-local-overlay@v1',
      preferences: { extensionPacks: { 'sample.readiness': { enabled: false } } },
    },
  })
  const result = run(['list', '--json', '--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.packs[0].status, 'skipped')
  assert.equal(report.packs[0].skippedReason, 'disabled-by-overlay')
  assert.equal(report.packs[0].enabled, false)
})

test('a lock digest mismatch fails validate and lists lock status mismatch', (t) => {
  const sample = packProject(t, {
    entries: [entryFor('sample.readiness')],
    files: validPackFiles(),
    lock: { extensionPacks: [{ id: 'sample.readiness', version: 'v1', digest: `sha256:${'0'.repeat(64)}` }] },
  })
  const validate = run(['validate', '--project', sample.config])
  assert.equal(validate.status, 1)
  assert.match(validate.stdout, /^ {2}error: lock digest mismatch for extension pack sample\.readiness/m)
  const list = run(['list', '--json', '--project', sample.config])
  assert.equal(list.status, 1)
  assert.equal(JSON.parse(list.stdout).packs[0].lock, 'mismatch')
})

test('a matching lock entry reports locked status', (t) => {
  const sample = packProject(t, { entries: [entryFor('sample.readiness')], files: validPackFiles() })
  const rawBytes = fs.readFileSync(path.join(sample.dir, 'packs/sample.readiness.v1.json'))
  const protocolBytes = fs.readFileSync(path.join(sample.dir, 'packs/protocols/contract-gate.v1.json'))
  const digest = computePackDigest(rawBytes, [protocolBytes])
  writeJson(path.join(sample.dir, 'atelier.lock.json'), {
    extensionPacks: [{ id: 'sample.readiness', version: 'v1', digest }],
  })
  const result = run(['validate', '--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^sample\.readiness ok \(v1, 1 protocol, locked\)$/m)
})

test('a project with no declared packs validates clean', (t) => {
  const sample = packProject(t, {})
  const result = run(['validate', '--project', sample.config])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^no extension packs declared$/m)
})

test('usage and project resolution errors exit 2', (t) => {
  const sample = packProject(t, {})
  assert.equal(run(['frobnicate', '--project', sample.config]).status, 2)
  assert.equal(run(['validate', '--nope', '--project', sample.config]).status, 2)
  assert.equal(run(['validate', 'stray-positional', '--project', sample.config]).status, 2)
  const missing = run(['validate', '--project', path.join(sample.dir, 'no-such-config.json')])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /project config not found/)
})

test('help prints usage with both subcommands and exits 0', () => {
  for (const args of [['--help'], ['help'], ['validate', '--help']]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /extension-pack <subcommand>/)
    assert.match(result.stdout, /validate \[--json\]/)
    assert.match(result.stdout, /list \[--json\]/)
  }
})
