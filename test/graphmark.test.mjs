import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateEvidenceDocument } from '../src/evidence-navigation/contracts.mjs'
import { REPO_ACCESS_SCHEMA, buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { buildCommittedGraph, checkGraphmarks, classifyBlobs, committedReader, isPromisorRepository, projectLayout, readMarkRecord, validateMarkRecord, withCommittedReader } from '../src/graphmark/graphmark.mjs'
import { buildGraph } from '../src/graph/graph.mjs'
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
  // The target is the evidence-navigation exact source reference, unchanged,
  // refined by GraphMark's own constraints.
  assert.deepEqual(markSchema.$defs.evidenceRef, evidenceSchema.$defs.evidenceRef)
  assert.deepEqual(markSchema.$defs.selector, evidenceSchema.$defs.selector)
  assert.deepEqual(markSchema.properties.target.allOf, [{ $ref: '#/$defs/evidenceRef' }, { $ref: '#/$defs/graphmarkTarget' }])

  const files = markFiles()
  assert.deepEqual(files.sort(), [WHEEL, DRAWING, PADS].sort())
  for (const name of files) {
    const record = readMarkRecord(fs.readFileSync(path.join(fixtureContent, 'marks', name), 'utf8'))
    const result = validateMarkRecord(record)
    assert.equal(result.ok, true, `${name}: ${result.errors.join('; ')}`)
    assert.deepEqual(validateEvidenceDocument('evidenceRef', record.target), { valid: true, reason: null }, `${name} target is an evidenceRef`)
    // objectId is the path from the Git repository root: the fixture folder.
    const bytes = fs.readFileSync(path.join(root, 'fixtures', 'graphmark', record.target.objectId))
    assert.equal(digest(bytes), record.target.contentDigest, `${name} edition matches ${record.target.objectId}`)
  }
  assert.equal(validateMarkRecord({ title: 'Mark', summary: 'x', tags: ['graphmark'] }).ok, false)
})

test('the standalone validator refuses what the check refuses about the target and the reason', () => {
  const record = readMarkRecord(fs.readFileSync(path.join(fixtureContent, 'marks', WHEEL), 'utf8'))
  const refused = (edit, pattern) => {
    const copy = structuredClone(record)
    edit(copy)
    const result = validateMarkRecord(copy)
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((error) => pattern.test(error)), result.errors.join('\n'))
  }
  refused((copy) => { copy.target.revision = 'main' }, /\/target\/revision must match pattern/)
  refused((copy) => { copy.target.revision = '94f6c9e' }, /\/target\/revision must match pattern/)
  refused((copy) => { copy.target.selector.type = 'line' }, /\/target\/selector\/type must be equal to one of the allowed values/)
  refused((copy) => { copy.target.selector.version = '2' }, /\/target\/selector\/version must be equal to constant/)
  refused((copy) => { copy.target.selector = { type: 'whole', version: '1', value: 'lines 3-5' } }, /\/target\/selector\/value must be equal to constant/)
  refused((copy) => { copy.target.selector.value = 'three' }, /\/target\/selector\/value must match pattern/)
  for (const objectId of ['./content/notes/wheel-checks.md', 'content//notes/wheel-checks.md', '/content/notes/wheel-checks.md', 'content/../content/notes/wheel-checks.md', '.git/config']) {
    refused((copy) => { copy.target.objectId = objectId }, /\/target\/objectId must match pattern/)
  }
  refused((copy) => { copy.summary = '   ' }, /\/summary must match pattern/)
  refused((copy) => { copy.markedBy = ' ' }, /\/markedBy must match pattern/)
})

// A project copy of the fixture under Git, as a consumer would hold it.

const ZERO = '0'.repeat(40)

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
  for (const name of [WHEEL, DRAWING, PADS]) editMark(dir, name, (text) => text.replace(`revision: "${ZERO}"`, `revision: "${head}"`))
  git(dir, ['commit', '-qam', 'pin mark revisions'])
  return head
}

function pinnedProject() {
  const dir = projectFromFixture()
  const head = pinRevisions(dir)
  return { dir, head }
}

function commitAll(dir, message) {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', message])
}

function checkProject(dir, options) {
  return checkGraphmarks(commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false }), options)
}

// The bytes Git holds for a path at a revision: what the check verifies, which
// on a host that converts line endings is not what the working file holds.
function committedBytes(dir, objectId, revision = 'HEAD') {
  const result = spawnSync('git', ['cat-file', 'blob', `${revision}:${objectId}`], { cwd: dir, maxBuffer: 256 * 1024 * 1024 })
  assert.equal(result.status, 0, String(result.stderr))
  return result.stdout
}

// Point a mark at a committed file: its path from the repository root, the
// digest of its committed bytes and the commit at HEAD.
function retarget(dir, name, objectId, extra = (text) => text) {
  const head = git(dir, ['rev-parse', 'HEAD'])
  editMark(dir, name, (text) => extra(text
    .replace(/objectId: ".*"/, `objectId: "${objectId}"`)
    .replace(/revision: ".*"/, `revision: "${head}"`)
    .replace(/contentDigest: ".*"/, `contentDigest: "${digest(committedBytes(dir, objectId))}"`)))
}

// Add a file to the index and commit it through Git's own objects, so the
// tree holds exactly these names whatever the host filesystem would merge.
function commitObjects(dir, entries, message, gitConfig = []) {
  const lines = []
  for (const { path: name, content = '', mode = '100644' } of entries) {
    const hashed = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: content })
    assert.equal(hashed.status, 0, String(hashed.stderr))
    lines.push(Buffer.concat([Buffer.from(`${mode} ${String(hashed.stdout).trim()}\t`), Buffer.isBuffer(name) ? name : Buffer.from(name), Buffer.from([0])]))
  }
  const updated = spawnSync('git', [...gitConfig, 'update-index', '-z', '--add', '--index-info'], { cwd: dir, input: Buffer.concat(lines) })
  assert.equal(updated.status, 0, String(updated.stderr))
  git(dir, [...gitConfig, 'commit', '-qm', message])
}

// Commit one file at `objectPath` on top of HEAD through Git's tree objects
// alone (mktree, commit-tree), leaving the index as it was.
function commitTreeEntry(dir, objectPath, content, message) {
  const run = (args, input) => {
    const result = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', ...args], { cwd: dir, input })
    assert.equal(result.status, 0, String(result.stderr))
    return String(result.stdout).trim()
  }
  const blob = run(['hash-object', '-w', '--stdin'], content)
  const segments = objectPath.split('/')
  const rebuild = (tree, depth) => {
    const entries = tree ? run(['ls-tree', '-z', tree]).split('\0').filter(Boolean) : []
    const name = segments[depth]
    const named = (line) => line.slice(line.indexOf('\t') + 1) === name
    const existing = entries.find(named)
    const entry = depth === segments.length - 1
      ? `100644 blob ${blob}\t${name}`
      : `040000 tree ${rebuild(existing ? existing.split('\t')[0].split(' ')[2] : null, depth + 1)}\t${name}`
    return run(['mktree', '-z'], `${[...entries.filter((line) => !named(line)), entry].join('\0')}\0`)
  }
  const commit = run(['commit-tree', rebuild('HEAD^{tree}', 0), '-p', 'HEAD', '-m', message])
  run(['update-ref', 'HEAD', commit])
}

const markOf = (report, suffix) => report.marks.find((mark) => mark.id.endsWith(suffix))
const has = (list, ...parts) => list.some((line) => parts.every((part) => line.includes(part)))

test('the unpinned fixture is refused with a repair hint, and verifies once each revision names its commit', () => {
  const dir = projectFromFixture()
  const head = git(dir, ['rev-parse', 'HEAD'])
  const first = checkProject(dir)
  assert.equal(first.ok, false)
  assert.deepEqual(first.marks.map((mark) => mark.edition), ['refused', 'refused', 'refused'], 'a HEAD fallback is never an intact mark')
  assert.equal(first.errors.filter((error) => error.includes(`the marked edition is not verified: revision ${ZERO} is not a commit id in this repository`)).length, 3, first.errors.join('\n'))
  assert.equal(first.warnings.filter((warning) => warning.includes(`repair hint: HEAD (${head}) holds the marked bytes`)).length, 3, first.warnings.join('\n'))

  pinRevisions(dir)
  const pinned = checkProject(dir)
  assert.equal(pinned.ok, true, pinned.errors.join('\n'))
  assert.deepEqual(pinned.warnings, [])
  assert.deepEqual(pinned.marks.map((mark) => [mark.id, mark.edition, mark.selector, mark.revision]), [
    ['repair-workshop:mark:2026-01-12-order-of-wheel-checks', 'intact', 'lines', head],
    ['repair-workshop:mark:2026-01-12-spoke-tension-drawing', 'intact', 'whole', head],
    ['repair-workshop:mark:2026-01-14-pads-before-cable', 'intact', 'text-quote', head],
  ])
})

test('a full commit id that names no commit is not intact, even when HEAD holds the same bytes', () => {
  const { dir, head } = pinnedProject()
  editMark(dir, PADS, (text) => text.replace(`revision: "${head}"`, `revision: "${'f'.repeat(40)}"`).replace('markState: "recorded"', 'markState: "shared"'))
  commitAll(dir, 'a revision that does not exist')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.equal(markOf(report, 'pads-before-cable').edition, 'refused')
  assert.ok(has(report.errors, PADS, `revision ${'f'.repeat(40)} is not a commit id in this repository`), report.errors.join('\n'))
  assert.ok(has(report.warnings, PADS, 'repair hint: HEAD'), report.warnings.join('\n'))
})

test('a revision given as a branch name or an abbreviation is refused, with the full id as a repair hint', () => {
  const { dir, head } = pinnedProject()
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  editMark(dir, DRAWING, (text) => text.replace(`revision: "${head}"`, `revision: "${branch}"`))
  editMark(dir, WHEEL, (text) => text.replace(`revision: "${head}"`, `revision: "${head.slice(0, 7)}"`))
  commitAll(dir, 'names and abbreviations')
  const now = git(dir, ['rev-parse', 'HEAD'])
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.deepEqual(report.marks.filter((mark) => mark.edition !== 'refused').map((mark) => mark.id), ['repair-workshop:mark:2026-01-14-pads-before-cable'])
  assert.ok(has(report.errors, DRAWING, `target revision "${branch}" is not a full commit id`), report.errors.join('\n'))
  assert.ok(has(report.errors, WHEEL, `target revision "${head.slice(0, 7)}" is not a full commit id`), report.errors.join('\n'))
  assert.ok(has(report.warnings, DRAWING, `"${branch}" resolves to ${now}`), report.warnings.join('\n'))
  assert.ok(has(report.warnings, WHEEL, `"${head.slice(0, 7)}" resolves to ${head}`), report.warnings.join('\n'))
})

test('a path from the repository entry folder is refused, with the root path as a repair hint', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('objectId: "content/notes/wheel-checks.md"', 'objectId: "notes/wheel-checks.md"'))
  commitAll(dir, 'a folder-relative path')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.equal(markOf(report, 'order-of-wheel-checks').edition, 'refused')
  assert.ok(has(report.errors, WHEEL, 'does not hold notes/wheel-checks.md'), report.errors.join('\n'))
  assert.ok(has(report.warnings, WHEEL, 'objectId is the path from the Git repository root, so record "content/notes/wheel-checks.md"'), report.warnings.join('\n'))
})

test('a committed change to the marked file is a changed edition, recoverable at its revision', () => {
  const { dir, head } = pinnedProject()
  fs.appendFileSync(path.join(dir, 'content', 'notes', 'wheel-checks.md'), '\nA later line.\n')
  const capture = path.join(dir, 'content', 'captures', '2026-01-14-brake-check-advice.md')
  fs.writeFileSync(capture, fs.readFileSync(capture, 'utf8').replace('The mechanic checks pad wear before cable tension', 'The mechanic now checks cable first'))
  commitAll(dir, 'later edits')

  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  const wheel = markOf(report, 'order-of-wheel-checks')
  assert.equal(wheel.edition, 'changed')
  assert.deepEqual(wheel.recover, ['git', '-C', dir, '--no-replace-objects', 'cat-file', 'blob', `${head}:content/notes/wheel-checks.md`])
  assert.ok(has(report.warnings, `--no-replace-objects cat-file blob '${head}:content/notes/wheel-checks.md'`), report.warnings.join('\n'))
  assert.ok(has(report.warnings, 'the marked quote is no longer in the current file'), report.warnings.join('\n'))
})

test('an edition that exists only in the working tree is refused until it is committed', () => {
  const { dir } = pinnedProject()
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.appendFileSync(note, '\nAn uncommitted line.\n')
  editMark(dir, WHEEL, (text) => text.replace(/contentDigest: ".*"/, `contentDigest: "${digest(fs.readFileSync(note))}"`))
  git(dir, ['commit', '-qm', 'claim the uncommitted bytes', '--', markPath(dir, WHEEL)])
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, WHEEL, 'the marked edition is not verified', 'holds different bytes'), report.errors.join('\n'))
  assert.ok(has(report.warnings, WHEEL, 'exists only in the working tree'), report.warnings.join('\n'))
})

test('an edition no commit holds is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, DRAWING, (text) => text.replace(/contentDigest: ".*"/, `contentDigest: "sha256:${'0'.repeat(64)}"`))
  commitAll(dir, 'a digest nothing holds')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, DRAWING, 'the marked edition is not verified', 'holds different bytes'), report.errors.join('\n'))
})

