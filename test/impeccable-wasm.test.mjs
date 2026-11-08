import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { compileImpeccablePolicy } from '../src/impeccable/index.mjs'
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
