import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BOUNDARY_POLICY_SCHEMA, checkBoundaryPolicy } from '../src/boundary/policy.mjs'
import { buildGraph } from '../src/graph/graph.mjs'
import { REPO_ACCESS_SCHEMA, SOURCE_SIDECAR_SCHEMA, buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { commandProject, resolveProjectConfig } from '../src/project/config.mjs'
import { projectGraph } from '../src/projection/policy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = path.join(root, 'fixtures/projects/source-formats-workspace')

const FORMAT_NODE_IDS = [
  'source-formats:data-json',
  'source-formats:logo-png',
  'source-formats:metrics-csv',
  'source-formats:pipeline-yaml',
]

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true })
  for (const ent of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, ent.name)
    const to = path.join(target, ent.name)
    if (ent.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

function makeFormatsProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnstry-atelier-formats-'))
  copyDir(fixture, dir)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    config: path.join(dir, 'atelier.project.json'),
  }
}

function fixtureProject(sample) {
  return resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })
}

test('a .kg.json sidecar attaches any sibling file to the graph regardless of extension', (t) => {
  const sample = makeFormatsProject(t)
  const graph = buildGraph(fixtureProject(sample))
  assert.deepEqual(graph.errors, [])
  assert.equal(graph.counts.nodes, 5)

  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  assert.deepEqual([...byId.keys()].sort(), ['source-formats:readme', ...FORMAT_NODE_IDS].sort())
  assert.equal(byId.get('source-formats:data-json').audience, 'team')
  assert.equal(byId.get('source-formats:pipeline-yaml').audience, 'public')
  assert.equal(byId.get('source-formats:metrics-csv').audience, 'operator')
  assert.equal(byId.get('source-formats:logo-png').audience, 'sensitive')

  // All identity comes from the sidecar, never from the asset bytes.
  const png = byId.get('source-formats:logo-png')
  assert.equal(png.title, 'Sample binary asset')
  assert.equal(png.type, 'artifact')
  assert.equal(png.path, 'logo.png')

  // Markdown front-matter behavior is unchanged and edges still resolve.
  assert.ok(graph.edges.some((edge) => edge.source === 'source-formats:readme' && edge.target === 'source-formats:data-json' && edge.type === 'supports'))
})

test('the graph never parses foreign formats: corrupting asset bytes changes nothing', (t) => {
  const sample = makeFormatsProject(t)
  const project = fixtureProject(sample)
  const before = buildGraph(project)
  assert.deepEqual(before.errors, [])

  // Invalid JSON, invalid YAML, and binary garbage in the CSV. If any walker
  // read these bytes, the build would error or the nodes would change.
  fs.writeFileSync(path.join(sample.dir, 'content/data.json'), '{not json at all')
  fs.writeFileSync(path.join(sample.dir, 'content/pipeline.yaml'), '\t- : ::: {')
  fs.writeFileSync(path.join(sample.dir, 'content/metrics.csv'), Buffer.from([0x00, 0xff, 0x00, 0xff]))

  const after = buildGraph(project)
  assert.deepEqual(after.errors, [])
  assert.deepEqual(after.nodes, before.nodes)
})

test('projection policy filters expanded source formats by declared audience', (t) => {
  const sample = makeFormatsProject(t)
  const graph = buildGraph(fixtureProject(sample))
  assert.deepEqual(graph.errors, [])

  const ids = (projection) => projection.nodes.map((node) => node.id).sort()
  assert.deepEqual(ids(projectGraph(graph, { target: 'public' })), ['source-formats:pipeline-yaml'])
  assert.deepEqual(ids(projectGraph(graph, { target: 'team' })), ['source-formats:data-json', 'source-formats:pipeline-yaml', 'source-formats:readme'])
  assert.deepEqual(ids(projectGraph(graph, { target: 'operator' })), ['source-formats:data-json', 'source-formats:metrics-csv', 'source-formats:pipeline-yaml', 'source-formats:readme'])
  assert.deepEqual(ids(projectGraph(graph, { target: 'local' })), ['source-formats:readme', ...FORMAT_NODE_IDS].sort())

  const publicBlocked = projectGraph(graph, { target: 'public' }).blocked.map((entry) => entry.id)
  assert.ok(publicBlocked.includes('source-formats:logo-png'))
  assert.ok(publicBlocked.includes('source-formats:metrics-csv'))
})

test('sensitive binary asset in a team-readable repo raises the disclosure diagnostic', (t) => {
  const sample = makeFormatsProject(t)
  const graph = buildGraph(fixtureProject(sample))
  assert.deepEqual(graph.errors, [])
  const diagnostic = graph.diagnostics.find((entry) => entry.node === 'source-formats:logo-png')
  assert.equal(diagnostic?.code, 'audience-wider-repo-boundary')
})