test('a selector that names nothing inside the edition is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('value: "16-21"', 'value: "16-99"'))
  editMark(dir, PADS, (text) => text.replace(/value: "The mechanic.*"/, 'value: "Words the mechanic never said."'))
  commitAll(dir, 'selectors outside the edition')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'selector lines 16-99 fall outside the marked edition (23 lines)'), report.errors.join('\n'))
  assert.ok(has(report.errors, 'selector text-quote is not in the marked edition'), report.errors.join('\n'))
})

test('an ambiguous quote is an error, and overlapping occurrences count', () => {
  const { dir } = pinnedProject()
  editMark(dir, PADS, (text) => text.replace(/value: "The mechanic.*"/, 'value: "the "'))
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'echo.txt'), 'la la la\n')
  commitAll(dir, 'an ambiguous quote and an echo')
  retarget(dir, DRAWING, 'content/notes/echo.txt', (text) => text.replace('type: "whole"', 'type: "text-quote"').replace('value: "*"', 'value: "la la"'))
  commitAll(dir, 'an overlapping quote')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.equal(markOf(report, 'pads-before-cable').edition, 'refused')
  assert.ok(has(report.errors, PADS, 'selector text-quote occurs', 'a mark names one part'), report.errors.join('\n'))
  assert.ok(has(report.errors, DRAWING, 'selector text-quote occurs 2 times'), report.errors.join('\n'))
})

test('text selectors need UTF-8 text, an empty file has no lines, and a binary file can be marked whole', () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'photo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0xff]))
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'empty.txt'), '')
  commitAll(dir, 'binary, invalid UTF-8 and empty files')
  retarget(dir, DRAWING, 'content/notes/photo.bin', (text) => text.replace('type: "whole"', 'type: "lines"').replace('value: "*"', 'value: "1"'))
  retarget(dir, PADS, 'content/notes/latin1.txt', (text) => text.replace(/value: "The mechanic.*"/, 'value: "caf"'))
  retarget(dir, WHEEL, 'content/notes/empty.txt', (text) => text.replace('value: "16-21"', 'value: "1"'))
  commitAll(dir, 'text selectors on what is not text')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, DRAWING, 'selector lines needs a UTF-8 text edition'), report.errors.join('\n'))
  assert.ok(has(report.errors, PADS, 'selector text-quote needs a UTF-8 text edition'), report.errors.join('\n'))
  assert.ok(has(report.errors, WHEEL, 'selector lines 1 fall outside the marked edition (0 lines)'), report.errors.join('\n'))

  retarget(dir, DRAWING, 'content/notes/photo.bin', (text) => text.replace('type: "lines"', 'type: "whole"').replace('value: "1"', 'value: "*"'))
  commitAll(dir, 'the binary file, whole')
  const whole = checkProject(dir)
  assert.equal(markOf(whole, 'spoke-tension-drawing')?.edition, 'intact', whole.errors.join('\n'))
})

test('a mark more widely visible than what it marks is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'widen')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'audience "public" is wider than "team"'), report.errors.join('\n'))
})

test('the audience the marked edition declared is held, even after the file is rewritten wider', () => {
  const { dir } = pinnedProject()
  const rewrite = path.join(dir, 'content', 'notes', 'rewrite.md')
  const note = (audience, body) => `---\ntitle: "Rewrite"\nkg:\n  id: "repair-workshop:notes:rewrite"\n  type: "document"\n  status: "active"\n  audience: "${audience}"\n---\n# Rewrite\n\n${body}\n`
  fs.writeFileSync(rewrite, note('private', 'A private sentence about one volunteer.'))
  const sidecar = path.join(dir, 'content', 'drawings', 'spoke-tension.html.kg.json')
  fs.writeFileSync(sidecar, fs.readFileSync(sidecar, 'utf8').replace('"audience": "team"', '"audience": "private"'))
  commitAll(dir, 'private editions')
  retarget(dir, PADS, 'content/notes/rewrite.md', (text) => text
    .replace(/value: "The mechanic.*"/, 'value: "A private sentence about one volunteer."')
    .replace('"repair-workshop:captures:2026-01-14-brake-check-advice"', '"repair-workshop:notes:rewrite"'))
  retarget(dir, DRAWING, 'content/drawings/spoke-tension.html')
  commitAll(dir, 'team marks of private editions')
  // The owner widens both to team and drops the private sentence.
  fs.writeFileSync(rewrite, note('team', 'A sentence anyone in the workshop may read.'))
  fs.writeFileSync(sidecar, fs.readFileSync(sidecar, 'utf8').replace('"audience": "private"', '"audience": "team"'))
  commitAll(dir, 'rewritten wider')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, PADS, 'wider than "private" of content/notes/rewrite.md (the audience its marked edition declares)'), report.errors.join('\n'))
  assert.ok(has(report.errors, DRAWING, 'wider than "private" of content/drawings/spoke-tension.html (the audience its marked edition declares)'), report.errors.join('\n'))
})

test('an unknown audience in the marked edition is an error, not a pass', () => {
  const { dir } = pinnedProject()
  const sidecar = path.join(dir, 'content', 'drawings', 'spoke-tension.html.kg.json')
  const original = fs.readFileSync(sidecar, 'utf8')
  fs.writeFileSync(sidecar, original.replace('"audience": "team"', '"audience": "secret"'))
  git(dir, ['add', '-A'])
  // The graph would refuse the unknown value at HEAD; commit it, then restore.
  git(dir, ['commit', '-qm', 'an unknown audience'])
  retarget(dir, DRAWING, 'content/drawings/spoke-tension.html')
  fs.writeFileSync(sidecar, original)
  commitAll(dir, 'restore a known audience')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, DRAWING, 'has the unknown audience "secret"'), report.errors.join('\n'))
})

test('the committed mark record is what is checked; an uncommitted edit is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('Marked for the order of the checks', 'Marked for a reason nobody committed'))
  const edited = checkProject(dir)
  assert.equal(edited.ok, false)
  assert.equal(markOf(edited, 'order-of-wheel-checks').edition, 'refused')
  assert.ok(has(edited.errors, WHEEL, 'differs from the one committed at HEAD'), edited.errors.join('\n'))

  git(dir, ['add', '-A'])
  const staged = checkProject(dir)
  assert.ok(has(staged.errors, WHEEL, 'differs from the one committed at HEAD'), 'staging is not committing')

  git(dir, ['commit', '-qm', 'commit the reason'])
  assert.equal(checkProject(dir).ok, true)
})

test('an untracked or only staged mark record is refused', () => {
  const { dir } = pinnedProject()
  fs.copyFileSync(markPath(dir, DRAWING), markPath(dir, '2026-01-16-untracked.md'))
  editMark(dir, '2026-01-16-untracked.md', (text) => text.replace('repair-workshop:mark:2026-01-12-spoke-tension-drawing', 'repair-workshop:mark:2026-01-16-untracked').replace('    supports:\n      - "repair-workshop:mark:2026-01-12-order-of-wheel-checks"\n', ''))
  const untracked = checkProject(dir)
  assert.equal(untracked.ok, false)
  assert.ok(has(untracked.errors, '2026-01-16-untracked.md: pending mark: an uncommitted change (untracked) in a folder that holds marks'), untracked.errors.join('\n'))
  git(dir, ['add', '-A'])
  const staged = checkProject(dir)
  assert.ok(has(staged.errors, '2026-01-16-untracked.md: pending mark: the record is in the index'), staged.errors.join('\n'))
})

test('a blank reason in the summary or the body is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace(/summary: ".*"/, 'summary: "   "'))
  editMark(dir, DRAWING, (text) => `${text.slice(0, text.indexOf('# Mark: the spoke tension drawing'))}# Mark: the spoke tension drawing\n\n`)
  commitAll(dir, 'blank reasons')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, WHEEL, '/summary must match pattern'), report.errors.join('\n'))
  assert.ok(has(report.errors, DRAWING, 'the record body is blank'), report.errors.join('\n'))
})

test('--expect fails a check whose expected mark is missing, and a record that lost its tag is named', () => {
  const { dir } = pinnedProject()
  const expected = ['repair-workshop:mark:2026-01-12-order-of-wheel-checks', 'repair-workshop:mark:2026-01-14-pads-before-cable']
  assert.equal(checkProject(dir, { expect: expected }).ok, true)
  editMark(dir, PADS, (text) => text.replace('tags: [graphmark]', 'tags: [brakes]'))
  commitAll(dir, 'drop the tag')
  const report = checkProject(dir, { expect: [...expected, 'repair-workshop:mark:never-written'] })
  assert.equal(report.ok, false)
  assert.equal(markOf(report, 'pads-before-cable'), undefined, 'an untagged record is not a mark; its index entry is the error')
  assert.ok(has(report.errors, `${PADS}: belongs to the marks index repair-workshop:marks but is not tagged graphmark`), report.errors.join('\n'))
  assert.ok(has(report.errors, 'expected mark repair-workshop:mark:2026-01-14-pads-before-cable is not a GraphMark record'), report.errors.join('\n'))
  assert.ok(has(report.errors, 'expected mark repair-workshop:mark:never-written was not found'), report.errors.join('\n'))
  assert.ok(has(checkProject(dir, { expect: ['repair-workshop:marks'] }).errors, 'expected mark repair-workshop:marks is a marks index, not a mark record'))

  const cli = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--expect', 'repair-workshop:mark:never-written', '--expect=repair-workshop:mark:2026-01-12-order-of-wheel-checks'], { cwd: dir, encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stderr, /expected mark repair-workshop:mark:never-written was not found/)
  const empty = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--expect'], { cwd: dir, encoding: 'utf8' })
  assert.equal(empty.status, 2)
})

test('a parent index of the marks index is not itself a marks index', () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(path.join(dir, 'content', 'index.md'), '---\ntitle: "Workshop"\nkg:\n  id: "repair-workshop:index"\n  type: "index"\n  status: "active"\n  audience: "team"\n---\n# Workshop\n\nEverything the workshop keeps.\n')
  const notes = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.writeFileSync(notes, fs.readFileSync(notes, 'utf8').replace('  audience: "team"\n', '  audience: "team"\n  relations:\n    belongs_to:\n      - "repair-workshop:index"\n'))
  const index = path.join(dir, 'content', 'marks', 'README.md')
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('  audience: "team"\n', '  audience: "team"\n  relations:\n    belongs_to:\n      - "repair-workshop:index"\n'))
  commitAll(dir, 'a parent index')
  retarget(dir, WHEEL, 'content/notes/wheel-checks.md')
  commitAll(dir, 'repin the note')
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
})

test('a mark whose target another repository owns is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('owner: "content"', 'owner: "elsewhere"'))
  commitAll(dir, 'foreign owner')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'target owner "elsewhere" is not this repository "content"'), report.errors.join('\n'))
})

test('a record tagged graphmark that breaks the contract is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, DRAWING, (text) => text.replace(/contentDigest: ".*"/, 'contentDigest: "unrecorded"'))
  commitAll(dir, 'break the contract')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'atelier-graphmark@v1 /target/contentDigest'), report.errors.join('\n'))
})

test('a file outside the knowledge folder is marked by its path from the repository root', () => {
  const { dir } = pinnedProject()
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tools', 'checklist.txt'), 'wheel, brakes, chain\n')
  commitAll(dir, 'a file outside the knowledge folder')
  retarget(dir, WHEEL, 'tools/checklist.txt', (text) => text.replace('value: "16-21"', 'value: "1"'))
  commitAll(dir, 'mark a file outside the folder')
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(markOf(report, 'order-of-wheel-checks').edition, 'intact')
  // Not a graph node, so it is held to the repository's read boundary (team), which the team mark meets.
  assert.deepEqual(report.warnings.filter((warning) => warning.includes('order-of-wheel-checks')), [])
})

test('atelier graphmark check reports through the CLI, writes nothing and exits non-zero on a refusal', () => {
  const { dir } = pinnedProject()
  const ok = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /graphmark: 3 marks · 3 intact · 0 changed · 0 removed · 0 refused · 0 errors/)
  assert.equal(fs.existsSync(path.join(dir, '.atelier-local')), false, 'the check creates no local state')
  assert.equal(git(dir, ['status', '--porcelain']), '')
  const json = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--json'], { cwd: dir, encoding: 'utf8' })
  assert.equal(JSON.parse(json.stdout).ok, true)
  editMark(dir, WHEEL, (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'widen')
  const refused = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /never more widely visible than what it marks/)
})

