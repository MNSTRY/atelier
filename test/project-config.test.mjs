import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  PROJECT_CONFIG_ENV,
  LOCAL_OVERLAY_SCHEMA,
  PROJECT_CONFIG_SCHEMA,
  projectConfigArg,
  resolveProjectConfig,
  stripProjectConfigArgs,
  validateProjectConfigDoc,
} from '../src/project/config.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-project-config-'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

test('CLI project config wins over env config and resolves relative project paths', () => {
  const root = makeTempRoot()
  const configDir = path.join(root, 'configs')
  const cliConfig = path.join(configDir, 'cli-project.json')
  const envConfig = path.join(configDir, 'env-project.json')

  writeJson(envConfig, {
    schema: PROJECT_CONFIG_SCHEMA,
    roots: {
      workspace: '../env-workspace',
      repoOps: '../env-ops',
    },
  })
  writeJson(cliConfig, {
    schema: PROJECT_CONFIG_SCHEMA,
    roots: {
      workspace: '../workspace',
      repoOps: './repo-ops',
    },
    graph: {
      repoAccessPath: 'governance/access.json',
      workspaceGraphPath: 'generated/workspace.graph.json',
    },
    alignment: {
      appRepo: 'client-zero',
      root: 'ATELIER/alignment',
    },
  })

  const cfg = resolveProjectConfig({
    argv: ['node', 'script.mjs', `--project-config=${path.relative(root, cliConfig)}`],
    env: { [PROJECT_CONFIG_ENV]: envConfig },
    cwd: root,
  })

  assert.equal(cfg.source, 'cli')
  assert.equal(cfg.configPath, cliConfig)
  assert.equal(cfg.repoOpsRoot, path.join(configDir, 'repo-ops'))
  assert.equal(cfg.workspaceRoot, path.join(root, 'workspace'))
  assert.equal(cfg.repoAccessPath, path.join(configDir, 'repo-ops', 'governance', 'access.json'))
  assert.equal(cfg.workspaceGraphPath, path.join(configDir, 'repo-ops', 'generated', 'workspace.graph.json'))
  assert.equal(cfg.appRepoName, 'client-zero')
  assert.equal(cfg.appRoot, path.join(root, 'workspace', 'client-zero'))
  assert.equal(cfg.alignmentRoot, path.join(root, 'workspace', 'client-zero', 'ATELIER', 'alignment'))
})

test('generic defaults do not require adapter-specific values', () => {
  const root = makeTempRoot()
  const cfg = resolveProjectConfig({
    argv: ['node', 'script.mjs'],
    env: {},
    cwd: root,
    defaults: {
      repoOpsRoot: 'ops-kit',
      workspaceRoot: 'workspace',
      repoAccessPath: 'governance/access.json',
      workspaceGraphPath: 'graphs/workspace.graph.json',
      appRepoName: 'sample-app',
      alignmentRoot: 'alignment',
    },
  })

  assert.equal(cfg.source, 'default')
  assert.equal(cfg.repoOpsRoot, path.join(root, 'ops-kit'))
  assert.equal(cfg.workspaceRoot, path.join(root, 'workspace'))
  assert.equal(cfg.repoAccessPath, path.join(root, 'ops-kit', 'governance', 'access.json'))
  assert.equal(cfg.workspaceGraphPath, path.join(root, 'ops-kit', 'graphs', 'workspace.graph.json'))
  assert.equal(cfg.appRepoName, 'sample-app')
  assert.equal(cfg.appRoot, path.join(root, 'workspace', 'sample-app'))
  assert.equal(cfg.alignmentRoot, path.join(root, 'workspace', 'sample-app', 'alignment'))
})

test('checked-in project template validates as a neutral adapter scaffold', () => {
  const templatePath = path.join(ROOT, 'templates', 'atelier.project.example.json')
  const doc = JSON.parse(fs.readFileSync(templatePath, 'utf8'))
  assert.deepEqual(validateProjectConfigDoc(doc, { neutralTemplate: true }), [])
  const adapterSpecificNamePattern = new RegExp(['h', 'e', 'a', 'r', 't', 'h'].join(''), 'i')
  assert.doesNotMatch(JSON.stringify(doc), adapterSpecificNamePattern)
})

