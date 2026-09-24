import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test, { beforeEach } from 'node:test'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { validateJsonSchema } from '../src/export/atelier-export-contract.mjs'
import { writeAtelierLock } from '../src/upgrade/upgrade.mjs'
import { prepareUpgrade, applySavedUpgrade, upgradeOperationStatus, recoverUpgradeDryRun, validateUpgradeDocument, explainSavedUpgrade, prepareTemplateUpgrade } from '../src/upgrade/transaction.mjs'
import { hashObject, hashBytes, inventory } from '../src/upgrade/transaction-files.mjs'
import { renderUpgradeExplanation } from '../src/upgrade/explanation.mjs'
import { resolveGitExecutable } from '../src/runtime/git-adapter.mjs'
import { upgradeTestGit } from '../scripts/upgrade-test-git.mjs'

beforeEach((t) => {
  const keys = ['GITHUB_ACTOR', 'MNSTRY_ATELIER_ACTOR', 'HOME', 'XDG_CONFIG_HOME', 'PATH', 'ATELIER_GIT_PATH']
  const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  const environment = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-upgrade-git-'))
  if (process.platform !== 'win32') Object.assign(process.env, upgradeTestGit(environment).env)
  process.env.GITHUB_ACTOR = 'author'
  delete process.env.MNSTRY_ATELIER_ACTOR
  t.after(() => {
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key] }
    fs.rmSync(environment, { recursive: true, force: true })
  })
})
const transactionTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'Exact transaction execution requires a qualified POSIX directory-durability path; refusal is tested separately.' : false }, fn)
const git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const put = (root, name, value) => fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`)
function baseFixture(t, hook) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-exact-upgrade-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const source = path.join(parent, 'source')
  const root = path.join(parent, 'candidate')
  fs.mkdirSync(source)
  git(source, ['init'])
  git(source, ['config', 'user.name', 'Example Author'])
  git(source, ['config', 'user.email', 'author@example.invalid'])
  git(source, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(source, '.gitignore'), '.atelier-local/\natelier-output/\n')
  fs.writeFileSync(path.join(source, 'seed.md'), '---\ntitle: Seed\nkg:\n  id: "workspace:seed"\n  type: "document"\n  status: "active"\n  audience: "private"\n---\n# Seed\n')
  put(source, 'atelier.project.json', { schema: 'mnstry.atelier-project-config@v1', name: 'Example Workshop', roots: { workspace: '.' }, graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' }, projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' }, boundaries: { policyPath: 'boundary-policy.v1.json' }, repos: [{ name: 'workspace', path: '.', readBoundary: 'private' }], ext: { 'mnstry.atelier': { distribution: { name: 'Example Workshop', theme: { accent: '#abcdef' } } } } })
  put(source, 'repo-access.v1.json', { schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'private', repos: { workspace: { readBoundary: 'private' } } })
  put(source, 'boundary-policy.v1.json', { schema: 'mnstry.atelier-boundary-policy@v1', mode: 'strict', actors: { author: { githubLogin: 'author', gitEmails: ['author@example.invalid'], privateDomainRepo: 'workspace' } }, repos: { workspace: { kind: 'private_domain', ownerActor: 'author', readBoundary: 'private', allowedAudiences: ['private'], forbiddenAudiences: [], autoCommit: 'guarded' } }, promotion: { requiresGitPromote: true, recordsPath: 'governance/events.jsonl' }, forbiddenPaths: [] })
  put(source, 'atelier.adoption-policy.json', { schema: 'mnstry.atelier-adoption-policy@v1', enabled: true, mode: 'manual-exact-plan', maxAgeSeconds: 86400, recoveryCoverage: 'local-only', allowedEffects: ['lock-and-projections', 'git-commit'] })
  git(source, ['add', '.'])
  git(source, ['commit', '-m', 'Seed synthetic workspace'])
  git(source, ['worktree', 'add', '-b', 'example-upgrade', root])
  if (hook) { const file = path.join(source, '.git', 'hooks', 'pre-commit'); fs.writeFileSync(file, `#!/bin/sh\n${hook}\n`); fs.chmodSync(file, 0o755) }
  const project = resolveProjectConfig({ cwd: root, argv: ['--project', path.join(root, 'atelier.project.json')], env: {}, writeLocalState: false })
  return { source, root, project }
}
const apply = (project, prepared) => applySavedUpgrade({ project, planFile: prepared.savedPlan, confirm: prepared.plan.digest })