test('--project accepts the project directory as well as its atelier.project.json', () => {
  const { dir } = pinnedProject()
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-cwd-'))
  for (const args of [['graphmark', 'check', '--project', dir], ['graphmark', 'check', `--project=${dir}`], ['graph', '--project', dir], ['graph', '--check', '--project', dir]]) {
    const run = spawnSync(process.execPath, [binary, ...args], { cwd: elsewhere, encoding: 'utf8' })
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`)
  }
  const missing = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--project', elsewhere], { cwd: elsewhere, encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /atelier\.project\.json: the project config is not in a Git repository/)
})


// Refusals from the earlier independent reviews of this standard.

function addRepository(dir, name, readBoundary, files) {
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'atelier.project.json'), 'utf8'))
  config.repos.push({ name, path: name, readBoundary })
  fs.writeFileSync(path.join(dir, 'atelier.project.json'), `${JSON.stringify(config, null, 2)}\n`)
  const access = JSON.parse(fs.readFileSync(path.join(dir, 'repo-access.v1.json'), 'utf8'))
  access.repos[name] = { readBoundary }
  fs.writeFileSync(path.join(dir, 'repo-access.v1.json'), `${JSON.stringify(access, null, 2)}\n`)
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, name, file), text)
  }
}

test('a mark whose target lies in another configured repository is refused', () => {
  const { dir } = pinnedProject()
  addRepository(dir, 'vault', 'private', {
    'diary.md': '---\ntitle: "Diary"\nkg:\n  id: "vault:diary"\n  type: "document"\n  audience: "private"\n---\n# Diary\n\nA private sentence.\n',
  })
  commitAll(dir, 'a private sibling')
  retarget(dir, PADS, 'vault/diary.md', (text) => text.replace(/value: "The mechanic.*"/, 'value: "A private sentence."'))
  commitAll(dir, 'mark the sibling')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'lies in repository "vault", not in "content"'), report.errors.join('\n'))
})

test('a revision in the stash or no longer reachable does not hold an edition', () => {
  const { dir, head } = pinnedProject()
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.appendFileSync(note, '\nA stashed line.\n')
  const stashedDigest = digest(fs.readFileSync(note))
  git(dir, ['stash'])
  const stash = git(dir, ['rev-parse', 'stash'])
  editMark(dir, WHEEL, (text) => text.replace(`revision: "${head}"`, `revision: "${stash}"`).replace(/contentDigest: ".*"/, `contentDigest: "${stashedDigest}"`))
  editMark(dir, DRAWING, (text) => text.replace(`revision: "${head}"`, 'revision: "stash"'))
  commitAll(dir, 'mark a stashed edition')
  const stashed = checkProject(dir)
  assert.equal(stashed.ok, false)
  assert.ok(has(stashed.errors, WHEEL, `revision ${stash} is not reachable from HEAD or any branch or tag`), stashed.errors.join('\n'))
  assert.ok(has(stashed.errors, DRAWING, 'target revision "stash" is not a full commit id'), stashed.errors.join('\n'))

  const dir2 = projectFromFixture()
  const head2 = pinRevisions(dir2)
  fs.appendFileSync(path.join(dir2, 'content', 'notes', 'wheel-checks.md'), '\nA line later reset away.\n')
  commitAll(dir2, 'soon unreachable')
  const lost = git(dir2, ['rev-parse', 'HEAD'])
  const lostDigest = digest(fs.readFileSync(path.join(dir2, 'content', 'notes', 'wheel-checks.md')))
  git(dir2, ['reset', '-q', '--hard', 'HEAD~1'])
  editMark(dir2, WHEEL, (text) => text.replace(`revision: "${head2}"`, `revision: "${lost}"`).replace(/contentDigest: ".*"/, `contentDigest: "${lostDigest}"`))
  commitAll(dir2, 'mark an unreachable edition')
  const unreachable = checkProject(dir2)
  assert.equal(unreachable.ok, false)
  assert.ok(has(unreachable.errors, 'is not reachable from HEAD or any branch or tag'), unreachable.errors.join('\n'))
})

test('a removed file is reported removed, with its recovery command', () => {
  const { dir, head } = pinnedProject()
  git(dir, ['rm', '-q', 'content/captures/2026-01-14-brake-check-advice.md'])
  editMark(dir, PADS, (text) => text.replace('"repair-workshop:captures:2026-01-14-brake-check-advice"', '"repair-workshop:notes:wheel-checks"'))
  commitAll(dir, 'remove the capture')
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(markOf(report, 'pads-before-cable').edition, 'removed')
  assert.ok(has(report.warnings, `--no-replace-objects cat-file blob '${head}:content/captures/2026-01-14-brake-check-advice.md'`), report.warnings.join('\n'))
})

test('a selector type, version or whole value the standard does not define is refused', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('type: "lines"', 'type: "line"'))
  editMark(dir, PADS, (text) => text.replace(/version: "1"/, 'version: "2"'))
  editMark(dir, DRAWING, (text) => text.replace('value: "*"', 'value: "lines 3-5"'))
  commitAll(dir, 'undefined selectors')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'selector type "line" is not one of whole, lines, text-quote'), report.errors.join('\n'))
  assert.ok(has(report.errors, 'selector text-quote version "2" is not 1'), report.errors.join('\n'))
  assert.ok(has(report.errors, 'selector whole must have the value "*"'), report.errors.join('\n'))
})

test('a marked file that is not a graph node is held to the repository read boundary', () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'parts.txt'), 'spokes, nipples, rim tape\n')
  commitAll(dir, 'a plain file')
  retarget(dir, DRAWING, 'content/notes/parts.txt', (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'a public mark of a team file')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'wider than "team" of content/notes/parts.txt (the repository\'s read boundary)'), report.errors.join('\n'))
})

test('a symbolic link, a path into .git and a path out of the repository are refused', () => {
  const { dir } = pinnedProject()
  fs.symlinkSync('wheel-checks.md', path.join(dir, 'content', 'notes', 'link.md'))
  commitAll(dir, 'a link')
  const head = git(dir, ['rev-parse', 'HEAD'])
  editMark(dir, WHEEL, (text) => text.replace('objectId: "content/notes/wheel-checks.md"', 'objectId: "content/notes/link.md"').replace(/revision: ".*"/, `revision: "${head}"`))
  editMark(dir, DRAWING, (text) => text.replace('objectId: "content/drawings/spoke-tension.html"', 'objectId: ".git/config"'))
  editMark(dir, PADS, (text) => text.replace(/objectId: ".*"/, 'objectId: "../outside.md"'))
  commitAll(dir, 'escaping targets')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'content/notes/link.md', 'symbolic link'), report.errors.join('\n'))
  assert.ok(has(report.errors, 'points into .git'), report.errors.join('\n'))
  assert.ok(has(report.errors, 'leaves the repository'), report.errors.join('\n'))
})

test('belongs_to must name a marks index', () => {
  const { dir } = pinnedProject()
  editMark(dir, DRAWING, (text) => text.replace('      - "repair-workshop:marks"', '      - "repair-workshop:notes:wheel-checks"'))
  commitAll(dir, 'not an index')
  const report = checkProject(dir)
  assert.ok(has(report.errors, 'belongs_to repair-workshop:notes:wheel-checks is not a marks index'), report.errors.join('\n'))
})

test('a record tagged graphmark without front matter fields is refused, and unknown options exit 2', () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(markPath(dir, '2026-01-15-bare.md'), '---\ntitle: "Bare"\ntags: [graphmark]\nkg:\n  id: "repair-workshop:mark:2026-01-15-bare"\n  type: "evidence"\n  audience: "team"\n  relations:\n    belongs_to:\n      - "repair-workshop:marks"\n---\n# Bare\n')
  commitAll(dir, 'a bare mark')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, '2026-01-15-bare.md: atelier-graphmark@v1'), report.errors.join('\n'))
  const unknown = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--jsn'], { cwd: dir, encoding: 'utf8' })
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown option: --jsn/)
})

test('a marked file outside the graph keeps its own narrower audience', () => {
  const { dir } = pinnedProject()
  fs.mkdirSync(path.join(dir, 'content', 'uploads'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'content', 'uploads', 'call.md'), '# A call\n\nA private sentence.\n')
  fs.mkdirSync(path.join(dir, 'content', 'drafts'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'content', 'drafts', 'diary.md'), '---\ntitle: "Diary"\nkg:\n  id: "repair-workshop:drafts:diary"\n  type: "document"\n  audience: "private"\n---\n# Diary\n\nA private sentence.\n')
  const config = JSON.parse(fs.readFileSync(path.join(dir, 'atelier.project.json'), 'utf8'))
  config.setup = { ...(config.setup ?? {}), exclude: 'content/drafts' }
  fs.writeFileSync(path.join(dir, 'atelier.project.json'), `${JSON.stringify(config, null, 2)}\n`)
  commitAll(dir, 'material outside the graph')
  const quote = (text) => text.replace(/value: "The mechanic.*"/, 'value: "A private sentence."').replace('"repair-workshop:captures:2026-01-14-brake-check-advice"', '"repair-workshop:notes:wheel-checks"')
  retarget(dir, PADS, 'content/uploads/call.md', quote)
  commitAll(dir, 'mark an undeclared upload')
  const upload = checkProject(dir)
  assert.equal(upload.ok, false)
  assert.ok(has(upload.errors, 'wider than "private" of content/uploads/call.md (the audience its marked edition declares)'), upload.errors.join('\n'))

  retarget(dir, PADS, 'content/drafts/diary.md')
  commitAll(dir, 'mark an excluded private draft')
  const draft = checkProject(dir)
  assert.equal(draft.ok, false)
  assert.ok(has(draft.errors, 'wider than "private" of content/drafts/diary.md (the audience its marked edition declares)'), draft.errors.join('\n'))
})

test('an index tagged graphmark that carries a target is checked, not skipped', () => {
  const { dir } = pinnedProject()
  editMark(dir, DRAWING, (text) => text.replace('  type: "evidence"', '  type: "index"'))
  commitAll(dir, 'a mark disguised as an index')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, `${DRAWING}: atelier-graphmark@v1 /kg/type`), report.errors.join('\n'))
})

test('evidences must name the marked node', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('      - "repair-workshop:notes:wheel-checks"', '      - "repair-workshop:drawings:spoke-tension"'))
  commitAll(dir, 'evidence of something else')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'evidences must name the marked node repair-workshop:notes:wheel-checks'), report.errors.join('\n'))
})

test('a local replace ref cannot make a commit appear to hold an edition', () => {
  const { dir, head } = pinnedProject()
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.appendFileSync(note, '\nA line only a replacement holds.\n')
  const forged = digest(fs.readFileSync(note))
  commitAll(dir, 'the replacement')
  const replacement = git(dir, ['rev-parse', 'HEAD'])
  git(dir, ['reset', '-q', '--hard', head])
  git(dir, ['replace', head, replacement])
  git(dir, ['checkout', '-q', '--', '.'])
  editMark(dir, WHEEL, (text) => text.replace(/contentDigest: ".*"/, `contentDigest: "${forged}"`))
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'claim the replaced bytes'])
  const report = checkProject(dir)
  assert.ok(has(report.errors, 'order-of-wheel-checks', 'not verified'), report.errors.join('\n') || JSON.stringify(report.marks))
})

// Findings from the confirmation review of eb68b24.

test('the recovery command reads Git as the check does, so a replace ref cannot change what it returns', () => {
  const { dir, head } = pinnedProject()
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.appendFileSync(note, '\nA later line.\n')
  commitAll(dir, 'a later edition')
  const later = git(dir, ['rev-parse', 'HEAD'])
  git(dir, ['replace', head, later])
  const marked = readMarkRecord(fs.readFileSync(markPath(dir, WHEEL), 'utf8')).target.contentDigest
  const report = checkProject(dir)
  const wheel = markOf(report, 'order-of-wheel-checks')
  assert.equal(wheel.edition, 'changed', report.errors.join('\n'))
  assert.ok(has(report.warnings, WHEEL, '--no-replace-objects cat-file blob'), report.warnings.join('\n'))
  const recovered = () => spawnSync(wheel.recover[0], wheel.recover.slice(1), { cwd: os.tmpdir() }).stdout
  const plain = spawnSync('git', ['cat-file', 'blob', `${head}:content/notes/wheel-checks.md`], { cwd: dir }).stdout
  assert.notEqual(digest(plain), marked, 'the fixture exercises a commit-level replace ref')
  assert.equal(digest(recovered()), marked)

  // A blob-level replace ref, too.
  git(dir, ['replace', '-d', head])
  const blob = git(dir, ['rev-parse', `${head}:content/notes/wheel-checks.md`])
  const forged = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'forged\n', encoding: 'utf8' }).stdout.trim()
  git(dir, ['replace', blob, forged])
  assert.equal(spawnSync('git', ['cat-file', 'blob', `${head}:content/notes/wheel-checks.md`], { cwd: dir, encoding: 'utf8' }).stdout, 'forged\n')
  assert.equal(digest(recovered()), marked)
})

test('an uncommitted edit to the marked node cannot turn a refused mark green', () => {
  const { dir } = pinnedProject()
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  const team = fs.readFileSync(note, 'utf8')
  fs.writeFileSync(note, team.replace('  audience: "team"', '  audience: "private"'))
  commitAll(dir, 'the owner narrows the note')
  const narrowed = checkProject(dir)
  assert.equal(narrowed.ok, false)
  assert.ok(has(narrowed.errors, WHEEL, 'wider than "private" of repair-workshop:notes:wheel-checks'), narrowed.errors.join('\n'))
  fs.writeFileSync(note, team)
  const widened = checkProject(dir)
  assert.equal(widened.ok, false)
  // The committed note is still private; the working-tree edit only warns.
  assert.ok(has(widened.errors, WHEEL, 'wider than "private" of repair-workshop:notes:wheel-checks'), widened.errors.join('\n'))
  assert.ok(has(widened.warnings, WHEEL, 'the marked file content/notes/wheel-checks.md has uncommitted changes (modified)'), widened.warnings.join('\n'))
  assert.equal(markOf(widened, 'order-of-wheel-checks').edition, 'refused')
})

test('an untracked sidecar cannot supply the node a mark evidences', () => {
  const { dir } = pinnedProject()
  const plan = path.join(dir, 'content', 'drawings', 'plan.html')
  fs.writeFileSync(plan, '<!doctype html>\n<title>Plan</title>\n<p>A plan.</p>\n')
  git(dir, ['add', '--', plan])
  git(dir, ['commit', '-qm', 'a drawing without a committed sidecar'])
  fs.writeFileSync(`${plan}.kg.json`, `${JSON.stringify({ schema: 'mnstry.source-sidecar@v1', asset: 'plan.html', title: 'Plan', summary: 'A plan.', tags: ['repair'], kg: { id: 'repair-workshop:drawings:plan', type: 'artifact', domain: 'repair', lifecycle: 'active', status: 'active', audience: 'team', relations: {} } }, null, 2)}\n`)
  retarget(dir, DRAWING, 'content/drawings/plan.html', (text) => text.replace('"repair-workshop:drawings:spoke-tension"', '"repair-workshop:drawings:plan"'))
  git(dir, ['commit', '-qm', 'mark it', '--', markPath(dir, DRAWING)])
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  // The committed graph has no such node: the build fails, and the mark is refused.
  assert.ok(has(report.errors, DRAWING, 'declared evidences target "repair-workshop:drawings:plan" was not found'), report.errors.join('\n'))
  assert.equal(markOf(report, 'spoke-tension-drawing').edition, 'refused')
})

test('an untracked marks index cannot hold a mark', () => {
  const { dir } = pinnedProject()
  git(dir, ['rm', '-q', '--cached', 'content/marks/README.md'])
  git(dir, ['commit', '-qm', 'the index leaves Git but stays on disk'])
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'content/marks/README.md: pending mark: an uncommitted change (untracked) in a folder that holds marks'), report.errors.join('\n'))
  assert.equal(report.errors.filter((error) => error.includes('declared belongs_to target "repair-workshop:marks" was not found')).length, 3, report.errors.join('\n'))
  assert.deepEqual(report.marks.map((mark) => mark.edition), ['refused', 'refused', 'refused'])
})

test('graphmark check takes --project-config and --repo-path through the shared resolver', () => {
  const { dir } = pinnedProject()
  const config = path.join(dir, 'atelier.project.json')
  const run = (args, cwd = dir) => spawnSync(process.execPath, [binary, 'graphmark', 'check', ...args], { cwd, encoding: 'utf8' })
  assert.equal(run(['--project-config', config]).status, 0)
  assert.equal(run([`--project-config=${config}`]).status, 0)
  // A repository override is honoured: a clean copy replaces a broken one.
  const { dir: clean } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'widen')
  assert.equal(run(['--project', config]).status, 1)
  const overridden = run(['--project', config, '--repo-path', `content=${path.join(clean, 'content')}`])
  assert.equal(overridden.status, 0, overridden.stderr)
  const bad = run(['--repo-path', 'content'])
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /--repo-path requires NAME=PATH/)
})

test('a mark with any error is refused in the report, not counted intact', () => {
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'widen')
  const report = checkProject(dir)
  assert.equal(markOf(report, 'order-of-wheel-checks').edition, 'refused')
  // The marked node is also in evidences; its audience error is reported once.
  assert.equal(report.errors.filter((error) => error.includes('wider than "team" of repair-workshop:notes:wheel-checks')).length, 1, report.errors.join('\n'))
  const cli = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stdout, /graphmark: 3 marks · 2 intact · 0 changed · 0 removed · 1 refused · \d+ errors/)
})

// Findings from the re-check of 0c048cf: the check verifies the committed tree.

function sidecarFor(asset, id, audience = 'team') {
  return `${JSON.stringify({ schema: 'mnstry.source-sidecar@v1', asset, title: asset, summary: `The ${asset} file.`, tags: ['repair'], kg: { id, type: 'artifact', domain: 'repair', lifecycle: 'active', status: 'active', audience, relations: {} } }, null, 2)}\n`
}

test('a clean checkout with line-ending conversion or a checkout filter verifies', () => {
  const { dir } = pinnedProject()
  // A filter that prefixes each line on checkout and strips it on commit.
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'content/drawings/*.html filter=prefix\n')
  commitAll(dir, 'a checkout filter')
  const crlf = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-crlf-'))
  git(crlf, ['-c', 'core.autocrlf=true', 'clone', '-q', '-c', 'core.autocrlf=true', dir, '.'])
  assert.ok(fs.readFileSync(markPath(crlf, WHEEL), 'utf8').includes('\r\n'), 'the checkout converted line endings')
  assert.equal(git(crlf, ['status', '--porcelain']), '')
  const converted = checkProject(crlf)
  assert.equal(converted.ok, true, converted.errors.join('\n'))
  assert.deepEqual(converted.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
  assert.deepEqual(converted.warnings, [])

  const filtered = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-filter-'))
  git(filtered, ['clone', '-q', '-c', "filter.prefix.smudge=sed 's/^/~/'", '-c', "filter.prefix.clean=sed 's/^~//'", dir, '.'])
  assert.ok(fs.readFileSync(path.join(filtered, 'content', 'drawings', 'spoke-tension.html'), 'utf8').startsWith('~'), 'the checkout ran the filter')
  assert.equal(git(filtered, ['status', '--porcelain']), '')
  const report = checkProject(filtered)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.deepEqual(report.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
})

test('a sidecar that is a symbolic link is never trusted, committed or not', () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(path.join(dir, 'content', 'drawings', 'plan.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n')
  fs.writeFileSync(path.join(dir, 'elsewhere.json'), sidecarFor('plan.svg', 'repair-workshop:drawings:plan'))
  git(dir, ['add', '--', 'content/drawings/plan.svg', 'elsewhere.json'])
  git(dir, ['commit', '-qm', 'a drawing that only a link would enrol'])
  fs.symlinkSync('../../elsewhere.json', path.join(dir, 'content', 'drawings', 'plan.svg.kg.json'))
  retarget(dir, DRAWING, 'content/drawings/plan.svg', (text) => text.replace('"repair-workshop:drawings:spoke-tension"', '"repair-workshop:drawings:plan"'))
  git(dir, ['commit', '-qm', 'mark it', '--', markPath(dir, DRAWING)])
  const linked = checkProject(dir)
  assert.equal(linked.ok, false)
  assert.ok(has(linked.errors, DRAWING, 'declared evidences target "repair-workshop:drawings:plan" was not found'), linked.errors.join('\n'))
  assert.equal(markOf(linked, 'spoke-tension-drawing').edition, 'refused')

  commitAll(dir, 'commit the link too')
  const committed = checkProject(dir)
  assert.equal(committed.ok, false)
  assert.ok(has(committed.errors, DRAWING, 'declared evidences target "repair-workshop:drawings:plan" was not found'), committed.errors.join('\n'))
  assert.ok(has(committed.warnings, 'content/drawings/plan.svg.kg.json: is a symbolic link at HEAD'), committed.warnings.join('\n'))
})

test('uncommitted repository policy has no effect on the verdict', () => {
  const { dir } = pinnedProject()
  const setBoundary = (boundary) => {
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'atelier.project.json'), 'utf8'))
    config.repos[0].readBoundary = boundary
    fs.writeFileSync(path.join(dir, 'atelier.project.json'), `${JSON.stringify(config, null, 2)}\n`)
    const access = JSON.parse(fs.readFileSync(path.join(dir, 'repo-access.v1.json'), 'utf8'))
    access.repos.content.readBoundary = boundary
    fs.writeFileSync(path.join(dir, 'repo-access.v1.json'), `${JSON.stringify(access, null, 2)}\n`)
  }
  setBoundary('private')
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'parts.txt'), 'spokes, nipples, rim tape\n')
  commitAll(dir, 'a private repository and a plain file')
  retarget(dir, DRAWING, 'content/notes/parts.txt')
  commitAll(dir, 'a team mark of a file only private readers may see')
  const committed = checkProject(dir)
  assert.equal(committed.ok, false)
  assert.ok(has(committed.errors, DRAWING, 'wider than "private" of content/notes/parts.txt (the repository\'s read boundary)'), committed.errors.join('\n'))

  setBoundary('team')
  const widened = checkProject(dir)
  assert.equal(widened.ok, false)
  assert.ok(has(widened.errors, DRAWING, 'wider than "private" of content/notes/parts.txt (the repository\'s read boundary)'), widened.errors.join('\n'))
  assert.ok(has(widened.warnings, 'atelier.project.json: has uncommitted changes'), widened.warnings.join('\n'))
  assert.ok(has(widened.warnings, 'repo-access.v1.json: has uncommitted changes'), widened.warnings.join('\n'))
})

test('an audience name inherited from a JavaScript object is unknown', () => {
  const { dir } = pinnedProject()
  const sidecar = path.join(dir, 'content', 'drawings', 'spoke-tension.html.kg.json')
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  const [sidecarText, noteText] = [fs.readFileSync(sidecar, 'utf8'), fs.readFileSync(note, 'utf8')]
  fs.writeFileSync(sidecar, sidecarText.replace('"audience": "team"', '"audience": "constructor"'))
  fs.writeFileSync(note, noteText.replace('  audience: "team"', '  audience: "__proto__"'))
  commitAll(dir, 'inherited names')
  retarget(dir, DRAWING, 'content/drawings/spoke-tension.html')
  retarget(dir, WHEEL, 'content/notes/wheel-checks.md')
  fs.writeFileSync(sidecar, sidecarText)
  fs.writeFileSync(note, noteText)
  commitAll(dir, 'restore known audiences')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, DRAWING, 'has the unknown audience "constructor"'), report.errors.join('\n'))
  assert.ok(has(report.errors, WHEEL, 'has the unknown audience "__proto__"'), report.errors.join('\n'))
})

test('a current file too large to read is refused, not reported removed', () => {
  const { dir } = pinnedProject()
  const parts = path.join(dir, 'content', 'notes', 'parts.txt')
  fs.writeFileSync(parts, 'spokes, nipples, rim tape\n')
  commitAll(dir, 'a plain file')
  retarget(dir, DRAWING, 'content/notes/parts.txt')
  commitAll(dir, 'mark it')
  fs.writeFileSync(parts, Buffer.alloc(65 * 1024 * 1024, 0x61))
  commitAll(dir, 'it grows past what the check reads')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.equal(markOf(report, 'spoke-tension-drawing').edition, 'refused')
  assert.ok(has(report.errors, DRAWING, 'more than this check reads', 'cannot be checked'), report.errors.join('\n'))
  assert.equal(has(report.warnings, DRAWING, 'no longer held at HEAD'), false)
})

test('an edition a partial clone lacks is unavailable, and nothing is fetched', () => {
  const { dir, head } = pinnedProject()
  fs.appendFileSync(path.join(dir, 'content', 'notes', 'wheel-checks.md'), '\nA later line.\n')
  commitAll(dir, 'a later edition')
  git(dir, ['config', 'uploadpack.allowFilter', 'true'])
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-partial-'))
  git(partial, ['clone', '-q', '--filter=blob:none', `file://${dir}`, '.'])
  const missing = () => git(partial, ['rev-list', '--objects', '--missing=print', '--no-walk', head]).split('\n').filter((line) => line.startsWith('?')).sort()
  const edition = git(dir, ['rev-parse', `${head}:content/notes/wheel-checks.md`])
  const before = missing()
  assert.ok(before.includes(`?${edition}`), 'the pinned edition of the note is not in the clone')
  const report = checkProject(partial)
  assert.equal(report.ok, false)
  assert.equal(markOf(report, 'order-of-wheel-checks').edition, 'refused')
  assert.ok(has(report.errors, WHEEL, 'not available in this clone'), report.errors.join('\n'))
  assert.equal(markOf(report, 'spoke-tension-drawing').edition, 'intact')
  assert.deepEqual(missing(), before, 'the check fetched nothing')
})

test('each value-taking flag takes its own adjacent value', () => {
  const { dir } = pinnedProject()
  const config = path.join(dir, 'atelier.project.json')
  const run = (args) => spawnSync(process.execPath, [binary, 'graphmark', 'check', ...args], { cwd: dir, encoding: 'utf8' })
  const split = run(['--expect', '--project', config, 'repair-workshop:mark:2026-01-12-order-of-wheel-checks'])
  assert.equal(split.status, 2, split.stdout)
  assert.match(split.stderr, /unknown option: --expect/)
  assert.equal(run(['--project', config, '--expect', 'repair-workshop:mark:2026-01-12-order-of-wheel-checks']).status, 0)
})

test('the standalone validator refuses a lines range that ends before it starts', () => {
  const record = readMarkRecord(fs.readFileSync(path.join(fixtureContent, 'marks', WHEEL), 'utf8'))
  record.target.selector.value = '5-3'
  const result = validateMarkRecord(record)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.startsWith('/target/selector/value') && error.includes('ends before it starts')), result.errors.join('\n'))
  const { dir } = pinnedProject()
  editMark(dir, WHEEL, (text) => text.replace('value: "16-21"', 'value: "21-16"'))
  commitAll(dir, 'a reversed range')
  const report = checkProject(dir)
  assert.ok(has(report.errors, WHEEL, 'selector lines "21-16" ends before it starts'), report.errors.join('\n'))
})

