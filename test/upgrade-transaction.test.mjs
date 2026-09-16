import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test, { beforeEach } from 'node:test'
import { resolveProjectConfig } from '../src/project/config.mjs'
import { writeAtelierLock } from '../src/upgrade/upgrade.mjs'
import { prepareUpgrade, applySavedUpgrade, upgradeOperationStatus, recoverUpgradeDryRun, validateUpgradeDocument } from '../src/upgrade/transaction.mjs'
import { hashObject } from '../src/upgrade/transaction-files.mjs'

beforeEach((t) => {
  const keys = ['GITHUB_ACTOR', 'MNSTRY_ATELIER_ACTOR']
  const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
  process.env.GITHUB_ACTOR = 'author'
  delete process.env.MNSTRY_ATELIER_ACTOR
  t.after(() => { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key] } })
})
const transactionTest = (name, fn) => test(name, { skip: process.platform === 'win32' ? 'Exact transaction execution requires a qualified POSIX directory-durability path; refusal is tested separately.' : false }, fn)
const git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const put = (root, name, value) => fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`)
function fixture(t, hook) {
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

transactionTest('in-progress Git operations refuse preparation and application from outside the worktree', (t) => {
  const f = fixture(t)
  assert.notEqual(fs.realpathSync(process.cwd()), fs.realpathSync(f.root))
  const prepared = prepareUpgrade(f)
  const before = git(f.root, ['rev-parse', 'HEAD'])
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const marker = path.resolve(f.root, git(f.root, ['rev-parse', '--git-path', name]))
    if (name.startsWith('rebase-')) fs.mkdirSync(marker)
    else fs.writeFileSync(marker, `${before}\n`)
    assert.throws(() => prepareUpgrade(f), /Git operation already in progress/)
    assert.throws(() => apply(f.project, prepared), /Git operation already in progress/)
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), before)
    assert.equal(fs.existsSync(path.join(f.root, 'atelier.lock.json')), false)
    assert.equal(fs.existsSync(marker), true)
    fs.rmSync(marker, { recursive: true })
  }
})

transactionTest('repository and default global attributes refuse before saved plans or generated writes', (t) => {
  for (const location of ['repository', 'global']) {
    const f = fixture(t)
    const originalXdg = process.env.XDG_CONFIG_HOME
    const xdg = path.join(path.dirname(f.root), 'xdg')
    process.env.XDG_CONFIG_HOME = xdg
    try {
      const prepared = prepareUpgrade(f)
      const file = location === 'repository'
        ? path.resolve(f.root, git(f.root, ['rev-parse', '--git-path', 'info/attributes']))
        : path.join(xdg, 'git/attributes')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '* working-tree-encoding=UTF-16\n')
      const plans = fs.readdirSync(path.dirname(prepared.savedPlan))
      assert.throws(() => prepareUpgrade(f), /attribute transformations unsupported/)
      assert.throws(() => apply(f.project, prepared), /attribute transformations unsupported/)
      assert.deepEqual(fs.readdirSync(path.dirname(prepared.savedPlan)), plans)
      assert.equal(fs.existsSync(path.join(f.root, 'atelier.lock.json')), false)
      assert.equal(fs.existsSync(path.join(f.root, '.atelier-local/upgrades/operations')), false)
      assert.equal(git(f.root, ['diff', '--cached', '--name-only']), '')
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = originalXdg
    }
  }
})

transactionTest('exact plan prepares a customized candidate through existing hooks, retaining source branch', (t) => {
  const f = fixture(t, 'exit 0')
  const sourceHead = git(f.source, ['rev-parse', 'HEAD'])
  const p = prepareUpgrade(f)
  assert.equal(git(f.root, ['status', '--porcelain']), '')
  assert.equal(p.plan.writes.length, 5)
  const result = apply(f.project, p)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(git(f.source, ['rev-parse', 'HEAD']), sourceHead)
  assert.match(fs.readFileSync(path.join(f.root, 'atelier-output/index.html'), 'utf8'), /#abcdef/)
  const status = upgradeOperationStatus({ ...f, operationId: result.operationId })
  assert.equal(status.status, 'completed')
  assert.equal(status.activated, false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'atelier.lock.json'))).lastSuccessfulUpgrade, null)
  assert.equal(git(f.root, ['ls-files', '.atelier-local']), '')
  assert.throws(() => apply(f.project, p), /repository changed|requires a clean/)
})

transactionTest('wrong confirmation, stale source, expired plans, hook changes and revoked policy refuse before writes', (t) => {
  for (const type of ['confirmation', 'source', 'expiry', 'hook', 'policy']) {
    const f = fixture(t)
    const p = prepareUpgrade({ ...f, ...(type === 'expiry' ? { now: new Date(Date.now() - 86400001) } : {}) })
    if (type === 'source') fs.appendFileSync(path.join(f.root, 'seed.md'), '\nUser edit\n')
    if (type === 'hook') fs.writeFileSync(path.join(f.source, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n')
    if (type === 'policy') { const file = path.join(f.root, 'atelier.adoption-policy.json'); const d = JSON.parse(fs.readFileSync(file)); d.enabled = false; fs.writeFileSync(file, JSON.stringify(d)) }
    assert.throws(() => applySavedUpgrade({ project: f.project, planFile: p.savedPlan, confirm: type === 'confirmation' ? 'sha256:wrong' : p.plan.digest }))
    assert.equal(fs.existsSync(path.join(f.root, 'atelier.lock.json')), false)
  }
})

transactionTest('rejecting hook retains staged candidate, history and recoverable backups', (t) => {
  const f = fixture(t)
  const lock = writeAtelierLock({ project: f.project, templateId: 'example-template' })
  lock.lastSuccessfulUpgrade = '2025-01-01T00:00:00.000Z'
  lock.appliedMigrations = [{ id: 'example-prior', hash: 'a'.repeat(64), appliedAt: lock.lastSuccessfulUpgrade }]
  put(f.root, 'atelier.lock.json', lock)
  git(f.root, ['add', 'atelier.lock.json']); git(f.root, ['commit', '-m', 'Retain prior lineage'])
  const hook = path.join(f.source, '.git/hooks/pre-commit')
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n'); fs.chmodSync(hook, 0o755)
  const p = prepareUpgrade(f)
  const result = apply(f.project, p)
  assert.equal(result.status, 'commit-refused', JSON.stringify(result))
  const after = JSON.parse(fs.readFileSync(path.join(f.root, 'atelier.lock.json')))
  assert.deepEqual(after.appliedMigrations, lock.appliedMigrations)
  assert.deepEqual(after.template, lock.template)
  assert.equal(after.lastSuccessfulUpgrade, lock.lastSuccessfulUpgrade)
  const recover = recoverUpgradeDryRun({ ...f, operationId: result.operationId })
  assert.equal(recover.mutation, false)
  assert.ok(recover.entries.every((e) => e.state === 'restorable-after-new-confirmation'))
  fs.appendFileSync(path.join(f.root, 'atelier-output/index.html'), 'user edit')
  assert.equal(recoverUpgradeDryRun({ ...f, operationId: result.operationId }).entries.find((e) => e.path.endsWith('index.html')).state, 'conflict')
})

transactionTest('index-modifying hook and HEAD-changing hook never yield completed receipts', (t) => {
  for (const hook of ['printf "Changed by hook\\n" >> seed.md\ngit add seed.md', 'git update-ref HEAD "$(git commit-tree HEAD^{tree} -p HEAD -m intermediate)"\nexit 1']) {
    const f = fixture(t, hook)
    const p = prepareUpgrade(f)
    const r = apply(f.project, p)
    assert.equal(r.status, 'recovery-required', JSON.stringify(r))
    assert.equal(upgradeOperationStatus({ ...f, operationId: r.operationId }).ok, false)
  }
})

transactionTest('symlink outputs, private-state tracking, duplicate or modified plan contents refuse', (t) => {
  const f = fixture(t)
  const p = prepareUpgrade(f)
  const changed = JSON.parse(fs.readFileSync(p.savedPlan)); changed.message = 'unreviewed'
  fs.writeFileSync(p.savedPlan, JSON.stringify(changed))
  assert.throws(() => apply(f.project, p), /digest mismatch/)
  fs.writeFileSync(p.savedPlan, JSON.stringify(p.plan))
  fs.symlinkSync(os.tmpdir(), path.join(f.root, 'atelier-output'))
  assert.throws(() => apply(f.project, p), /redirected|clean/)
  fs.unlinkSync(path.join(f.root, 'atelier-output'))
  git(f.root, ['add', '-f', p.savedPlan])
  assert.throws(() => apply(f.project, p), /ignored and untracked/)
})

transactionTest('journal corruption cannot become a successful status', (t) => {
  const f = fixture(t)
  const p = prepareUpgrade(f)
  const r = apply(f.project, p)
  assert.equal(r.ok, true, JSON.stringify(r))
  const dir = path.join(f.root, '.atelier-local/upgrades/operations', r.operationId, 'events')
  fs.unlinkSync(path.join(dir, fs.readdirSync(dir).sort()[1]))
  assert.throws(() => upgradeOperationStatus({ ...f, operationId: r.operationId }), /broken upgrade journal/)
})

test('legacy lock refresh retains lineage and refuses malformed history', (t) => {
  const f = fixture(t)
  const old = writeAtelierLock({ project: f.project, templateId: 'example-lineage' })
  old.appliedMigrations = [{ id: 'example-prior', hash: 'b'.repeat(64), appliedAt: '2025-01-01T00:00:00Z' }]
  old.lastSuccessfulUpgrade = '2025-01-01T00:00:00Z'
  put(f.root, 'atelier.lock.json', old)
  const refreshed = writeAtelierLock({ project: f.project })
  for (const key of ['template', 'appliedMigrations', 'lastSuccessfulUpgrade']) assert.deepEqual(refreshed[key], old[key])
  old.appliedMigrations = 'invalid'
  put(f.root, 'atelier.lock.json', old)
  assert.throws(() => writeAtelierLock({ project: f.project }), /invalid lock history/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'atelier.lock.json'))), old)
})

transactionTest('v2 contracts refuse unknown authority and v1 inputs', (t) => {
  const f = fixture(t)
  const p = prepareUpgrade(f).plan
  assert.throws(() => validateUpgradeDocument('plan', { ...p, install: true }), /additional propert/)
  assert.throws(() => validateUpgradeDocument('plan', { ...p, schema: 'mnstry.atelier-upgrade-plan@v1' }))
  assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }))
})

for (const [kind, directory] of [['policy', 'adoption-policy'], ['migration', 'migration'], ['plan', 'upgrade-plan'], ['event', 'upgrade-receipt']]) {
  test(`${kind} contract corpus accepts valid and refuses unknown authority`, () => {
    const read = (type) => JSON.parse(fs.readFileSync(new URL(`../fixtures/atelier-upgrade-transaction/${directory}/${type}/example.json`, import.meta.url)))
    assert.doesNotThrow(() => validateUpgradeDocument(kind, read('valid')))
    assert.throws(() => validateUpgradeDocument(kind, read('invalid')), /additional propert/)
  })
}

transactionTest('interruption after commit leaves a nonterminal journal and a held lease', (t) => {
  const f = fixture(t)
  const p = prepareUpgrade(f)
  const before = git(f.root, ['rev-parse', 'HEAD'])
  // Fault injection is confined to this disposable subprocess. Production
  // exposes no environment switch or test hook that can skip a receipt.
  const script = `
    import fs from 'node:fs';
    import { resolveProjectConfig } from ${JSON.stringify(new URL('../src/project/config.mjs', import.meta.url).href)};
    import { applySavedUpgrade } from ${JSON.stringify(new URL('../src/upgrade/transaction.mjs', import.meta.url).href)};
    const project = resolveProjectConfig({cwd: ${JSON.stringify(f.root)}, argv: ['--project', ${JSON.stringify(path.join(f.root, 'atelier.project.json'))}], env: {}, writeLocalState:false});
    const write = fs.writeFileSync;
    fs.writeFileSync = function(fd, bytes, ...args) {
      if (typeof bytes === 'string' && bytes.includes('"phase": "completed"')) process.exit(73);
      return write.call(fs, fd, bytes, ...args);
    };
    applySavedUpgrade({project, planFile:${JSON.stringify(p.savedPlan)}, confirm:${JSON.stringify(p.plan.digest)}});
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60000 })
  assert.equal(child.status, 73, child.stderr)
  assert.notEqual(git(f.root, ['rev-parse', 'HEAD']), before)
  const id = p.plan.digest.slice(7)
  // An exclusive receipt file interrupted during publication is corrupt,
  // never silently skipped. Inspection must explicitly report that refusal.
  assert.throws(() => upgradeOperationStatus({ ...f, operationId: id }), /JSON|journal|Unexpected/)
  assert.throws(() => apply(f.project, p), /EEXIST/)
})