const profileSample = JSON.parse(fs.readFileSync(new URL('../fixtures/templates/local-library.v1.json', import.meta.url)))
const policyV2 = { schema: 'mnstry.atelier-adoption-policy@v2', enabled: true, mode: 'manual-exact-plan', maxAgeSeconds: 86400, recoveryCoverage: 'local-only', participant: 'local-template-profile@1', allowedEffects: ['template-adoption', 'lock-and-projections', 'git-commit'] }
function fixture(t, hook) {
  const f = baseFixture(t)
  put(f.root, 'next-profile.json', profileSample)
  put(f.root, 'next-selection.json', { projectRef: 'sample.workshop', roleNodeIds: { items: ['workspace:seed'] }, target: 'local' })
  put(f.root, 'atelier.adoption-policy.json', policyV2)
  git(f.root, ['add', 'next-profile.json', 'next-selection.json', 'atelier.adoption-policy.json'])
  git(f.root, ['commit', '-m', 'Enroll synthetic template inputs'])
  if (hook) { const file = path.join(f.source, '.git', 'hooks', 'pre-commit'); fs.writeFileSync(file, '#!/bin/sh\n' + hook + '\n'); fs.chmodSync(file, 0o755) }
  return f
}
const prepare = f => prepareTemplateUpgrade({ project: f.project, profileFile: 'next-profile.json', selectionFile: 'next-selection.json' })
const commit = f => { git(f.root, ['add', '-A']); git(f.root, ['commit', '-m', 'Change synthetic inputs']) }
const read = (f, name) => fs.readFileSync(path.join(f.root, name))
const state = f => hashObject(inventory(f.root, { exclude: ['.git', '.atelier-local'] }))
const update = f => { const profile = structuredClone(profileSample); profile.version = '1.1.0'; profile.purpose = 'An updated invented reading shelf.'; put(f.root, 'next-profile.json', profile); commit(f) }

transactionTest('prior-release lock upgrades through the template v3 transaction without a separate repin', (t) => {
  const f = fixture(t)
  const bytes = fs.readFileSync(new URL('./fixtures/upgrade/alpha10-lock.json', import.meta.url))
  const previous = JSON.parse(bytes)
  fs.writeFileSync(path.join(f.root, 'atelier.lock.json'), bytes)
  commit(f)
  const source = read(f, 'seed.md')
  const prepared = prepare(f)
  assert.equal(prepared.plan.schema, 'mnstry.atelier-upgrade-plan@v3')
  assert.deepEqual(read(f, 'atelier.lock.json'), bytes)
  const applied = apply(f.project, prepared)
  assert.equal(applied.ok, true, JSON.stringify(applied))
  const next = JSON.parse(read(f, 'atelier.lock.json'))
  assert.deepEqual(next.extensionPacks, previous.extensionPacks)
  assert.notEqual(next.package.version, previous.package.version)
  assert.equal(next.template.id, profileSample.id)
  assert.deepEqual(next.appliedMigrations, previous.appliedMigrations)
  assert.deepEqual(read(f, 'seed.md'), source)
  assert.equal(upgradeOperationStatus({ project: f.project, operationId: applied.operationId }).status, 'completed')
})

transactionTest('prior-release lock with a changed pack digest still refuses template preparation', (t) => {
  const f = fixture(t)
  const previous = JSON.parse(fs.readFileSync(new URL('./fixtures/upgrade/alpha10-lock.json', import.meta.url)))
  previous.extensionPacks[0].digest = 'sha256:' + '0'.repeat(64)
  put(f.root, 'atelier.lock.json', previous)
  commit(f)
  assert.throws(() => prepare(f), /pack adoption requires a separate participant/)
  assert.deepEqual(JSON.parse(read(f, 'atelier.lock.json')), previous)
})