// Findings from the re-check of 5c3162a.

const moduleUrl = new URL('../src/graphmark/graphmark.mjs', import.meta.url).href
const checkAt = (dir, argv = ['--project', path.join(dir, 'atelier.project.json')], options) => checkGraphmarks({ argv, cwd: dir, env: {} }, options)
const editJson = (file, edit) => {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  edit(doc)
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
}

test('the read policy comes from the committed access file the committed config names, never a live file', () => {
  // A configured access file outside the project's repositories is refused, not read.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-outside-'))
  fs.writeFileSync(path.join(outside, 'access.json'), `${JSON.stringify({ schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'public', repos: { content: { readBoundary: 'public' } } })}\n`)
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.graph.repoAccessPath = path.join(outside, 'access.json') })
  commitAll(dir, 'an access file outside the project')
  const live = checkProject(dir)
  assert.equal(live.ok, false)
  assert.ok(has(live.errors, 'is outside the project\'s repositories', 'does not read live files'), live.errors.join('\n'))

  // A committed access file that is a link is an error, not defaults.
  const { dir: linked } = pinnedProject()
  fs.renameSync(path.join(linked, 'repo-access.v1.json'), path.join(linked, 'repo-access.real.json'))
  fs.symlinkSync('repo-access.real.json', path.join(linked, 'repo-access.v1.json'))
  commitAll(linked, 'the access file becomes a link')
  const link = checkProject(linked)
  assert.equal(link.ok, false)
  assert.ok(has(link.errors, 'repo-access.v1.json: the committed repository access file is a symbolic link', 'does not fall back to defaults'), link.errors.join('\n'))

  // Status warnings name the access file the committed config names.
  const { dir: edited } = pinnedProject()
  editJson(path.join(edited, 'atelier.project.json'), (doc) => { doc.graph.repoAccessPath = 'repo-access.v2.json' })
  fs.appendFileSync(path.join(edited, 'repo-access.v1.json'), '\n')
  const report = checkProject(edited)
  assert.ok(has(report.warnings, 'repo-access.v1.json: has uncommitted changes'), report.warnings.join('\n'))
  assert.ok(has(report.warnings, 'atelier.project.json: has uncommitted changes'), report.warnings.join('\n'))

  // A committed access file that is truly absent leaves the defaults.
  const { dir: absent } = pinnedProject()
  git(absent, ['rm', '-q', 'repo-access.v1.json'])
  git(absent, ['commit', '-qm', 'no access file'])
  assert.equal(checkProject(absent).ok, true)
})

