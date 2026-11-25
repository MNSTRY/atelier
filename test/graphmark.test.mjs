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

// Point a mark at a committed file: its path from the repository root, the
// digest of its committed bytes and the commit at HEAD.
function retarget(dir, name, objectId, extra = (text) => text) {
  const head = git(dir, ['rev-parse', 'HEAD'])
  editMark(dir, name, (text) => extra(text
    .replace(/objectId: ".*"/, `objectId: "${objectId}"`)
    .replace(/revision: ".*"/, `revision: "${head}"`)
    .replace(/contentDigest: ".*"/, `contentDigest: "${digest(fs.readFileSync(path.join(dir, objectId)))}"`)))
}

const markOf = (report, suffix) => report.marks.find((mark) => mark.id.endsWith(suffix))
const has = (list, ...parts) => list.some((line) => parts.every((part) => line.includes(part)))

test('the unpinned fixture is refused with a repair hint, and verifies once each revision names its commit', () => {
  const dir = projectFromFixture()
  const head = git(dir, ['rev-parse', 'HEAD'])
  const first = checkProject(dir)
  assert.equal(first.ok, false)
  assert.deepEqual(first.marks, [], 'a HEAD fallback is never an intact mark')
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
  assert.equal(markOf(report, 'pads-before-cable'), undefined)
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
  assert.deepEqual(report.marks.map((mark) => mark.id), ['repair-workshop:mark:2026-01-14-pads-before-cable'])
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
  assert.equal(markOf(report, 'order-of-wheel-checks'), undefined)
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
  assert.deepEqual(wheel.recover, ['git', 'cat-file', 'blob', `${head}:content/notes/wheel-checks.md`])
  assert.ok(has(report.warnings, `git cat-file blob '${head}:content/notes/wheel-checks.md'`), report.warnings.join('\n'))
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
  assert.equal(markOf(report, 'pads-before-cable'), undefined)
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
  assert.equal(markOf(edited, 'order-of-wheel-checks'), undefined)
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
  assert.ok(has(untracked.errors, '2026-01-16-untracked.md: the mark record is not committed at HEAD'), untracked.errors.join('\n'))
  git(dir, ['add', '-A'])
  const staged = checkProject(dir)
  assert.ok(has(staged.errors, '2026-01-16-untracked.md: the mark record is not committed at HEAD'), staged.errors.join('\n'))
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
  assert.equal(markOf(report, 'pads-before-cable'), undefined)
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
  assert.match(ok.stdout, /graphmark: 3 marks · 3 intact · 0 changed · 0 removed · 0 errors/)
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
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /atelier project config not found: .*atelier\.project\.json/)
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
  assert.ok(has(report.warnings, `git cat-file blob '${head}:content/captures/2026-01-14-brake-check-advice.md'`), report.warnings.join('\n'))
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
