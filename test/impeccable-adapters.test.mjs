import test from 'node:test'
import assert from 'node:assert/strict'
import {
  impeccableResources, describeImpeccableCommand, projectImpeccableContext,
  compileImpeccablePolicy, interpretImpeccableDetection,
} from '../src/impeccable/index.mjs'

const source = () => ({ id: 'sample.studio/design', revision: 'revision-1', digest: 'sha256:' + 'a'.repeat(64) })
const policy = () => compileImpeccablePolicy({ requiredRules: ['broken-image'], advisoryRules: ['side-tab'] })
const finding = (id = 'side-tab') => ({
  antipattern: id, name: 'Sample finding', description: 'Synthetic detector observation',
  severity: 'warning', category: 'slop', file: 'src/sample.html', line: 2, snippet: '<section />',
})
const run = overrides => ({
  source: source(), policy: policy(), engine: 'source', engineDigest: 'sha256:' + 'b'.repeat(64),
  exitCode: 0, stdout: '[]', stderr: '', ...overrides,
})
const context = overrides => ({
  source: source(), productMarkdown: '# Sample product\n\nA fictional task board.\n',
  designMarkdown: '# Sample design\n\nUse the declared role scale.\n',
  ...overrides,
})

test('pinned resource view is complete, detached and carries no execution authority', () => {
  const first = impeccableResources()
  assert.equal(first.commands.length, 24)
  assert.equal(first.rules.length, 62)
  assert.equal(new Set(first.rules.map(rule => rule.id)).size, 62)
  first.commands.pop()
  first.upstream.commit = 'changed'
  assert.equal(impeccableResources().commands.length, 24)
  assert.equal(impeccableResources().upstream.commit, '924bbd194d02e5e15a227e75b5901fb0d7a4ecad')
  for (const command of impeccableResources().commands) assert.equal(describeImpeccableCommand(command).authority, 'none')
})

test('command routing preserves report/session/proposal and deprecated alias boundaries', () => {
  assert.equal(describeImpeccableCommand('audit').outcome, 'report')
  assert.equal(describeImpeccableCommand('generate').outcome, 'variant-session')
  assert.equal(describeImpeccableCommand('polish').outcome, 'proposal')
  assert.equal(describeImpeccableCommand('extract').mayProduceImplementationProposal, true)
  assert.equal(describeImpeccableCommand('craft').deprecated, true)
  assert.throws(() => describeImpeccableCommand('publish'))
})

test('context preserves host-authored bytes and binds source identity and content', () => {
  const input = context()
  const first = projectImpeccableContext(input)
  assert.equal(first.files[0].content, input.productMarkdown)
  assert.equal(first.files[1].content, input.designMarkdown)
  assert.equal(first.digest, projectImpeccableContext(structuredClone(input)).digest)
  assert.notEqual(first.digest, projectImpeccableContext(context({ source: { ...source(), revision: 'revision-2' } })).digest)
  assert.notEqual(first.digest, projectImpeccableContext(context({ designMarkdown: input.designMarkdown + 'Changed.\n' })).digest)
  assert.equal(first.authority, 'projection-only')
  first.source.id = 'mutated-output'
  assert.equal(input.source.id, 'sample.studio/design')
})

test('non-enumerable source fields remain explicit and distinct in context and scan evidence', () => {
  const hidden = revision => Object.defineProperties({}, Object.fromEntries(
    Object.entries({ ...source(), revision }).map(([key, value]) => [key, { value }]),
  ))
  const first = projectImpeccableContext(context({ source: hidden('first') }))
  const second = projectImpeccableContext(context({ source: hidden('second') }))
  assert.deepEqual(first.source, { ...source(), revision: 'first' })
  assert.notEqual(first.digest, second.digest)
  assert.deepEqual(interpretImpeccableDetection(run({ source: hidden('first') })).source, first.source)
  const reads = { id: 0, revision: 0, digest: 0 }
  const once = Object.defineProperties({}, Object.fromEntries(Object.entries(source()).map(([key, value]) => [key, {
    get() { assert.equal(++reads[key], 1); return value },
  }])))
  assert.deepEqual(projectImpeccableContext(context({ source: once })).source, source())
})