test('pending mark records are refused by what Git holds or by where they are, and new Markdown elsewhere only warns', () => {
  const draft = (dir, name) => {
    fs.copyFileSync(markPath(dir, DRAWING), markPath(dir, name))
    editMark(dir, name, (text) => text.replace('repair-workshop:mark:2026-01-12-spoke-tension-drawing', `repair-workshop:mark:${name.replace(/\.md$/, '')}`).replace('    supports:\n      - "repair-workshop:mark:2026-01-12-order-of-wheel-checks"\n', ''))
  }
  // Staged, then deleted from the working tree (AD): the index holds a mark.
  const { dir } = pinnedProject()
  draft(dir, '2026-01-17-staged.md')
  git(dir, ['add', '--', markPath(dir, '2026-01-17-staged.md')])
  fs.rmSync(markPath(dir, '2026-01-17-staged.md'))
  const staged = checkProject(dir)
  assert.equal(staged.ok, false)
  assert.ok(has(staged.errors, '2026-01-17-staged.md: pending mark: the record is in the index'), staged.errors.join('\n'))

  // Untracked in the marks folder, however large: refused by where it is.
  const { dir: large } = pinnedProject()
  draft(large, '2026-01-17-large.md')
  fs.appendFileSync(markPath(large, '2026-01-17-large.md'), `\n${'A long body. '.repeat(200000)}\n`)
  const big = checkProject(large)
  assert.equal(big.ok, false)
  assert.ok(has(big.errors, '2026-01-17-large.md: pending mark: an uncommitted change (untracked) in a folder that holds marks'), big.errors.join('\n'))

  // A tracked note turned into a mark: its working copy is never read, so it
  // is the dependency warning until it is staged, and refused once it is.
  const { dir: turned } = pinnedProject()
  const note = path.join(turned, 'content', 'notes', 'wheel-checks.md')
  fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('tags: [repair, wheels]', 'tags: [repair, wheels, graphmark]'))
  const unstaged = checkProject(turned)
  assert.equal(unstaged.ok, true, unstaged.errors.join('\n'))
  assert.ok(has(unstaged.warnings, 'notes/wheel-checks.md has uncommitted changes'), unstaged.warnings.join('\n'))
  git(turned, ['add', '--', note])
  const pending = checkProject(turned)
  assert.equal(pending.ok, false)
  assert.ok(has(pending.errors, 'notes/wheel-checks.md: pending mark: the record is in the index'), pending.errors.join('\n'))

  // New Markdown in a folder without marks is reported as not verified.
  const { dir: fresh } = pinnedProject()
  fs.writeFileSync(path.join(fresh, 'content', 'notes', 'brakes.md'), '---\ntitle: "Brakes"\n---\n# Brakes\n')
  const elsewhere = checkProject(fresh)
  assert.equal(elsewhere.ok, true, elsewhere.errors.join('\n'))
  assert.ok(has(elsewhere.warnings, 'content/notes/brakes.md: uncommitted Markdown (untracked); not verified'), elsewhere.warnings.join('\n'))

  // Renaming the marks index, unstaged or staged, is a pending change in the
  // marks folder; the committed marks are still verified.
  for (const stage of [false, true]) {
    const { dir: renamed } = pinnedProject()
    if (stage) git(renamed, ['mv', 'content/marks/README.md', 'content/marks/INDEX.md'])
    else fs.renameSync(path.join(renamed, 'content', 'marks', 'README.md'), path.join(renamed, 'content', 'marks', 'INDEX.md'))
    const report = checkProject(renamed)
    assert.equal(report.ok, false, stage ? 'staged' : 'unstaged')
    assert.deepEqual(report.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
    assert.ok(has(report.errors, 'content/marks/INDEX.md: pending mark'), report.errors.join('\n'))
    assert.ok(has(report.errors, 'content/marks/README.md: pending mark'), report.errors.join('\n'))
  }
})

test('a status query that fails leaves the result indeterminate, never a success', () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(path.join(dir, '.git', 'index'), 'not an index')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'git status failed', 'indeterminate'), report.errors.join('\n'))
})

test('the committed config is read from HEAD: a sparse checkout or an unfinished edit still verifies', () => {
  const { dir } = pinnedProject()
  git(dir, ['sparse-checkout', 'set', '--no-cone', '/content/'])
  assert.equal(fs.existsSync(path.join(dir, 'atelier.project.json')), false, 'the config is not checked out')
  for (const argv of [['--project', path.join(dir, 'atelier.project.json')], ['--project', dir]]) {
    const report = checkAt(dir, argv)
    assert.equal(report.ok, true, report.errors.join('\n'))
    assert.deepEqual(report.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
  }
  const cli = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stderr)

  const { dir: editing } = pinnedProject()
  fs.writeFileSync(path.join(editing, 'atelier.project.json'), '{ "schema": ')
  const unfinished = checkAt(editing)
  assert.equal(unfinished.ok, true, unfinished.errors.join('\n'))
  assert.ok(has(unfinished.warnings, 'atelier.project.json: has uncommitted changes'), unfinished.warnings.join('\n'))
})

test('promisor settings are read with Git\'s boolean parser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-promisor-'))
  git(dir, ['init', '-q'])
  assert.equal(isPromisorRepository(dir), false)
  for (const value of ['true', 'yes', 'on', '1']) {
    git(dir, ['config', 'remote.origin.promisor', value])
    assert.equal(isPromisorRepository(dir), true, value)
  }
  git(dir, ['config', 'remote.origin.promisor', 'no'])
  assert.equal(isPromisorRepository(dir), false)
  git(dir, ['config', 'remote.origin.promisor', 'maybe'])
  assert.equal(isPromisorRepository(dir), true, 'a value Git cannot parse counts as a promisor')
  git(dir, ['config', '--unset', 'remote.origin.promisor'])
  git(dir, ['config', 'extensions.partialClone', 'origin'])
  assert.equal(isPromisorRepository(dir), true)
})

test('a promisor remote spelled with another true value still keeps the check from fetching', () => {
  const { dir, head } = pinnedProject()
  fs.appendFileSync(path.join(dir, 'content', 'notes', 'wheel-checks.md'), '\nA later line.\n')
  commitAll(dir, 'a later edition')
  git(dir, ['config', 'uploadpack.allowFilter', 'true'])
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-partial-'))
  git(partial, ['clone', '-q', '--filter=blob:none', `file://${dir}`, '.'])
  git(partial, ['config', 'remote.origin.promisor', 'yes'])
  const missing = () => git(partial, ['rev-list', '--objects', '--missing=print', '--no-walk', head]).split('\n').filter((line) => line.startsWith('?')).sort()
  const before = missing()
  assert.ok(before.length > 0)
  const report = checkProject(partial)
  assert.equal(markOf(report, 'order-of-wheel-checks').edition, 'refused')
  assert.ok(has(report.errors, WHEEL, 'not available in this clone'), report.errors.join('\n'))
  assert.deepEqual(missing(), before, 'the check fetched nothing')
})

test('a committed name that is not valid UTF-8 is refused, since no exact name can be read', () => {
  // Bytes no checkout can hold as given are refused on every volume.
  const { dir } = pinnedProject()
  commitObjects(dir, [{ path: Buffer.concat([Buffer.from('content/notes/caf'), Buffer.from([0xe9]), Buffer.from('.txt')]), content: 'latin-1 name\n' }], 'a name that is not UTF-8')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'cannot be read exactly', 'a path that is not valid UTF-8'), report.errors.join('\n'))
})

test('a marked file that became a directory or a submodule at HEAD is refused, not removed', () => {
  for (const kind of ['directory', 'gitlink']) {
    const { dir, head } = pinnedProject()
    const parts = path.join(dir, 'content', 'notes', 'parts.txt')
    fs.writeFileSync(parts, 'spokes, nipples, rim tape\n')
    commitAll(dir, 'a plain file')
    retarget(dir, DRAWING, 'content/notes/parts.txt')
    commitAll(dir, 'mark it')
    git(dir, ['rm', '-q', 'content/notes/parts.txt'])
    if (kind === 'directory') {
      fs.mkdirSync(parts)
      fs.writeFileSync(path.join(parts, 'inner.txt'), 'now a folder\n')
      git(dir, ['add', '-A'])
    } else {
      git(dir, ['update-index', '--add', '--cacheinfo', `160000,${head},content/notes/parts.txt`])
    }
    git(dir, ['commit', '-qm', `it becomes a ${kind}`])
    const report = checkProject(dir)
    assert.equal(report.ok, false, kind)
    assert.equal(markOf(report, 'spoke-tension-drawing').edition, 'refused', kind)
    assert.ok(has(report.errors, DRAWING, kind === 'directory' ? 'is a directory' : 'is a submodule'), `${kind}: ${report.errors.join('\n')}`)
    assert.equal(has(report.warnings, DRAWING, 'no longer held at HEAD'), false, kind)
  }
})

test('the committed graph reads Git objects on demand, with bounded memory', () => {
  const { dir } = pinnedProject()
  const size = 160 * 1024 * 1024
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'big.bin'), Buffer.alloc(size))
  commitAll(dir, 'a large file in the managed folder')
  const script = `import { checkGraphmarks } from ${JSON.stringify(moduleUrl)}
const report = checkGraphmarks({ argv: ['--project', ${JSON.stringify(path.join(dir, 'atelier.project.json'))}], cwd: ${JSON.stringify(dir)}, env: {} })
console.log(JSON.stringify({ ok: report.ok, errors: report.errors, rss: process.resourceUsage().maxRSS * 1024 }))`
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(run.stdout)
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.ok(result.rss < size, `peak memory ${result.rss} bytes is below the ${size}-byte file`)
})

test('the committed graph does not depend on where the temporary folder is', () => {
  const { dir } = pinnedProject()
  const enclosing = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-enclosing-'))
  git(enclosing, ['init', '-q'])
  fs.writeFileSync(path.join(enclosing, '.gitignore'), '*\n')
  fs.mkdirSync(path.join(enclosing, 'tmp'))
  const run = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--json'], { cwd: dir, encoding: 'utf8', env: { ...process.env, TMPDIR: path.join(enclosing, 'tmp') } })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout).marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
})

test('line ranges are compared as exact integers, whatever their size', () => {
  const record = readMarkRecord(fs.readFileSync(path.join(fixtureContent, 'marks', WHEEL), 'utf8'))
  record.target.selector.value = '9007199254740993-9007199254740992'
  const result = validateMarkRecord(record)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('ends before it starts')), result.errors.join('\n'))
  record.target.selector.value = '9007199254740992-9007199254740993'
  assert.equal(validateMarkRecord(record).ok, true)
})

test('an audience declared with a value that is not a name is an error, not private', () => {
  const { dir } = pinnedProject()
  const sidecar = path.join(dir, 'content', 'drawings', 'spoke-tension.html.kg.json')
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  const [sidecarText, noteText] = [fs.readFileSync(sidecar, 'utf8'), fs.readFileSync(note, 'utf8')]
  fs.writeFileSync(sidecar, sidecarText.replace('"audience": "team"', '"audience": 3'))
  fs.writeFileSync(note, noteText.replace('  audience: "team"', '  audience: [team]'))
  commitAll(dir, 'audiences that are not names')
  retarget(dir, DRAWING, 'content/drawings/spoke-tension.html', (text) => text.replace('  audience: "team"', '  audience: "private"'))
  retarget(dir, WHEEL, 'content/notes/wheel-checks.md', (text) => text.replace('  audience: "team"', '  audience: "private"'))
  fs.writeFileSync(sidecar, sidecarText)
  fs.writeFileSync(note, noteText)
  commitAll(dir, 'restore named audiences')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, DRAWING, 'declares an audience that is not a name (3)'), report.errors.join('\n'))
  assert.ok(has(report.errors, WHEEL, 'declares an audience that is not a name'), report.errors.join('\n'))
})

// Findings from the confirmation review of d4fa5ba.

test('a policy path under a committed link, submodule or file is refused, not treated as absent', () => {
  for (const [label, entry] of [['a symbolic link', { mode: '120000', content: 'elsewhere' }], ['a file', { mode: '100644', content: 'not a folder\n' }]]) {
    const { dir } = pinnedProject()
    editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.graph.repoAccessPath = 'policy/repo-access.v1.json' })
    commitAll(dir, 'the policy lives under policy/')
    commitObjects(dir, [{ path: 'policy', ...entry }], `policy is ${label}`)
    const report = checkProject(dir)
    assert.equal(report.ok, false, label)
    assert.ok(has(report.errors, 'policy/repo-access.v1.json', `lies under policy, which is ${label}`, 'does not fall back to defaults'), `${label}: ${report.errors.join('\n')}`)
  }
  // Under plain folders, a missing file is truly absent and the defaults apply.
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.graph.repoAccessPath = 'content/notes/no-such-policy.json' })
  commitAll(dir, 'a policy file that does not exist')
  assert.equal(checkProject(dir).ok, true)
})