transactionTest('template epoch metadata is optional and reserved extensions cannot enable behavior', t => {
  const f = fixture(t), { plan } = prepare(f)
  const adoption = JSON.parse(Buffer.from(plan.writes.find(entry => entry.path === 'atelier-template/adoption.json').content, 'base64'))
  const cases = [['atelier-adoption-policy.v2', plan.policy], ['atelier-migration.v3', plan.migration], ['atelier-template-adoption.v1', adoption], ['atelier-upgrade-plan.v3', plan]]
  for (const [name, document] of cases) {
    const schema = JSON.parse(fs.readFileSync(new URL('../contracts/' + name + '.schema.json', import.meta.url)))
    const major = name.match(/\.v(\d+)$/)[1]
    assert.deepEqual(validateJsonSchema(schema, document), [])
    assert.deepEqual(validateJsonSchema(schema, { ...document, contractVersion: major + '.0.0', ext: {} }), [])
    assert.notDeepEqual(validateJsonSchema(schema, { ...document, contractVersion: '9.0.0' }), [])
    assert.notDeepEqual(validateJsonSchema(schema, { ...document, ext: { execute: true } }), [])
    const inspect = node => {
      if (!node || typeof node !== 'object') return
      if (node.additionalProperties === false) {
        assert.equal(node.properties.ext.type, 'object')
        assert.equal(node.properties.ext.maxProperties, 0)
        assert.equal((node.required ?? []).includes('ext'), false)
        assert.equal((node.required ?? []).includes('contractVersion'), false)
      }
      for (const [key, value] of Object.entries(node)) if (!['const', 'enum', 'default', 'examples'].includes(key)) inspect(value)
    }
    inspect(schema)
  }
  const nested = structuredClone(plan)
  nested.participant.ext = { execute: true }
  assert.throws(() => validateUpgradeDocument('plan', nested))
  const embeddedMetadata = structuredClone(plan)
  embeddedMetadata.policy.contractVersion = '2.0.0'
  embeddedMetadata.migration.contractVersion = '3.0.0'
  assert.doesNotThrow(() => validateUpgradeDocument('plan', embeddedMetadata))
})

transactionTest('first adoption and update use one journal, preserve source/history and render current bindings', t => {
  const f = fixture(t), source = read(f, 'seed.md'), head = git(f.root, ['rev-parse', 'HEAD'])
  const prepared = prepare(f)
  assert.equal(prepared.plan.schema, 'mnstry.atelier-upgrade-plan@v3')
  assert.equal(prepared.plan.policy.schema, 'mnstry.atelier-adoption-policy@v2')
  assert.equal(prepared.plan.participant.id, 'local-template-profile@1')
  assert.equal(fs.existsSync(path.join(f.root, 'atelier-template')), false)
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), head)
  const explained = explainSavedUpgrade({ project: f.project, planFile: prepared.savedPlan })
  assert.equal(explained.participant, 'local-template-profile@1')
  assert.equal(explained.consent.applicationAuthorized, false)
  const result = apply(f.project, prepared)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.activated, false)
  assert.deepEqual(read(f, 'seed.md'), source)
  assert.match(read(f, 'atelier-output/template.html').toString(), /Seed/)
  const firstAdoption = read(f, 'atelier-template/adoption.json')
  const lock = JSON.parse(read(f, 'atelier.lock.json'))
  assert.equal(lock.template.id, profileSample.id)
  assert.equal(lock.lastSuccessfulUpgrade, null)
  assert.equal(upgradeOperationStatus({ project: f.project, operationId: result.operationId }).status, 'completed')
  assert.throws(() => apply(f.project, prepared))
  lock.ext = { 'sample.notes': { retained: true } }
  lock.template.ext = { 'sample.notes': { prior: 'kept' } }
  lock.lastSuccessfulUpgrade = '2020-01-01T00:00:00.000Z'
  put(f.root, 'atelier.lock.json', lock)
  update(f)
  const second = prepare(f), completed = apply(f.project, second)
  assert.equal(completed.ok, true, JSON.stringify(completed))
  const previous = second.plan.participant.previousAdoptionDigest
  assert.deepEqual(read(f, 'atelier-template/history/' + previous.slice(7) + '.json'), firstAdoption)
  assert.deepEqual(read(f, 'seed.md'), source)
  assert.match(read(f, 'atelier-output/template.html').toString(), /updated invented reading shelf/)
  const updatedLock = JSON.parse(read(f, 'atelier.lock.json'))
  assert.equal(updatedLock.template.version, '1.1.0')
  assert.deepEqual(updatedLock.ext, lock.ext)
  assert.deepEqual(updatedLock.template.ext, lock.template.ext)
  assert.equal(updatedLock.lastSuccessfulUpgrade, lock.lastSuccessfulUpgrade)
  assert.deepEqual(updatedLock.appliedMigrations, lock.appliedMigrations)
  assert.equal(git(f.root, ['status', '--porcelain']), '')
  const recovery = recoverUpgradeDryRun({ project: f.project, operationId: completed.operationId })
  assert.equal(recovery.mutation, false)
  assert.equal(recovery.requiresNewConfirmation, true)
})

