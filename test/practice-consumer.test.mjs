import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import crypto from 'node:crypto'
import { CORPUS, LABELS, anchorChange, assess, citations, citedPaths, label, measure, parseDecisions } from '../scripts/practice-consumer/reconsider.mjs'

// Foundation's repository-local decision-practice consumer, exercised on a
// disposable git repository with invented decisions and sources.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts/practice-consumer/reconsider.mjs')

const CORPUS_TEXT = `# Invented decisions

## Layered example

The [example layering](layers.md) is the reference model. Reconsider it if a
proposed change needs a second writer.

| Artifact | Decision | Notes |
| --- | --- | --- |
| Invented record | Keep it separate | No citation here. |
`
const SOURCE = ['# Layers', '', 'Line one of the invented model.', 'Line two of the invented model.', 'Line three.', ''].join('\n')

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-consumer-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.email', 'foundation@example.invalid')
  git('config', 'user.name', 'Foundation')
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, CORPUS), CORPUS_TEXT)
  fs.writeFileSync(path.join(dir, 'docs/layers.md'), SOURCE)
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  const commit = (message, change) => {
    change()
    git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  return { dir, git, base: git('rev-parse', 'HEAD'), commit }
}

const outcome = (measurement) => measurement.decisions.find((item) => item.cited.length).outcomes[0]

test('the corpus parser finds prose and table decisions and only explicit links', () => {
  const decisions = parseDecisions(CORPUS_TEXT)
  assert.equal(decisions.length, 2)
  assert.deepEqual(decisions[0].cited, ['docs/layers.md'])
  assert.deepEqual(decisions[1].cited, [])
  assert.ok(decisions.every((item) => /^d-[a-z0-9-]+-[0-9a-f]{8}$/.test(item.id) && item.id.length <= 53))
})

test('an unrelated change stops on the false prerequisite and prepares nothing', (t) => {
  const r = repo(t)
  const head = r.commit('unrelated', () => fs.writeFileSync(path.join(r.dir, 'other.md'), 'x\n'))
  const value = outcome(measure({ repo: r.dir, pr: 1, base: r.base, head }))
  assert.equal(value.prerequisite, false)
  assert.deepEqual(value.assessment, { status: 'not-assessed', reason: 'prerequisite-false' })
  assert.equal(value.status, 'stop')
  assert.equal(value.reason, 'prerequisite-false')
  assert.equal(value.draftDigest, null)
})

