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

test('labels name who labelled them and validate every field', () => {
  const decision = 'd-layered-example-0123abcd'
  for (const value of LABELS) {
    const made = label({ pr: 1, decision, value, reviewMinutes: 0, by: 'atelier-foundation' })
    assert.equal(made.label, value)
    assert.equal(made.by, 'atelier-foundation')
  }
  assert.throws(() => label({ pr: 1, decision, value: 'accepted', reviewMinutes: 1, by: 'x' }), /label must be one of/)
  assert.throws(() => label({ pr: 1, decision, value: 'correct', reviewMinutes: -1, by: 'x' }), /nonnegative/)
  assert.throws(() => label({ pr: 1, decision, value: 'correct', reviewMinutes: 1 }), /by must name/)
  assert.throws(() => label({ pr: null, decision, value: 'correct', reviewMinutes: 1, by: 'x' }), /pr must be/)
  assert.throws(() => label({ pr: 1, decision: undefined, value: 'correct', reviewMinutes: 1, by: 'x' }), /decision must be/)
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
  assert.throws(() => measure({ repo: r.dir, pr: 1, base: r.base, head: r.base, mode: 'guess' }), /live or retrospective/)
  for (const args of [['measure', '--pr', 'x', '--base', r.base, '--head', r.base], ['measure', '--pr', '1', '--base', r.base, '--head', r.base, '--mode', 'guess'],
    ['label', '--pr', '1', '--decision', 'd-a-0123abcd', '--label', 'correct', '--minutes'], ['label', '--pr', '1', '--decision', 'd-a-0123abcd', '--label', 'correct', '--minutes', '1']]) {
    const run = spawnSync(process.execPath, [SCRIPT, ...args, '--repo', r.dir, '--out', never], { encoding: 'utf8' })
    assert.equal(run.status, 2, args.join(' '))
  }
  assert.equal(fs.existsSync(never), false)
})