test('boundary guard evaluates every sidecar-attached format node', (t) => {
  const sample = makeFormatsProject(t)
  const project = commandProject({ argv: ['--project', sample.config], cwd: sample.dir, env: {} })
  const policy = {
    schema: BOUNDARY_POLICY_SCHEMA,
    mode: 'strict',
    actors: {
      author: {
        gitEmails: ['author@example.invalid'],
        privateDomainRepo: 'author-private',
      },
    },
    repos: {
      content: {
        kind: 'shared',
        readBoundary: 'team',
        autoCommit: 'blocked',
        allowedAudiences: ['team'],
      },
      'author-private': {
        kind: 'private_domain',
        ownerActor: 'author',
        readBoundary: 'private',
        autoCommit: 'blocked',
        allowedAudiences: ['private', 'sensitive', 'team'],
      },
    },
  }

  const report = checkBoundaryPolicy({ project, policy, actor: 'author' })
  assert.equal(report.ok, false)
  const flagged = new Set(report.findings.filter((item) => item.code === 'audience-not-allowed-in-repo').map((item) => item.node))
  assert.ok(flagged.has('source-formats:pipeline-yaml'))
  assert.ok(flagged.has('source-formats:metrics-csv'))
  assert.ok(flagged.has('source-formats:logo-png'))
  assert.ok(!flagged.has('source-formats:data-json'))
  assert.ok(report.findings.some((item) => item.code === 'private-audience-in-shared-repo' && item.node === 'source-formats:logo-png'))
})

test('foreign files without sidecars stay out of the census; orphan sidecars still fail', (t) => {
  const sample = makeFormatsProject(t)
  const project = fixtureProject(sample)

  // Removing a sidecar removes the node without error: non-document formats
  // are opt-in, not demanded.
  fs.rmSync(path.join(sample.dir, 'content/pipeline.yaml.kg.json'))
  let graph = buildGraph(project)
  assert.deepEqual(graph.errors, [])
  assert.equal(graph.counts.nodes, 4)
  assert.ok(!graph.nodes.some((node) => node.id === 'source-formats:pipeline-yaml'))

  // A sidecar-less foreign file is invisible.
  fs.writeFileSync(path.join(sample.dir, 'content/notes.json'), '{"sample":true}\n')
  graph = buildGraph(project)
  assert.deepEqual(graph.errors, [])
  assert.equal(graph.counts.nodes, 4)

  // Removing the asset while keeping the sidecar is still an orphan error.
  fs.rmSync(path.join(sample.dir, 'content/data.json'))
  graph = buildGraph(project)
  assert.match(graph.errors.join('\n'), /data\.json\.kg\.json: sidecar has no matching source asset/)
})

test('workspace knowledge graph builder attaches sidecar-described formats deterministically', (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-formats-kg-'))
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  const repo = path.join(workspaceRoot, 'project-app')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })

  const writeAsset = (rel, contents) => {
    const abs = path.join(repo, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, contents)
  }
  const writeSidecar = (rel, id, type, audience) => {
    writeAsset(`${rel}.kg.json`, `${JSON.stringify({
      schema: SOURCE_SIDECAR_SCHEMA,
      asset: path.basename(rel),
      title: `Fixture ${path.basename(rel)}`,
      summary: '',
      tags: ['fixture'],
      kg: { id, type, domain: 'app', lifecycle: 'root', status: 'active', audience, relations: {} },
    }, null, 2)}\n`)
  }

  writeAsset('assets/data.json', '{"sample":true}\n')
  writeSidecar('assets/data.json', 'project-app:data-json', 'source', 'team')
  writeAsset('assets/pipeline.yaml', 'sample: true\n')
  writeSidecar('assets/pipeline.yaml', 'project-app:pipeline-yaml', 'source', 'public')
  writeAsset('assets/metrics.csv', 'name,value\nalpha,1\n')
  writeSidecar('assets/metrics.csv', 'project-app:metrics-csv', 'evidence', 'operator')
  writeAsset('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeSidecar('assets/logo.png', 'project-app:logo-png', 'artifact', 'sensitive')
  // No sidecar: stays out of the census instead of failing the build.
  writeAsset('assets/uncatalogued.json', '{"sample":true}\n')

  const repoAccessConfig = {
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: { 'project-app': { readBoundary: 'team' } },
  }

  const first = buildKnowledgeGraph({ workspaceRoot, repoAccessConfig })
  assert.equal(first.ok, true, first.errors.join('\n'))
  const byId = new Map(first.workspaceGraph.nodes.map((node) => [node.id, node]))
  assert.deepEqual(
    [...byId.keys()].sort(),
    ['project-app:data-json', 'project-app:logo-png', 'project-app:metrics-csv', 'project-app:pipeline-yaml'],
  )
  assert.ok(!first.workspaceGraph.nodes.some((node) => node.path === 'assets/uncatalogued.json'))
  for (const node of first.workspaceGraph.nodes) {
    assert.equal(node.hasSidecar, true)
    assert.deepEqual(node.sidecarSchemaErrors, [])
  }
  assert.equal(byId.get('project-app:logo-png').audience, 'sensitive')
  assert.equal(byId.get('project-app:pipeline-yaml').audience, 'public')

  // Determinism: building again from the same tree yields identical output.
  const second = buildKnowledgeGraph({ workspaceRoot, repoAccessConfig })
  assert.deepEqual(second.workspaceGraph, first.workspaceGraph)
})