test('a committed access file is validated as written, before any defaults are filled in', () => {
  const cases = [
    ['repos that are not an object', (doc) => { doc.repos = 'content' }, 'repos must be an object'],
    ['a managed repository without a read boundary', (doc) => { doc.repos = {} }, 'repos.content must declare readBoundary'],
    ['an unknown read boundary', (doc) => { doc.repos.content.readBoundary = 'everyone' }, 'repos.content.readBoundary must be a valid'],
    ['an unsupported format', (doc) => { doc.schema = 'mnstry.repo-access@v9' }, 'schema must be one of'],
  ]
  for (const [label, edit, message] of cases) {
    const { dir } = pinnedProject()
    editJson(path.join(dir, 'repo-access.v1.json'), edit)
    commitAll(dir, label)
    const report = checkProject(dir)
    assert.equal(report.ok, false, label)
    assert.ok(has(report.errors, 'repo-access.v1.json', message, 'does not fill in defaults'), `${label}: ${report.errors.join('\n')}`)
  }
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'repo-access.v1.json'), (doc) => { doc.schema = 'mnstry.repo-access@v1' })
  commitAll(dir, 'the other supported format')
  assert.equal(checkProject(dir).ok, true)
})

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
test('a pending Markdown file the check cannot read changes nothing: the check never opens it', { skip: (process.platform === 'win32' || isRoot) && 'needs POSIX permissions that bind this user' }, () => {
  const { dir } = pinnedProject()
  const unreadable = path.join(dir, 'content', 'notes', 'closed.md')
  fs.writeFileSync(unreadable, '---\ntitle: "Closed"\n---\n# Closed\n')
  fs.chmodSync(unreadable, 0o000)
  try {
    const report = checkProject(dir)
    assert.equal(report.ok, true, report.errors.join('\n'))
    assert.ok(has(report.warnings, 'content/notes/closed.md: uncommitted Markdown (untracked); not verified'), report.warnings.join('\n'))
  } finally {
    fs.chmodSync(unreadable, 0o644)
  }
})

test('an unresolved conflict is classified by each of its index stages', () => {
  const { dir } = pinnedProject()
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  const base = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  git(dir, ['checkout', '-q', '-b', 'other'])
  fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('tags: [repair, wheels]', 'tags: [repair, wheels, graphmark]'))
  commitAll(dir, 'the other side makes it a mark')
  git(dir, ['checkout', '-q', base])
  fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('tags: [repair, wheels]', 'tags: [repair, wheels, brakes]'))
  commitAll(dir, 'this side tags it otherwise')
  const merge = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'merge', '-q', 'other'], { cwd: dir, encoding: 'utf8' })
  assert.notEqual(merge.status, 0, 'the merge conflicts')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'notes/wheel-checks.md: pending mark: the record is in the index (an unresolved conflict)'), report.errors.join('\n'))
})

test('a Git name that begins with U+FEFF keeps its identity', () => {
  const { dir } = pinnedProject()
  const name = '﻿top.txt'
  commitObjects(dir, [{ path: name, content: 'a name that starts with a byte order mark\n' }], 'a top-level name with U+FEFF')
  retarget(dir, DRAWING, name)
  git(dir, ['commit', '-qm', 'mark it', '--', markPath(dir, DRAWING)])
  const report = checkProject(dir)
  assert.equal(markOf(report, 'spoke-tension-drawing').edition, 'intact', report.errors.join('\n'))
})

test('a remote with a partial-clone filter is a promisor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-promisor-'))
  git(dir, ['init', '-q'])
  assert.equal(isPromisorRepository(dir), false)
  git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none'])
  assert.equal(isPromisorRepository(dir), true)
})

test('a tagged index the check cannot read is inspected and refused, not skipped', () => {
  const { dir } = pinnedProject()
  const index = path.join(dir, 'content', 'marks', 'README.md')
  fs.appendFileSync(index, `\n${'An index line that will not be read in full.\n'.repeat(1600000)}`)
  commitAll(dir, 'an index past what the check reads')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'content/marks/README.md: the committed mark record holds', 'more than this check reads'), report.errors.join('\n'))
})

test('external repositories are never probed while the committed project is resolved', { skip: process.platform === 'win32' && 'uses a POSIX shell wrapper to trace Git' }, () => {
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.repos.push({ name: 'vendor', kind: 'external', remote: 'https://example.invalid/vendor.git' }) })
  commitAll(dir, 'an external repository')
  const vendor = path.join(dir, 'vendor')
  fs.mkdirSync(vendor)
  git(vendor, ['init', '-q'])
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
  const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-trace-'))
  const log = path.join(wrapper, 'calls.log')
  fs.writeFileSync(path.join(wrapper, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 })
  const run = spawnSync(process.execPath, [binary, 'graphmark', 'check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${wrapper}${path.delimiter}${process.env.PATH}` } })
  assert.equal(run.status, 0, run.stderr)
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
  assert.ok(calls.length > 0, 'the wrapper traced the check')
  assert.equal(calls.split('\n').filter((line) => line.includes('remote get-url')).length, 0, calls)
})

// Findings from the confirmation reviews of 69613bd and cc43715: whether two
// names are one file is asked of the volume, never modelled.

test('a pending Markdown file whose name is not UTF-8 makes the result indeterminate', { skip: process.platform !== 'linux' && 'needs a filesystem that accepts names that are not UTF-8' }, () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(Buffer.concat([Buffer.from(path.join(dir, 'content', 'notes', 'draft-')), Buffer.from([0xff]), Buffer.from('.md')]), '---\ntitle: "Draft"\ntags: [graphmark]\n---\n# Draft\n')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'a pending Markdown file whose name is not UTF-8', 'indeterminate'), report.errors.join('\n'))
})

// The check verifies from Git objects alone (the confirmation review of
// 48912c0): no copy of the tree on any filesystem, so name folding, links,
// host path rules and timing on a volume cannot change what it reads.

function recordFs(run) {
  const reads = ['readFileSync', 'openSync', 'readdirSync', 'createReadStream', 'opendirSync']
  const writes = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'createWriteStream']
  const real = Object.fromEntries([...reads, ...writes].map((name) => [name, fs[name]]))
  const calls = { reads: [], writes: [] }
  for (const name of reads) fs[name] = function (target, ...rest) { calls.reads.push(String(target)); return real[name].call(this, target, ...rest) }
  for (const name of writes) fs[name] = function (target, ...rest) { calls.writes.push(`${name} ${String(target)}`); return real[name].call(this, target, ...rest) }
  try {
    return { result: run(), calls }
  } finally {
    Object.assign(fs, real)
  }
}

test('the check reads the committed tree from Git objects alone: nothing in the repository is read from disk but a location overlay, nothing is written', () => {
  const { dir } = pinnedProject()
  // A machine-local overlay, a documented location input, is the one file read.
  const overlay = path.join(dir, 'atelier.local.json')
  fs.writeFileSync(overlay, `${JSON.stringify({ schema: 'mnstry.atelier-local-overlay@v1', repoPaths: { content: 'content' } })}\n`)
  const project = commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false })
  const { result, calls } = recordFs(() => checkGraphmarks(project))
  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(result.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
  assert.deepEqual([...new Set(calls.reads.filter((name) => name.startsWith(dir)))], [overlay], 'no file under the repository but the overlay was opened')
  assert.deepEqual(calls.writes, [], 'nothing was written anywhere')
})

test('the check never opens a working-tree file, pending ones included: what is pending comes from git status and Git objects', () => {
  const { dir } = pinnedProject()
  const overlay = path.join(dir, 'atelier.local.json')
  fs.writeFileSync(overlay, `${JSON.stringify({ schema: 'mnstry.atelier-local-overlay@v1', repoPaths: { content: 'content' } })}\n`)
  // New in the marks folder, new elsewhere, edited, and staged.
  const pendingMark = markPath(dir, '2026-01-21-pending.md')
  fs.copyFileSync(markPath(dir, DRAWING), pendingMark)
  const newNote = path.join(dir, 'content', 'notes', 'brakes.md')
  fs.writeFileSync(newNote, '---\ntitle: "Brakes"\ntags: [graphmark]\n---\n# Brakes\n')
  const edited = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.appendFileSync(edited, '\nAn uncommitted line.\n')
  const stagedNote = path.join(dir, 'content', 'captures', 'staged.md')
  fs.writeFileSync(stagedNote, '---\ntitle: "Staged"\n---\n# Staged\n')
  git(dir, ['add', '--', stagedNote])
  const project = commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false })
  const { result, calls } = recordFs(() => checkGraphmarks(project))
  assert.deepEqual([...new Set(calls.reads.filter((name) => name.startsWith(dir)))], [overlay], 'no file under the repository but the overlay was opened')
  assert.deepEqual(calls.writes, [], 'nothing was written anywhere')
  assert.equal(result.ok, false)
  assert.ok(has(result.errors, 'content/marks/2026-01-21-pending.md: pending mark'), result.errors.join('\n'))
  assert.ok(has(result.warnings, 'content/notes/brakes.md: uncommitted Markdown (untracked); not verified'), result.warnings.join('\n'))
  assert.ok(has(result.warnings, 'content/captures/staged.md: uncommitted Markdown (added); not verified'), result.warnings.join('\n'))
  assert.ok(has(result.warnings, 'notes/wheel-checks.md has uncommitted changes'), result.warnings.join('\n'))
})

test('a filesystem call the committed reader does not serve is refused, never passed to the disk', async () => {
  const base = path.join(os.tmpdir(), `.atelier-graphmark-reader-test-${process.pid}`)
  const reader = committedReader(base)
  reader.addRoot(path.join(base, 'tree'))
  reader.add(path.join(base, 'tree', 'note.md'), 'file', { bytes: Buffer.from('# Note\n') })
  reader.add(path.join(base, 'tree', 'link.md'), 'link', {})
  const note = path.join(base, 'tree', 'note.md')
  withCommittedReader(reader, () => {
    assert.equal(fs.readFileSync(note, 'utf8'), '# Note\n')
    assert.equal(fs.existsSync(path.join(base, 'tree', 'link.md')), false, 'a committed link is listed, never followed')
    assert.equal(fs.lstatSync(path.join(base, 'tree', 'link.md')).isSymbolicLink(), true)
    assert.deepEqual(fs.readdirSync(path.join(base, 'tree')), ['link.md', 'note.md'])
    assert.throws(() => fs.readFileSync(path.join(base, 'tree', 'NOTE.md')), { code: 'ENOENT' }, 'names are exact, never folded')
    assert.throws(() => fs.createReadStream(note), { code: 'EPERM' })
    assert.throws(() => fs.writeFileSync(note, 'x'), { code: 'EPERM' })
  })
  assert.equal(reader.violations.length, 2, reader.violations.join('\n'))
  assert.equal(fs.existsSync(base), false, 'the virtual root never exists on disk')
})

test('a policy reached only through another spelling or a link on disk changes nothing: the committed path decides', () => {
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.graph.repoAccessPath = 'Policy/repo-access.json' })
  commitAll(dir, 'a policy path nothing commits')
  // A committed link under another spelling of the folder, and a wide policy on disk where a folding host would look.
  commitObjects(dir, [{ path: 'policy', mode: '120000', content: 'elsewhere' }], 'a link spelled otherwise')
  fs.mkdirSync(path.join(dir, 'Policy'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Policy', 'repo-access.json'), `${JSON.stringify({ schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'public', repos: { content: { readBoundary: 'public' } } })}\n`)
  editMark(dir, WHEEL, (text) => text.replace('  audience: "team"', '  audience: "public"'))
  git(dir, ['commit', '-qm', 'a public mark', '--', markPath(dir, WHEEL)])
  const report = checkProject(dir)
  // Exact Git lookup: the policy is absent, so the repository's team boundary stands and the public mark is refused.
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, WHEEL, 'wider than "team"'), report.errors.join('\n'))
  assert.ok(has(report.warnings, 'Policy/repo-access.json: has uncommitted changes (untracked)'), report.warnings.join('\n'))
})

test('nothing the check does can enter the graph: a sidecar whose source is a committed link stays an orphan', () => {
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.graph.repoAccessPath = 'content/drawings/absent-policy.json' })
  commitAll(dir, 'an absent policy inside a managed folder')
  commitObjects(dir, [
    { path: 'content/drawings/ghost.svg', mode: '120000', content: 'spoke-tension.html' },
    { path: 'content/drawings/ghost.svg.kg.json', content: sidecarFor('ghost.svg', 'repair-workshop:drawings:ghost') },
  ], 'a sidecar for a link')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(has(report.errors, 'content/drawings/ghost.svg.kg.json'), report.errors.join('\n'))
})

