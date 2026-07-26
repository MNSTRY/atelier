import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BOUNDARY_POLICY_SCHEMA, checkBoundaryPolicy, installBoundaryHooks, validateBoundaryPolicy } from '../src/boundary/policy.mjs'
import { buildGraph } from '../src/graph/graph.mjs'
import { buildKnowledgeGraph, validateRepoAccessConfig } from '../src/graph/knowledge-graph.mjs'
import { PROJECT_CONFIG_SCHEMA, commandProject, remoteHost, validateProjectConfigDoc, writeJson } from '../src/project/config.mjs'

// An app-builder export that landed in the workspace during the 2026-07 Client zero
// incident. Not an org remote, not managed, and previously impossible to declare
// honestly: the only unblock was giving it a read boundary it does not have.
const FOREIGN_REMOTE = 'https://git.example.test/0000/project_deadbeef.git'

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function writeDoc(repo, rel, id, audience = 'private') {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---\ntitle: "${id}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "${audience}"\n---\n\n# ${id}\n`)
}

function makeWorkspace(t, { declareExternal = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-external-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const managed = path.join(root, 'mnstry-private-author')
  const foreign = path.join(root, 'external-vendor-site')
  for (const repo of [managed, foreign]) {
    fs.mkdirSync(repo, { recursive: true })
    git(repo, ['init', '--quiet'])
    git(repo, ['config', 'user.email', 'author@example.invalid'])
    git(repo, ['config', 'user.name', 'Author'])
  }
  git(foreign, ['remote', 'add', 'origin', FOREIGN_REMOTE])
  writeDoc(managed, 'README.md', 'mnstry-private-author:readme')
  // Content the workspace does not own and cannot answer for.
  fs.writeFileSync(path.join(foreign, 'index.html'), '<!doctype html><title>vendor</title>\n')
  fs.writeFileSync(path.join(foreign, 'about.html'), '<!doctype html><title>about</title>\n')

  const repos = [
    { name: 'mnstry-private-author', path: 'mnstry-private-author', readBoundary: 'private' },
    declareExternal ? { name: 'external-vendor-site', path: 'external-vendor-site', kind: 'external' } : { name: 'external-vendor-site', path: 'external-vendor-site', readBoundary: 'team' },
  ]
  writeJson(path.join(root, 'atelier.project.json'), {
    schema: PROJECT_CONFIG_SCHEMA,
    name: 'external-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    boundaries: { policyPath: 'boundary-policy.v1.json' },
    repos,
  })
  writeJson(path.join(root, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: declareExternal ? { 'mnstry-private-author': { readBoundary: 'private' } } : { 'mnstry-private-author': { readBoundary: 'private' }, 'external-vendor-site': { readBoundary: 'team' } },
  })
  return { root, managed, foreign, project: commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} }) }
}

function boundaryPolicy() {
  return {
    schema: BOUNDARY_POLICY_SCHEMA,
    mode: 'strict',
    actors: { author: { gitEmails: ['author@example.invalid'], privateDomainRepo: 'mnstry-private-author' } },
    repos: {
      'mnstry-private-author': {
        kind: 'private_domain',
        ownerActor: 'author',
        readBoundary: 'private',
        allowedAudiences: ['private', 'sensitive', 'team'],
        forbiddenAudiences: [],
        autoCommit: 'guarded',
      },
    },
  }
}

test('an external repo is excluded from the graph census and surfaced with its remote host', (t) => {
  const { project, foreign } = makeWorkspace(t)
  const graph = buildGraph(project)

  assert.deepEqual(graph.errors, [], 'external content must not demand sidecars or front matter')
  assert.deepEqual(
    graph.nodes.map((node) => node.repo),
    ['mnstry-private-author'],
    'external repo content entered the graph',
  )
  assert.deepEqual(graph.external, [{ name: 'external-vendor-site', path: foreign, remoteHost: 'git.example.test' }])
})