test('a modified cited line proceeds to an unaccepted draft and the harness marks the decision', (t) => {
  const r = repo(t)
  const head = r.commit('modify', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed line two')))
  const measurement = measure({ repo: r.dir, pr: 2, base: r.base, head })
  const value = outcome(measurement)
  assert.deepEqual(value.assessment, { status: 'assessed', choice: 'affected' })
  assert.equal(value.status, 'proceed')
  assert.equal(value.reason, 'reconsideration-draft-prepared')
  assert.match(value.draftDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(value.harnessReconsider, true)
  assert.equal(measurement.summary.drafts, 1)
})

test('an addition only is unaffected and stops by the adopted rubric', (t) => {
  const r = repo(t)
  const head = r.commit('append', () => fs.appendFileSync(path.join(r.dir, 'docs/layers.md'), 'An added line.\n'))
  const value = outcome(measure({ repo: r.dir, pr: 3, base: r.base, head }))
  assert.deepEqual(value.assessment, { status: 'assessed', choice: 'unaffected' })
  assert.equal(value.status, 'stop')
  assert.equal(value.reason, 'rubric-disposition')
})

test('a removed or binary source abstains with its reason recorded and escalates', (t) => {
  const removed = repo(t)
  const gone = removed.commit('remove', () => fs.rmSync(path.join(removed.dir, 'docs/layers.md')))
  const a = outcome(measure({ repo: removed.dir, pr: 4, base: removed.base, head: gone }))
  assert.deepEqual(a.assessment, { status: 'abstained', reason: 'insufficient-evidence' })
  assert.equal(a.status, 'escalate')
  assert.equal(a.reason, 'rubric-abstained')
  const binary = repo(t)
  const bin = binary.commit('binary', () => fs.writeFileSync(path.join(binary.dir, 'docs/layers.md'), Buffer.from([0, 1, 2, 3])))
  const b = outcome(measure({ repo: binary.dir, pr: 5, base: binary.base, head: bin }))
  assert.deepEqual(b.assessment, { status: 'abstained', reason: 'insufficient-evidence' })
  assert.equal(b.status, 'escalate')
})

test('the assessment is the declared predicate', () => {
  assert.deepEqual(assess({ binary: false, removed: 1, added: 0 }), { status: 'assessed', choice: 'affected' })
  assert.deepEqual(assess({ binary: false, removed: 0, added: 2 }), { status: 'assessed', choice: 'unaffected' })
  assert.deepEqual(assess({ binary: false, removed: 0, added: 0 }), { status: 'assessed', choice: 'unclear' })
  assert.deepEqual(assess({ binary: true, removed: 0, added: 0 }), { status: 'abstained', reason: 'insufficient-evidence' })
  assert.deepEqual(assess({ binary: false, removed: 1, added: 1, oversize: true }), { status: 'abstained', reason: 'insufficient-evidence' })
})

test('measuring changes nothing in the repository; the CLI appends one line', (t) => {
  const r = repo(t)
  const head = r.commit('modify', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line one', 'Changed one')))
  const before = r.git('status', '--porcelain', '--ignored')
  const out = path.join(r.dir, '..', `${path.basename(r.dir)}-measurements.jsonl`)
  t.after(() => fs.rmSync(out, { force: true }))
  const run = spawnSync(process.execPath, [SCRIPT, 'measure', '--pr', '6', '--base', r.base, '--head', head, '--repo', r.dir, '--out', out], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(r.git('status', '--porcelain', '--ignored'), before)
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).summary.drafts, 1)
  const refused = spawnSync(process.execPath, [SCRIPT, 'measure', '--pr', '6', '--base', 'HEAD', '--head', head, '--repo', r.dir, '--out', out], { encoding: 'utf8' })
  assert.equal(refused.status, 2)
  assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 1)
})

test('labels name who labelled them and the exact outcome they judge', (t) => {
  const decision = 'd-layered-example-0123abcd'
  const measurement = `sha256:${'a'.repeat(64)}`
  const base = { pr: 1, decision, file: 'docs/layers.md', measurement, reviewMinutes: 0, by: 'atelier-foundation' }
  for (const value of LABELS) assert.equal(label({ ...base, value }).label, value)
  assert.throws(() => label({ ...base, value: 'accepted' }), /label must be one of/)
  assert.throws(() => label({ ...base, value: 'correct', reviewMinutes: -1 }), /nonnegative/)
  assert.throws(() => label({ ...base, value: 'correct', by: undefined }), /by must name/)
  assert.throws(() => label({ ...base, value: 'correct', pr: '1e2' }), /pr must be/)
  assert.throws(() => label({ ...base, value: 'correct', decision: undefined }), /decision must be/)
  assert.throws(() => label({ ...base, value: 'correct', file: '' }), /file must name/)
  assert.throws(() => label({ ...base, value: 'correct', measurement: 'x' }), /measurement must be/)
  // The CLI binds a label to the latest measurement of that pull request and to one outcome.
  const r = repo(t)
  const head = r.commit('modify', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-labels-')), 'm.jsonl')
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }))
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--out', out], { encoding: 'utf8' })
  assert.equal(cli('label', '--pr', '11', '--decision', 'd-a-0123abcd', '--file', 'docs/layers.md', '--label', 'correct', '--minutes', '1', '--by', 'atelier-foundation').status, 2)
  assert.equal(cli('measure', '--pr', '11', '--base', r.base, '--head', head, '--repo', r.dir).status, 0)
  const measured = JSON.parse(fs.readFileSync(out, 'utf8').trim())
  const id = measured.decisions.find((item) => item.cited.length).id
  assert.equal(cli('label', '--pr', '11', '--decision', id, '--file', 'docs/other.md', '--label', 'correct', '--minutes', '1', '--by', 'atelier-foundation').status, 2)
  assert.equal(cli('label', '--pr', '11', '--decision', id, '--file', 'docs/layers.md', '--label', 'false-alarm', '--minutes', '1', '--by', 'atelier-foundation').status, 0)
  const labelled = JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n').at(-1))
  assert.equal(labelled.file, 'docs/layers.md')
  assert.match(labelled.measurement, /^sha256:[0-9a-f]{64}$/)
})

test('a measurement does not depend on the working directory', (t) => {
  const r = repo(t)
  const head = r.commit('modify', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  r.git('config', 'diff.relative', 'true')
  const fromTop = outcome(measure({ repo: r.dir, pr: 12, base: r.base, head }))
  const fromSub = outcome(measure({ repo: path.join(r.dir, 'docs'), pr: 12, base: r.base, head }))
  assert.deepEqual(fromSub.change, fromTop.change)
  assert.deepEqual(fromSub.assessment, { status: 'assessed', choice: 'affected' })
})

test('pathspec and replace-object variables in the caller environment do not change a measurement', (t) => {
  const r = repo(t)
  const head = r.commit('modify', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-env-')), 'm.jsonl')
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }))
  for (const extra of [{ GIT_LITERAL_PATHSPECS: '1' }, { GIT_ICASE_PATHSPECS: '1' }, { GIT_GLOB_PATHSPECS: '1' }]) {
    const run = spawnSync(process.execPath, [SCRIPT, 'measure', '--pr', '15', '--base', r.base, '--head', head, '--repo', r.dir, '--print'], { encoding: 'utf8', env: { ...process.env, ...extra } })
    assert.equal(run.status, 0, run.stderr)
    const value = JSON.parse(run.stdout).decisions.find((item) => item.cited.length).outcomes[0]
    assert.deepEqual(value.change, { removed: 1, added: 1, binary: false }, JSON.stringify(extra))
  }
})