test('a committed name this host would not keep as one literal path is refused', () => {
  const { dir } = pinnedProject()
  // Made with Git's tree objects, not its index, so every host can hold the
  // commit: Git on Windows may refuse the name in an index.
  commitTreeEntry(dir, 'content/notes/a\\b.txt', 'a backslash in one name\n', 'a backslash in a name')
  assert.ok(git(dir, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').includes('content/notes/a\\b.txt'))
  const report = checkProject(dir)
  if (process.platform === 'win32') {
    assert.equal(report.ok, false)
    assert.ok(has(report.errors, 'content/notes/a\\b.txt is not one literal path on this host'), report.errors.join('\n'))
  } else {
    assert.equal(report.ok, true, report.errors.join('\n'))
  }
})

test('the committed graph equals the graph built from a clean checkout', () => {
  const facts = (graph) => ({
    nodes: graph.nodes.map(({ id, repo, path: where, type, audience, status, tags, relations, title, summary }) => ({ id, repo, path: where, type, audience, status, tags, relations, title, summary })),
    edges: graph.edges,
    errors: graph.errors,
  })
  const sources = ['fixtures/graphmark', 'fixtures/projects/source-formats-workspace', 'fixtures/projects/sample-workspace', 'templates/knowledge-workspace', 'examples/loomworks-studio']
  for (const source of sources) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-parity-'))
    fs.cpSync(path.join(root, source), dir, { recursive: true })
    git(dir, ['init', '-q'])
    commitAll(dir, source)
    const project = commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false })
    const committed = buildCommittedGraph({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {} })
    assert.ok(committed.graph, `${source}: ${committed.errors.join('\n')}`)
    assert.deepEqual(facts(committed.graph), facts(buildGraph(project)), source)
  }
  // Failures too: an orphan sidecar and a broken relation give the same errors.
  const { dir } = pinnedProject()
  fs.writeFileSync(path.join(dir, 'content', 'drawings', 'ghost.svg.kg.json'), sidecarFor('ghost.svg', 'repair-workshop:drawings:ghost'))
  editMark(dir, WHEEL, (text) => text.replace('"repair-workshop:notes:wheel-checks"', '"repair-workshop:notes:never-written"'))
  commitAll(dir, 'broken')
  const project = commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false })
  const real = buildGraph(project)
  assert.ok(real.errors.length >= 2)
  const committed = buildCommittedGraph({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {} })
  assert.deepEqual(facts(committed.graph), facts(real))
})

// Findings from the confirmation review of 6b64c9b.

const graphFacts = (dir) => {
  const project = commandProject({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {}, writeLocalState: false })
  const real = buildGraph(project)
  const committed = buildCommittedGraph({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {} })
  return { real, committed: committed.graph, errors: committed.errors }
}

test('a configured folder never stands in for a committed one: an orphan sidecar and a missing repository still surface', () => {
  // The operations folder is configured at the path of the sidecar's missing source.
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.roots.repoOps = 'content/drawings/ghost.svg' })
  fs.writeFileSync(path.join(dir, 'content', 'drawings', 'ghost.svg.kg.json'), sidecarFor('ghost.svg', 'repair-workshop:drawings:ghost'))
  commitAll(dir, 'an orphan sidecar and an operations folder named like its source')
  const orphan = graphFacts(dir)
  assert.ok(orphan.committed, orphan.errors.join('\n'))
  assert.ok(orphan.committed.errors.some((error) => error.includes('ghost.svg.kg.json')), orphan.committed.errors.join('\n'))
  assert.deepEqual(orphan.committed.errors, orphan.real.errors)
  assert.equal(checkProject(dir).ok, false)

  // The workspace folder is configured at the path of a managed folder nothing commits.
  const { dir: absent } = pinnedProject()
  editJson(path.join(absent, 'atelier.project.json'), (doc) => {
    doc.roots.workspace = 'extra'
    doc.repos.push({ name: 'extra', path: 'extra', readBoundary: 'team' })
  })
  editJson(path.join(absent, 'repo-access.v1.json'), (doc) => { doc.repos.extra = { readBoundary: 'team' } })
  commitAll(absent, 'a managed folder that is not committed')
  const missing = graphFacts(absent)
  assert.ok(missing.committed, missing.errors.join('\n'))
  assert.ok(missing.committed.errors.some((error) => error.includes('extra')), missing.committed.errors.join('\n'))
  assert.deepEqual(missing.committed.errors, missing.real.errors)
})

test('the virtual layout keeps every repository at its host path from the config folder, or refuses', () => {
  const win = path.win32
  const base = 'X:\\tmp\\.atelier-graphmark-committed'
  const config = 'C:\\work\\project'
  const roots = ['C:\\work\\project', 'C:\\work\\knowledge', 'c:\\WORK\\knowledge\\inner', 'C:\\work\\drafts\\shelf']
  const layout = projectLayout(base, [config, ...roots], win)
  assert.ok(layout)
  assert.equal(layout.anchor, 'C:\\work')
  for (const root of roots) {
    assert.equal(win.relative(layout.at(config), layout.at(root)), win.relative(config, root), root)
    assert.ok(layout.at(root).startsWith(win.join(base, 'project', 'work')), layout.at(root))
    assert.equal(win.basename(layout.at(root)), win.basename(root))
  }
  const virtual = roots.map((root) => layout.at(root))
  assert.equal(new Set(virtual.map((one) => one.toLowerCase())).size, roots.length, virtual.join('\n'))
  // Two drives, or a drive and a share, have no folder in common.
  assert.equal(projectLayout(base, [config, 'D:\\work\\knowledge'], win), null)
  assert.equal(projectLayout(base, [config, '\\\\server\\share\\knowledge'], win), null)
  const posix = projectLayout('/tmp/.atelier-graphmark-committed', ['/srv/a/project', '/home/b/knowledge'], path.posix)
  assert.equal(posix.anchor, '/')
  assert.equal(path.posix.relative(posix.at('/srv/a/project'), posix.at('/home/b/knowledge')), '../../../home/b/knowledge')
})

test('a repository nested in another is read from its own HEAD only', () => {
  const { dir } = pinnedProject()
  fs.writeFileSync(path.join(dir, '.gitignore'), 'content/inner/\n')
  const inner = path.join(dir, 'content', 'inner')
  fs.mkdirSync(inner)
  git(inner, ['init', '-q'])
  fs.writeFileSync(path.join(inner, 'note.md'), '---\ntitle: "Inner"\nkg:\n  id: "inner:note"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n# Inner\n\nA note of the inner repository.\n')
  commitAll(inner, 'the inner repository')
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.repos.push({ name: 'inner', path: 'content/inner', readBoundary: 'team' }) })
  editJson(path.join(dir, 'repo-access.v1.json'), (doc) => { doc.repos.inner = { readBoundary: 'team' } })
  commitAll(dir, 'enrol the inner repository')
  const { real, committed, errors } = graphFacts(dir)
  assert.ok(committed, errors.join('\n'))
  assert.deepEqual(committed.nodes.filter((node) => node.id === 'inner:note').map((node) => node.repo), ['inner'], 'the outer repository does not see the inner one')
  assert.deepEqual(committed.nodes, real.nodes)
  assert.deepEqual(committed.errors, real.errors)
})

test('the committed reader serves file URLs and refuses paths in no committed tree', () => {
  const base = path.join(os.tmpdir(), `.atelier-graphmark-reader-url-${process.pid}`)
  const reader = committedReader(base)
  const root = path.join(base, 'repo-0', 'repo')
  reader.addRoot(root)
  reader.add(path.join(root, 'note.md'), 'file', { bytes: Buffer.from('# Note\n') })
  withCommittedReader(reader, () => {
    assert.equal(fs.readFileSync(pathToFileURL(path.join(root, 'note.md')), 'utf8'), '# Note\n')
    assert.throws(() => fs.existsSync(path.join(base, 'elsewhere', 'note.md')), { code: 'EPERM' })
  })
  assert.equal(reader.violations.length, 1, reader.violations.join('\n'))
})

// Findings from the confirmation review of 0d12e9d.

// A project whose config repository holds no content, with the workshop in a
// Git repository of its own at `shelfAt` (a path from the config folder), and
// optionally a docs folder in the config repository that links across to it.
// The workshop's repository keeps its name, content, which its marks name.
function twoRootProject(shelfAt, setup, { docs = false } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-roots-'))
  const { dir: shelf } = pinnedProject()
  const place = path.join(project, ...shelfAt.split('/'))
  fs.mkdirSync(path.dirname(place), { recursive: true })
  fs.renameSync(shelf, place)
  const repos = [{ name: 'content', path: `${shelfAt}/content`, readBoundary: 'team' }]
  if (docs) {
    fs.mkdirSync(path.join(project, 'docs'))
    fs.writeFileSync(path.join(project, 'docs', 'guide.md'), `---\ntitle: "Guide"\nkg:\n  id: "repair-workshop:docs:guide"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n# Guide\n\nSee [the wheel checks](../${shelfAt}/content/notes/wheel-checks.md).\n`)
    repos.unshift({ name: 'docs', path: 'docs', readBoundary: 'team' })
  }
  fs.writeFileSync(path.join(project, 'atelier.project.json'), `${JSON.stringify({ schema: 'mnstry.atelier-project-config@v1', name: 'two-roots', roots: { workspace: '.', repoOps: '.' }, graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' }, setup, repos }, null, 2)}\n`)
  fs.writeFileSync(path.join(project, 'repo-access.v1.json'), `${JSON.stringify({ schema: 'mnstry.atelier-repo-access@v1', defaultReadBoundary: 'team', repos: Object.fromEntries(repos.map((repo) => [repo.name, { readBoundary: 'team' }])) }, null, 2)}\n`)
  fs.writeFileSync(path.join(project, '.gitignore'), `${shelfAt.split('/')[0]}/\n`)
  git(project, ['init', '-q'])
  commitAll(project, 'the project')
  return { project, shelf: place }
}

const sameGraph = (committed, real) => {
  assert.ok(committed)
  for (const key of new Set([...Object.keys(real), ...Object.keys(committed)])) assert.deepEqual(committed[key], real[key], key)
}

test('the census scope is read from the config folder across Git roots: an include keeps the separate repository', () => {
  const { project, shelf } = twoRootProject('knowledge/shelf', { include: 'knowledge', exclude: 'knowledge/shelf/content/drafts' })
  // A mark record the scope leaves out is reported, not silently dropped.
  fs.mkdirSync(path.join(shelf, 'content', 'drafts'))
  fs.copyFileSync(markPath(shelf, DRAWING), path.join(shelf, 'content', 'drafts', DRAWING))
  commitAll(shelf, 'a draft mark the census leaves out')
  const { real, committed, errors } = graphFacts(project)
  assert.ok(committed, errors.join('\n'))
  assert.equal(real.nodes.filter((node) => node.repo === 'content').length, 7)
  sameGraph(committed, real)
  const report = checkProject(project, { expect: ['repair-workshop:mark:2026-01-12-order-of-wheel-checks'] })
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.deepEqual(report.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
  assert.ok(has(report.warnings, `content/drafts/${DRAWING}: a committed mark record outside the knowledge graph's census`), report.warnings.join('\n'))
})

test('the census scope is read from the config folder across Git roots: an exclude leaves the separate repository out, and nothing passes empty', () => {
  const { project } = twoRootProject('content/drafts/shelf', { exclude: 'content/drafts' })
  const { real, committed, errors } = graphFacts(project)
  assert.ok(committed, errors.join('\n'))
  assert.equal(real.nodes.length, 0)
  sameGraph(committed, real)
  const report = checkProject(project)
  assert.equal(report.ok, false)
  assert.deepEqual(report.marks, [])
  assert.ok(has(report.errors, 'no mark record is in the knowledge graph\'s census, but the committed tree holds 3 outside it'), report.errors.join('\n'))
  for (const name of [WHEEL, DRAWING, PADS]) assert.ok(has(report.warnings, `content/marks/${name}: a committed mark record outside`), report.warnings.join('\n'))
})

test('the committed graph of a project across Git roots equals a clean checkout, in any order', () => {
  const { project, shelf } = twoRootProject('knowledge/shelf', { exclude: 'knowledge/shelf/content/drafts' }, { docs: true })
  fs.mkdirSync(path.join(shelf, 'content', 'drafts'))
  fs.writeFileSync(path.join(shelf, 'content', 'drafts', 'unfinished.md'), '---\ntitle: "Unfinished"\n---\n# Unfinished\n')
  commitAll(shelf, 'a draft the census leaves out')
  const first = graphFacts(project)
  assert.ok(first.committed, first.errors.join('\n'))
  assert.ok(first.real.nodes.some((node) => node.id === 'repair-workshop:docs:guide'))
  assert.equal(first.real.nodes.some((node) => node.path === 'drafts/unfinished.md'), false)
  sameGraph(first.committed, first.real)
  // The order the repositories are declared in does not move them.
  editJson(path.join(project, 'atelier.project.json'), (doc) => { doc.repos.reverse() })
  commitAll(project, 'the repositories in the other order')
  const second = graphFacts(project)
  sameGraph(second.committed, second.real)
  assert.deepEqual(second.committed.nodes, first.committed.nodes)
})

test('a repository where another repository commits files is refused', () => {
  const { dir } = pinnedProject()
  const inner = path.join(dir, 'content', 'inner')
  fs.mkdirSync(inner)
  fs.writeFileSync(path.join(inner, 'outer.md'), '---\ntitle: "Outer"\n---\n# Outer\n')
  commitAll(dir, 'the outer repository commits a file there')
  git(inner, ['init', '-q'])
  fs.writeFileSync(path.join(inner, 'note.md'), '---\ntitle: "Inner"\n---\n# Inner\n')
  git(inner, ['add', 'note.md'])
  git(inner, ['commit', '-qm', 'the inner repository'])
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.repos.push({ name: 'inner', path: 'content/inner', readBoundary: 'team' }) })
  editJson(path.join(dir, 'repo-access.v1.json'), (doc) => { doc.repos.inner = { readBoundary: 'team' } })
  commitAll(dir, 'enrol the inner repository')
  const result = buildCommittedGraph({ argv: ['--project', path.join(dir, 'atelier.project.json')], cwd: dir, env: {} })
  assert.equal(result.graph, null)
  assert.ok(has(result.errors, `${inner}: is a Git repository where the enclosing repository ${dir} holds committed files at content/inner in its HEAD`), result.errors.join('\n'))
})