test('leaving a foreign git folder managed still fails, and names external as the resolution', (t) => {
  const { project } = makeWorkspace(t, { declareExternal: false })
  const graph = buildGraph(project)
  assert.ok(
    graph.errors.some((message) => /external-vendor-site\/index\.html: non-Markdown source requires sidecar/.test(message)),
    'a managed repo must still answer for its content',
  )

  const errors = validateRepoAccessConfig(
    { schema: 'mnstry.repo-access@v1', defaultReadBoundary: 'team', repos: {} },
    ['external-vendor-site'],
  )
  assert.match(errors.join('\n'), /must declare readBoundary, or be declared with kind "external"/)
})

test('knowledge graph build skips external repos entirely', (t) => {
  const { root, managed, foreign } = makeWorkspace(t)
  const result = buildKnowledgeGraph({
    workspaceRoot: root,
    repoRoots: [managed, foreign],
    externalRepos: ['external-vendor-site'],
    repoAccessConfig: {
      schema: 'mnstry.repo-access@v1',
      defaultReadBoundary: 'team',
      repos: { 'mnstry-private-author': { readBoundary: 'private' } },
    },
  })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(
    result.repoGraphs.map((entry) => entry.repoName),
    ['mnstry-private-author'],
  )
})

test('external repos need no boundary policy entry, and must not have one', (t) => {
  const { project } = makeWorkspace(t)
  const policy = boundaryPolicy()
  assert.deepEqual(validateBoundaryPolicy(policy, project), [])

  policy.repos['external-vendor-site'] = {
    kind: 'shared',
    readBoundary: 'team',
    allowedAudiences: ['team'],
    forbiddenAudiences: [],
    autoCommit: 'guarded',
  }
  assert.match(
    validateBoundaryPolicy(policy, project).join('\n'),
    /policy repos\.external-vendor-site must not be declared; it is an external \(unmanaged\) repo/,
  )
})

test('boundary hooks are never installed into an external repo', (t) => {
  const { project, foreign } = makeWorkspace(t)
  const result = installBoundaryHooks({ project })
  assert.deepEqual(
    [...new Set(result.installed.map((item) => item.repo))],
    ['mnstry-private-author'],
  )
  assert.equal(fs.existsSync(path.join(foreign, '.git/hooks/pre-commit')), false)
})

test('the staged guard does not read an external repo working tree', (t) => {
  const { project, foreign } = makeWorkspace(t)
  writeDoc(foreign, 'leak.md', 'vendor:leak', 'public')
  git(foreign, ['add', '.'])
  const report = checkBoundaryPolicy({ project, policy: boundaryPolicy(), actor: 'author', staged: true, stagedOnly: true })
  assert.equal(report.ok, true, report.errors.map((item) => item.message).join('\n'))
})

test('an external repo must not declare a read boundary', () => {
  const doc = {
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.', repoOps: '.' },
    repos: [{ name: 'vendor', path: 'vendor', kind: 'external', readBoundary: 'team' }],
  }
  assert.match(
    validateProjectConfigDoc(doc).join('\n'),
    /repos\[0\] is kind "external" and must not declare readBoundary/,
  )

  delete doc.repos[0].readBoundary
  assert.deepEqual(validateProjectConfigDoc(doc), [])
})

test('a workspace of only external repos is not an Atelier workspace', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-external-only-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  writeJson(path.join(root, 'atelier.project.json'), {
    schema: PROJECT_CONFIG_SCHEMA,
    roots: { workspace: '.', repoOps: '.' },
    repos: [{ name: 'vendor', path: 'vendor', kind: 'external' }],
  })
  assert.throws(
    () => commandProject({ argv: ['--project', path.join(root, 'atelier.project.json')], cwd: root, env: {} }),
    /must declare at least one managed repo/,
  )
})

test('remote host parsing covers https, ssh, and scp-style remotes', () => {
  assert.equal(remoteHost('https://github.com/mnstry/atelier.git'), 'github.com')
  assert.equal(remoteHost('git@github.com:mnstry/atelier.git'), 'github.com')
  assert.equal(remoteHost('ssh://git@git.example.test:2222/x/y.git'), 'git.example.test')
  assert.equal(remoteHost(FOREIGN_REMOTE), 'git.example.test')
  assert.equal(remoteHost(''), null)
})