test('neutral template validation rejects adapter-name leakage and unknown keys', () => {
  const templatePath = path.join(ROOT, 'templates', 'atelier.project.example.json')
  const valid = JSON.parse(fs.readFileSync(templatePath, 'utf8'))
  const adapterSpecificName = ['h', 'e', 'a', 'r', 't', 'h'].join('')
  const errors = validateProjectConfigDoc({
    ...valid,
    roots: {
      ...valid.roots,
      workspace: `../${adapterSpecificName}`,
      adapterOnly: true,
    },
  }, { neutralTemplate: true })

  assert.match(errors.join('\n'), /additional property adapterOnly/)
  assert.match(errors.join('\n'), /adapter-specific names/)
})

test('explicit missing project config fails fast unless fallback roots are supplied', () => {
  const root = makeTempRoot()
  assert.throws(
    () => resolveProjectConfig({ argv: ['node', 'script.mjs', '--project-config=missing.json'], env: {}, cwd: root }),
    /atelier project config not found/,
  )

  const cfg = resolveProjectConfig({
    argv: ['node', 'script.mjs', '--project-config=missing.json'],
    env: {},
    cwd: root,
    defaults: {
      repoOpsRoot: 'ops',
      workspaceRoot: 'workspace',
    },
  })
  assert.equal(cfg.source, 'cli')
  assert.equal(cfg.configPath, null)
  assert.equal(cfg.missingConfigPath, path.join(root, 'missing.json'))
})

test('project config arg helpers are narrow and leave other flags alone', () => {
  const args = ['node', 'script.mjs', '--check', '--project-config=project.json', '--target=team']
  assert.equal(projectConfigArg(args), 'project.json')
  assert.deepEqual(stripProjectConfigArgs(args.slice(2)), ['--check', '--target=team'])
})

test('ignored local overlay supplies machine-local repo paths without tracked config paths', () => {
  const root = makeTempRoot()
  const repo = path.join(root, 'workspace', 'content')
  fs.mkdirSync(repo, { recursive: true })
  const configPath = path.join(root, 'atelier.project.json')
  writeJson(configPath, {
    schema: PROJECT_CONFIG_SCHEMA,
    name: 'overlay-fixture',
    roots: { workspace: 'workspace', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output' },
    repos: [{ name: 'content', readBoundary: 'private', role: 'source' }],
  })
  writeJson(path.join(root, '.atelier-local', 'workspace.json'), {
    schema: LOCAL_OVERLAY_SCHEMA,
    repos: {
      content: { path: 'workspace/content' },
    },
  })

  const cfg = resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: root })
  assert.equal(cfg.repos[0].path, repo)
  assert.equal(cfg.repos[0].pathSource, 'local-overlay')
  assert.deepEqual(cfg.localOverlay.paths, [path.join(root, '.atelier-local', 'workspace.json')])
})

test('sibling discovery resolves logical repos when local overlay is absent', () => {
  const root = makeTempRoot()
  const repo = path.join(root, 'content')
  fs.mkdirSync(repo, { recursive: true })
  const configPath = path.join(root, 'atelier.project.json')
  writeJson(configPath, {
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output' },
    repos: [{ name: 'content', readBoundary: 'private', role: 'source' }],
  })

  const cfg = resolveProjectConfig({ argv: [`--project=${configPath}`], cwd: root })
  assert.equal(cfg.repos[0].path, repo)
  assert.equal(cfg.repos[0].pathSource, 'sibling-discovery')
})

test('project config validation rejects tracked absolute repo paths', () => {
  const errors = validateProjectConfigDoc({
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.' },
    graph: { outputPath: 'atelier-output/knowledge.graph.json' },
    repos: [{ name: 'content', path: '/Users/someone/content' }],
  })
  assert.match(errors.join('\n'), /machine-local absolute paths/)
})