for (const name of ['unknown-target', 'runtime', 'pack', 'extension', 'unknown-selection-field']) transactionTest('refuses unsupported ' + name + ' before installed writes', t => {
  const f = fixture(t), p = structuredClone(profileSample)
  if (name === 'runtime') p.runtimeProfileRef = { kind: 'RuntimeProfileRef', id: 'runtime.sample', version: '1.0.0', digest: 'sha256:' + 'a'.repeat(64) }
  if (name === 'pack') p.compatibility.packRefs = [{ id: 'sample.pack', version: 'v1', digest: 'sha256:' + 'a'.repeat(64) }]
  if (name === 'extension') p.extensions = [{ namespace: 'sample.notes', required: true, schemaRef: { kind: 'SchemaRef', id: 'schema.sample', version: '1.0.0', digest: 'sha256:' + 'a'.repeat(64) }, payloadRef: { kind: 'PayloadRef', id: 'payload.sample', version: '1.0.0', digest: 'sha256:' + 'b'.repeat(64) } }]
  put(f.root, 'next-profile.json', p)
  if (name === 'unknown-target') put(f.root, 'next-selection.json', { projectRef: 'sample.workshop', roleNodeIds: { items: ['workspace:seed'] }, target: 'unknown' })
  if (name === 'unknown-selection-field') put(f.root, 'next-selection.json', { projectRef: 'sample.workshop', roleNodeIds: { items: ['workspace:seed'] }, target: 'local', execute: true })
  commit(f); const before = state(f)
  assert.throws(() => prepare(f))
  assert.equal(state(f), before)
})

for (const change of ['missing', 'disabled', 'participant', 'effects', 'v1']) transactionTest('refuses wrong template policy: ' + change, t => {
  const f = fixture(t), policy = structuredClone(policyV2)
  if (change === 'missing') fs.unlinkSync(path.join(f.root, 'atelier.adoption-policy.json'))
  else {
    if (change === 'disabled') policy.enabled = false
    if (change === 'participant') policy.participant = 'custom'
    if (change === 'effects') policy.allowedEffects = ['lock-and-projections', 'git-commit']
    if (change === 'v1') { policy.schema = 'mnstry.atelier-adoption-policy@v1'; delete policy.participant; policy.allowedEffects = ['lock-and-projections', 'git-commit'] }
    put(f.root, 'atelier.adoption-policy.json', policy)
  }
  commit(f); const before = state(f)
  assert.throws(() => prepare(f))
  assert.equal(state(f), before)
})

