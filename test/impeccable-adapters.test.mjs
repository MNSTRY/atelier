import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

test('composition preserves supplied requirements and emits only the existing effective policy shape', async () => {
  const { composeImpeccablePolicies } = await import('../src/impeccable/index.mjs')
  const first = compileImpeccablePolicy({ requiredRules: ['broken-image'], advisoryRules: ['side-tab'] })
  const later = compileImpeccablePolicy({ requiredRules: ['side-tab'], advisoryRules: ['broken-image', 'bounce-easing'] })
  const result = composeImpeccablePolicies({ policies: [first, later] })
  assert.deepEqual(Object.keys(result.policy).sort(), ['upstream', 'requiredRules', 'advisoryRules', 'digest'].sort())
  assert.deepEqual(result.policy.requiredRules, ['broken-image', 'side-tab'])
  assert.deepEqual(result.policy.advisoryRules, ['bounce-easing'])
  assert.deepEqual(result.lineage.inputPolicyDigests, [first.digest, later.digest].sort())
  assert.equal(result.lineage.effectivePolicyDigest, result.policy.digest)
  const observed = interpretImpeccableDetection(run({ policy: result.policy, exitCode: 2, stdout: JSON.stringify([finding()]) }))
  assert.equal(observed.status, 'failed'); assert.equal(observed.findings[0].disposition, 'required-failure')
  assert.equal(result.authority, 'projection-only')
})

test('composition normalizes permutations and duplicates without discarding validation', async () => {
  const { composeImpeccablePolicies: compose } = await import('../src/impeccable/index.mjs')
  const a = policy(), b = compileImpeccablePolicy({ requiredRules: ['side-tab'], advisoryRules: ['bounce-easing'] })
  const expected = compose({ policies: [a, b] })
  for (const inputs of [[b, a], [a, a, b], [b, a, b, a]]) assert.deepEqual(compose({ policies: inputs }), expected)
  assert.deepEqual(compose({ policies: Array(64).fill(a) }), compose({ policies: [a] }))
  const changed = structuredClone(a); changed.requiredRules = []
  assert.throws(() => compose({ policies: [a, changed] }), 'a reused digest cannot hide an invalid input before deduplication')
  assert.throws(() => compose({ policies: [] }))
  assert.throws(() => compose({ policies: Array(65).fill(a) }))
})

test('composition preserves every supplied pinned rule across conflicting classifications', async () => {
  const { composeImpeccablePolicies: compose } = await import('../src/impeccable/index.mjs')
  const ids = impeccableResources().rules.map(rule => rule.id).sort(), middle = Math.floor(ids.length / 2)
  const a = compileImpeccablePolicy({ requiredRules: ids.slice(0, middle), advisoryRules: ids.slice(middle) })
  const b = compileImpeccablePolicy({ requiredRules: ids.slice(middle), advisoryRules: ids.slice(0, middle) })
  const result = compose({ policies: [a, b] })
  assert.deepEqual(result.policy.requiredRules, ids); assert.deepEqual(result.policy.advisoryRules, [])
  const empty = compileImpeccablePolicy({ requiredRules: [], advisoryRules: [] })
  assert.deepEqual(compose({ policies: [a, empty] }).policy, a, 'an empty later input cannot clear supplied obligations')
})

test('composition snapshots are detached and frozen without changing ordinary compiler results', async () => {
  const { composeImpeccablePolicies: compose } = await import('../src/impeccable/index.mjs')
  const original = policy(), expected = structuredClone(original), list = [original]
  const result = compose({ policies: list })
  original.requiredRules.length = 0; original.advisoryRules.push('bounce-easing'); original.upstream.commit = 'changed'; list.length = 0
  assert.deepEqual(result.policy, expected)
  for (const value of [result, result.policy, result.policy.upstream, result.policy.requiredRules, result.policy.advisoryRules, result.lineage, result.lineage.inputPolicyDigests]) assert.ok(Object.isFrozen(value))
  assert.throws(() => result.policy.requiredRules.pop(), TypeError)
  assert.throws(() => { result.policy.upstream.commit = 'changed' }, TypeError)
  assert.throws(() => result.lineage.inputPolicyDigests.push('changed'), TypeError)
  assert.equal(Object.isFrozen(policy()), false, 'the existing compiler behavior remains unchanged')
})

test('composition refuses malformed, stale and mismatched policy values before hashing unbounded data', async () => {
  const { composeImpeccablePolicies: compose } = await import('../src/impeccable/index.mjs')
  const changes = [
    value => { value.digest = 'sha256:' + '0'.repeat(64) },
    value => { value.digest = [value.digest] },
    value => { value.requiredRules.push('unknown-rule') },
    value => { value.requiredRules.push('broken-image') },
    value => { value.advisoryRules.push('broken-image') },
    value => { value.requiredRules = Array(63).fill('broken-image') },
    value => { value.upstream.commit = '0'.repeat(40) },
    value => { value.upstream.engineVersion = 'future' },
    value => { value.upstream.repository = { value: value.upstream.repository } },
    value => { value.upstream.extra = value.upstream },
    value => { delete value.upstream.license },
    value => { value.extraAuthority = true },
    value => { value.requiredRules = 'broken-image' },
    value => { value.requiredRules = [null] },
    value => { value.requiredRules = ['x'.repeat(100000)] },
    value => { value.digest = 'sha256:' + 'a'.repeat(100000) },
  ]
  for (const [i, change] of changes.entries()) { const value = policy(); change(value); assert.throws(() => compose({ policies: [value] }), undefined, `case ${i}`) }
  for (const request of [null, [], {}, { policies: null }, { policies: [null] }, { policies: [new Date()] }, { policies: [policy()], rootApproved: true }]) assert.throws(() => compose(request))
})

