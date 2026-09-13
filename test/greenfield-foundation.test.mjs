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
      assert.deepEqual(preview.runtimeArgs, ['./node_modules/@mnstry/atelier/bin/atelier.mjs', 'server'])
      const missing = spawnSync(process.execPath, preview.runtimeArgs, { cwd: dir, encoding: 'utf8' })
      assert.equal(missing.status, 1)
      assert.match(missing.stderr, /MODULE_NOT_FOUND/)
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