transactionTest('exact confirmation, committed source drift, policy revocation and input digest tampering refuse', t => {
  const f = fixture(t), prepared = prepare(f), before = state(f)
  assert.throws(() => applySavedUpgrade({ project: f.project, planFile: prepared.savedPlan, confirm: 'sha256:' + '0'.repeat(64) }), /confirmation/)
  assert.equal(state(f), before)
  const tampered = structuredClone(prepared.plan)
  tampered.participant.profileDigest = 'sha256:' + 'b'.repeat(64)
  fs.writeFileSync(prepared.savedPlan, JSON.stringify(tampered))
  assert.throws(() => apply(f.project, prepared), /digest/)
  fs.writeFileSync(prepared.savedPlan, JSON.stringify(prepared.plan))
  fs.appendFileSync(path.join(f.root, 'seed.md'), '\nAnother synthetic line.\n')
  commit(f)
  assert.throws(() => apply(f.project, prepared), /changed/)
  assert.equal(fs.existsSync(path.join(f.root, 'atelier-template')), false)
})

transactionTest('rehashed surplus history writes refuse in explain, apply, status and recovery', t => {
  const f = fixture(t), prepared = prepare(f), before = state(f)
  const forged = structuredClone(prepared.plan)
  const name = 'atelier-template/history/' + 'a'.repeat(64) + '.json'
  const bytes = Buffer.from('{}\n')
  forged.migration.allowedWrites.push(name)
  forged.writes.push({ path: name, action: 'create', owner: 'template-history', before: null, after: { digest: hashBytes(bytes), mode: '100644' }, content: bytes.toString('base64') })
  const { digest, ...authority } = forged
  forged.digest = hashObject(authority)
  const savedPlan = path.join(path.dirname(prepared.savedPlan), forged.digest.slice(7) + '.json')
  fs.writeFileSync(savedPlan, JSON.stringify(forged))
  const operationId = forged.digest.slice(7)
  for (const inspect of [
    () => explainSavedUpgrade({ project: f.project, planFile: savedPlan }),
    () => applySavedUpgrade({ project: f.project, planFile: savedPlan, confirm: forged.digest }),
    () => upgradeOperationStatus({ project: f.project, operationId }),
    () => recoverUpgradeDryRun({ project: f.project, operationId }),
  ]) assert.throws(inspect, /unregistered template managed path set/)
  assert.equal(state(f), before)
})

transactionTest('repeated identical input is explicit history adoption without rewriting identical template bytes', t => {
  const f = fixture(t)
  assert.equal(apply(f.project, prepare(f)).ok, true)
  const previous = read(f, 'atelier-template/adoption.json')
  const repeated = prepare(f)
  const stable = ['atelier-template/profile.json', 'atelier-template/selection.json', 'atelier-output/template.html', 'atelier-output/template-binding.json']
  assert.equal(repeated.plan.writes.some(entry => stable.includes(entry.path)), false)
  assert.equal(repeated.plan.participant.previousAdoptionDigest, hashBytes(previous))
  assert.equal(apply(f.project, repeated).ok, true)
  assert.deepEqual(read(f, 'atelier-template/history/' + hashBytes(previous).slice(7) + '.json'), previous)
  assert.notDeepEqual(read(f, 'atelier-template/adoption.json'), previous)
})

transactionTest('first adoption allows empty reserved roots but refuses unknown empty child directories', t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'atelier-template/history'), { recursive: true })
  fs.mkdirSync(path.join(f.root, 'atelier-template/custom'))
  assert.throws(() => prepare(f), /unknown reserved template directory/)
  fs.rmdirSync(path.join(f.root, 'atelier-template/custom'))
  fs.mkdirSync(path.join(f.root, 'atelier-template/history/custom'))
  assert.throws(() => prepare(f), /unknown template history directory/)
  fs.rmdirSync(path.join(f.root, 'atelier-template/history/custom'))
  assert.equal(apply(f.project, prepare(f)).ok, true)
})

for (const managed of ['atelier-template/profile.json', 'atelier-output/template.html', 'atelier-template/adoption.json']) transactionTest('committed local override refuses: ' + managed, t => {
  const f = fixture(t); assert.equal(apply(f.project, prepare(f)).ok, true)
  fs.appendFileSync(path.join(f.root, managed), '\nlocal override\n')
  commit(f); const before = state(f)
  assert.throws(() => prepare(f))
  assert.equal(state(f), before)
})

