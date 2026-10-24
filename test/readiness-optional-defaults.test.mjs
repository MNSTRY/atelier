import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createProtocolRegistry, loadExtensionPacks } from '../src/extension-packs/loader.mjs'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { captureReviewEvidence } from '../src/readiness-protocols/evidence.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = path.join(ROOT, 'bin', 'atelier.mjs')
const CUSTOM_ID = 'sample.readiness:contract-gate'
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)

function workspace(t, { includeBundled = false, custom = false } = {}) {
  const sample = makeSampleProject(t)
  const config = read(sample.config)
  config.ext = { 'mnstry.atelier': { readiness: { includeBundled } } }
  if (custom) {
    const fixtures = path.join(ROOT, 'fixtures', 'atelier-extension-pack', 'valid')
    fs.mkdirSync(path.join(sample.dir, 'packs', 'protocols'), { recursive: true })
    fs.copyFileSync(path.join(fixtures, 'sample-pack.v1.json'), path.join(sample.dir, 'packs', 'sample.readiness.v1.json'))
    fs.copyFileSync(path.join(fixtures, 'protocols', 'contract-gate.v1.json'), path.join(sample.dir, 'packs', 'protocols', 'contract-gate.v1.json'))
    config.ext['mnstry.atelier'].extensionPacks = [{ id: 'sample.readiness', version: 'v1', path: 'packs/sample.readiness.v1.json', enabled: true }]
  }
  write(sample.config, config)
  return sample
}