test('a cited file replaced by a directory at the head counts as removed', (t) => {
  const r = repo(t)
  const head = r.commit('replace with a directory', () => {
    fs.rmSync(path.join(r.dir, 'docs/layers.md'))
    fs.mkdirSync(path.join(r.dir, 'docs/layers.md'))
    fs.writeFileSync(path.join(r.dir, 'docs/layers.md/inner.md'), 'inner\n')
  })
  const value = outcome(measure({ repo: r.dir, pr: 16, base: r.base, head }))
  assert.deepEqual(value.assessment, { status: 'abstained', reason: 'insufficient-evidence' })
  assert.equal(value.status, 'escalate')
})

test('attributes cannot make a text source binary', (t) => {
  const r = repo(t)
  r.commit('attributes', () => fs.writeFileSync(path.join(r.dir, '.gitattributes'), '*.md binary\n'))
  const base = r.git('rev-parse', 'HEAD')
  r.git('config', 'core.bigFileThreshold', '1')
  const head = r.commit('modify', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  const value = outcome(measure({ repo: r.dir, pr: 13, base, head }))
  assert.deepEqual(value.change, { removed: 1, added: 1, binary: false })
  assert.deepEqual(value.assessment, { status: 'assessed', choice: 'affected' })
})

test('a cited directory is not evaluated rather than silently stopping', (t) => {
  const r = repo(t)
  const base = r.commit('cite a directory', () => {
    fs.mkdirSync(path.join(r.dir, 'docs/parts'))
    fs.writeFileSync(path.join(r.dir, 'docs/parts/one.md'), 'one\n')
    fs.writeFileSync(path.join(r.dir, CORPUS), CORPUS_TEXT.replace('[example layering](layers.md)', '[example parts](parts)'))
  })
  const head = r.commit('change inside', () => fs.writeFileSync(path.join(r.dir, 'docs/parts/one.md'), 'changed\n'))
  const value = measure({ repo: r.dir, pr: 14, base, head }).decisions.find((item) => item.cited.length).outcomes[0]
  assert.deepEqual(value, { file: 'docs/parts', anchor: null, status: 'not-evaluated', reason: 'cited-path-not-a-file' })
})

test('a renamed cited source escalates instead of looking unchanged', (t) => {
  const r = repo(t)
  const head = r.commit('rename', () => r.git('mv', 'docs/layers.md', 'docs/moved-layers.md'))
  const value = outcome(measure({ repo: r.dir, pr: 7, base: r.base, head }))
  assert.equal(value.prerequisite, true)
  assert.deepEqual(value.assessment, { status: 'abstained', reason: 'insufficient-evidence' })
  assert.equal(value.status, 'escalate')
})

test('repository diff settings cannot turn additions into removals', (t) => {
  const r = repo(t)
  r.git('config', 'diff.interHunkContext', '20')
  r.git('config', 'diff.renames', 'copies')
  const head = r.commit('two additions', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line one of the invented model.', 'Line one of the invented model.\nAdded A.').replace('Line three.', 'Line three.\nAdded B.')))
  const value = outcome(measure({ repo: r.dir, pr: 8, base: r.base, head }))
  assert.deepEqual(value.change, { removed: 0, added: 2, binary: false })
  assert.deepEqual(value.assessment, { status: 'assessed', choice: 'unaffected' })
})

test('a pull request is measured from its merge base, and an unchanged source is not assessed', (t) => {
  const r = repo(t)
  const branch = r.commit('unrelated', () => fs.writeFileSync(path.join(r.dir, 'other.md'), 'x\n'))
  r.git('checkout', '-q', '-b', 'side', r.base)
  const side = r.commit('side change to the source', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Side two')))
  const measured = measure({ repo: r.dir, pr: 9, base: side, head: branch })
  assert.equal(measured.mergeBase, r.base)
  assert.equal(measured.base, side)
  const value = outcome(measured)
  assert.equal(value.prerequisite, false)
  assert.deepEqual(value.assessment, { status: 'not-assessed', reason: 'prerequisite-false' })
  assert.match(measured.definitionDigest, /^sha256:[0-9a-f]{64}$/)
})

test('citations exclude schemes, absolute paths and escapes from the repository', () => {
  assert.deepEqual(citedPaths('[a](https://example.invalid/x.md) [b](/etc/x.md) [c](../../outside.md) [d](layers.md#part)'), ['docs/layers.md'])
})

test('a change larger than the excerpt bound abstains', (t) => {
  const r = repo(t)
  const long = Array.from({ length: 300 }, (_, index) => `Line ${index}`).join('\n')
  const base = r.commit('long source', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), `${long}\n`))
  const head = r.commit('rewrite', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), `${long.replaceAll('Line', 'Row')}\n`))
  const value = outcome(measure({ repo: r.dir, pr: 10, base, head }))
  assert.deepEqual(value.assessment, { status: 'abstained', reason: 'insufficient-evidence' })
})

