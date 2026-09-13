import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseProjectOptions } from '../src/cli/project-options.mjs'
import { parseRepoPathOverrides, resolveProjectConfig } from '../src/project/config.mjs'
import { makeSampleProject } from './helpers/sample-project.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('project aliases preserve first selection, named overrides preserve last selection', () => {
  const argv = ['--project', 'first.json', '--project-config=second.json', '--repo-path', 'content=old', '--repo-path=content=folder=two', '--repo-path', 'media=other', '--check']
  const parsed = parseProjectOptions(argv)
  assert.equal(parsed.project, 'first.json')
  assert.deepEqual([...parsed.repoPaths], [['content', 'folder=two'], ['media', 'other']])
  assert.deepEqual(parsed.remaining, ['--check'])
  assert.equal(parseRepoPathOverrides(argv, root).get('content'), path.join(root, 'folder=two'))
  assert.equal(parseProjectOptions(['--adapter-config=custom.json'], '--adapter-config=').project, 'custom.json')
})

test('malformed shared options refuse before project state is created', (t) => {
  const sample = makeSampleProject(t)
  const cases = [
    ['--project'], ['--project='], ['--project', '--check'],
    ['--project-config'], ['--project-config=  '],
    ['--repo-path'], ['--repo-path='], ['--repo-path', '--check'],
    ['--repo-path=content'], ['--repo-path==folder'], ['--repo-path=content= '],
  ]
  for (const argv of cases) {
    assert.throws(() => resolveProjectConfig({ argv, cwd: sample.dir, env: {} }), { code: 'project-option-invalid' })
  }
  assert.equal(fs.existsSync(path.join(sample.dir, '.atelier-local')), false)
})

test('overrides relocate declared repositories without changing their read boundaries', (t) => {
  const sample = makeSampleProject(t)
  const moved = path.join(sample.dir, 'relocated content')
  fs.renameSync(path.join(sample.dir, 'content'), moved)
  const project = resolveProjectConfig({ argv: ['--project', sample.config, '--repo-path', 'content=relocated content', '--repo-path=undeclared=.'], cwd: sample.dir, env: {} })
  assert.deepEqual(project.repos.map(({ name, path: repoPath, readBoundary, pathSource }) => ({ name, repoPath, readBoundary, pathSource })), [
    { name: 'content', repoPath: moved, readBoundary: 'private', pathSource: 'cli' },
  ])
})

test('moved repository works through CLI, legacy alias, distribution wrapper and direct pack module', (t) => {
  const sample = makeSampleProject(t)
  fs.renameSync(path.join(sample.dir, 'content'), path.join(sample.dir, 'moved content'))
  const wrapper = path.join(sample.dir, 'wrapper.mjs')
  fs.writeFileSync(wrapper, `import { runCli } from ${JSON.stringify(new URL('../src/cli/run.mjs', import.meta.url).href)}; process.exitCode = await runCli({ argv: process.argv.slice(2), brand: { command: 'sample-kit', displayName: 'Sample Kit' } });`)
  const entries = [
    [path.join(root, 'bin/atelier.mjs'), 'extension-pack', 'list'],
    [path.join(root, 'bin/mnstry-atelier.mjs'), 'extension-pack:validate'],
    [wrapper, 'extension-pack', 'validate'],
    [path.join(root, 'src/commands/extension-pack.mjs'), 'list'],
  ]
  for (const entry of entries) {
    for (const flags of [
      ['--project', sample.config, '--repo-path', 'content=moved content'],
      [`--project-config=${sample.config}`, '--repo-path=content=moved content'],
    ]) {
      const result = spawnSync(process.execPath, [...entry, ...flags, '--json'], { cwd: sample.dir, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).ok, true)
    }
  }
  for (const option of ['--nope', '--constructor', '--repo-path=content', '--project=']) {
    const result = spawnSync(process.execPath, [entries[3][0], 'list', '--project', sample.config, option], { cwd: sample.dir, encoding: 'utf8' })
    assert.equal(result.status, 2, result.stderr)
  }
})

test('project command families use the relocated source and explain omits machine paths', (t) => {
  const sample = makeSampleProject(t)
  fs.renameSync(path.join(sample.dir, 'content'), path.join(sample.dir, 'moved'))
  const flags = ['--project', sample.config, '--repo-path', 'content=moved']
  const cli = (args) => spawnSync(process.execPath, [path.join(root, 'bin/atelier.mjs'), ...args, ...flags], { cwd: sample.dir, encoding: 'utf8' })
  for (const args of [['graph'], ['project'], ['readiness'], ['context', 'flow'], ['support', 'bundle', '--dry-run'], ['config', 'check']]) {
    const result = cli(args)
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`)
  }
  const graph = JSON.parse(fs.readFileSync(path.join(sample.dir, 'atelier-output/knowledge.graph.json'), 'utf8'))
  assert.equal(graph.counts.nodes, 2)
  const explained = cli(['config', 'check', '--explain'])
  assert.equal(explained.status, 0, explained.stderr)
  assert.equal(explained.stdout.includes(sample.dir), false)
  assert.deepEqual(JSON.parse(explained.stdout).repos, [{ name: 'content', pathSource: 'cli', resolved: true, readBoundary: 'private', external: false }])
  fs.rmSync(path.join(sample.dir, 'moved'), { recursive: true })
  assert.notEqual(cli(['graph']).status, 0, 'a missing required source must still fail')
})
