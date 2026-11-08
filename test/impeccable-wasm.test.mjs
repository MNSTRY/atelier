import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { objectDigest } from '../src/capabilities/files.mjs'
import { compileImpeccablePolicy, impeccableResources } from '../src/impeccable/index.mjs'
import { detectImpeccableWasmSource } from '../src/impeccable/wasm.mjs'

const finding = extra => ({ antipattern: 'bounce-easing', name: 'Synthetic observation', description: 'An invented source finding', severity: 'advisory', advisory: true, category: 'slop', file: 'sample.css', line: 1, snippet: 'animation: bounce', ...extra })
const request = extra => ({ source: { id: 'sample/source', revision: 'r1', digest: 'sha256:' + 'a'.repeat(64) }, policy: compileImpeccablePolicy({ requiredRules: ['broken-image'], advisoryRules: ['bounce-easing'] }), engine: 'source', engineDigest: 'sha256:' + 'b'.repeat(64), file: 'sample.css', content: '.sample { animation: bounce 1s; }', ...extra })

test('WASM source calls the admitted export with explicit ignores disabled and retains advisory findings', () => {
  const value = request(), before = structuredClone(value), raw = JSON.stringify([finding()])
  let calls = 0
  const output = detectImpeccableWasmSource(value, { detect_text_json(content, file, options) {
    calls++
    assert.deepEqual([content, file, JSON.parse(options)], [value.content, 'sample.css', { inlineIgnores: false }])
    return raw
  } })
  assert.equal(calls, 1)
  assert.deepEqual(value, before)
  assert.equal(output.result.status, 'reported')
  assert.equal(output.result.authority, 'evidence-only')
  assert.equal(output.result.raw.stdout, raw)
  assert.equal(output.result.raw.exitCode, 0)
  assert.equal(output.exitCodeSource, 'derived-from-findings')
  assert.equal(output.target.digest, 'sha256:' + createHash('sha256').update(value.content).digest('hex'))
  assert.notEqual(output.target.digest, output.result.source.digest)
  assert.equal('requiredPolicyPassed' in output.result, false)
})

test('WASM static HTML selection and primary finding status reuse the existing policy', () => {
  const output = detectImpeccableWasmSource(request({ engine: 'static-html', file: 'page.html', content: '<img>' }), {
    detect_text_json() { assert.fail('wrong source export') },
    detect_html_source_json() { return JSON.stringify([finding({ antipattern: 'broken-image', severity: 'warning', advisory: false })]) },
  })
  assert.equal(output.result.raw.exitCode, 2)
  assert.equal(output.result.status, 'failed')
  assert.equal(output.result.requiredFindingsStatus, 'present')
})

test('WASM throws, malformed output and unknown findings never become clean reports', () => {
  const cases = [
    () => { throw new Error('Synthetic export failure') },
    () => 'not-json',
    () => '{}',
    () => '\0',
    () => ' '.repeat(2 * 1024 * 1024 + 1),
    () => JSON.stringify([finding({ antipattern: 'future-rule' })]),
    () => JSON.stringify([finding({ advisory: 'true' })]),
  ]
  for (const detect_text_json of cases) {
    const output = detectImpeccableWasmSource(request(), { detect_text_json })
    assert.equal(output.result.status, 'inconclusive')
    assert.equal(output.result.requiredFindingsStatus, 'unknown')
    assert.equal('requiredPolicyPassed' in output.result, false)
  }
  const raw = 'not-json'
  assert.equal(detectImpeccableWasmSource(request(), { detect_text_json: () => raw }).result.raw.stdout, raw)
  assert.equal(detectImpeccableWasmSource(request(), { detect_text_json() { throw new Error('Retained failure') } }).result.raw.stderr, 'Retained failure')
})