test('measure and the CLI refuse malformed arguments', (t) => {
  const r = repo(t)
  const never = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-never-')), 'never.jsonl')
  t.after(() => fs.rmSync(path.dirname(never), { recursive: true, force: true }))
  assert.throws(() => measure({ repo: r.dir, pr: 1, base: 'HEAD', head: r.base }), /full commit ids/)
  assert.throws(() => measure({ repo: r.dir, pr: 0, base: r.base, head: r.base }), /positive integer/)
  assert.throws(() => measure({ repo: r.dir, pr: '1e2', base: r.base, head: r.base }), /positive integer/)
  assert.throws(() => measure({ repo: r.dir, pr: 1, base: r.base, head: r.base, mode: 'guess' }), /live or retrospective/)
  for (const args of [['measure', '--pr', 'x', '--base', r.base, '--head', r.base], ['measure', '--pr', '1', '--base', r.base, '--head', r.base, '--mode', 'guess'],
    ['label', '--pr', '1', '--decision', 'd-a-0123abcd', '--label', 'correct', '--minutes'], ['label', '--pr', '1', '--decision', 'd-a-0123abcd', '--label', 'correct', '--minutes', '1'],
    ['measure', '--pr', '0x6f', '--base', r.base, '--head', r.base]]) {
    const run = spawnSync(process.execPath, [SCRIPT, ...args, '--repo', r.dir, '--out', never], { encoding: 'utf8' })
    assert.equal(run.status, 2, args.join(' '))
  }
  assert.equal(fs.existsSync(never), false)
  // A bare --out must not fall back to the committed measurements file.
  const bare = spawnSync(process.execPath, [SCRIPT, 'measure', '--pr', '1', '--base', r.base, '--head', r.base, '--repo', r.dir, '--out'], { encoding: 'utf8' })
  assert.equal(bare.status, 2)
})

test('the CLI measures when invoked through a symlinked path, and importing it runs nothing', (t) => {
  const r = repo(t)
  const head = r.commit('modify', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  const links = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-links-'))
  t.after(() => fs.rmSync(links, { recursive: true, force: true }))
  const args = ['measure', '--pr', '16', '--base', r.base, '--head', head, '--repo', r.dir, '--print']
  const run = (script) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: links })
  const direct = run(SCRIPT)
  assert.equal(direct.status, 0, direct.stderr)
  const expected = JSON.parse(direct.stdout)
  assert.equal(expected.summary.drafts, 1)
  const same = (label, script) => {
    const linked = run(script)
    assert.equal(linked.status, 0, `${label}: ${linked.stderr}`)
    assert.notEqual(linked.stdout, '', `${label}: the command printed nothing`)
    const value = JSON.parse(linked.stdout)
    assert.deepEqual({ ...value, measuredAt: null }, { ...expected, measuredAt: null }, label)
  }
  // A linked checkout: the repository root reached through a directory link.
  const root = path.join(links, 'root')
  fs.symlinkSync(ROOT, root, process.platform === 'win32' ? 'junction' : 'dir')
  same('directory link', path.join(root, 'scripts/practice-consumer/reconsider.mjs'))
  // A link to the script itself, where the platform allows file links.
  const file = path.join(links, 'reconsider.mjs')
  try {
    fs.symlinkSync(SCRIPT, file, 'file')
  } catch (error) {
    if (error.code !== 'EPERM') throw error
    t.diagnostic('file symlinks need a privilege this host lacks')
    return
  }
  same('file link', file)
  // Importing the module, through either path, measures and writes nothing.
  for (const target of [SCRIPT, file]) {
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(target).href)})`], { encoding: 'utf8', cwd: links })
    assert.equal(imported.status, 0, imported.stderr)
    assert.equal(imported.stdout, '')
  }
})

// Line anchors: GitHub #L fragments become the existing text-lines@1 selector.
const sha = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`
const anchoredRepo = (t, fragment = '#L3-L4', source = SOURCE) => {
  const r = repo(t)
  const base = r.commit('anchor', () => {
    fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), source)
    fs.writeFileSync(path.join(r.dir, CORPUS), CORPUS_TEXT.replace('(layers.md)', `(layers.md${fragment})`))
  })
  return { ...r, base }
}
const lines = (...items) => [...items, ''].join('\n')

test('citations translate #L anchors and refuse every other fragment without widening it', () => {
  const cite = (target) => citations(`see [x](${target})`)
  assert.deepEqual(cite('layers.md'), [{ file: 'docs/layers.md', anchor: null }])
  assert.deepEqual(cite('layers.md#L3-L4'), [{ file: 'docs/layers.md', anchor: { start: 3, end: 4, value: 'lines:3-4' } }])
  assert.deepEqual(cite('layers.md#L4'), [{ file: 'docs/layers.md', anchor: { start: 4, end: 4, value: 'lines:4-4' } }])
  for (const fragment of ['heading', 'L0', 'L01', 'L1-2', 'l3', 'L3-L', 'L3-L4-L5', '']) assert.equal(cite(`layers.md#${fragment}`)[0].refusal, 'cited-anchor-unsupported', fragment)
  for (const fragment of ['L5-L3', 'L99999999999999999999']) assert.equal(cite(`layers.md#${fragment}`)[0].refusal, 'cited-anchor-malformed', fragment)
  assert.equal(cite('layers.md#heading')[0].anchor, null)
  // The same file anchored twice is two citations; citedPaths still names the file once.
  assert.equal(citations('[a](layers.md#L1-L2) [b](layers.md#L3-L4) [c](layers.md#L1-L2)').length, 2)
  assert.deepEqual(citedPaths('[a](layers.md#L1-L2) [b](layers.md#heading)'), ['docs/layers.md'])
})