transactionTest('unknown reserved state, missing managed files and corrupted immutable history refuse', t => {
  for (const mode of ['orphan', 'unknown', 'missing', 'history', 'manifest-digest']) {
    const f = fixture(t)
    if (mode !== 'orphan') assert.equal(apply(f.project, prepare(f)).ok, true)
    if (mode === 'history') { update(f); assert.equal(apply(f.project, prepare(f)).ok, true); const history = fs.readdirSync(path.join(f.root, 'atelier-template/history'))[0]; fs.appendFileSync(path.join(f.root, 'atelier-template/history', history), 'changed') }
    if (mode === 'missing') fs.unlinkSync(path.join(f.root, 'atelier-template/selection.json'))
    if (mode === 'manifest-digest') { const adoption = JSON.parse(read(f, 'atelier-template/adoption.json')); adoption.inputs.profile.digest = 'sha256:' + '0'.repeat(64); put(f.root, 'atelier-template/adoption.json', adoption) }
    if (mode === 'unknown' || mode === 'orphan') { fs.mkdirSync(path.join(f.root, 'atelier-template'), { recursive: true }); fs.writeFileSync(path.join(f.root, 'atelier-template/custom.txt'), 'custom') }
    commit(f); const before = state(f)
    assert.throws(() => prepare(f))
    assert.equal(state(f), before)
  }
})

transactionTest('literal input paths refuse aliases, traversal, overlap, symlinks and executable input', t => {
  const f = fixture(t)
  for (const profileFile of ['./next-profile.json', '../next-profile.json', '/next-profile.json', 'atelier-template/profile.json', 'atelier-output/template.html']) {
    assert.throws(() => prepareTemplateUpgrade({ project: f.project, profileFile, selectionFile: 'next-selection.json' }))
  }
  assert.throws(() => prepareTemplateUpgrade({ project: f.project, profileFile: 'next-profile.json', selectionFile: 'next-profile.json' }))
  fs.symlinkSync('next-profile.json', path.join(f.root, 'alias.json')); commit(f)
  assert.throws(() => prepareTemplateUpgrade({ project: f.project, profileFile: 'alias.json', selectionFile: 'next-selection.json' }))
  fs.unlinkSync(path.join(f.root, 'alias.json')); fs.chmodSync(path.join(f.root, 'next-profile.json'), 0o755); commit(f)
  assert.throws(() => prepare(f), /non-executable/)
})

transactionTest('local overlay and output collisions refuse without installed writes', t => {
  const f = fixture(t)
  put(f.root, 'atelier.local.json', { schema: 'mnstry.atelier-local-overlay@v1', preferences: {} }); commit(f)
  f.project = resolveProjectConfig({ cwd: f.root, argv: ['--project', path.join(f.root, 'atelier.project.json')], env: {}, writeLocalState: false })
  assert.throws(() => prepare(f), /overlays/)
  fs.unlinkSync(path.join(f.root, 'atelier.local.json'))
  const config = JSON.parse(read(f, 'atelier.project.json'))
  config.graph.outputPath = 'atelier-output/template.html'
  put(f.root, 'atelier.project.json', config); commit(f)
  f.project = resolveProjectConfig({ cwd: f.root, argv: ['--project', path.join(f.root, 'atelier.project.json')], env: {}, writeLocalState: false })
  const before = state(f)
  assert.throws(() => prepare(f), /conflicts/)
  assert.equal(state(f), before)
})

transactionTest('expired plans and uncommitted ignored source drift refuse without adoption', t => {
  const f = fixture(t)
  const expired = prepareTemplateUpgrade({ project: f.project, profileFile: 'next-profile.json', selectionFile: 'next-selection.json', now: new Date(Date.now() - 172800000) })
  assert.throws(() => apply(f.project, expired), /expired/)
  const prepared = prepare(f)
  fs.mkdirSync(path.join(f.root, 'atelier-output'), { recursive: true })
  fs.writeFileSync(path.join(f.root, 'atelier-output/unexpected.json'), '{}')
  assert.equal(git(f.root, ['status', '--porcelain']), '')
  const before = state(f)
  assert.throws(() => apply(f.project, prepared), /changed/)
  assert.equal(state(f), before)
  assert.equal(fs.existsSync(path.join(f.root, 'atelier-template/adoption.json')), false)
})