test('composition refuses accessors, sparse arrays and custom iteration without executing callbacks', async () => {
  const { composeImpeccablePolicies: compose } = await import('../src/impeccable/index.mjs')
  let calls = 0
  const request = Object.defineProperty({}, 'policies', { get() { calls++; return [policy()] } })
  assert.throws(() => compose(request))
  const value = policy(); Object.defineProperty(value, 'digest', { get() { calls++; return 'unused' } })
  assert.throws(() => compose({ policies: [value] }))
  const array = [policy()]; array[Symbol.iterator] = () => { calls++; throw new Error('unused iterator') }
  assert.throws(() => compose({ policies: array }))
  const indexed = [policy()]; Object.defineProperty(indexed, '0', { get() { calls++; return policy() } })
  assert.throws(() => compose({ policies: indexed }))
  const rules = policy(); Object.defineProperty(rules.requiredRules, '0', { get() { calls++; return 'broken-image' } })
  assert.throws(() => compose({ policies: [rules] }))
  const upstream = policy(); Object.defineProperty(upstream.upstream, 'commit', { get() { calls++; return 'unused' } })
  assert.throws(() => compose({ policies: [upstream] }))
  assert.throws(() => compose({ policies: Array(1) }))
  const extra = [policy()]; extra.override = true; assert.throws(() => compose({ policies: extra }))
  assert.equal(calls, 0)
})

test('composition remains compatible with WASM evidence and cannot enable inline waivers', async () => {
  const { composeImpeccablePolicies: compose } = await import('../src/impeccable/index.mjs')
  const { detectImpeccableWasmSource } = await import('../src/impeccable/wasm.mjs')
  const required = compileImpeccablePolicy({ requiredRules: ['bounce-easing'], advisoryRules: [] })
  const taste = compileImpeccablePolicy({ requiredRules: [], advisoryRules: ['bounce-easing'] })
  const composed = compose({ policies: [required, taste] })
  const raw = JSON.stringify([{ ...finding('bounce-easing'), severity: 'advisory', advisory: true }])
  const output = detectImpeccableWasmSource({ source: source(), policy: composed.policy, engine: 'source', engineDigest: 'sha256:' + 'b'.repeat(64), file: 'sample.css', content: '/* invented source */' }, {
    detect_text_json(_content, _file, options) { assert.deepEqual(JSON.parse(options), { inlineIgnores: false }); return raw },
  })
  assert.equal(output.result.raw.stdout, raw)
  assert.equal(output.result.raw.exitCode, 0, 'engine advisory status remains raw evidence')
  assert.equal(output.result.status, 'failed', 'supplied required classification still governs the finding')
  assert.equal(output.result.findings[0].disposition, 'required-failure')
})

test('composition cannot adopt a changed resource pin through a mutable module alias', () => {
  const moduleUrl = new URL('../src/impeccable/index.mjs', import.meta.url).href
  const resourceUrl = new URL('../src/impeccable/resources.mjs', import.meta.url).href
  const script = `import {compileImpeccablePolicy,composeImpeccablePolicies} from ${JSON.stringify(moduleUrl)};
    import resources from ${JSON.stringify(resourceUrl)};
    const policy=compileImpeccablePolicy({requiredRules:['broken-image'],advisoryRules:[]});
    resources.upstream.commit='0'.repeat(40);
    try { composeImpeccablePolicies({policies:[policy]}); process.exitCode=1; } catch { process.stdout.write('refused'); }`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'refused')
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
  const result = interpretImpeccableDetection(run({ exitCode: 0, stdout: JSON.stringify([{ ...finding('broken-image'), severity: 'advisory', advisory: true }]) }))
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

test('advisory-only native runs use exit zero and preserve explicit policy disposition', () => {
  for (const advisory of [{ severity: 'advisory' }, { advisory: true }]) {
    const result = interpretImpeccableDetection(run({ exitCode: 0, stdout: JSON.stringify([{ ...finding(), ...advisory }]) }))
    assert.equal(result.status, 'reported')
    assert.equal(result.findings[0].disposition, 'advisory')
    assert.equal(result.requiredFindingsStatus, 'absent-in-reported-run')
    assert.equal('requiredPolicyPassed' in result, false)
  }
})

test('advisory exit mismatches and malformed advisory flags remain inconclusive', () => {
  for (const findingValue of [{ ...finding(), severity: 'advisory' }, { ...finding(), advisory: true }, { ...finding(), advisory: 'false' }, { ...finding(), advisory: null }]) {
    const result = interpretImpeccableDetection(run({ exitCode: 2, stdout: JSON.stringify([findingValue]) }))
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.requiredFindingsStatus, 'unknown')
  }
})