test('invalid source, policy, build identity, target and unsupported modes refuse before WASM execution', () => {
  let calls = 0
  const module = { detect_text_json() { calls++; return '[]' }, detect_html_source_json() { calls++; return '[]' } }
  const cases = [
    value => { value.source.digest = ['sha256:' + 'a'.repeat(64)] },
    value => { value.policy.requiredRules = [] },
    value => { value.engineDigest = new String(value.engineDigest) },
    value => { value.engine = 'browser' },
    value => { value.file = '../outside.css' },
    value => { value.file = '/absolute.css' },
    value => { value.file = 'https://example.invalid' },
    value => { value.file = 'nested//file.css' },
    value => { value.content = ['input'] },
    value => { value.content = '\0' },
    value => { value.content = ' '.repeat(2 * 1024 * 1024 + 1) },
    value => { value.publish = true },
  ]
  for (const change of cases) { const value = request(); change(value); assert.throws(() => detectImpeccableWasmSource(value, module)) }
  assert.equal(calls, 0)
  assert.throws(() => detectImpeccableWasmSource(request(), {}), /unavailable/)
  assert.throws(() => detectImpeccableWasmSource(request(), { detect_text_json: () => [] }), /primitive JSON string/)
})

test('execution retains the captured source and policy even if the external module mutates caller objects', () => {
  const value = request(), expectedSource = structuredClone(value.source), expectedPolicy = value.policy.digest
  const result = detectImpeccableWasmSource(value, { detect_text_json() {
    value.source.revision = 'changed'
    value.policy.requiredRules.length = 0
    return JSON.stringify([finding({ antipattern: 'broken-image', severity: 'warning', advisory: false })])
  } }).result
  assert.deepEqual(result.source, expectedSource)
  assert.equal(result.policyDigest, expectedPolicy)
  assert.equal(result.status, 'failed')
})

test('WASM refuses scoped-waiver markers before either export, including conservative literal matches', () => {
  let calls = 0, lookups = 0
  const module = Object.defineProperties({}, Object.fromEntries(['detect_text_json', 'detect_html_source_json'].map(name => [name, { get() { lookups++; return () => { calls++; return '[]' } } }])))
  const inputs = [
    '<article data-impeccable-ignore="hard-offset-shadow">Invented</article>',
    '<section DATA-IMPECCABLE-IGNORE = "all"><article>Invented</article></section>',
    '<article data-impeccable-ignore>Invented</article>',
    '<!-- data-impeccable-ignore is an invented literal -->',
    'const marker = "data-impeccable-ignore";',
  ]
  for (const engine of ['source', 'static-html']) for (const content of inputs) {
    assert.throws(() => detectImpeccableWasmSource(request({ engine, content }), module), /scoped-waiver marker/)
  }
  assert.equal(calls, 0)
  assert.equal(lookups, 0)
})

// This fixture is a test projection of the existing resource and pinned build.
// Neither its expected hits nor a protocol callback establishes engine coverage.
const conformanceUrl = new URL('../fixtures/impeccable/source-conformance.v1.json', import.meta.url)
const conformanceBytes = readFileSync(conformanceUrl)
const conformance = JSON.parse(conformanceBytes)
const conformanceIds = impeccableResources().rules.map(rule => rule.id).sort()
const conformanceCases = conformance.pairs.flatMap(pair => ['positive', 'negative'].map(side => ({ pair, side, content: pair[side] })))

