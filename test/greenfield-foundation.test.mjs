import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { commandProject } from '../src/project/config.mjs'
import { buildGraph } from '../src/graph/graph.mjs'
import { checkAtelierLock } from '../src/upgrade/upgrade.mjs'
import { validateBoundaryPolicy } from '../src/boundary/policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
function run(cwd, args) {
  return spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, MNSTRY_ATELIER_ACTOR: 'author' },
  })
}
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'atelier-greenfield-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function project(dir) {
  return commandProject({ cwd: dir, argv: ['--project', path.join(dir, 'atelier.project.json')] })
}

for (const template of ['private-domain', 'shared-project', 'distribution', 'sample-workspace', 'external-project']) {
  test(`initialized ${template} has a valid graph, policy and lock`, (t) => {
    const parent = workspace(t)
    const dir = path.join(parent, 'workspace')
    const initialized = run(parent, ['init', '--template', template, '--target', dir, '--actor', 'author'])
    assert.equal(initialized.status, 0, initialized.stderr)
    const cfg = project(dir)
    assert.deepEqual(buildGraph(cfg).errors, [])
    assert.deepEqual(validateBoundaryPolicy(JSON.parse(fs.readFileSync(cfg.boundaryPolicyPath, 'utf8')), cfg), [])
    assert.equal(checkAtelierLock(cfg).ok, true)
  })
}

for (const profile of ['single-repo', 'private-domain', 'shared-project', 'multi-repo', 'monorepo', 'control-workspace']) {
  test(`adopt ${profile} writes a valid policy and preserves an existing lock`, (t) => {
    const dir = workspace(t)
    const args = ['adopt', '--profile', profile, '--target', dir, '--actor', 'author',
      ...(profile === 'monorepo' ? ['--include', 'docs/**'] : [])]
    const adopted = run(dir, args)
    assert.equal(adopted.status, 0, adopted.stderr)
    const cfg = project(dir)
    assert.deepEqual(validateBoundaryPolicy(JSON.parse(fs.readFileSync(cfg.boundaryPolicyPath, 'utf8')), cfg), [])
    assert.equal(checkAtelierLock(cfg).ok, true)
    const lockPath = path.join(dir, 'atelier.lock.json')
    const retained = fs.readFileSync(lockPath, 'utf8')
    assert.equal(run(dir, args).status, 0)
    assert.equal(fs.readFileSync(lockPath, 'utf8'), retained)
  })
}

test('project check refuses a corrupted manifest without rewriting it', (t) => {
  const dir = workspace(t)
  assert.equal(run(dir, ['init', '--template', 'sample-workspace', '--target', dir]).status, 0)
  assert.equal(run(dir, ['graph']).status, 0)
  assert.equal(run(dir, ['project']).status, 0)
  assert.equal(run(dir, ['project', '--check']).status, 0)
  const manifestPath = path.join(project(dir).outputRoot, 'atelier.manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.nodes = []
  const corrupt = JSON.stringify(manifest)
  fs.writeFileSync(manifestPath, corrupt)
  assert.equal(run(dir, ['project', '--check']).status, 1)
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), corrupt)
})

test('template preview commands require the locally installed scoped kit', (t) => {
  const dir = workspace(t)
  for (const rel of ['launch.json', 'private-domain-workspace/.claude/launch.json',
    'shared-project-workspace/.claude/launch.json', 'distribution-workspace/.claude/launch.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'templates', rel), 'utf8'))
    for (const preview of config.configurations) {
      assert.equal(preview.runtimeExecutable, 'node')
      assert.deepEqual(preview.runtimeArgs.slice(0, 2), ['--input-type=module', '--eval'])
      assert.match(preview.runtimeArgs[2], /@mnstry\/atelier\/cli/)
      const missing = spawnSync(process.execPath, preview.runtimeArgs, { cwd: dir, encoding: 'utf8' })
      assert.equal(missing.status, 1)
      assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/)
    }
  }
})

test('shared adoption keeps its policy-only private domain distinct from the managed repo', (t) => {
  const dir = workspace(t)
  const adopted = run(dir, ['adopt', '--profile', 'shared-project', '--target', dir,
    '--actor', 'author', '--name', 'author-private'])
  assert.equal(adopted.status, 0, adopted.stderr)
  const cfg = project(dir)
  const policy = JSON.parse(fs.readFileSync(cfg.boundaryPolicyPath, 'utf8'))
  assert.deepEqual(validateBoundaryPolicy(policy, cfg), [])
  assert.notEqual(policy.actors.author.privateDomainRepo, cfg.repos[0].name)
})