test('anchor relevance uses base hunk coordinates and explicit insertion boundaries', () => {
  // A hunk as git reports it: old start and count, new start and count.
  const at = (oldStart, oldCount, newStart, newCount) => ({ oldStart, oldCount, newStart, newCount, removed: oldCount, added: newCount })
  const anchor = { start: 10, end: 12 }
  // A modified line inside.
  assert.deepEqual(anchorChange([at(11, 1, 11, 1)], anchor), { removed: 1, added: 1, outside: false, head: { start: 10, end: 12 }, reanchor: true })
  // Insertions directly before (after line 9) and directly after (after line 12) are outside.
  assert.deepEqual(anchorChange([at(9, 0, 10, 2)], anchor), { removed: 0, added: 0, outside: true, head: { start: 12, end: 14 }, reanchor: true })
  assert.deepEqual(anchorChange([at(12, 0, 13, 2)], anchor), { removed: 0, added: 0, outside: true, head: { start: 10, end: 12 }, reanchor: false })
  // An insertion between anchored lines is inside, as additions only.
  assert.deepEqual(anchorChange([at(10, 0, 11, 1)], anchor), { removed: 0, added: 1, outside: false, head: { start: 10, end: 13 }, reanchor: true })
  // A change below the anchor leaves it in place.
  assert.deepEqual(anchorChange([at(20, 1, 20, 1)], anchor), { removed: 0, added: 0, outside: true, head: { start: 10, end: 12 }, reanchor: false })
  // Hunks crossing an endpoint: only the anchored lines count, and each endpoint
  // maps through the crossing hunk's new lines.
  assert.deepEqual(anchorChange([at(8, 4, 7, 0)], anchor), { removed: 2, added: 0, outside: false, head: { start: 8, end: 8 }, reanchor: true })
  assert.deepEqual(anchorChange([at(12, 5, 11, 0)], anchor), { removed: 1, added: 0, outside: false, head: { start: 10, end: 11 }, reanchor: true })
  assert.deepEqual(anchorChange([at(8, 3, 8, 1)], anchor), { removed: 1, added: 1, outside: false, head: { start: 8, end: 10 }, reanchor: true })
  assert.deepEqual(anchorChange([at(18, 10, 17, 0)], { start: 10, end: 20 }).head, { start: 10, end: 17 })
  assert.deepEqual(anchorChange([at(1, 3, 0, 0)], { start: 2, end: 5 }).head, { start: 1, end: 2 })
  // Hunks above the anchor that cancel out leave it in place: nothing to re-anchor.
  assert.deepEqual(anchorChange([at(2, 1, 1, 0), at(5, 0, 5, 1)], anchor), { removed: 0, added: 0, outside: true, head: { start: 10, end: 12 }, reanchor: false })
  // Several hunks interacting with a wider anchor.
  assert.deepEqual(anchorChange([at(8, 4, 8, 2), at(14, 0, 13, 3), at(18, 8, 18, 0)], { start: 10, end: 20 }).head, { start: 8, end: 18 })
  // Removing every anchored line leaves no head lines.
  assert.equal(anchorChange([at(10, 3, 9, 0)], anchor).head, null)
  assert.equal(anchorChange([at(9, 5, 8, 0)], anchor).head, null)
})

