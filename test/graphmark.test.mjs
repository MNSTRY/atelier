import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateEvidenceDocument } from '../src/evidence-navigation/contracts.mjs'
import { REPO_ACCESS_SCHEMA, buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { checkGraphmarks, readMarkRecord, validateMarkRecord } from '../src/graphmark/graphmark.mjs'
import { commandProject } from '../src/project/config.mjs'

// The MNSTRY GraphMark standard (docs/reference/graphmark.md). A mark is a
// Markdown source whose kg block points at the marked node and whose target is
// an exact source reference to a recoverable edition. These tests pin that the
// documented shape compiles, that a mark cannot point at nothing, that an
// unrecorded mark is not silently governed, that every record satisfies
// atelier-graphmark@v1, and that `atelier graphmark check` proves the edition,
// the selector and the audience.

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtureContent = path.join(root, 'fixtures', 'graphmark', 'content')
const binary = path.join(root, 'bin', 'atelier.mjs')
const WHEEL = '2026-01-12-order-of-wheel-checks.md'
const DRAWING = '2026-01-12-spoke-tension-drawing.md'
const PADS = '2026-01-14-pads-before-cable.md'
const markFiles = () => fs.readdirSync(path.join(fixtureContent, 'marks')).filter((file) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(file))
const digest = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`

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

test('the documented mark shape compiles into evidence, index and support edges', () => {
  const { workspace } = workspaceFromFixture()
  const result = build(workspace)
  assert.equal(result.ok, true, result.errors.join('\n'))

  const marks = result.workspaceGraph.nodes.filter((node) => node.id.startsWith('repair-workshop:mark:'))
  assert.equal(marks.length, 3)
  for (const mark of marks) {
    assert.equal(mark.kgType, 'evidence')
    assert.equal(mark.classification, 'classified')
    assert.equal(mark.audience, 'team')
  }

  const compiled = edges(result)
  assert.ok(compiled.includes('repair-workshop:mark:2026-01-12-order-of-wheel-checks evidences repair-workshop:notes:wheel-checks'))
  assert.ok(compiled.includes('repair-workshop:mark:2026-01-12-order-of-wheel-checks belongs_to repair-workshop:marks'))
  // A non-Markdown marked object is reached through its sidecar identity.
  assert.ok(compiled.includes('repair-workshop:mark:2026-01-12-spoke-tension-drawing evidences repair-workshop:drawings:spoke-tension'))
  assert.ok(compiled.includes('repair-workshop:mark:2026-01-12-spoke-tension-drawing supports repair-workshop:mark:2026-01-12-order-of-wheel-checks'))
  // Captured material is committed first, then marked like any other source.
  assert.ok(compiled.includes('repair-workshop:mark:2026-01-14-pads-before-cable evidences repair-workshop:captures:2026-01-14-brake-check-advice'))
})

test('a mark that names a node which does not exist is refused', () => {
  const { workspace, repo } = workspaceFromFixture()
  const markPath = path.join(repo, 'marks', WHEEL)
  fs.writeFileSync(markPath, fs.readFileSync(markPath, 'utf8').replace('"repair-workshop:notes:wheel-checks"', '"repair-workshop:notes:never-written"'))

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
    result.errors.some((error) => error.includes(DRAWING) && error.includes('was not found')),
    result.errors.join('\n'),
  )
})

test('a mark written without a kg block is not governed and falls back to the private audience', () => {
  const { workspace, repo } = workspaceFromFixture()
  fs.writeFileSync(
    path.join(repo, 'marks', '2026-01-15-unrecorded.md'),
    '---\ntitle: "Mark: said but not recorded"\n---\n# Mark\n\nA mark that never reached the graph.\n',
  )

  const result = build(workspace)
  const node = result.workspaceGraph.nodes.find((item) => item.path === 'marks/2026-01-15-unrecorded.md')
  assert.ok(node, 'the file is still counted in the census')
  assert.equal(node.classification, 'unclassified')
  assert.equal(node.audience, 'private')
  assert.equal(edges(result).some((edge) => edge.includes('2026-01-15-unrecorded')), false)
})

test('each fixture mark names the exact bytes of its object and satisfies the contract', () => {
  const evidenceSchema = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'atelier-evidence-navigation.v1.schema.json'), 'utf8'))
  const markSchema = JSON.parse(fs.readFileSync(path.join(root, 'contracts', 'atelier-graphmark.v1.schema.json'), 'utf8'))
  // The target is the evidence-navigation exact source reference, unchanged.
  assert.deepEqual(markSchema.$defs.evidenceRef, evidenceSchema.$defs.evidenceRef)
  assert.deepEqual(markSchema.$defs.selector, evidenceSchema.$defs.selector)

  const files = markFiles()
  assert.deepEqual(files.sort(), [WHEEL, DRAWING, PADS].sort())
  for (const name of files) {
    const record = readMarkRecord(fs.readFileSync(path.join(fixtureContent, 'marks', name), 'utf8'))
    const result = validateMarkRecord(record)
    assert.equal(result.ok, true, `${name}: ${result.errors.join('; ')}`)
    assert.deepEqual(validateEvidenceDocument('evidenceRef', record.target), { valid: true, reason: null }, `${name} target is an evidenceRef`)
    const bytes = fs.readFileSync(path.join(fixtureContent, record.target.objectId))
    assert.equal(digest(bytes), record.target.contentDigest, `${name} edition matches ${record.target.objectId}`)
  }
  assert.equal(validateMarkRecord({ title: 'Mark', summary: 'x', tags: ['graphmark'] }).ok, false)
})

// A project copy of the fixture under Git, as a consumer would hold it.

function git(dir, args) {
  const result = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: dir, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function projectFromFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-project-'))
  fs.cpSync(path.join(root, 'fixtures', 'graphmark'), dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'fixture'])
  return dir
}

function markPath(dir, name) {
  return path.join(dir, 'content', 'marks', name)
}

function editMark(dir, name, edit) {
  fs.writeFileSync(markPath(dir, name), edit(fs.readFileSync(markPath(dir, name), 'utf8')))
}

// Record the commit that holds every edition, as a marker would.
function pinRevisions(dir) {
  const head = git(dir, ['rev-parse', 'HEAD'])
  for (const name of [WHEEL, DRAWING, PADS]) editMark(dir, name, (text) => text.replace('revision: "example"', `revision: "${head}"`))
  git(dir, ['commit', '-qam', 'pin mark revisions'])
  return head
}

function commitAll(dir, message) {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', message])
}

function checkProject(dir) {
  return checkGraphmarks(commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false }))
}

test('graphmark check passes the fixture, held at HEAD until the revisions name a real commit', () => {
  const dir = projectFromFixture()
  const first = checkProject(dir)
  assert.equal(first.ok, true, first.errors.join('\n'))
  assert.deepEqual(first.marks.map((mark) => [mark.id, mark.edition, mark.selector]), [
    ['repair-workshop:mark:2026-01-12-order-of-wheel-checks', 'intact', 'lines'],
    ['repair-workshop:mark:2026-01-12-spoke-tension-drawing', 'intact', 'whole'],
    ['repair-workshop:mark:2026-01-14-pads-before-cable', 'intact', 'text-quote'],
  ])
  assert.equal(first.warnings.filter((warning) => warning.includes('revision example is not in this repository\'s history; the edition is held at HEAD')).length, 3)

  pinRevisions(dir)
  const pinned = checkProject(dir)
  assert.equal(pinned.ok, true, pinned.errors.join('\n'))
  assert.deepEqual(pinned.warnings, [])
})

test('a committed change to the marked file is a changed edition, recoverable at its revision', () => {
  const dir = projectFromFixture()
  const head = pinRevisions(dir)
  fs.appendFileSync(path.join(dir, 'content', 'notes', 'wheel-checks.md'), '\nA later line.\n')
  const capture = path.join(dir, 'content', 'captures', '2026-01-14-brake-check-advice.md')
  fs.writeFileSync(capture, fs.readFileSync(capture, 'utf8').replace('The mechanic checks pad wear before cable tension', 'The mechanic now checks cable first'))
  commitAll(dir, 'later edits')

  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.marks.find((mark) => mark.id.endsWith('order-of-wheel-checks')).edition, 'changed')
  assert.ok(report.warnings.some((warning) => warning.includes(`git cat-file blob ${head}:content/notes/wheel-checks.md`)), report.warnings.join('\n'))
  assert.ok(report.warnings.some((warning) => warning.includes('the marked quote is no longer in the current file')), report.warnings.join('\n'))
})

test('an edition that exists only in the working tree is refused until it is committed', () => {
  const dir = projectFromFixture()
  pinRevisions(dir)
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.appendFileSync(note, '\nAn uncommitted line.\n')
  editMark(dir, WHEEL, (text) => text.replace(/contentDigest: ".*"/, `contentDigest: "${digest(fs.readFileSync(note))}"`))
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('exists only in the working tree')), report.errors.join('\n'))
})

test('an edition no commit holds is refused as unrecoverable', () => {
  const dir = projectFromFixture()
  editMark(dir, DRAWING, (text) => text.replace(/contentDigest: ".*"/, `contentDigest: "sha256:${'0'.repeat(64)}"`))
  commitAll(dir, 'a digest nothing holds')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('the marked edition is not recoverable')), report.errors.join('\n'))
})

test('a selector that names nothing inside the edition is refused', () => {
  const dir = projectFromFixture()
  editMark(dir, WHEEL, (text) => text.replace('value: "16-21"', 'value: "16-99"'))
  editMark(dir, PADS, (text) => text.replace(/value: "The mechanic.*"/, 'value: "Words the mechanic never said."'))
  commitAll(dir, 'selectors outside the edition')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('selector lines 16-99 fall outside the marked edition (23 lines)')), report.errors.join('\n'))
  assert.ok(report.errors.some((error) => error.includes('selector text-quote is not in the marked edition')), report.errors.join('\n'))
})

test('a mark more widely visible than what it marks is refused', () => {
  const dir = projectFromFixture()
  editMark(dir, WHEEL, (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'widen')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('audience "public" is wider than "team"')), report.errors.join('\n'))
})

test('a mark whose target another repository owns is refused', () => {
  const dir = projectFromFixture()
  editMark(dir, WHEEL, (text) => text.replace('owner: "content"', 'owner: "elsewhere"'))
  commitAll(dir, 'foreign owner')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('target owner "elsewhere" is not this repository "content"')), report.errors.join('\n'))
})

test('a record tagged graphmark that breaks the contract is refused', () => {
  const dir = projectFromFixture()
  editMark(dir, DRAWING, (text) => text.replace(/contentDigest: ".*"/, 'contentDigest: "unrecorded"'))
  commitAll(dir, 'break the contract')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('atelier-graphmark@v1 /target/contentDigest')), report.errors.join('\n'))
})

test('objectId resolves from the Git repository root when the knowledge folder is inside it', () => {
  const dir = projectFromFixture()
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tools', 'checklist.txt'), 'wheel, brakes, chain\n')
  commitAll(dir, 'a file outside the knowledge folder')
  const head = git(dir, ['rev-parse', 'HEAD'])
  editMark(dir, WHEEL, (text) => text
    .replace('objectId: "notes/wheel-checks.md"', 'objectId: "tools/checklist.txt"')
    .replace(`revision: "example"`, `revision: "${head}"`)
    .replace('value: "16-21"', 'value: "1"')
    .replace(/contentDigest: ".*"/, `contentDigest: "${digest(fs.readFileSync(path.join(dir, 'tools', 'checklist.txt')))}"`))
  commitAll(dir, 'mark a file outside the folder')
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.marks.find((mark) => mark.id.endsWith('order-of-wheel-checks')).edition, 'intact')
  assert.ok(report.warnings.some((warning) => warning.includes('tools/checklist.txt: is not a node in the graph')), report.warnings.join('\n'))
})

test('atelier graphmark check reports through the CLI and exits non-zero on a refusal', () => {
  const dir = projectFromFixture()
  pinRevisions(dir)
  const ok = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /graphmark: 3 marks · 3 intact · 0 changed · 0 removed · 0 errors/)
  const json = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--json'], { cwd: dir, encoding: 'utf8' })
  assert.equal(JSON.parse(json.stdout).ok, true)
  editMark(dir, WHEEL, (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'widen')
  const refused = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /never more widely visible than what it marks/)
})
