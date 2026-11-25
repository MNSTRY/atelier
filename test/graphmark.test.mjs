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
  assert.equal(first.warnings.filter((warning) => warning.includes('revision example is not a commit in this repository; the edition is held at HEAD')).length, 3)

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
  // Not a graph node, so it is held to the repository's read boundary (team), which the team mark meets.
  assert.deepEqual(report.warnings.filter((warning) => warning.includes('order-of-wheel-checks')), [])
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


// Refusals and warnings from the independent review of this standard.

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

function retarget(dir, name, objectId, file, extra = (text) => text) {
  editMark(dir, name, (text) => extra(text
    .replace(/objectId: ".*"/, `objectId: "${objectId}"`)
    .replace(/contentDigest: ".*"/, `contentDigest: "${digest(fs.readFileSync(file))}"`)))
}

test('a mark whose target lies in another configured repository is refused', () => {
  const dir = projectFromFixture()
  addRepository(dir, 'vault', 'private', {
    'diary.md': '---\ntitle: "Diary"\nkg:\n  id: "vault:diary"\n  type: "document"\n  audience: "private"\n---\n# Diary\n\nA private sentence.\n',
  })
  commitAll(dir, 'a private sibling')
  retarget(dir, PADS, 'vault/diary.md', path.join(dir, 'vault', 'diary.md'), (text) => text.replace(/value: "The mechanic.*"/, 'value: "A private sentence."'))
  commitAll(dir, 'mark the sibling')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('lies in repository "vault", not in "content"')), report.errors.join('\n'))
})

test('a revision in the stash or no longer reachable does not hold an edition', () => {
  const dir = projectFromFixture()
  const note = path.join(dir, 'content', 'notes', 'wheel-checks.md')
  fs.appendFileSync(note, '\nA stashed line.\n')
  const stashedDigest = digest(fs.readFileSync(note))
  git(dir, ['stash'])
  editMark(dir, WHEEL, (text) => text.replace('revision: "example"', 'revision: "stash"').replace(/contentDigest: ".*"/, `contentDigest: "${stashedDigest}"`))
  commitAll(dir, 'mark a stashed edition')
  const stashed = checkProject(dir)
  assert.equal(stashed.ok, false)
  assert.ok(stashed.errors.some((error) => error.includes('not recoverable') && error.includes('revision stash is not a commit')), stashed.errors.join('\n'))

  const dir2 = projectFromFixture()
  fs.appendFileSync(path.join(dir2, 'content', 'notes', 'wheel-checks.md'), '\nA line later reset away.\n')
  commitAll(dir2, 'soon unreachable')
  const lost = git(dir2, ['rev-parse', 'HEAD'])
  const lostDigest = digest(fs.readFileSync(path.join(dir2, 'content', 'notes', 'wheel-checks.md')))
  git(dir2, ['reset', '-q', '--hard', 'HEAD~1'])
  editMark(dir2, WHEEL, (text) => text.replace('revision: "example"', `revision: "${lost}"`).replace(/contentDigest: ".*"/, `contentDigest: "${lostDigest}"`))
  commitAll(dir2, 'mark an unreachable edition')
  const unreachable = checkProject(dir2)
  assert.equal(unreachable.ok, false)
  assert.ok(unreachable.errors.some((error) => error.includes('is not reachable from HEAD or any branch or tag')), unreachable.errors.join('\n'))
})

test('a revision given as a name is accepted with a warning to record the commit id', () => {
  const dir = projectFromFixture()
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
  editMark(dir, DRAWING, (text) => text.replace('revision: "example"', `revision: "${branch}"`))
  commitAll(dir, 'name a branch')
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.ok(report.warnings.some((warning) => warning.includes(`revision ${branch} is a name or an abbreviation`)), report.warnings.join('\n'))
})

test('a removed file marked by its folder path is reported removed, with its recovery command', () => {
  const dir = projectFromFixture()
  const head = pinRevisions(dir)
  git(dir, ['rm', '-q', 'content/captures/2026-01-14-brake-check-advice.md'])
  editMark(dir, PADS, (text) => text.replace('"repair-workshop:captures:2026-01-14-brake-check-advice"', '"repair-workshop:notes:wheel-checks"'))
  commitAll(dir, 'remove the capture')
  const report = checkProject(dir)
  assert.equal(report.ok, true, report.errors.join('\n'))
  assert.equal(report.marks.find((mark) => mark.id.endsWith('pads-before-cable')).edition, 'removed')
  assert.ok(report.warnings.some((warning) => warning.includes(`git cat-file blob ${head}:content/captures/2026-01-14-brake-check-advice.md`)), report.warnings.join('\n'))
})

