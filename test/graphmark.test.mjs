import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { REPO_ACCESS_SCHEMA, buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'

// Graphmark uses the existing knowledge graph contract: a mark is a Markdown
// source whose kg block points at the marked node. These tests pin that the
// documented mark shape compiles, that a mark cannot point at nothing, that an
// unmarked note is not silently governed, and that the recorded edition still
// names the bytes that were marked.

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtureContent = path.join(root, 'fixtures', 'graphmark', 'content')

function workspaceFromFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-'))
  const repo = path.join(workspace, 'content')
  fs.cpSync(fixtureContent, repo, { recursive: true })
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
  return { workspace, repo }
}

function repoAccess() {
  return { schema: REPO_ACCESS_SCHEMA, defaultReadBoundary: 'team', repos: { content: { readBoundary: 'team' } } }
}

function build(workspace) {
  return buildKnowledgeGraph({ workspaceRoot: workspace, repoAccessConfig: repoAccess() })
}

function edges(result) {
  return result.workspaceGraph.edges.map((edge) => `${edge.source} ${edge.type} ${edge.target}`)
}

function frontMatterValue(text, key) {
  const match = text.match(new RegExp(`^${key}: "([^"]*)"$`, 'm'))
  return match ? match[1] : null
}

test('the documented mark shape compiles into evidence, index and support edges', () => {
  const { workspace } = workspaceFromFixture()
  const result = build(workspace)
  assert.equal(result.ok, true, result.errors.join('\n'))

  const marks = result.workspaceGraph.nodes.filter((node) => node.id.startsWith('repair-workshop:mark:'))
  assert.equal(marks.length, 2)
  for (const mark of marks) {
    assert.equal(mark.kgType, 'evidence')
    assert.equal(mark.classification, 'classified')
    assert.equal(mark.audience, 'team')
  }

  const compiled = edges(result)
  assert.ok(compiled.includes('repair-workshop:mark:0001-the-order-of-wheel-checks evidences repair-workshop:notes:wheel-checks'))
  assert.ok(compiled.includes('repair-workshop:mark:0001-the-order-of-wheel-checks belongs_to repair-workshop:marks'))
  // A non-Markdown marked object is reached through its sidecar identity.
  assert.ok(compiled.includes('repair-workshop:mark:0002-spoke-tension-drawing evidences repair-workshop:drawings:spoke-tension'))
  assert.ok(compiled.includes('repair-workshop:mark:0002-spoke-tension-drawing supports repair-workshop:mark:0001-the-order-of-wheel-checks'))
})

test('a mark that names a node which does not exist is refused', () => {
  const { workspace, repo } = workspaceFromFixture()
  const markPath = path.join(repo, 'marks', '0001-the-order-of-wheel-checks.md')
  const text = fs.readFileSync(markPath, 'utf8')
  fs.writeFileSync(markPath, text.replace('"repair-workshop:notes:wheel-checks"', '"repair-workshop:notes:never-written"'))

  const result = build(workspace)
  assert.equal(result.ok, false)
  assert.ok(
    result.errors.some((error) => error.includes('evidences') && error.includes('repair-workshop:notes:never-written')),
    result.errors.join('\n'),
  )
})

test('removing the marked asset refuses the build instead of leaving a dangling mark', () => {
  const { workspace, repo } = workspaceFromFixture()
  fs.rmSync(path.join(repo, 'drawings', 'spoke-tension.svg'))

  const result = build(workspace)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('orphan sidecar')), result.errors.join('\n'))
  assert.ok(
    result.errors.some((error) => error.includes('0002-spoke-tension-drawing.md') && error.includes('was not found')),
    result.errors.join('\n'),
  )
})

test('a mark written without a kg block is not governed and falls back to the private audience', () => {
  const { workspace, repo } = workspaceFromFixture()
  fs.writeFileSync(
    path.join(repo, 'marks', '0003-unrecorded.md'),
    '---\ntitle: "Mark 0003: said but not recorded"\n---\n# Mark 0003\n\nA mark that never reached the graph.\n',
  )

  const result = build(workspace)
  const node = result.workspaceGraph.nodes.find((item) => item.path === 'marks/0003-unrecorded.md')
  assert.ok(node, 'the file is still counted in the census')
  assert.equal(node.classification, 'unclassified')
  assert.equal(node.audience, 'private')
  assert.equal(edges(result).some((edge) => edge.includes('0003')), false)
})

test('each fixture mark still names the exact bytes that were marked', () => {
  for (const name of fs.readdirSync(path.join(fixtureContent, 'marks')).filter((file) => /^\d{4}-.*\.md$/.test(file))) {
    const text = fs.readFileSync(path.join(fixtureContent, 'marks', name), 'utf8')
    const markedPath = frontMatterValue(text, 'markedPath')
    const markedSha256 = frontMatterValue(text, 'markedSha256')
    assert.ok(markedPath && markedSha256, `${name} records markedPath and markedSha256`)
    const bytes = fs.readFileSync(path.join(fixtureContent, markedPath))
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), markedSha256, `${name} edition matches ${markedPath}`)
  }
})
