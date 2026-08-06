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
  commandProject,
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

test('project config validation accepts contractVersion and namespaced ext members', () => {
  const fixture = path.join(ROOT, 'fixtures', 'atelier-project-config', 'valid', 'ext-extension-packs.v1.json')
  const doc = JSON.parse(fs.readFileSync(fixture, 'utf8'))
  assert.equal(doc.contractVersion, '1.1.0')
  assert.equal(typeof doc.ext['mnstry.atelier'], 'object')
  assert.deepEqual(validateProjectConfigDoc(doc), [])
})

test('project config validation accepts ext on every subobject the schema allows it on', () => {
  const ext = { 'sample.vendor': { note: true } }
  const errors = validateProjectConfigDoc({
    schema: PROJECT_CONFIG_SCHEMA,
    ext,
    roots: { workspace: '.', ext },
    graph: { outputPath: 'atelier-output/knowledge.graph.json', ext },
    projection: { outputRoot: 'atelier-output', ext },
    alignment: { appRepo: 'sample-app', root: 'alignment', ext },
    runtime: { root: 'runtime', ext },
    boundaries: { policyPath: 'boundary-policy.v1.json', ext },
    setup: { profile: 'single-repo', ext },
    repos: [{ name: 'content', path: 'content', ext, identity: { provider: 'github', id: 'R_1', ext } }],
  })
  assert.deepEqual(errors, [])
})

test('project config validation rejects an invalid contractVersion', () => {
  const base = {
    schema: PROJECT_CONFIG_SCHEMA,
    repos: [{ name: 'content', path: 'content' }],
  }
  assert.match(validateProjectConfigDoc({ ...base, contractVersion: '2.0.0' }).join('\n'), /contractVersion/)
  assert.match(validateProjectConfigDoc({ ...base, contractVersion: 1 }).join('\n'), /contractVersion/)
  assert.deepEqual(validateProjectConfigDoc({ ...base, contractVersion: '1.4.2' }), [])
})

// The JSON schema deliberately leaves ext contents unvalidated at v1, so a
// non-object ext member cannot live in the contract corpus invalid/ directory
// (the schema accepts it and the registry agreement test requires both sides
// to reject). The hand-rolled validator is stricter here by design: ext
// members are namespaced containers, so this fixture is validator-only.
test('project config validation rejects a non-object ext member', () => {
  const fixture = path.join(ROOT, 'fixtures', 'atelier-project-config', 'validator-only', 'ext-member-not-object.v1.json')
  const doc = JSON.parse(fs.readFileSync(fixture, 'utf8'))
  assert.match(validateProjectConfigDoc(doc).join('\n'), /ext\.mnstry\.atelier must be an object/)
  const nested = validateProjectConfigDoc({
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.', ext: { 'sample.vendor': ['not-an-object'] } },
    repos: [{ name: 'content', path: 'content' }],
  })
  assert.match(nested.join('\n'), /roots\.ext\.sample\.vendor must be an object/)
})

test('commandProject fails closed on an invalid loaded config file', () => {
  const root = makeTempRoot()
  const configPath = path.join(root, 'atelier.project.json')
  writeJson(configPath, {
    schema: PROJECT_CONFIG_SCHEMA,
    name: 'fail-closed-fixture',
    telemetry: { endpoint: 'https://example.test/collect' },
    repos: [{ name: 'content', path: 'content', readBoundary: 'private' }],
  })
  assert.throws(
    () => commandProject({ argv: ['--project', configPath], env: {}, cwd: root }),
    (error) => /invalid atelier project config/.test(error.message) && /additional property telemetry/.test(error.message),
  )

  writeJson(configPath, {
    schema: PROJECT_CONFIG_SCHEMA,
    name: 'fail-closed-fixture',
    repos: [{ name: 'content', path: 'content', readBoundary: 'private' }],
  })
  const project = commandProject({ argv: ['--project', configPath], env: {}, cwd: root })
  assert.equal(project.configPath, configPath)
})

// The fail-closed guard in commandProject keys on configPath: the defaults
// path resolves with no file loaded and an empty config document, which must
// not be pushed through document validation.
test('defaults path resolves with a null configPath and empty config document', () => {
  const root = makeTempRoot()
  const project = resolveProjectConfig({
    argv: ['node', 'script.mjs'],
    env: {},
    cwd: root,
    defaults: { repoOpsRoot: 'ops', workspaceRoot: 'workspace' },
  })
  assert.equal(project.configPath, null)
  assert.deepEqual(project.config, {})
})

test('project config validation rejects tracked absolute repo paths', () => {
  const errors = validateProjectConfigDoc({
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.' },
    graph: { outputPath: 'atelier-output/knowledge.graph.json' },
    repos: [{ name: 'content', path: '/home/someone/content' }],
  })
  assert.match(errors.join('\n'), /machine-local absolute paths/)
})