function versionContent(sample) {
  const repo = path.join(sample.dir, 'content')
  for (const args of [['init'], ['config', 'user.name', 'Invented Owner'], ['config', 'user.email', 'owner@example.invalid'], ['add', '.'], ['commit', '-m', 'seed']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 60000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
}

function cli(sample, ...args) {
  const env = { ...process.env, GITHUB_ACTOR: 'sample-owner', MNSTRY_ATELIER_PROJECT_CONFIG: sample.config }
  delete env.MNSTRY_ATELIER_ACTOR
  return spawnSync(process.execPath, [CLI, ...args, '--project', sample.config], {
    cwd: sample.dir,
    encoding: 'utf8',
    timeout: 60000,
    env,
  })
}

function successful(sample, ...args) {
  const result = cli(sample, ...args)
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr || result.stdout}`)
  return result
}

test('explicit custom-only registry excludes every bundled lookup affordance', (t) => {
  const sample = workspace(t, { custom: true })
  const project = resolveProjectConfig({ argv: ['--project', sample.config], cwd: sample.dir, env: {} })
  const registry = createProtocolRegistry({ packs: loadExtensionPacks(project).packs, includeBundled: false })
  assert.deepEqual(registry.listProtocols().map((protocol) => protocol.id), [CUSTOM_ID])
  assert.equal(registry.protocolById(CUSTOM_ID)?.id, CUSTOM_ID)
  assert.equal(registry.protocolById('contract-gate'), null)
  assert.equal(registry.protocolById('identity-map'), null)
  assert.equal(registry.protocolById('mnstry.readiness:identity-map'), null)
})

test('deselected bundle supports the actual graph, projection, readiness and lock path', (t) => {
  const sample = workspace(t)
  versionContent(sample)
  successful(sample, 'graph')
  successful(sample, 'project')
  successful(sample, 'readiness')
  const readiness = read(path.join(sample.dir, 'atelier-output', 'atelier-readiness.json'))
  const manifest = read(path.join(sample.dir, 'atelier-output', 'atelier.manifest.json'))
  const html = fs.readFileSync(path.join(sample.dir, 'atelier-output', 'index.html'), 'utf8')
  assert.equal(readiness.ready, true)
  assert.equal(Object.hasOwn(readiness, 'tenantReadiness'), false)
  assert.equal(Object.hasOwn(manifest, 'tenantReadiness'), false)
  assert.doesNotMatch(html, /MNSTRY Tenant Readiness|data-protocol="mnstry\.readiness:/)
  assert.deepEqual(JSON.parse(successful(sample, 'readiness', 'protocols', '--json').stdout).protocols, [])
  successful(sample, 'lock', 'write')
  successful(sample, 'lock', 'check')
  assert.deepEqual(read(path.join(sample.dir, 'atelier.lock.json')).extensionPacks, [])
  const locked = fs.readFileSync(path.join(sample.dir, 'atelier.lock.json'), 'utf8')
  const upgrade = JSON.parse(successful(sample, 'upgrade', '--dry-run').stdout)
  assert.equal(upgrade.ok, true)
  assert.deepEqual(upgrade.blockers, [])
  assert.equal(fs.readFileSync(path.join(sample.dir, 'atelier.lock.json'), 'utf8'), locked)
})

for (const args of [['journey'], ['packet'], ['export', '--dry-run']]) {
  test(`deselected bundle refuses tenant-only ${args[0]} before producing local packets`, (t) => {
    const sample = workspace(t, { custom: true })
    const result = cli(sample, 'readiness', ...args)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /bundled readiness pack.*disabled/i)
    assert.equal(fs.existsSync(path.join(sample.dir, '.atelier-local', 'readiness')), false)
  })
}

test('malformed tracked selection refuses protocol listing instead of selecting a default', (t) => {
  const sample = workspace(t, { includeBundled: 'false' })
  const result = cli(sample, 'readiness', 'protocols', '--json')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /includeBundled.*boolean/)
})

test('custom CLI runs persist and reopen without selecting bundled protocols', (t) => {
  const sample = workspace(t, { custom: true })
  const listed = JSON.parse(successful(sample, 'readiness', 'protocols', '--json').stdout)
  assert.deepEqual(listed.protocols.map((protocol) => protocol.id), [CUSTOM_ID])
  assert.equal(listed.protocols[0].source, 'sample.readiness')
  const answers = path.join(sample.dir, 'answers.json')
  write(answers, { scope: { name: 'Invented scope', sourceRef: 'source:local-note' } })
  const output = JSON.parse(successful(sample, 'readiness', 'run', CUSTOM_ID, '--answers', answers, '--no-proposal').stdout)
  assert.equal(output.status, 'review-needed')
  assert.equal(output.protocolId, CUSTOM_ID)
  assert.deepEqual(output.blockers, [])
  const stored = read(output.runPath)
  assert.equal(stored.protocolId, CUSTOM_ID)
  assert.equal(stored.safety.runtimeMutation, false)
  assert.ok(stored.claims.every((claim) => claim.status === 'proposed' && !claim.promoted))
  const unknown = cli(sample, 'readiness', 'run', 'identity-map', '--no-proposal')
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stderr, /readiness-protocol-unavailable/)
  assert.deepEqual(fs.readdirSync(path.dirname(output.runPath)), [path.basename(output.runPath)])
})

test('evidence capture cannot re-enable a bundled protocol excluded by tracked selection', (t) => {
  const sample = workspace(t)
  const project = resolveProjectConfig({ argv: ['--project', sample.config], cwd: sample.dir, env: {} })
  assert.throws(() => captureReviewEvidence(project, 'mnstry.readiness:identity-map', {}), /protocol unavailable/)
  assert.equal(fs.existsSync(path.join(sample.dir, '.atelier-local', 'review')), false)
})

test('review command refuses excluded bundled IDs before evidence or run persistence', (t) => {
  const sample = workspace(t)
  const result = cli(sample, 'review', 'run', 'mnstry.readiness:identity-map')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /readiness-protocol-unavailable/)
  assert.equal(fs.existsSync(path.join(sample.dir, '.atelier-local', 'review')), false)
  assert.equal(fs.existsSync(path.join(sample.dir, '.atelier-local', 'readiness')), false)
})

test('explicit lock writing changes bundle selection while preserving existing history and custom pins', (t) => {
  const sample = workspace(t, { includeBundled: true, custom: true })
  successful(sample, 'lock', 'write')
  const lockPath = path.join(sample.dir, 'atelier.lock.json')
  const previous = read(lockPath)
  previous.appliedMigrations = [{ id: 'synthetic-recorded-migration', hash: '1'.repeat(64), appliedAt: '2026-01-01T00:00:00.000Z' }]
  previous.lastSuccessfulUpgrade = '2026-01-01T00:00:00.000Z'
  write(lockPath, previous)
  const config = read(sample.config)
  config.ext['mnstry.atelier'].readiness.includeBundled = false
  write(sample.config, config)
  const stale = cli(sample, 'lock', 'check')
  assert.notEqual(stale.status, 0)
  assert.match(stale.stdout + stale.stderr, /bundled readiness pack.*disabled/i)
  assert.deepEqual(read(lockPath), previous)
  const upgrade = cli(sample, 'upgrade', '--dry-run')
  assert.notEqual(upgrade.status, 0)
  assert.ok(JSON.parse(upgrade.stdout).blockers.some((message) => /bundled readiness pack.*disabled/i.test(message)))
  assert.deepEqual(read(lockPath), previous)
  successful(sample, 'lock', 'write')
  successful(sample, 'lock', 'check')
  const selected = read(lockPath)
  assert.deepEqual(selected.extensionPacks, previous.extensionPacks.filter((pack) => pack.id !== 'mnstry-readiness-pack'))
  assert.deepEqual(selected.appliedMigrations, previous.appliedMigrations)
  assert.equal(selected.lastSuccessfulUpgrade, previous.lastSuccessfulUpgrade)
  assert.deepEqual(selected.template, previous.template)
  config.ext['mnstry.atelier'].readiness.includeBundled = true
  write(sample.config, config)
  successful(sample, 'lock', 'write')
  assert.deepEqual(read(lockPath).extensionPacks, previous.extensionPacks)
})

test('deselecting the bundle does not permit a custom pack to claim a bundled slug', (t) => {
  const sample = workspace(t, { custom: true })
  const protocolPath = path.join(sample.dir, 'packs', 'protocols', 'contract-gate.v1.json')
  const protocol = read(protocolPath)
  protocol.id = 'sample.readiness:offer-map'
  protocol.slug = 'offer-map'
  write(protocolPath, protocol)
  const manifestPath = path.join(sample.dir, 'packs', 'sample.readiness.v1.json')
  const manifest = read(manifestPath)
  manifest.protocols[0].id = protocol.id
  write(manifestPath, manifest)
  const result = cli(sample, 'readiness', 'protocols', '--json')
  assert.notEqual(result.status, 0)
  const project = resolveProjectConfig({ argv: ['--project', sample.config], cwd: sample.dir, env: {} })
  assert.throws(() => loadExtensionPacks(project), /collides with a bundled protocol slug/)
})

test('the existing external starter records custom review evidence with the bundle deselected', (t) => {
  const sample = makeSampleProject(t)
  const adapter = path.join(fs.realpathSync(sample.dir), 'adapter')
  const result = spawnSync(process.execPath, [CLI, 'init', '--template', 'external-project', '--target', adapter], {
    cwd: sample.dir, encoding: 'utf8', timeout: 60000,
  })
  assert.equal(result.status, 0, result.stderr)
  const project = { dir: adapter, config: path.join(adapter, 'atelier.project.json') }
  const config = read(project.config)
  config.ext['mnstry.atelier'].readiness = { includeBundled: false }
  write(project.config, config)
  successful(project, 'lock', 'write')
  const output = JSON.parse(successful(project, 'review', 'run', CUSTOM_ID, '--answers', path.join(adapter, 'answers.example.json')).stdout)
  assert.equal(output.ok, true)
  assert.match(output.evidenceDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(output.confidence, 'not-calibrated')
  const ledger = fs.readFileSync(path.join(adapter, '.atelier-local', 'review', 'evidence.ndjson'), 'utf8')
  assert.ok(ledger.includes(CUSTOM_ID))
  assert.equal(fs.existsSync(path.join(adapter, '.atelier-local', 'readiness')), false)
})


test('machine-local preferences cannot re-enable the bundle excluded by tracked selection', (t) => {
  const sample = workspace(t)
  write(path.join(sample.dir, 'atelier.local.json'), {
    preferences: { readiness: { includeBundled: true } },
    ext: { 'mnstry.atelier': { readiness: { includeBundled: true } } },
  })
  assert.deepEqual(JSON.parse(successful(sample, 'readiness', 'protocols', '--json').stdout).protocols, [])
  const result = cli(sample, 'readiness', 'journey')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /readiness-pack-disabled/)
})

test('custom-only selection keeps the existing byte-locked pack refusal before run writes', (t) => {
  const sample = workspace(t, { custom: true })
  successful(sample, 'lock', 'write')
  fs.appendFileSync(path.join(sample.dir, 'packs', 'protocols', 'contract-gate.v1.json'), '\n')
  const result = cli(sample, 'readiness', 'run', CUSTOM_ID, '--no-proposal')
  assert.notEqual(result.status, 0)
  const project = resolveProjectConfig({ argv: ['--project', sample.config], cwd: sample.dir, env: {} })
  assert.throws(() => loadExtensionPacks(project), /lock digest mismatch/)
  assert.equal(fs.existsSync(path.join(sample.dir, '.atelier-local', 'readiness')), false)
})


for (const selection of ['true', 'absent']) {
  test(`reselecting bundled readiness through ${selection} refuses a modern opt-out lock until explicit writing`, (t) => {
    const sample = workspace(t, { custom: true })
    versionContent(sample)
    successful(sample, 'lock', 'write')
    const lockPath = path.join(sample.dir, 'atelier.lock.json')
    const previousBytes = fs.readFileSync(lockPath, 'utf8')
    const previous = JSON.parse(previousBytes)
    assert.deepEqual(previous.extensionPacks.map((pack) => pack.id), ['sample.readiness'])
    const config = read(sample.config)
    if (selection === 'true') config.ext['mnstry.atelier'].readiness.includeBundled = true
    else delete config.ext['mnstry.atelier'].readiness
    write(sample.config, config)
    const lockCheck = cli(sample, 'lock', 'check')
    const upgrade = cli(sample, 'upgrade', '--dry-run')
    assert.equal(fs.readFileSync(lockPath, 'utf8'), previousBytes)
    assert.deepEqual({ lockCheckRefused: lockCheck.status !== 0, upgradeRefused: upgrade.status !== 0 }, { lockCheckRefused: true, upgradeRefused: true })
    assert.match(lockCheck.stdout + lockCheck.stderr, /bundled readiness pack.*selected.*not recorded/i)
    assert.ok(JSON.parse(upgrade.stdout).blockers.some((message) => /bundled readiness pack.*selected.*not recorded/i.test(message)))
    successful(sample, 'lock', 'write')
    successful(sample, 'lock', 'check')
    const selected = read(lockPath)
    assert.ok(selected.extensionPacks.some((pack) => pack.id === 'mnstry-readiness-pack'))
    assert.deepEqual(selected.extensionPacks.filter((pack) => pack.id !== 'mnstry-readiness-pack'), previous.extensionPacks)
    const nextBytes = fs.readFileSync(lockPath, 'utf8')
    assert.equal(JSON.parse(successful(sample, 'upgrade', '--dry-run').stdout).ok, true)
    assert.equal(fs.readFileSync(lockPath, 'utf8'), nextBytes)
  })
}

for (const inventory of ['empty', 'absent']) {
  test(`pre-bundle alpha.0 lock with ${inventory} pack inventory retains legacy default planning behavior`, (t) => {
    const sample = workspace(t, { includeBundled: true })
    versionContent(sample)
    successful(sample, 'lock', 'write')
    const lockPath = path.join(sample.dir, 'atelier.lock.json')
    const previous = read(lockPath)
    previous.package.version = '0.1.0-alpha.0'
    if (inventory === 'empty') previous.extensionPacks = []
    else delete previous.extensionPacks
    write(lockPath, previous)
    const previousBytes = fs.readFileSync(lockPath, 'utf8')
    assert.equal(JSON.parse(successful(sample, 'upgrade', '--dry-run').stdout).ok, true)
    assert.equal(fs.readFileSync(lockPath, 'utf8'), previousBytes)
    const checked = JSON.parse(cli(sample, 'lock', 'check').stdout)
    assert.equal(checked.ok, false)
    assert.ok(checked.errors.some((message) => /lock package version/.test(message)))
    if (inventory === 'absent') assert.ok(checked.errors.some((message) => /extensionPacks/.test(message)))
    assert.equal(fs.readFileSync(lockPath, 'utf8'), previousBytes)
  })
}