transactionTest('another writer and backward-clock plan both refuse', (t) => {
  const f = fixture(t)
  const p = prepareUpgrade({ ...f, now: new Date(Date.now() + 60000) })
  assert.throws(() => apply(f.project, p), /clock moved backward/)
  fs.mkdirSync(path.join(f.root, '.atelier-local/upgrades/writer'))
  assert.throws(() => prepareUpgrade(f), /EEXIST/)
})

transactionTest('changed auxiliary Git inputs and attempted boundary adoption refuse', (t) => {
  for (const kind of ['ignore', 'boundary']) {
    const f = fixture(t)
    if (kind === 'boundary') {
      writeAtelierLock({ project: f.project })
      git(f.root, ['add', 'atelier.lock.json']); git(f.root, ['commit', '-m', 'Record policy'])
      const policyPath = path.join(f.root, 'boundary-policy.v1.json')
      const policy = JSON.parse(fs.readFileSync(policyPath)); policy.mode = 'legacy-warning'
      fs.writeFileSync(policyPath, JSON.stringify(policy))
      git(f.root, ['add', 'boundary-policy.v1.json']); git(f.root, ['commit', '-m', 'Change policy'])
      assert.throws(() => prepareUpgrade(f), /boundary policy adoption/)
    } else {
      const p = prepareUpgrade(f)
      fs.appendFileSync(path.join(f.source, '.git/info/exclude'), '\nseed.md\n')
      assert.throws(() => apply(f.project, p), /Git or hook identity changed/)
    }
  }
})