test('source conformance inputs are bounded contrasting invented cases on the existing pin', () => {
  assert.deepEqual(conformance.upstream, impeccableResources().upstream)
  assert.ok(conformance.pairs.length > 0 && conformanceCases.length + conformance.refusals.length <= 64)
  assert.equal(new Set(conformance.pairs.map(pair => pair.id)).size, conformance.pairs.length)
  for (const pair of conformance.pairs) {
    assert.match(pair.id, /^[a-z][a-z0-9-]+$/)
    assert.ok(['source', 'static-html'].includes(pair.engine))
    assert.match(pair.file, /^conformance\/[a-z0-9-]+\.(css|tsx|html)$/)
    assert.ok(pair.targets.length > 0)
    assert.equal(new Set(pair.targets).size, pair.targets.length)
    for (const id of pair.targets) assert.ok(conformanceIds.includes(id), id)
    for (const side of ['positive', 'negative']) {
      assert.equal(typeof pair[side], 'string')
      assert.ok(Buffer.byteLength(pair[side]) > 0 && Buffer.byteLength(pair[side]) <= 64 * 1024)
      assert.equal(pair[side].includes('\0'), false)
    }
    assert.notEqual(pair.positive, pair.negative)
    assert.ok(pair.referenceTests.length > 0)
    for (const reference of pair.referenceTests) assert.match(reference, /^crates\/[a-z_]+\/(src|tests)\/[a-z_/.]+\.rs$/)
  }
  for (const input of conformance.refusals) {
    assert.ok(['source', 'static-html'].includes(input.engine))
    assert.ok(Buffer.byteLength(input.content) <= 64 * 1024)
    assert.match(input.content, /data-impeccable-ignore/i)
  }
  const { digest: closureDigest, ...closureSource } = conformance.closure
  assert.equal(objectDigest(closureSource), closureDigest)
  assert.equal(conformance.closure.source, conformance.upstream.commit)
  assert.equal(conformance.closure.files.length, 5)
  assert.deepEqual(conformance.closure.files.map(file => file.path), ['impeccable_source.d.ts', 'impeccable_source.js', 'impeccable_source_bg.wasm', 'impeccable_source_bg.wasm.d.ts', 'package.json'])
  for (const file of conformance.closure.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0)
  }
})

test('every conformance case exercises source routing, evidence retention and disabled ignores using protocol doubles only', () => {
  for (const { pair, side, content } of conformanceCases) {
    const raw = JSON.stringify(side === 'positive' ? pair.targets.map(antipattern => finding({ antipattern, file: pair.file })) : [])
    let calls = 0
    const selected = pair.engine === 'source' ? 'detect_text_json' : 'detect_html_source_json'
    const module = {
      [selected](actualContent, actualFile, options) {
        calls++
        assert.equal(actualContent, content)
        assert.equal(actualFile, pair.file)
        assert.deepEqual(JSON.parse(options), { inlineIgnores: false })
        return raw
      },
    }
    const output = detectImpeccableWasmSource(request({ engine: pair.engine, file: pair.file, content, policy: compileImpeccablePolicy({ requiredRules: [], advisoryRules: conformanceIds }), engineDigest: conformance.closure.digest }), module)
    assert.equal(calls, 1)
    assert.equal(output.result.status, 'reported')
    assert.equal(output.result.raw.stdout, raw)
    assert.equal(output.result.authority, 'evidence-only')
    assert.equal(output.target.digest, 'sha256:' + createHash('sha256').update(content).digest('hex'))
  }
})

// Opt-in only: a host provides an already admitted local closure. No download,
// compilation, external-resource fetching, script evaluation or fallback engine.
const actualWasmDir = process.env.ATELIER_IMPECCABLE_WASM_DIR

