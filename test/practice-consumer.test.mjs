import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CORPUS, LABELS, assess, citedPaths, label, measure, parseDecisions } from '../scripts/practice-consumer/reconsider.mjs'

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
  assert.deepEqual(value, { file: 'docs/parts', status: 'not-evaluated', reason: 'cited-path-not-a-file' })
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