transactionTest('hook refusal uses existing receipt/backups and corrupted backups become conflicts', t => {
  const f = fixture(t)
  assert.equal(apply(f.project, prepare(f)).ok, true)
  update(f)
  const hook = path.join(f.source, '.git/hooks/pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n'); fs.chmodSync(hook, 0o755)
  const prepared = prepare(f)
  const result = apply(f.project, prepared)
  assert.equal(result.status, 'commit-refused')
  assert.equal(result.ok, false)
  const recovery = recoverUpgradeDryRun({ project: f.project, operationId: result.operationId })
  assert.equal(recovery.mutation, false)
  assert.ok(recovery.entries.some(x => x.state === 'restorable-after-new-confirmation'))
  const index = prepared.plan.writes.findIndex(x => x.path === 'atelier-template/profile.json')
  const backup = path.join(f.root, '.atelier-local/upgrades/operations', result.operationId, 'backups', index + '.bin')
  fs.appendFileSync(backup, 'corrupt')
  assert.equal(recoverUpgradeDryRun({ project: f.project, operationId: result.operationId }).entries.find(x => x.path === 'atelier-template/profile.json').state, 'conflict')
  assert.throws(() => apply(f.project, prepared))
})

transactionTest('interruption after each prepared write boundary consumes the plan and retains source', t => {
  // No production failpoint is installed: faults wrap fs only inside this
  // sequential disposable test and are always restored.
  const probe = fixture(t), paths = prepare(probe).plan.writes.map(x => x.path)
  for (const interruptedPath of paths) {
    const f = fixture(t), prepared = prepare(f), source = read(f, 'seed.md')
    const original = fs.renameSync
    let interrupted = false, result
    fs.renameSync = function(from, to) {
      const value = original.call(fs, from, to)
      if (!interrupted && to === path.join(fs.realpathSync(f.root), interruptedPath)) {
        interrupted = true
        throw new Error('synthetic interruption after managed write')
      }
      return value
    }
    try { result = apply(f.project, prepared) } finally { fs.renameSync = original }
    assert.equal(interrupted, true)
    assert.equal(result.status, 'recovery-required', JSON.stringify(result))
    assert.equal(upgradeOperationStatus({ project: f.project, operationId: result.operationId }).ok, false)
    assert.equal(recoverUpgradeDryRun({ project: f.project, operationId: result.operationId }).mutation, false)
    assert.deepEqual(read(f, 'seed.md'), source)
    assert.throws(() => apply(f.project, prepared))
  }
})

transactionTest('hook mutation refuses completion and post-plan policy revocation refuses before writes', t => {
  const f = fixture(t, 'printf "Changed by hook\\n" >> seed.md\ngit add seed.md')
  const prepared = prepare(f), result = apply(f.project, prepared)
  assert.equal(result.status, 'recovery-required')
  assert.equal(upgradeOperationStatus({ project: f.project, operationId: result.operationId }).ok, false)
  const g = fixture(t), pending = prepare(g)
  put(g.root, 'atelier.adoption-policy.json', { ...policyV2, enabled: false }); commit(g)
  const before = state(g)
  assert.throws(() => apply(g.project, pending), /disabled|revoked|changed/)
  assert.equal(state(g), before)
})

transactionTest('template v3 schema and old v2 transaction remain separate', t => {
  const f = baseFixture(t), prepared = prepareUpgrade(f)
  assert.equal(prepared.plan.schema, 'mnstry.atelier-upgrade-plan@v2')
  assert.equal(apply(f.project, prepared).ok, true)
  assert.throws(() => validateUpgradeDocument('plan', { ...prepared.plan, participant: { id: 'local-template-profile@1' } }))
  const g = fixture(t), template = prepare(g)
  assert.throws(() => validateUpgradeDocument('plan', { ...template.plan, migration: { ...template.plan.migration, id: 'custom' } }))
  assert.throws(() => validateUpgradeDocument('plan', { ...template.plan, execute: true }))
})
