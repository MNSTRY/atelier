import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateEvidenceDocument } from '../src/evidence-navigation/contracts.mjs'
import { REPO_ACCESS_SCHEMA, buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { SNAPSHOT_PREFIX, checkGraphmarks, isPromisorRepository, readMarkRecord, reclaimAbandonedSnapshots, validateMarkRecord, withPrivateSnapshot } from '../src/graphmark/graphmark.mjs'
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
  assert.ok(has(report.warnings, 'content/marks/README.md: an uncommitted marks index change (untracked)'), report.warnings.join('\n'))
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

test('the committed snapshot is removed after the check', () => {
  const { dir } = pinnedProject()
  const snapshots = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('atelier-graphmark-snapshot-')).sort()
  const before = snapshots()
  assert.equal(checkProject(dir).ok, true)
  assert.deepEqual(snapshots(), before)
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

test('pending mark records are refused wherever they are, and pending index changes only warn', () => {
  const draft = (dir, name) => {
    fs.copyFileSync(markPath(dir, DRAWING), markPath(dir, name))
    editMark(dir, name, (text) => text.replace('repair-workshop:mark:2026-01-12-spoke-tension-drawing', `repair-workshop:mark:${name.replace(/\.md$/, '')}`).replace('    supports:\n      - "repair-workshop:mark:2026-01-12-order-of-wheel-checks"\n', ''))
  }
  // Staged, then deleted from the working tree (AD).
  const { dir } = pinnedProject()
  draft(dir, '2026-01-17-staged.md')
  git(dir, ['add', '--', markPath(dir, '2026-01-17-staged.md')])
  fs.rmSync(markPath(dir, '2026-01-17-staged.md'))
  const staged = checkProject(dir)
  assert.equal(staged.ok, false)
  assert.ok(has(staged.errors, '2026-01-17-staged.md: the mark record is not committed at HEAD (it is in the index)'), staged.errors.join('\n'))

  // An untracked mark larger than the old classification cap.
  const { dir: large } = pinnedProject()
  draft(large, '2026-01-17-large.md')
  fs.appendFileSync(markPath(large, '2026-01-17-large.md'), `\n${'A long body. '.repeat(200000)}\n`)
  const big = checkProject(large)
  assert.equal(big.ok, false)
  assert.ok(has(big.errors, '2026-01-17-large.md: the mark record is not committed at HEAD (it is in the working tree)'), big.errors.join('\n'))

  // A tracked note turned into a mark without committing.
  const { dir: turned } = pinnedProject()
  const note = path.join(turned, 'content', 'notes', 'wheel-checks.md')
  fs.writeFileSync(note, fs.readFileSync(note, 'utf8').replace('tags: [repair, wheels]', 'tags: [repair, wheels, graphmark]'))
  const pending = checkProject(turned)
  assert.equal(pending.ok, false)
  assert.ok(has(pending.errors, 'notes/wheel-checks.md: the mark record is not committed at HEAD (it is in the working tree)'), pending.errors.join('\n'))

  // Renaming the marks index, unstaged or staged, warns and verifies the committed marks.
  for (const stage of [false, true]) {
    const { dir: renamed } = pinnedProject()
    if (stage) git(renamed, ['mv', 'content/marks/README.md', 'content/marks/INDEX.md'])
    else fs.renameSync(path.join(renamed, 'content', 'marks', 'README.md'), path.join(renamed, 'content', 'marks', 'INDEX.md'))
    const report = checkProject(renamed)
    assert.equal(report.ok, true, `${stage ? 'staged' : 'unstaged'}: ${report.errors.join('\n')}`)
    assert.deepEqual(report.marks.map((mark) => mark.edition), ['intact', 'intact', 'intact'])
    assert.ok(has(report.warnings, 'content/marks/INDEX.md: an uncommitted marks index change'), report.warnings.join('\n'))
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

test('the snapshot is removed when its work throws or the process is signalled, and abandoned ones are reclaimed', async () => {
  let seen = null
  assert.throws(() => withPrivateSnapshot((base) => {
    seen = base
    fs.writeFileSync(path.join(base, 'partial'), 'x')
    throw new Error('construction failed')
  }), /construction failed/)
  assert.equal(fs.existsSync(seen), false)

  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { withPrivateSnapshot } from ${JSON.stringify(moduleUrl)}
withPrivateSnapshot((base) => { console.log(base); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000) })`], { stdio: ['ignore', 'pipe', 'inherit'] })
  const base = await new Promise((resolve) => child.stdout.once('data', (data) => resolve(data.toString().trim())))
  assert.equal(fs.existsSync(base), true)
  child.kill('SIGTERM')
  const [, signal] = await once(child, 'exit')
  assert.equal(signal, 'SIGTERM')
  assert.equal(fs.existsSync(base), false, 'the snapshot was removed before the signal ended the process')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graphmark-reclaim-'))
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'])
  try {
    for (const name of [`${SNAPSHOT_PREFIX}${dead}-AbC123`, `${SNAPSHOT_PREFIX}${sleeper.pid}-AbC123`, `other-${dead}-AbC123`]) fs.mkdirSync(path.join(tmp, name))
    fs.symlinkSync(tmp, path.join(tmp, `${SNAPSHOT_PREFIX}${dead}-LiNk00`))
    reclaimAbandonedSnapshots(tmp)
    assert.deepEqual(fs.readdirSync(tmp).sort(), [`${SNAPSHOT_PREFIX}${dead}-LiNk00`, `${SNAPSHOT_PREFIX}${sleeper.pid}-AbC123`, `other-${dead}-AbC123`].sort())
  } finally {
    sleeper.kill()
  }
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

test('paths a checkout could not hold faithfully are refused before anything is written', () => {
  const cases = [
    ['a case-insensitive collision', (dir) => {
      fs.writeFileSync(path.join(dir, 'content', 'notes', 'Parts.md'), '# Parts\n')
      fs.writeFileSync(path.join(dir, 'content', 'notes', 'parts.md'), '# parts\n')
    }, 'name one file on a case-insensitive or Unicode-normalising filesystem'],
    ['a normalisation collision', (dir) => {
      fs.writeFileSync(path.join(dir, 'content', 'notes', 'café.md'), '# NFC\n')
      fs.writeFileSync(path.join(dir, 'content', 'notes', 'café.md'), '# NFD\n')
    }, 'name one file on a case-insensitive or Unicode-normalising filesystem'],
    ['a name that is not UTF-8', (dir) => {
      fs.writeFileSync(Buffer.concat([Buffer.from(path.join(dir, 'content', 'notes', 'caf')), Buffer.from([0xe9]), Buffer.from('.txt')]), 'latin-1 name\n')
    }, 'a path that is not valid UTF-8'],
  ]
  for (const [label, make, message] of cases) {
    const { dir } = pinnedProject()
    make(dir)
    commitAll(dir, label)
    const report = checkProject(dir)
    assert.equal(report.ok, false, label)
    assert.ok(has(report.errors, 'cannot be written faithfully', message), `${label}: ${report.errors.join('\n')}`)
  }
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

test('the snapshot streams large files with bounded memory', () => {
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

test('the committed graph build does not look for repositories past its snapshot', () => {
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