test('adopt refuses invalid existing policy and malformed lock without scaffold writes', (t) => {
  for (const [file, contents] of [['boundary-policy.v1.json', '{'], ['boundary-policy.v1.json', JSON.stringify({ mode: 'off' })], ['atelier.lock.json', '{'], ['atelier.lock.json', 'null']]) {
    const dir = workspace(t)
    fs.writeFileSync(path.join(dir, file), contents)
    const result = run(dir, ['adopt', '--target', dir, '--actor', 'author'])
    assert.notEqual(result.status, 0)
    assert.deepEqual(fs.readdirSync(dir), [file])
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), contents)
  }
})

test('adopt refuses drift and missing alternate policy without accepting a new lock', (t) => {
  const dir = workspace(t)
  assert.equal(run(dir, ['adopt', '--target', dir, '--actor', 'author']).status, 0)
  const lockPath = path.join(dir, 'atelier.lock.json')
  const retained = fs.readFileSync(lockPath, 'utf8')
  const cfg = project(dir)
  const policy = JSON.parse(fs.readFileSync(cfg.boundaryPolicyPath, 'utf8'))
  policy.mode = 'legacy-warning'
  fs.writeFileSync(cfg.boundaryPolicyPath, JSON.stringify(policy))
  assert.notEqual(run(dir, ['adopt', '--target', dir]).status, 0)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), retained)
  fs.rmSync(lockPath)
  const configPath = path.join(dir, 'atelier.project.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.boundaries.policyPath = 'missing-policy.json'
  fs.writeFileSync(configPath, JSON.stringify(config))
  assert.notEqual(run(dir, ['adopt', '--target', dir]).status, 0)
  assert.equal(fs.existsSync(lockPath), false)
})

test('project manifest stays current through relocation and JSON key reordering', (t) => {
  const parent = workspace(t)
  const dir = path.join(parent, 'first')
  assert.equal(run(parent, ['init', '--template', 'sample-workspace', '--target', dir]).status, 0)
  assert.equal(run(dir, ['graph']).status, 0)
  assert.equal(run(dir, ['project']).status, 0)
  const manifestPath = path.join(project(dir).outputRoot, 'atelier.manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(path.isAbsolute(manifest.graphPath), false)
  fs.writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(Object.entries(manifest).reverse())))
  assert.equal(run(dir, ['project', '--check']).status, 0)
  const moved = path.join(parent, 'second')
  fs.renameSync(dir, moved)
  assert.equal(run(moved, ['project', '--check']).status, 0)
})

test('repeated init preserves authored material, policy and lock byte-for-byte', (t) => {
  const dir = workspace(t)
  const args = ['init', '--template', 'private-domain', '--target', dir, '--actor', 'author']
  assert.equal(run(dir, args).status, 0)
  const files = ['domain/README.md', 'boundary-policy.v1.json', 'atelier.lock.json']
  fs.appendFileSync(path.join(dir, files[0]), '\nAuthored paragraph retained.\n')
  const before = files.map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
  assert.notEqual(run(dir, args).status, 0)
  assert.deepEqual(files.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')), before)
})

test('fresh shared adoption passes CLI boundary check with only an unrelated platform actor', (t) => {
  const dir = workspace(t)
  assert.equal(run(dir, ['adopt', '--profile', 'shared-project', '--target', dir, '--actor', 'author']).status, 0)
  const env = { ...process.env, GITHUB_ACTOR: 'undeclared-contributor' }
  delete env.MNSTRY_ATELIER_ACTOR
  const checked = spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), 'boundary', 'check'], { cwd: dir, env, encoding: 'utf8' })
  assert.equal(checked.status, 0, checked.stderr)
})

test('init does not bind an ambient CI login as the owner platform identity', (t) => {
  const dir = workspace(t)
  const initialized = spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), 'init',
    '--template', 'private-domain', '--target', dir, '--actor', 'author'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTOR: 'unrelated-ci-trigger' },
  })
  assert.equal(initialized.status, 0, initialized.stderr)
  const policy = JSON.parse(fs.readFileSync(project(dir).boundaryPolicyPath, 'utf8'))
  assert.equal(policy.actors.author.githubLogin, 'AUTHOR_GITHUB_LOGIN_PLACEHOLDER')
})
