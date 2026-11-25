import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { REPO_ACCESS_SCHEMA, buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { spawnSync } from 'node:child_process'
import { checkGraphmarks, readMarkRecord, validateMarkRecord } from '../src/graphmark/graphmark.mjs'
import { commandProject } from '../src/project/config.mjs'

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
  fs.rmSync(path.join(repo, 'drawings', 'spoke-tension.html'))

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

// The MNSTRY GraphMark standard (docs/reference/graphmark.md) as code: every
// record satisfies atelier-graphmark@v1, and `atelier graphmark check` proves
// what the graph cannot see on its own: the edition and the audience.

const binary = path.join(root, 'bin', 'atelier.mjs')

function projectFromFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-project-'))
  fs.cpSync(path.join(root, 'fixtures', 'graphmark'), dir, { recursive: true })
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  return dir
}

function checkProject(dir) {
  return checkGraphmarks(commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false }))
}

test('each fixture mark satisfies the atelier-graphmark@v1 contract', () => {
  for (const name of fs.readdirSync(path.join(fixtureContent, 'marks')).filter((file) => /^\d{4}-.*\.md$/.test(file))) {
    const record = readMarkRecord(fs.readFileSync(path.join(fixtureContent, 'marks', name), 'utf8'))
    const result = validateMarkRecord(record)
    assert.equal(result.ok, true, `${name}: ${result.errors.join('; ')}`)
  }
  const missingReason = validateMarkRecord({ title: 'Mark', summary: 'x', tags: ['graphmark'] })
  assert.equal(missingReason.ok, false)
})

test('graphmark check passes intact marks and skips the marks index', () => {
  const report = checkProject(projectFromFixture())
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.deepEqual(report.marks.map((mark) => [mark.id, mark.edition]), [
    ['repair-workshop:mark:0001-the-order-of-wheel-checks', 'intact'],
    ['repair-workshop:mark:0002-spoke-tension-drawing', 'intact'],
  ])
  assert.deepEqual(report.warnings, [])
})

test('a marked file that moved on is reported as a changed edition, not an error', () => {
  const dir = projectFromFixture()
  fs.appendFileSync(path.join(dir, 'content', 'notes', 'wheel-checks.md'), '\nA later line.\n')
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.marks.find((mark) => mark.id.endsWith('0001-the-order-of-wheel-checks')).edition, 'changed')
  assert.ok(report.warnings.some((warning) => warning.includes('has changed since it was marked') && warning.includes('832bff3f')), report.warnings.join('\n'))
})

test('a mark more widely visible than what it marks is refused', () => {
  const dir = projectFromFixture()
  const markPath = path.join(dir, 'content', 'marks', '0001-the-order-of-wheel-checks.md')
  fs.writeFileSync(markPath, fs.readFileSync(markPath, 'utf8').replace('  audience: "team"', '  audience: "public"'))
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('audience "public" is wider than "team"')), report.errors.join('\n'))
})

test('a mark whose marked file is gone is refused', () => {
  const dir = projectFromFixture()
  const markPath = path.join(dir, 'content', 'marks', '0001-the-order-of-wheel-checks.md')
  fs.writeFileSync(markPath, fs.readFileSync(markPath, 'utf8').replace('markedPath: "notes/wheel-checks.md"', 'markedPath: "notes/never-written.md"'))
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('notes/never-written.md is gone')), report.errors.join('\n'))
})

test('a record tagged graphmark that breaks the contract is refused', () => {
  const dir = projectFromFixture()
  const markPath = path.join(dir, 'content', 'marks', '0002-spoke-tension-drawing.md')
  fs.writeFileSync(markPath, fs.readFileSync(markPath, 'utf8').replace(/^markedSha256: .*$/m, 'markedSha256: "unrecorded"'))
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('atelier-graphmark@v1 /markedSha256')), report.errors.join('\n'))
})

test('atelier graphmark check reports through the CLI and exits non-zero on a refusal', () => {
  const dir = projectFromFixture()
  const ok = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /graphmark: 2 marks · 2 editions intact · 0 changed · 0 errors/)
  const json = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--json'], { cwd: dir, encoding: 'utf8' })
  assert.equal(JSON.parse(json.stdout).ok, true)
  const markPath = path.join(dir, 'content', 'marks', '0001-the-order-of-wheel-checks.md')
  fs.writeFileSync(markPath, fs.readFileSync(markPath, 'utf8').replace('  audience: "team"', '  audience: "public"'))
  const refused = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /never more widely visible than what it marks/)
})

test('markedPath resolves from the Git repository root when the knowledge folder is inside it', () => {
  const dir = projectFromFixture()
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tools', 'checklist.txt'), 'wheel, brakes, chain\n')
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'tools', 'checklist.txt'))).digest('hex')
  const markPath = path.join(dir, 'content', 'marks', '0001-the-order-of-wheel-checks.md')
  fs.writeFileSync(markPath, fs.readFileSync(markPath, 'utf8')
    .replace('markedPath: "notes/wheel-checks.md"', 'markedPath: "tools/checklist.txt"')
    .replace(/^markedSha256: .*$/m, `markedSha256: "${digest}"`))
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.marks.find((mark) => mark.id.endsWith('0001-the-order-of-wheel-checks')).edition, 'intact')
  assert.ok(report.warnings.some((warning) => warning.includes('tools/checklist.txt is not a node in the graph')), report.warnings.join('\n'))
})
