import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BOUNDARY_POLICY_SCHEMA, checkBoundaryPolicy } from '../src/boundary/policy.mjs'
import { buildGraph, ignoredSidecarWarnings } from '../src/graph/graph.mjs'
import { REPO_ACCESS_SCHEMA, SOURCE_SIDECAR_SCHEMA, buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { commandProject, resolveProjectConfig, writeJson } from '../src/project/config.mjs'
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

// Replay of the ignored-sidecar census attack: '*.kg.json' in .gitignore plus
// an untracked sidecar declaring audience "public" minted a node that exists in
// no tracked file — invisible to review, and present on the author's machine
// only. These fixtures MUST be real git repositories: gitIgnoreFilter shells
// out to git, so in a plain scratch directory it is inert and the replay proves
// nothing.
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function assertIgnored(repo, rel) {
  const result = spawnSync('git', ['-C', repo, 'check-ignore', '--quiet', rel], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${rel} is not git-ignored — restore the .gitignore pattern or the replay is vacuous`)
}

function initRepo(dir, ignorePatterns) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '--quiet'])
  git(dir, ['config', 'user.email', 'builder@example.invalid'])
  git(dir, ['config', 'user.name', 'Builder'])
  fs.writeFileSync(path.join(dir, '.gitignore'), `${ignorePatterns.join('\n')}\n`)
}

function writeFile(repo, rel, contents) {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

// graph.mjs sidecar dialect.
function projectSidecar(assetRel, id, audience) {
  return `${JSON.stringify(
    {
      assetFilename: path.basename(assetRel),
      title: 'Injected title',
      summary: '',
      tags: [],
      kg: { id, type: 'artifact', status: 'active', audience, relations: {} },
    },
    null,
    2,
  )}\n`
}

// knowledge-graph.mjs sidecar dialect.
function workspaceSidecar(assetRel, id, type, audience) {
  return `${JSON.stringify(
    {
      schema: SOURCE_SIDECAR_SCHEMA,
      asset: path.basename(assetRel),
      title: 'Injected title',
      summary: '',
      tags: ['injected'],
      kg: { id, type, domain: 'app', lifecycle: 'root', status: 'active', audience, relations: {} },
    },
    null,
    2,
  )}\n`
}

function makeIgnoredSidecarProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ignored-sidecar-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, 'content')
  initRepo(repo, ['*.kg.json'])
  writeFile(repo, 'README.md', '---\ntitle: "Readme"\nkg:\n  id: "content:readme"\n  audience: "team"\n---\n\n# Readme\n')
  writeFile(repo, 'ghost.json', '{"sample":true}\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'seed'])

  writeJson(path.join(dir, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'ignored-sidecar-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: [{ name: 'content', path: 'content', readBoundary: 'team' }],
  })
  writeJson(path.join(dir, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: { content: { readBoundary: 'team' } },
  })
  return { dir, repo, config: path.join(dir, 'atelier.project.json') }
}

test('a git-ignored sidecar cannot enroll a file or hand it an audience', (t) => {
  const sample = makeIgnoredSidecarProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })

  const clean = buildGraph(project)
  assert.deepEqual(clean.errors, [])
  assert.deepEqual(clean.nodes.map((node) => node.id), ['content:readme'])
  assert.deepEqual(ignoredSidecarWarnings(project), [])

  // The demonstrated attack, verbatim.
  writeFile(sample.repo, 'ghost.json.kg.json', projectSidecar('ghost.json', 'content:ghost', 'public'))
  assertIgnored(sample.repo, 'ghost.json.kg.json')

  const attacked = buildGraph(project)
  assert.deepEqual(attacked.errors, [])
  assert.deepEqual(attacked.nodes.map((node) => node.id), ['content:readme'], 'a git-ignored sidecar enrolled a file in the census')
  assert.deepEqual(attacked.nodes, clean.nodes, 'a git-ignored sidecar changed the census')
  assert.ok(
    !projectGraph(attacked, { target: 'public' }).nodes.some((node) => node.id === 'content:ghost'),
    'an untracked sidecar reached the public projection',
  )

  // Refused, and said out loud: silently dropping is what got us here.
  const warnings = ignoredSidecarWarnings(project)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].severity, 'warning')
  assert.equal(warnings[0].code, 'ignored-sidecar')
  assert.equal(warnings[0].repo, 'content')
  assert.equal(warnings[0].path, 'ghost.json')
  assert.equal(warnings[0].sidecar, 'ghost.json.kg.json')
  assert.match(warnings[0].message, /ghost\.json\.kg\.json: sidecar is git-ignored/)

  // The rule is git visibility, not a ban on sidecars: tracked, the very same
  // file enrolls the asset exactly as before.
  git(sample.repo, ['add', '--force', 'ghost.json.kg.json'])
  git(sample.repo, ['commit', '--quiet', '-m', 'track the sidecar'])
  const tracked = buildGraph(project)
  assert.deepEqual(tracked.errors, [])
  assert.equal(tracked.nodes.find((node) => node.id === 'content:ghost')?.audience, 'public')
  assert.deepEqual(ignoredSidecarWarnings(project), [])
})

test('an ignored sidecar beside a document-extension asset still fails closed', (t) => {
  const sample = makeIgnoredSidecarProject(t)
  const project = resolveProjectConfig({ argv: [`--project=${sample.config}`], cwd: sample.dir })

  writeFile(sample.repo, 'brief.pdf', '%PDF-1.4 fixture\n')
  git(sample.repo, ['add', 'brief.pdf'])
  git(sample.repo, ['commit', '--quiet', '-m', 'add brief'])
  assert.match(buildGraph(project).errors.join('\n'), /brief\.pdf: non-Markdown source requires sidecar/)

  // A document extension demands a sidecar, and an ignored one does not answer
  // the demand: the verdict stays the error a clean checkout would reach.
  writeFile(sample.repo, 'brief.pdf.kg.json', projectSidecar('brief.pdf', 'content:brief', 'public'))
  assertIgnored(sample.repo, 'brief.pdf.kg.json')
  const graph = buildGraph(project)
  assert.match(graph.errors.join('\n'), /brief\.pdf: non-Markdown source requires sidecar/)
  assert.ok(!graph.nodes.some((node) => node.id === 'content:brief'), 'an ignored sidecar described a document-extension asset')
  assert.ok(
    ignoredSidecarWarnings(project).some((warning) => warning.sidecar === 'brief.pdf.kg.json'),
    'the refused sidecar was not named',
  )
})

test('the workspace builder refuses git-ignored sidecars in both directions', (t) => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ignored-sidecar-kg-'))
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }))
  const repo = path.join(workspaceRoot, 'project-app')
  initRepo(repo, ['assets/*.kg.json'])
  writeFile(repo, 'assets/data.json', '{"sample":true}\n')
  writeFile(repo, 'assets/page.html', '<!doctype html><title>Tracked page</title>\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'seed'])

  writeFile(repo, 'assets/data.json.kg.json', workspaceSidecar('assets/data.json', 'project-app:data-json', 'source', 'public'))
  writeFile(repo, 'assets/page.html.kg.json', workspaceSidecar('assets/page.html', 'project-app:page-html', 'html', 'public'))
  assertIgnored(repo, 'assets/data.json.kg.json')
  assertIgnored(repo, 'assets/page.html.kg.json')

  const repoAccessConfig = {
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: { 'project-app': { readBoundary: 'team' } },
  }
  const result = buildKnowledgeGraph({ workspaceRoot, repoAccessConfig, repoRoots: [repo] })

  // Enrolment refused: the opt-in asset is not knowledge-graph material.
  assert.ok(!result.workspaceGraph.nodes.some((node) => node.path === 'assets/data.json'), 'an ignored sidecar enrolled a file')
  // Description refused: the document-extension asset is a node either way, but
  // it fails closed instead of absorbing untracked identity or audience.
  const page = result.workspaceGraph.nodes.find((node) => node.path === 'assets/page.html')
  assert.equal(page?.hasSidecar, false)
  assert.equal(page?.audience, '')
  assert.notEqual(page?.title, 'Injected title')
  assert.notEqual(page?.id, 'project-app:page-html')
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /assets\/page\.html: missing non-Markdown sidecar/)

  // Reported beside the graph, never inside it.
  assert.deepEqual(
    result.ignoredSidecars.map((entry) => `${entry.repo}/${entry.sidecar}`).sort(),
    ['project-app/assets/data.json.kg.json', 'project-app/assets/page.html.kg.json'],
  )
  assert.equal(JSON.stringify(result.workspaceGraph).includes('Injected title'), false)
})