test('sidecar and surface resources retain unknown content without inventing authority', () => {
  const sidecar = { schemaVersion: 2, extensions: { future: { sample: true } } }
  const output = projectImpeccableContext(context({
    designSidecar: sidecar,
    surface: { id: 'sample-board', markdown: '---\nversion: 1\nslug: sample-board\nprimary_target: /board\n---\n# Sample board\n' },
  }))
  assert.equal(output.files.length, 4)
  assert.deepEqual(JSON.parse(output.files[2].content), sidecar)
  assert.equal(output.files[3].path, '.impeccable/surfaces/sample-board.md')
})

for (const [name, invalid] of [
  ['source digest', { source: { ...source(), digest: 'unknown' } }],
  ['array source digest', { source: { ...source(), digest: [source().digest] } }],
  ['object source digest', { source: { ...source(), digest: { toString: () => source().digest } } }],
  ['unknown context key', { path: '/outside' }],
  ['missing design document', { designMarkdown: undefined, designSidecar: { schemaVersion: 2 } }],
  ['future sidecar', { designSidecar: { schemaVersion: 3 } }],
  ['surface path escape', { surface: { id: '../elsewhere', markdown: '# Unsafe path' } }],
  ['array surface identity', { surface: { id: ['sample-board'], markdown: '# Sample' } }],
  ['surface unknown authority', { surface: { id: 'sample', markdown: '# Sample', publish: true } }],
  ['NUL text', { productMarkdown: '# Sample\0' }],
  ['oversized text', { productMarkdown: 'x'.repeat(2 * 1024 * 1024 + 1) }],
  ['non-JSON sidecar', { designSidecar: { schemaVersion: 2, missing: undefined } }],
]) {
  test('context refuses ' + name, () => assert.throws(() => projectImpeccableContext(context(invalid))))
}

test('context refuses redirected objects and dangerous JSON keys', () => {
  assert.throws(() => projectImpeccableContext(context({ designSidecar: new Date() })))
  assert.throws(() => projectImpeccableContext(context({ designSidecar: JSON.parse('{"schemaVersion":2,"__proto__":{}}') })))
  const cyclic = { schemaVersion: 2 }
  cyclic.self = cyclic
  assert.throws(() => projectImpeccableContext(context({ designSidecar: cyclic })))
})

test('policy identity is stable, detached and refuses ambiguous or unknown dispositions', () => {
  const input = { requiredRules: ['broken-image', 'script-error'], advisoryRules: ['side-tab'] }
  const compiled = compileImpeccablePolicy(input)
  assert.equal(compiled.digest, compileImpeccablePolicy({ requiredRules: [...input.requiredRules].reverse(), advisoryRules: input.advisoryRules }).digest)
  input.requiredRules.pop()
  assert.equal(compiled.requiredRules.length, 2)
  for (const invalid of [
    {}, { requiredRules: ['new-rule'], advisoryRules: [] },
    { requiredRules: ['side-tab'], advisoryRules: ['side-tab'] },
    { requiredRules: ['side-tab', 'side-tab'], advisoryRules: [] },
    { requiredRules: Array(1), advisoryRules: [] },
    { requiredRules: [], advisoryRules: Array(1) },
    { requiredRules: [], advisoryRules: [], ignoreRules: ['broken-image'] },
  ]) assert.throws(() => compileImpeccablePolicy(invalid))
})

test('result retains raw evidence and makes no unattempted-coverage pass claim', () => {
  const result = interpretImpeccableDetection(run())
  assert.equal(result.status, 'reported')
  assert.equal(result.requiredFindingsStatus, 'absent-in-reported-run')
  assert.equal(result.authority, 'evidence-only')
  assert.equal(result.requiredPolicyPassed, undefined)
  assert.ok(result.gaps.some(gap => gap.includes('unattempted')))
  assert.equal(result.raw.stdout, '[]')
})