test('a change inside an anchor drafts; a change only outside stops and still reports re-anchoring', (t) => {
  const inside = anchoredRepo(t)
  const changedHead = inside.commit('inside', () => fs.writeFileSync(path.join(inside.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  const m = measure({ repo: inside.dir, pr: 30, base: inside.base, head: changedHead })
  const hit = outcome(m)
  assert.equal(m.schema, 'atelier-practice-consumer-measurement@v1')
  assert.equal(hit.status, 'proceed')
  assert.deepEqual(hit.change, { removed: 1, added: 1, binary: false })
  assert.deepEqual(hit.anchor.base, { owner: 'atelier-root', objectId: 'docs/layers.md', revision: inside.base, selector: { type: 'text-lines', version: '1', value: 'lines:3-4' }, contentDigest: sha('Line one of the invented model.\nLine two of the invented model.') })
  assert.deepEqual(hit.anchor.head, { owner: 'atelier-root', objectId: 'docs/layers.md', revision: changedHead, selector: { type: 'text-lines', version: '1', value: 'lines:3-4' }, contentDigest: sha('Line one of the invented model.\nChanged two of the invented model.') })
  assert.equal(hit.anchor.reanchor, true)
  assert.equal(m.summary.reanchors, 1)

  // Lines added above the anchor move it: no draft, but the re-anchor is reported.
  const above = anchoredRepo(t)
  const movedHead = above.commit('above', () => fs.writeFileSync(path.join(above.dir, 'docs/layers.md'), SOURCE.replace('# Layers\n', '# Layers\nA new first paragraph.\n')))
  const moved = outcome(measure({ repo: above.dir, pr: 31, base: above.base, head: movedHead }))
  assert.equal(moved.prerequisite, false)
  assert.equal(moved.status, 'stop')
  assert.equal(moved.anchor.outsideChanges, true)
  assert.equal(moved.anchor.reanchor, true)
  assert.equal(moved.anchor.head.selector.value, 'lines:4-5')
  assert.equal(moved.anchor.head.contentDigest, moved.anchor.base.contentDigest)

  // A change below the anchor neither drafts nor moves it.
  const below = anchoredRepo(t)
  const belowHead = below.commit('below', () => fs.writeFileSync(path.join(below.dir, 'docs/layers.md'), SOURCE.replace('Line three.', 'Line three, changed.')))
  const still = outcome(measure({ repo: below.dir, pr: 32, base: below.base, head: belowHead }))
  assert.deepEqual([still.status, still.anchor.outsideChanges, still.anchor.reanchor, still.anchor.head.selector.value], ['stop', true, false, 'lines:3-4'])
})

test('anchors refuse out-of-range and unsupported citations, and a removed file escalates', (t) => {
  const far = anchoredRepo(t, '#L6-L9')
  const farHead = far.commit('edit', () => fs.writeFileSync(path.join(far.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'X')))
  assert.deepEqual(outcome(measure({ repo: far.dir, pr: 33, base: far.base, head: farHead })), { file: 'docs/layers.md', anchor: { value: 'lines:6-9', base: null, head: null, outsideChanges: false, reanchor: false }, status: 'not-evaluated', reason: 'cited-anchor-out-of-range' })
  // The split keeps a final empty element after the last LF: line 6 exists.
  const last = anchoredRepo(t, '#L6')
  const lastHead = last.commit('edit', () => fs.writeFileSync(path.join(last.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'X')))
  assert.equal(outcome(measure({ repo: last.dir, pr: 34, base: last.base, head: lastHead })).anchor.base.contentDigest, sha(''))
  // An unsupported fragment is refused even though the file changed: no whole-file fallback.
  const named = anchoredRepo(t, '#layers')
  const namedHead = named.commit('edit', () => fs.writeFileSync(path.join(named.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'X')))
  const refused = measure({ repo: named.dir, pr: 35, base: named.base, head: namedHead })
  assert.deepEqual(outcome(refused), { file: 'docs/layers.md', anchor: null, fragment: 'layers', status: 'not-evaluated', reason: 'cited-anchor-unsupported' })
  assert.equal(refused.summary.drafts, 0)
  // Renames are not followed: the file is absent at the head, so the anchor escalates.
  const gone = anchoredRepo(t)
  const goneHead = gone.commit('move', () => fs.renameSync(path.join(gone.dir, 'docs/layers.md'), path.join(gone.dir, 'docs/moved.md')))
  const lost = outcome(measure({ repo: gone.dir, pr: 36, base: gone.base, head: goneHead }))
  assert.deepEqual([lost.status, lost.assessment.reason, lost.anchor.head, lost.anchor.reanchor], ['escalate', 'insufficient-evidence', null, true])
})

test('anchored text keeps CR and BOM bytes; only LF separates lines', (t) => {
  const crlf = '﻿# Layers\r\n\r\nLine one.\r\nLine two.\r\n'
  const r = anchoredRepo(t, '#L1-L3', crlf)
  const head = r.commit('edit', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), crlf.replace('Line two.', 'Changed.')))
  assert.equal(outcome(measure({ repo: r.dir, pr: 37, base: r.base, head })).anchor.base.contentDigest, sha('﻿# Layers\r\n\r\nLine one.\r'))
})

test('a label names the anchor it judges, and a file cited twice needs --anchor', (t) => {
  const r = repo(t)
  const base = r.commit('two anchors', () => fs.writeFileSync(path.join(r.dir, CORPUS), CORPUS_TEXT.replace('(layers.md)', '(layers.md#L3) and [more](layers.md#L4)')))
  const head = r.commit('edit', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-anchor-labels-')), 'm.jsonl')
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }))
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--out', out], { encoding: 'utf8' })
  assert.equal(cli('measure', '--pr', '38', '--base', base, '--head', head, '--repo', r.dir).status, 0)
  const measured = JSON.parse(fs.readFileSync(out, 'utf8').trim())
  const decision = measured.decisions.find((item) => item.cited.length)
  assert.deepEqual(decision.outcomes.map((item) => [item.anchor.base.selector.value, item.status]), [['lines:3-3', 'stop'], ['lines:4-4', 'proceed']])
  const base3 = ['label', '--pr', '38', '--decision', decision.id, '--file', 'docs/layers.md', '--label', 'correct', '--minutes', '1', '--by', 'atelier-foundation']
  const ambiguous = cli(...base3)
  assert.equal(ambiguous.status, 2)
  assert.match(ambiguous.stderr, /name the --anchor/)
  assert.equal(cli(...base3, '--anchor', 'lines:9-9').status, 2)
  assert.equal(cli(...base3, '--anchor', 'lines:4-4').status, 0)
  const labelled = JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n').at(-1))
  assert.deepEqual([labelled.schema, labelled.anchor], ['atelier-practice-consumer-label@v1', 'lines:4-4'])
  assert.throws(() => label({ pr: 1, decision: decision.id, file: 'docs/layers.md', anchor: 'L4', measurement: `sha256:${'a'.repeat(64)}`, value: 'correct', reviewMinutes: 0, by: 'atelier-foundation' }), /anchor must be/)
})

