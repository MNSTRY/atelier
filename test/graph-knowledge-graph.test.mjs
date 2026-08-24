import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  REPO_ACCESS_SCHEMA,
  SOURCE_SIDECAR_SCHEMA,
  buildKnowledgeGraph,
  portableText,
  validateRepoAccessConfig,
} from '../src/graph/knowledge-graph.mjs'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graph-'))
  const repo = path.join(root, 'project-app')
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  return { root, repo }
}

function writeDoc(repo, rel, frontmatter, body = '# Fixture\n\nBody.') {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `---\n${frontmatter.trim()}\n---\n\n${body}\n`)
}

function writeAsset(repo, rel, contents = '') {
  const abs = path.join(repo, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
  return abs
}

function writeSidecar(repo, rel, metadata) {
  const abs = path.join(repo, `${rel}.kg.json`)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, `${JSON.stringify(metadata, null, 2)}\n`)
}

function repoAccess(repoName = 'project-app', readBoundary = 'team') {
  return {
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: {
      [repoName]: { readBoundary },
    },
  }
}

test('front matter kg.id survives rename while path updates', () => {
  const { root, repo } = makeWorkspace()
  writeDoc(
    repo,
    'docs/original.md',
    `
title: "Original"
kg:
  id: "project-app:stable-original"
  type: "document"
  status: "active"
  audience: "team"
`,
  )

  let result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  let node = result.workspaceGraph.nodes.find((item) => item.id === 'project-app:stable-original')
  assert.equal(node.path, 'docs/original.md')

  fs.mkdirSync(path.join(repo, 'moved'), { recursive: true })
  fs.renameSync(path.join(repo, 'docs/original.md'), path.join(repo, 'moved/original.md'))

  result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  node = result.workspaceGraph.nodes.find((item) => item.id === 'project-app:stable-original')
  assert.equal(node.path, 'moved/original.md')
})

test('non-Markdown sidecar kg.id survives html rename while edges remain stable', () => {
  const { root, repo } = makeWorkspace()
  writeDoc(
    repo,
    'docs/source.md',
    `
title: "Source"
kg:
  id: "project-app:source"
  type: "document"
  status: "active"
  audience: "team"
  relations:
    evidences:
      - "project-app:stable-html"
`,
  )
  writeAsset(repo, 'assets/original.html', '<!doctype html><title>HTML</title>')
  writeSidecar(repo, 'assets/original.html', {
    schema: SOURCE_SIDECAR_SCHEMA,
    asset: 'original.html',
    title: 'HTML',
    summary: '',
    tags: ['fixture'],
    kg: {
      id: 'project-app:stable-html',
      type: 'html',
      domain: 'app',
      lifecycle: 'root',
      status: 'active',
      audience: 'team',
      relations: { related: [], supports: [], supersedes: [] },
    },
  })

  let result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))

  fs.mkdirSync(path.join(repo, 'moved'), { recursive: true })
  fs.renameSync(path.join(repo, 'assets/original.html'), path.join(repo, 'moved/renamed.html'))
  fs.renameSync(path.join(repo, 'assets/original.html.kg.json'), path.join(repo, 'moved/renamed.html.kg.json'))
  const renamedSidecar = JSON.parse(fs.readFileSync(path.join(repo, 'moved/renamed.html.kg.json'), 'utf8'))
  renamedSidecar.asset = 'renamed.html'
  fs.writeFileSync(path.join(repo, 'moved/renamed.html.kg.json'), `${JSON.stringify(renamedSidecar, null, 2)}\n`)

  result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  const graph = result.workspaceGraph
  const html = graph.nodes.find((item) => item.id === 'project-app:stable-html')
  assert.equal(html.path, 'moved/renamed.html')
  assert.ok(graph.edges.some((edge) => edge.source === 'project-app:source' && edge.target === 'project-app:stable-html' && edge.type === 'evidences'))
})

test('missing non-Markdown sidecar fails validation', () => {
  const { root, repo } = makeWorkspace()
  writeAsset(repo, 'assets/missing.html', '<!doctype html><title>Missing</title>')

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /missing non-Markdown sidecar assets\/missing\.html\.kg\.json/)
})

test('repo-access config must cover discovered workspace repos', () => {
  const errors = validateRepoAccessConfig({
    schema: REPO_ACCESS_SCHEMA,
    defaultReadBoundary: 'team',
    repos: {},
  }, ['project-app'])

  assert.match(errors.join('\n'), /repos\.project-app must declare readBoundary/)
})

test('private node in team-readable repo emits disclosure diagnostics', () => {
  const { root, repo } = makeWorkspace()
  writeDoc(
    repo,
    'private-draft.md',
    `
title: "Private Draft"
kg:
  id: "project-app:private-draft"
  type: "document"
  status: "active"
  audience: "private"
`,
  )

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.ok(result.workspaceGraph.diagnostics.some((diagnostic) => diagnostic.type === 'private-repo-recommended'))
})

test('unclassified Markdown is enrolled privately with an explicit diagnostic', () => {
  const { root, repo } = makeWorkspace()
  const fixtures = {
    'absent.md': '# Absent\n\nNo front matter.',
    'empty.md': '---\n\n---\n\n# Empty',
    'malformed.md': '---\ntitle "Malformed"\n---\n\n# Malformed',
    'missing-kg.md': '---\ntitle: "Missing KG"\n---\n\n# Missing KG',
  }
  for (const [rel, contents] of Object.entries(fixtures)) writeAsset(repo, rel, `${contents}\n`)

  const result = buildKnowledgeGraph({ workspaceRoot: root, repoAccessConfig: repoAccess() })
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.equal(result.workspaceGraph.nodes.length, 4)
  assert.ok(result.workspaceGraph.nodes.every((node) => node.audience === 'private' && node.classification === 'unclassified'))
  assert.deepEqual(
    result.workspaceGraph.diagnostics
      .filter((diagnostic) => diagnostic.code === 'unclassified-content')
      .map((diagnostic) => diagnostic.reason)
      .sort(),
    ['absent-frontmatter', 'empty-frontmatter', 'malformed-frontmatter', 'missing-kg-block'],
  )
})

// The scrubber existed only for macOS home paths; Linux and Windows shapes
// passed through untouched, and CI runs on ubuntu-latest. The probe paths are
// assembled at runtime so the repo disclosure gate never sees a literal one.
test('portableText strips home directories on every OS shape', () => {
  const mac = ['', 'Users', 'sample', 'secret', 'notes.md'].join('/')
  const linux = ['', 'home', 'sample', 'secret', 'notes.md'].join('/')
  const windows = ['C:', 'Users', 'sample', 'secret'].join('\\')
  assert.equal(portableText(mac), '~/secret/notes.md')
  assert.equal(portableText(linux), '~/secret/notes.md')
  assert.equal(portableText(windows), '~\\secret')
  assert.equal(portableText('no paths here'), 'no paths here')
})