test('malformed and oversized scan strings retain exact raw evidence without a pass', () => {
  for (const overrides of [
    { exitCode: 1, stderr: 'failed\0detail' },
    { stderr: 'diagnostic\0detail' },
    { stdout: '[]\0' },
    { stdout: ' '.repeat(2 * 1024 * 1024 + 1) },
    { stderr: 'x'.repeat(2 * 1024 * 1024 + 1) },
  ]) {
    const input = run(overrides)
    const result = interpretImpeccableDetection(input)
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.requiredFindingsStatus, 'unknown')
    assert.deepEqual(result.raw, { stdout: input.stdout, stderr: input.stderr, exitCode: input.exitCode })
  }
})

test('mandatory findings remain failures even when the upstream severity is advisory', () => {
  const result = interpretImpeccableDetection(run({ exitCode: 2, stdout: JSON.stringify([{ ...finding('broken-image'), severity: 'advisory', advisory: true }]) }))
  assert.equal(result.status, 'failed')
  assert.equal(result.requiredFindingsStatus, 'present')
  assert.equal(result.findings[0].raw.advisory, true)
})

test('unclassified findings remain inconclusive and scoped advice is reported separately', () => {
  const advice = interpretImpeccableDetection(run({ exitCode: 2, stdout: JSON.stringify([finding()]) }))
  assert.equal(advice.status, 'reported')
  assert.equal(advice.findings[0].disposition, 'advisory')
  const unknown = interpretImpeccableDetection(run({ exitCode: 2, stdout: JSON.stringify([finding('low-contrast')]) }))
  assert.equal(unknown.status, 'inconclusive')
  assert.equal(unknown.requiredFindingsStatus, 'unclassified')
})

for (const [name, overrides] of [
  ['scan failure', { exitCode: 1, stderr: 'Could not inspect target' }],
  ['interruption', { exitCode: null }],
  ['invalid JSON', { stdout: 'not-json' }],
  ['non-array output', { stdout: '{}' }],
  ['empty finding exit', { exitCode: 2 }],
  ['findings with clean exit', { stdout: JSON.stringify([finding()]) }],
  ['unknown rule', { exitCode: 2, stdout: JSON.stringify([finding('future-rule')]) }],
  ['bad location', { exitCode: 2, stdout: JSON.stringify([{ ...finding(), line: -1 }]) }],
  ['fractional location', { exitCode: 2, stdout: JSON.stringify([{ ...finding(), line: 0.5 }]) }],
  ['unsafe integer location', { exitCode: 2, stdout: JSON.stringify([{ ...finding(), line: Number.MAX_SAFE_INTEGER + 1 }]) }],
  ['unknown severity', { exitCode: 2, stdout: JSON.stringify([{ ...finding(), severity: 'passed' }]) }],
  ['too many findings', { exitCode: 2, stdout: JSON.stringify(Array.from({ length: 10001 }, () => finding())) }],
]) {
  test('detector result stays inconclusive for ' + name, () => {
    const result = interpretImpeccableDetection(run(overrides))
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.requiredFindingsStatus, 'unknown')
  })
}

test('tampered policy, unknown engine and missing build identity refuse before evaluation', () => {
  const edited = policy()
  edited.requiredRules = []
  assert.throws(() => interpretImpeccableDetection(run({ policy: edited })))
  assert.throws(() => interpretImpeccableDetection(run({ engine: 'native-pixels' })))
  assert.throws(() => interpretImpeccableDetection(run({ engineDigest: 'unknown' })))
  assert.throws(() => interpretImpeccableDetection(run({ engineDigest: ['sha256:' + 'b'.repeat(64)] })))
  assert.throws(() => interpretImpeccableDetection(run({ engineDigest: { toString: () => 'sha256:' + 'b'.repeat(64) } })))
  assert.throws(() => interpretImpeccableDetection(run({ source: { ...source(), digest: [source().digest] } })))
  assert.throws(() => interpretImpeccableDetection(run({ publish: true })))
})

test('the pinned zero location sentinel remains valid and non-string streams are API errors', () => {
  const result = interpretImpeccableDetection(run({ exitCode: 2, stdout: JSON.stringify([{ ...finding(), line: 0 }]) }))
  assert.equal(result.status, 'reported')
  for (const field of ['stdout', 'stderr']) assert.throws(() => interpretImpeccableDetection(run({ [field]: [] })))
})