test('a git change crossing an anchor endpoint maps the surviving head lines exactly', (t) => {
  const numbered = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`))
  const cross = (fragment, edit) => {
    const r = anchoredRepo(t, fragment, numbered)
    const head = r.commit('cross', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), edit(numbered.split('\n')).join('\n')))
    return outcome(measure({ repo: r.dir, pr: 40, base: r.base, head }))
  }
  // Deleting old lines 8-11 crosses the start of lines 10-12: old line 12 survives as head line 8.
  const atStart = cross('#L10-L12', (all) => [...all.slice(0, 7), ...all.slice(11)])
  assert.deepEqual([atStart.status, atStart.anchor.head.selector.value, atStart.anchor.head.contentDigest], ['proceed', 'lines:8-8', sha('line 12')])
  // Deleting old lines 12-16 crosses the end: old lines 10-11 survive in place.
  const atEnd = cross('#L10-L12', (all) => [...all.slice(0, 11), ...all.slice(16)])
  assert.deepEqual([atEnd.status, atEnd.anchor.head.selector.value, atEnd.anchor.head.contentDigest], ['proceed', 'lines:10-11', sha('line 10\nline 11')])
  // The draft quotes the surviving lines, never a claim that all were removed.
  assert.equal(atEnd.change.removed, 1)
})

test('an anchored range the head no longer has is lost, not unchanged', (t) => {
  // #L6 is the empty line after the final LF; a head without the final LF has five lines.
  const r = anchoredRepo(t, '#L6')
  const head = r.commit('drop final newline', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace(/\n$/, '')))
  const value = outcome(measure({ repo: r.dir, pr: 41, base: r.base, head }))
  assert.equal(value.prerequisite, true)
  assert.deepEqual([value.status, value.assessment], ['escalate', { status: 'assessed', choice: 'unclear' }])
  assert.deepEqual([value.anchor.head, value.anchor.reanchor], [null, true])
})

test('anchored over-bounds, binary, oversize-at-head and mode-only cases are bounded', (t) => {
  const long = lines(...Array.from({ length: 130 }, (_, index) => `row ${index + 1}`))
  const over = anchoredRepo(t, '#L1-L121', long)
  const overHead = over.commit('edit', () => fs.writeFileSync(path.join(over.dir, 'docs/layers.md'), long.replace('row 2\n', 'row two\n')))
  assert.equal(outcome(measure({ repo: over.dir, pr: 42, base: over.base, head: overHead })).reason, 'cited-anchor-over-bounds')
  // Growing an anchor past the excerpt bound at the head abstains; the head reference names the whole mapped range.
  const grow = anchoredRepo(t, '#L1-L100', long)
  const grown = long.split('\n')
  grown.splice(50, 0, ...Array.from({ length: 30 }, (_, index) => `new ${index}`))
  const growHead = grow.commit('grow', () => fs.writeFileSync(path.join(grow.dir, 'docs/layers.md'), grown.join('\n')))
  const big = outcome(measure({ repo: grow.dir, pr: 43, base: grow.base, head: growHead }))
  assert.deepEqual([big.status, big.assessment.reason, big.anchor.head.selector.value], ['escalate', 'insufficient-evidence', 'lines:1-130'])
  // An anchored source that becomes binary escalates and needs re-anchoring.
  const bin = anchoredRepo(t)
  const binHead = bin.commit('binary', () => fs.writeFileSync(path.join(bin.dir, 'docs/layers.md'), Buffer.from([0, 1, 2])))
  const binary = outcome(measure({ repo: bin.dir, pr: 44, base: bin.base, head: binHead }))
  assert.deepEqual([binary.status, binary.anchor.head, binary.anchor.reanchor], ['escalate', null, true])
  // A mode-only change touches no anchored line: stop, nothing to re-anchor.
  const mode = anchoredRepo(t)
  const modeHead = mode.commit('mode', () => fs.chmodSync(path.join(mode.dir, 'docs/layers.md'), 0o755))
  if (mode.git('diff', '--name-only', mode.base, modeHead)) {
    const same = outcome(measure({ repo: mode.dir, pr: 45, base: mode.base, head: modeHead }))
    assert.deepEqual([same.status, same.anchor.reanchor], ['stop', false])
  } else t.diagnostic('this filesystem does not record the executable bit')
})

test('a whole-file citation stays labellable beside an anchored or refused citation of the same file', (t) => {
  const r = repo(t)
  const base = r.commit('mixed', () => fs.writeFileSync(path.join(r.dir, CORPUS), CORPUS_TEXT.replace('(layers.md)', '(layers.md), [line](layers.md#L4) and [section](layers.md#intro)')))
  const head = r.commit('edit', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-practice-mixed-labels-')), 'm.jsonl')
  t.after(() => fs.rmSync(path.dirname(out), { recursive: true, force: true }))
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--out', out], { encoding: 'utf8' })
  assert.equal(cli('measure', '--pr', '46', '--base', base, '--head', head, '--repo', r.dir).status, 0)
  const decision = JSON.parse(fs.readFileSync(out, 'utf8').trim()).decisions.find((item) => item.cited.length)
  assert.deepEqual(decision.outcomes.map((item) => [item.anchor?.value ?? null, item.fragment ?? null, item.status]), [[null, null, 'proceed'], ['lines:4-4', null, 'proceed'], [null, 'intro', 'not-evaluated']])
  const common = ['label', '--pr', '46', '--decision', decision.id, '--file', 'docs/layers.md', '--label', 'correct', '--minutes', '1', '--by', 'atelier-foundation']
  assert.equal(cli(...common).status, 0)
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n').at(-1)).anchor, null)
  assert.equal(cli(...common, '--anchor', 'lines:4-4').status, 0)
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n').at(-1)).anchor, 'lines:4-4')
  // A file cited only through a refused fragment has no whole-file outcome to label.
  const refusedOnly = repo(t)
  const rBase = refusedOnly.commit('refused only', () => fs.writeFileSync(path.join(refusedOnly.dir, CORPUS), CORPUS_TEXT.replace('(layers.md)', '(layers.md#intro)')))
  const rHead = refusedOnly.commit('edit', () => fs.writeFileSync(path.join(refusedOnly.dir, 'docs/layers.md'), SOURCE.replace('Line two', 'Changed two')))
  assert.equal(cli('measure', '--pr', '47', '--base', rBase, '--head', rHead, '--repo', refusedOnly.dir).status, 0)
  const refusedId = JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n').at(-1)).decisions.find((item) => item.cited.length).id
  const refusedLabel = cli('label', '--pr', '47', '--decision', refusedId, '--file', 'docs/layers.md', '--label', 'correct', '--minutes', '1', '--by', 'atelier-foundation')
  assert.equal(refusedLabel.status, 2)
  assert.match(refusedLabel.stderr, /no outcome for this decision, file and anchor/)
})

test('a block moved above an anchor leaves it in place, and quoted text always matches its lines', (t) => {
  const numbered = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`))
  const r = anchoredRepo(t, '#L10-L12', numbered)
  // Move line 2 below line 5: two hunks above the anchor that cancel out.
  const moved = numbered.split('\n')
  const [two] = moved.splice(1, 1)
  moved.splice(4, 0, two)
  const head = r.commit('move', () => fs.writeFileSync(path.join(r.dir, 'docs/layers.md'), moved.join('\n')))
  const still = outcome(measure({ repo: r.dir, pr: 50, base: r.base, head }))
  assert.deepEqual([still.status, still.anchor.reanchor, still.anchor.head.selector.value, still.anchor.outsideChanges], ['stop', false, 'lines:10-12', true])
  // Removing every anchored line: a draft whose quoted text is real head lines its selector names.
  const gone = anchoredRepo(t, '#L10-L12', numbered)
  const goneLines = numbered.split('\n')
  goneLines.splice(9, 3)
  const goneHead = gone.commit('remove anchored lines', () => fs.writeFileSync(path.join(gone.dir, 'docs/layers.md'), goneLines.join('\n')))
  const removed = outcome(measure({ repo: gone.dir, pr: 51, base: gone.base, head: goneHead }))
  assert.deepEqual([removed.status, removed.anchor.head, removed.anchor.reanchor], ['proceed', null, true])
  const [, from, to] = removed.quoted.selector.value.match(/^lines:(\d+)-(\d+)$/)
  assert.equal(removed.quoted.revision, goneHead)
  // The quote surrounds where the anchor was: old lines 9 and 13 are head lines 9 and 10.
  assert.ok(Number(from) <= 9 && Number(to) >= 10, removed.quoted.selector.value)
  assert.equal(removed.quoted.contentDigest, sha(goneLines.slice(Number(from) - 1, Number(to)).join('\n')))
  // The same holds for every anchored outcome on a text head.
  assert.equal(still.quoted.contentDigest, sha(moved.slice(9, 12).join('\n')))
})

test('two different refused fragments of one file stay two refusals', () => {
  const refused = citations('[a](layers.md#intro) [b](layers.md#usage) [c](layers.md#intro)')
  assert.deepEqual(refused.map((item) => item.fragment), ['intro', 'usage'])
})