test('the committed reader keeps no blob larger than its budget, and still serves it', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-cache-'))
  git(repo, ['init', '-q'])
  const hash = (content) => String(spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content }).stdout).trim()
  const large = 'x'.repeat(64)
  const small = 'small\n'
  const base = path.join(os.tmpdir(), `.atelier-graphmark-reader-cache-${process.pid}`)
  const reader = committedReader(base, { cacheBytes: 32 })
  const tree = path.join(base, 'project')
  reader.addRoot(tree)
  reader.add(path.join(tree, 'large.md'), 'file', { root: repo, oid: hash(large) })
  reader.add(path.join(tree, 'small.md'), 'file', { root: repo, oid: hash(small) })
  withCommittedReader(reader, () => {
    assert.equal(fs.readFileSync(path.join(tree, 'large.md'), 'utf8'), large)
    assert.equal(reader.cachedBytes(), 0)
    assert.equal(fs.readFileSync(path.join(tree, 'small.md'), 'utf8'), small)
    assert.equal(reader.cachedBytes(), small.length)
    assert.equal(fs.readFileSync(path.join(tree, 'large.md'), 'utf8'), large)
    assert.equal(reader.cachedBytes(), small.length)
  })
  assert.deepEqual(reader.violations, [])
})

test('while the graph builds, every path it names is served from Git objects or refused', () => {
  const base = path.join(os.tmpdir(), `.atelier-graphmark-reader-boundary-${process.pid}`)
  const reader = committedReader(base)
  const tree = path.join(base, 'project', 'repo')
  reader.addRoot(tree)
  reader.add(path.join(tree, 'note.md'), 'file', { bytes: Buffer.from('# Note\n') })
  const real = fileURLToPath(import.meta.url)
  withCommittedReader(reader, () => {
    assert.equal(fs.readFileSync(path.join(tree, 'note.md'), 'utf8'), '# Note\n')
    // A real file outside the committed tree, by path, URL or Buffer.
    assert.throws(() => fs.readFileSync(real), { code: 'EPERM' })
    assert.throws(() => fs.existsSync(pathToFileURL(real)), { code: 'EPERM' })
    assert.throws(() => fs.statSync(Buffer.from(real)), { code: 'EPERM' })
    assert.throws(() => fs.promises.readFile(real), { code: 'EPERM' })
    // A folder the layout made to hold a repository is in no committed tree.
    assert.throws(() => fs.readdirSync(path.join(base, 'project')), { code: 'EPERM' })
    assert.throws(() => fs.existsSync(base), { code: 'EPERM' })
  })
  assert.equal(reader.violations.length, 6, reader.violations.join('\n'))
  // Restored afterwards.
  assert.equal(fs.existsSync(real), true)
})

// Findings from the confirmation review of ae8bafa.

const cliCheck = (cwd, ...args) => {
  const result = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--json', '--project', 'atelier.project.json', ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, report: JSON.parse(result.stdout) }
}

test('a Git repository at a managed folder cannot hide what the enclosing repository commits there', () => {
  // The control: the config repository holds the workshop and its marks.
  const { dir } = pinnedProject()
  const control = cliCheck(dir)
  assert.equal(control.status, 0, control.report.errors.join('\n'))
  assert.equal(control.report.marks.length, 3)
  // The same HEAD, with its content out of the checkout and another
  // repository at the managed folder: the outer marks are still committed.
  git(dir, ['sparse-checkout', 'set', '--no-cone', '/atelier.project.json', '/repo-access.v1.json'])
  const inner = path.join(dir, 'content')
  fs.mkdirSync(inner, { recursive: true })
  git(inner, ['init', '-q'])
  fs.writeFileSync(path.join(inner, 'note.md'), '---\ntitle: "Inner"\n---\n# Inner\n')
  git(inner, ['add', 'note.md'])
  git(inner, ['commit', '-qm', 'another repository at the managed folder'])
  const hidden = cliCheck(dir)
  assert.equal(hidden.status, 1)
  assert.equal(hidden.report.ok, false)
  assert.ok(has(hidden.report.errors, `${inner}: is a Git repository where the enclosing repository ${dir} holds committed files at content in its HEAD`), hidden.report.errors.join('\n'))
})

test('a nested repository the enclosing one records as a submodule exactly there is read as its own', () => {
  const { dir } = pinnedProject()
  const inner = path.join(dir, 'content', 'inner')
  fs.mkdirSync(inner)
  git(inner, ['init', '-q'])
  fs.writeFileSync(path.join(inner, 'note.md'), '---\ntitle: "Inner"\nkg:\n  id: "inner:note"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n# Inner\n\nA note of the inner repository.\n')
  git(inner, ['add', 'note.md'])
  git(inner, ['commit', '-qm', 'the inner repository'])
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${git(inner, ['rev-parse', 'HEAD'])},content/inner`])
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.repos.push({ name: 'inner', path: 'content/inner', readBoundary: 'team' }) })
  editJson(path.join(dir, 'repo-access.v1.json'), (doc) => { doc.repos.inner = { readBoundary: 'team' } })
  git(dir, ['add', 'atelier.project.json', 'repo-access.v1.json'])
  git(dir, ['commit', '-qm', 'record the inner repository as a submodule and enrol it'])
  const { real, committed, errors } = graphFacts(dir)
  assert.ok(committed, errors.join('\n'))
  assert.deepEqual(committed.nodes.filter((node) => node.id === 'inner:note').map((node) => node.repo), ['inner'])
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.deepEqual(report.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
  assert.ok(real)
})

test('two repository declarations that resolve to one folder are refused', () => {
  const { project, shelf } = twoRootProject('knowledge/shelf', {}, { docs: true })
  const folder = path.join(shelf, 'content')
  const result = buildCommittedGraph({ argv: ['--project', path.join(project, 'atelier.project.json'), '--repo-path', `docs=${folder}`, '--repo-path', `content=${folder}`], cwd: project, env: {} })
  assert.equal(result.graph, null)
  assert.ok(has(result.errors, `repositories docs and content: both resolve to one folder (${folder})`), result.errors.join('\n'))
  const run = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--project', 'atelier.project.json', '--repo-path', `docs=${folder}`, '--repo-path', `content=${folder}`], { cwd: project, encoding: 'utf8' })
  assert.equal(run.status, 1)
})

test('a committed record outside the census with long front matter is indeterminate whatever its line endings', () => {
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.setup = { exclude: 'content/drafts' } })
  const record = fs.readFileSync(markPath(dir, WHEEL), 'utf8').replace('---\n', `---\n# ${'a'.repeat(256 * 1024)}\n`)
  assert.equal(validateMarkRecord(readMarkRecord(record)).ok, true)
  commitAll(dir, 'the census leaves drafts out')
  // Through Git's objects, so each record keeps its exact line endings.
  commitObjects(dir, [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']].map(([style, eol]) => ({ path: `content/drafts/${style}.md`, content: record.replaceAll('\n', eol) })), 'long records in a folder the census leaves out')
  git(dir, ['checkout', 'HEAD', '--', 'content/drafts'])
  const report = checkProject(dir)
  assert.deepEqual(report.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
  for (const style of ['LF', 'CRLF', 'CR']) {
    assert.ok(has(report.warnings, `content/drafts/${style}.md: is outside the knowledge graph's census, and the check cannot tell whether it is a mark record`), `${style}: ${report.warnings.join('\n')}`)
  }
})

test('the out-of-census scan reads Git in bounded batches and keeps only what each blob is', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-scan-'))
  git(repo, ['init', '-q'])
  const hash = (content) => String(spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: content }).stdout).trim()
  const record = fs.readFileSync(path.join(fixtureContent, 'marks', WHEEL), 'utf8')
  const oids = {
    mark: hash(record),
    cr: hash(record.replaceAll('\n', '\r')),
    plain: hash('---\ntitle: "Plain"\n---\n# Plain\n'),
    long: hash(record.replace('---\n', `---\n# ${'a'.repeat(300 * 1024)}\n`)),
    missing: 'f'.repeat(40),
  }
  const expected = { mark: 'mark', cr: 'mark', plain: 'other', long: 'indeterminate' }
  const batches = []
  const kinds = classifyBlobs(repo, Object.values(oids), { batchBytes: 1, onBatch: (bytes) => batches.push(bytes) })
  for (const [name, kind] of Object.entries(expected)) assert.equal(kinds.get(oids[name]), kind, name)
  assert.equal(kinds.has(oids.missing), false)
  // One blob per batch at this budget, and nothing larger than the limit.
  assert.equal(batches.length, 4)
  for (const bytes of batches) assert.ok(bytes <= 256 * 1024 + 128, String(bytes))
  assert.deepEqual(classifyBlobs(repo, Object.values(oids)), kinds)
})

// Findings from the confirmation review of 52302e1.

test('a nested repository reached through a link is checked against the enclosing HEAD where it really lies', { skip: process.platform === 'win32' && 'symbolic links' }, () => {
  for (const healthy of [false, true]) {
    const { dir } = pinnedProject()
    let real
    if (healthy) {
      // Nothing committed where the nested repository lies.
      real = path.join(dir, 'shelf')
      fs.writeFileSync(path.join(dir, '.gitignore'), 'shelf/\nlinked\n')
      commitAll(dir, 'ignore the nested repository and its link')
      fs.cpSync(path.join(dir, 'content'), path.join(real, 'content'), { recursive: true })
      git(real, ['init', '-q'])
      commitAll(real, 'the nested repository')
      const head = git(real, ['rev-parse', 'HEAD'])
      for (const name of [WHEEL, DRAWING, PADS]) editMark(real, name, (text) => text.replace(/revision: ".*"/, `revision: "${head}"`))
      commitAll(real, 'pin the nested marks')
    } else {
      // The enclosing HEAD holds the marks where the nested repository lies.
      real = path.join(dir, 'content')
      git(dir, ['sparse-checkout', 'set', '--no-cone', '/atelier.project.json', '/repo-access.v1.json'])
      fs.mkdirSync(real, { recursive: true })
      git(real, ['init', '-q'])
      fs.mkdirSync(path.join(real, 'content'))
      fs.writeFileSync(path.join(real, 'content', 'note.md'), '---\ntitle: "Inner"\n---\n# Inner\n')
      commitAll(real, 'another repository where the enclosing one commits')
    }
    // The managed folder is reached through a link to the nested repository.
    const linked = path.join(dir, 'linked')
    fs.symlinkSync(real, linked)
    const result = checkGraphmarks({ argv: ['--project', path.join(dir, 'atelier.project.json'), '--repo-path', `content=${path.join(linked, 'content')}`], cwd: dir, env: {} })
    if (healthy) {
      assert.equal(result.ok, true, result.errors.join('\n'))
      assert.deepEqual(result.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
    } else {
      assert.equal(result.ok, false)
      assert.ok(has(result.errors, `${linked}: is a Git repository where the enclosing repository ${dir} holds committed files at content in its HEAD`), result.errors.join('\n'))
    }
  }
})

test('two repository declarations naming one folder, one through a link, are refused', { skip: process.platform === 'win32' && 'symbolic links' }, () => {
  const { project, shelf } = twoRootProject('knowledge/shelf', {}, { docs: true })
  const folder = path.join(shelf, 'content')
  const alias = path.join(project, 'alias')
  fs.symlinkSync(folder, alias)
  const result = buildCommittedGraph({ argv: ['--project', path.join(project, 'atelier.project.json'), '--repo-path', `docs=${alias}`, '--repo-path', `content=${folder}`], cwd: project, env: {} })
  assert.equal(result.graph, null)
  assert.ok(has(result.errors, `repositories docs and content: both resolve to one folder (${alias} and ${folder})`), result.errors.join('\n'))
})

test('a pending change to a mark record the census leaves out is refused, and so is new Markdown beside it', () => {
  const { dir } = pinnedProject()
  editJson(path.join(dir, 'atelier.project.json'), (doc) => { doc.setup = { exclude: 'content/drafts' } })
  fs.mkdirSync(path.join(dir, 'content', 'drafts'))
  const excluded = path.join(dir, 'content', 'drafts', DRAWING)
  fs.copyFileSync(markPath(dir, DRAWING), excluded)
  commitAll(dir, 'a mark record the census leaves out')
  const before = checkProject(dir)
  assert.equal(before.ok, true, before.errors.join('\n'))
  assert.ok(has(before.warnings, `content/drafts/${DRAWING}: a committed mark record outside the knowledge graph's census`), before.warnings.join('\n'))
  // A staged editorial change to it, and an untracked neighbour.
  fs.writeFileSync(excluded, fs.readFileSync(excluded, 'utf8').replace('# Mark: the spoke tension drawing', '# Mark: the spoke tension drawing, edited'))
  git(dir, ['add', '--', excluded])
  fs.writeFileSync(path.join(dir, 'content', 'drafts', 'editorial-notes.md'), '---\ntitle: "Editorial notes"\n---\n# Editorial notes\n')
  const after = checkProject(dir)
  assert.equal(after.ok, false)
  assert.deepEqual(after.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
  assert.ok(has(after.errors, `content/drafts/${DRAWING}: pending mark: an uncommitted change (modified) to a committed mark record outside the census`), after.errors.join('\n'))
  assert.ok(has(after.errors, 'content/drafts/editorial-notes.md: pending mark: an uncommitted change (untracked) in a folder that holds marks'), after.errors.join('\n'))
})