test('actual pinned WASM source conformance (NOT_QUALIFIED unless the local closure is supplied)', { skip: !actualWasmDir }, () => {
  const verifyClosure = () => {
    for (const file of conformance.closure.files) {
      const target = join(actualWasmDir, file.path)
      assert.equal(lstatSync(target).isFile(), true, file.path)
      const bytes = readFileSync(target)
      assert.equal(bytes.length, file.bytes, file.path)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path)
    }
  }
  verifyClosure()
  const module = createRequire(import.meta.url)(join(resolve(actualWasmDir), 'impeccable_source.js'))
  const policy = compileImpeccablePolicy({ requiredRules: [], advisoryRules: conformanceIds })
  const observed = new Set(), cases = [], mismatches = []
  assert.deepEqual(JSON.parse(module.antipatterns_json()).map(rule => rule.id).sort(), conformanceIds)
  for (const { pair, side, content } of conformanceCases) {
    const output = detectImpeccableWasmSource(request({ engine: pair.engine, file: pair.file, content, policy, engineDigest: conformance.closure.digest }), module)
    const raw = output.result.raw
    let findings = []
    try { findings = JSON.parse(raw.stdout) } catch { mismatches.push(pair.id + '/' + side + ': invalid findings') }
    if (!Array.isArray(findings)) { findings = []; mismatches.push(pair.id + '/' + side + ': non-array findings') }
    const ids = [...new Set(findings.map(value => value.antipattern))].sort()
    for (const id of ids) observed.add(id)
    for (const id of pair.targets) if (ids.includes(id) !== (side === 'positive')) mismatches.push(pair.id + '/' + side + ': ' + id)
    if (output.result.status !== 'reported') mismatches.push(pair.id + '/' + side + ': ' + output.result.status)
    cases.push({ id: pair.id, side, engine: pair.engine, file: pair.file, targets: pair.targets, target: output.target, observedIds: ids, raw, status: output.result.status })
  }
  const refusals = []
  for (const input of conformance.refusals) {
    let calls = 0, refused = false
    const guarded = {
      detect_text_json(...args) { calls++; return module.detect_text_json(...args) },
      detect_html_source_json(...args) { calls++; return module.detect_html_source_json(...args) },
    }
    try {
      detectImpeccableWasmSource(request({ engine: input.engine, file: input.file, content: input.content, policy, engineDigest: conformance.closure.digest }), guarded)
    } catch (error) { refused = /scoped-waiver marker/.test(error.message) }
    if (!refused || calls !== 0) mismatches.push(input.id + ': scoped waiver not refused before execution')
    refusals.push({ id: input.id, refusedBeforeExecution: refused && calls === 0, exportCalls: calls })
  }
  verifyClosure()
  const pairedResults = conformance.pairs.map(pair => ({ id: pair.id, engine: pair.engine, targets: pair.targets, status: mismatches.some(message => message.startsWith(pair.id + '/')) ? 'FAILED' : 'QUALIFIED_FOR_THIS_PAIR' }))
  const qualified = [...new Set(pairedResults.filter(pair => pair.status === 'QUALIFIED_FOR_THIS_PAIR').flatMap(pair => pair.targets))].sort()
  const coverage = ['source', 'static-html'].map(engine => ({ engine, rules: conformanceIds.map(id => {
    const pairs = pairedResults.filter(pair => pair.engine === engine && pair.targets.includes(id) && pair.status === 'QUALIFIED_FOR_THIS_PAIR').map(pair => pair.id)
    return { id, status: pairs.length ? 'QUALIFIED_FOR_LISTED_PAIRS_ONLY' : 'NOT_QUALIFIED', pairs, reason: pairs.length ? 'Only these exact contrasting inputs; no other engine/profile claim.' : 'No passing contrasting pair for this rule/engine in this corpus; not a claim of unsupported behavior.' }
  }) }))
  const report = {
    fixtureDigest: 'sha256:' + createHash('sha256').update(conformanceBytes).digest('hex'),
    upstream: conformance.upstream, engineDigest: conformance.closure.digest,
    closureVerifiedBeforeAndAfter: true, registeredIds: conformanceIds,
    attemptedCases: cases.length, observedIds: [...observed].sort(),
    pairedQualifiedIds: qualified, pairedResults, coverage,
    notQualified: conformanceIds.filter(id => !qualified.includes(id)).map(id => ({ id, status: 'NOT_QUALIFIED', reason: 'No passing contrasting source/static pair in this corpus; no rendered/native/hosted claim.' })),
    cases, refusals, mismatches, memory: { current: process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024, heapLimitBytes: getHeapStatistics().heap_size_limit, totalRssOrWasmHardCap: false },
    scope: 'Exact local source/static engine observations only; no full P47, rendered/native-product, private-host or human acceptance.',
  }
  const encoded = Buffer.from(JSON.stringify(report)).toString('base64')
  assert.ok(encoded.length <= 2 * 1024 * 1024, 'conformance report exceeds the explicit2MiB transport bound')
  const chunks = encoded.match(/.{1,8192}/g)
  for (let index = 0; index < chunks.length; index++) console.log(`IMPECCABLE_SOURCE_CONFORMANCE_RESULT ${index + 1}/${chunks.length} ${chunks[index]}`)
  assert.deepEqual(mismatches, [])
})