transactionTest('ignored but tracked authored input remains present in prepared graph', (t) => {
  const f = fixture(t)
  fs.appendFileSync(path.join(f.root, '.gitignore'), 'seed.md\n')
  git(f.root, ['add', '.gitignore']); git(f.root, ['commit', '-m', 'Keep tracked source with ignore rule'])
  const p = prepareUpgrade(f)
  const graph = JSON.parse(Buffer.from(p.plan.writes.find((w) => w.path.endsWith('knowledge.graph.json')).content, 'base64'))
  assert.ok(graph.nodes.some((node) => node.id === 'workspace:seed'))
})

transactionTest('CLI requires explicit saved-plan arguments and supports exact plan/application', (t) => {
  const f = fixture(t)
  const cli = new URL('../bin/atelier.mjs', import.meta.url).pathname
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'upgrade', ...args, '--project', path.join(f.root, 'atelier.project.json')], { encoding: 'utf8', timeout: 60000 })
  assert.notEqual(invoke('plan').status, 0)
  const planned = invoke('plan', '--save')
  assert.equal(planned.status, 0, planned.stderr)
  const p = JSON.parse(planned.stdout)
  const applied = invoke('apply', '--plan', p.savedPlan, '--confirm', p.plan.digest)
  assert.equal(applied.status, 0, applied.stderr + applied.stdout)
  const operation = JSON.parse(applied.stdout).operationId
  assert.equal(JSON.parse(invoke('status', '--operation', operation).stdout).status, 'completed')
  const recovery = invoke('recover', '--operation', operation, '--dry-run')
  assert.equal(recovery.status, 0, recovery.stderr)
  assert.equal(JSON.parse(recovery.stdout).mutation, false)
})

test('unsupported transaction hosts refuse before inspecting or mutating a workspace', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
    assert.throws(() => prepareUpgrade({ project: null }), /host is unsupported/)
    assert.throws(() => applySavedUpgrade({ project: null }), /host is unsupported/)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
})