test('a selector type, version or whole value the standard does not define is refused', () => {
  const dir = projectFromFixture()
  editMark(dir, WHEEL, (text) => text.replace('type: "lines"', 'type: "line"'))
  editMark(dir, PADS, (text) => text.replace(/version: "1"/, 'version: "2"'))
  editMark(dir, DRAWING, (text) => text.replace('value: "*"', 'value: "lines 3-5"'))
  commitAll(dir, 'undefined selectors')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('selector type "line" is not one of whole, lines, text-quote')), report.errors.join('\n'))
  assert.ok(report.errors.some((error) => error.includes('selector text-quote version "2" is not 1')), report.errors.join('\n'))
  assert.ok(report.errors.some((error) => error.includes('selector whole must have the value "*"')), report.errors.join('\n'))
})

test('a marked file that is not a graph node is held to the repository read boundary', () => {
  const dir = projectFromFixture()
  fs.writeFileSync(path.join(dir, 'content', 'notes', 'parts.txt'), 'spokes, nipples, rim tape\n')
  commitAll(dir, 'a plain file')
  retarget(dir, DRAWING, 'notes/parts.txt', path.join(dir, 'content', 'notes', 'parts.txt'), (text) => text.replace('  audience: "team"', '  audience: "public"'))
  commitAll(dir, 'a public mark of a team file')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('wider than "team" of notes/parts.txt (the repository\'s read boundary)')), report.errors.join('\n'))
})

test('a symbolic link, a path into .git and a path out of the repository are refused', () => {
  const dir = projectFromFixture()
  fs.symlinkSync('wheel-checks.md', path.join(dir, 'content', 'notes', 'link.md'))
  commitAll(dir, 'a link')
  editMark(dir, WHEEL, (text) => text.replace('objectId: "notes/wheel-checks.md"', 'objectId: "notes/link.md"'))
  editMark(dir, DRAWING, (text) => text.replace('objectId: "drawings/spoke-tension.html"', 'objectId: ".git/config"'))
  editMark(dir, PADS, (text) => text.replace(/objectId: ".*"/, 'objectId: "../outside.md"'))
  commitAll(dir, 'escaping targets')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('notes/link.md') && (error.includes('symbolic link') || error.includes('not recoverable'))), report.errors.join('\n'))
  assert.ok(report.errors.some((error) => error.includes('points into .git')), report.errors.join('\n'))
  assert.ok(report.errors.some((error) => error.includes('leaves the repository')), report.errors.join('\n'))
})

test('an ambiguous quote warns, an overclaimed state warns, and belongs_to must name an index', () => {
  const dir = projectFromFixture()
  editMark(dir, PADS, (text) => text.replace(/value: "The mechanic.*"/, 'value: "the "').replace('markState: "recorded"', 'markState: "accepted"'))
  editMark(dir, DRAWING, (text) => text.replace('      - "repair-workshop:marks"', '      - "repair-workshop:notes:wheel-checks"'))
  commitAll(dir, 'ambiguity')
  const report = checkProject(dir)
  assert.ok(report.warnings.some((warning) => warning.includes('selector text-quote occurs')), report.warnings.join('\n'))
  assert.ok(report.warnings.some((warning) => warning.includes('markState "accepted" claims a verified edition')), report.warnings.join('\n'))
  assert.ok(report.errors.some((error) => error.includes('belongs_to repair-workshop:notes:wheel-checks is not a marks index')), report.errors.join('\n'))
})

test('a record tagged graphmark without front matter fields is refused, and unknown options exit 2', () => {
  const dir = projectFromFixture()
  fs.writeFileSync(markPath(dir, '2026-01-15-bare.md'), '---\ntitle: "Bare"\ntags: [graphmark]\nkg:\n  id: "repair-workshop:mark:2026-01-15-bare"\n  type: "evidence"\n  audience: "team"\n  relations:\n    belongs_to:\n      - "repair-workshop:marks"\n---\n# Bare\n')
  commitAll(dir, 'a bare mark')
  const report = checkProject(dir)
  assert.equal(report.ok, false)
  assert.ok(report.errors.some((error) => error.includes('2026-01-15-bare.md: atelier-graphmark@v1')), report.errors.join('\n'))
  const unknown = spawnSync(process.execPath, [binary, 'graphmark', 'check', '--jsn'], { cwd: dir, encoding: 'utf8' })
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /unknown option: --jsn/)
})
