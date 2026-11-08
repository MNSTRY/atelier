import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCHEMA_PATH = path.join(ROOT, 'contracts', 'atelier-boundary-policy.v1.schema.json')
const FIXTURE_ROOT = path.join(ROOT, 'fixtures', 'boundary-policy')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fixtureFiles(kind) {
  return fs.readdirSync(path.join(FIXTURE_ROOT, kind))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(FIXTURE_ROOT, kind, name))
}

function formatErrors(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('\n')
}

function compileBoundaryPolicySchema() {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  })
  return ajv.compile(readJson(SCHEMA_PATH))
}

test('boundary policy schema accepts positive contract fixtures', () => {
  const validate = compileBoundaryPolicySchema()

  for (const file of fixtureFiles('valid')) {
    const doc = readJson(file)
    assert.equal(validate(doc), true, `${path.basename(file)} failed:\n${formatErrors(validate)}`)
  }
})

test('boundary policy schema rejects negative contract fixtures', () => {
  const validate = compileBoundaryPolicySchema()
  const expected = new Map([
    ['invalid-actor-private-repo-mapping.v1.json', /must be string/],
    ['legacy-warning-missing-warning.v1.json', /allowedAudiences.*must be equal to one of the allowed values/],
    ['missing-repo-coverage.v1.json', /must have required property 'autoCommit'/],
    ['unknown-key.v1.json', /must NOT have additional properties/],
    ['content-rule-exception-blanket-path.v1.json', /contentRuleExceptions\/0\/paths\/0.*must NOT be valid/s],
  ])

  for (const file of fixtureFiles('invalid')) {
    const doc = readJson(file)
    assert.equal(validate(doc), false, `${path.basename(file)} unexpectedly passed`)
    const errors = formatErrors(validate)
    assert.match(errors, expected.get(path.basename(file)), `${path.basename(file)} failed for the wrong reason:\n${errors}`)
  }
})

test('v2 is explicit, preserves v1 schema and agrees with runtime profile refusals', async () => {
  const { validateBoundaryPolicy } = await import('../src/boundary/policy.mjs')
  const v1 = readJson(fixtureFiles('valid')[0])
  const schema = readJson(path.join(ROOT, 'contracts/atelier-boundary-policy.v2.schema.json'))
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema)
  const repo = Object.keys(v1.repos)[0]
  const profile = { artifacts: [{ repo, path: 'assets/sample.bin', blob: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 16, coverage: 'raw-bytes' }], limits: { maxArtifactBytes: 100, maxExpandedBytes: 100, maxEntryBytes: 100, maxEntries: 10, maxWorkBytes: 1000, timeoutMs: 1000 } }
  const v2 = { ...v1, schema: 'mnstry.atelier-boundary-policy@v2', contractVersion: '2.0.0', artifactScan: profile }
  assert.equal(validate(v2), true, formatErrors(validate))
  assert.deepEqual(validateBoundaryPolicy(v2), [])
  assert.equal(compileBoundaryPolicySchema()(v2), false, 'old consumers refuse a v2 policy')
  assert.equal(validate(v1), false, 'v2 never silently adopts v1 limits/profile')
  for (const change of [
    value => { value.artifactScan.limits.timeoutMs = 30001 },
    value => { value.artifactScan.limits.maxWorkBytes = 0 },
    value => { value.artifactScan.artifacts[0].coverage = 'recursive-any-format' },
    value => { value.artifactScan.artifacts[0].path = '../outside.bin' },
    value => { value.artifactScan.artifacts[0].path = 'nested//sample.bin' },
    value => { value.artifactScan.artifacts[0].sha256 = ['b'.repeat(64)] },
    value => { value.artifactScan.approved = true },
    value => { delete value.artifactScan },
    value => { value.artifactScan.artifacts = [null] },
  ]) {
    const value = structuredClone(v2); change(value)
    assert.equal(validate(value), false, JSON.stringify(validate.errors))
    assert.ok(validateBoundaryPolicy(value).length)
  }
  for (const change of [
    value => { value.artifactScan.artifacts[0].bytes = 101 },
    value => { value.artifactScan.artifacts.push(structuredClone(value.artifactScan.artifacts[0])) },
    value => { value.artifactScan.artifacts[0].repo = 'undeclared' },
  ]) {
    const value = structuredClone(v2); change(value)
    assert.ok(validateBoundaryPolicy(value).length, 'runtime enforces cross-field and unique identity constraints')
  }
  assert.ok(validateBoundaryPolicy({ ...v1, artifactScan: profile }).length, 'v1 cannot receive a new first-class field')
})


test('v2 ZIP tree coverage requires a finite supported depth in schema and runtime', async () => {
  const { validateBoundaryPolicy } = await import('../src/boundary/policy.mjs')
  const v1 = readJson(fixtureFiles('valid')[0]), repo = Object.keys(v1.repos)[0]
  const value = { ...v1, schema: 'mnstry.atelier-boundary-policy@v2', artifactScan: { artifacts: [{ repo, path: 'sample.zip', blob: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 10, coverage: 'zip-tree-entries' }], limits: { maxArtifactBytes: 100, maxExpandedBytes: 100, maxEntryBytes: 100, maxEntries: 10, maxWorkBytes: 1000, timeoutMs: 1000 } } }
  delete value.contractVersion
  const validate = new Ajv2020({ strict: false }).compile(readJson(path.join(ROOT, 'contracts/atelier-boundary-policy.v2.schema.json')))
  for (const depth of [undefined, 0, 5, '2']) {
    value.artifactScan.limits.maxDepth = depth
    assert.equal(validate(value), false)
    assert.ok(validateBoundaryPolicy(value).length)
  }
  value.artifactScan.limits.maxDepth = 2
  assert.equal(validate(value), true, formatErrors(validate))
  assert.deepEqual(validateBoundaryPolicy(value), [])
})


test('v2 reserved profile ext metadata is accepted as data and cannot supply authority', async () => {
  const { validateBoundaryPolicy } = await import('../src/boundary/policy.mjs')
  const v1 = readJson(fixtureFiles('valid')[0]), repo = Object.keys(v1.repos)[0]
  const value = { ...v1, schema: 'mnstry.atelier-boundary-policy@v2', artifactScan: { ext: { coverage: 'zip-tree-entries' }, artifacts: [{ repo, path: 'sample.bin', blob: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 10, coverage: 'raw-bytes', ext: { bytes: 1000 } }], limits: { maxArtifactBytes: 100, maxExpandedBytes: 100, maxEntryBytes: 100, maxEntries: 10, maxWorkBytes: 1000, timeoutMs: 1000, ext: { maxDepth: 4, maxWorkBytes: 1000000 } } } }
  delete value.contractVersion
  const validate = new Ajv2020({ strict: false }).compile(readJson(path.join(ROOT, 'contracts/atelier-boundary-policy.v2.schema.json')))
  assert.equal(validate(value), true)
  assert.deepEqual(validateBoundaryPolicy(value), [])
  value.artifactScan.artifacts[0].coverage = 'zip-tree-entries'
  assert.equal(validate(value), false, 'ext maxDepth cannot supply a required first-class bound')
  assert.ok(validateBoundaryPolicy(value).length)
  value.artifactScan.limits.maxDepth = 2
  assert.deepEqual(validateBoundaryPolicy(value), [])
  for (const target of [value.artifactScan, value.artifactScan.artifacts[0], value.artifactScan.limits]) {
    const previous = target.ext;target.ext = null
    assert.equal(validate(value), false)
    assert.ok(validateBoundaryPolicy(value).length)
    target.ext = previous
  }
})

test('v3 decoded entry exceptions are explicit and both older schemas refuse them', async () => {
  const { validateBoundaryPolicy } = await import('../src/boundary/policy.mjs')
  const base = readJson(fixtureFiles('valid')[0]), repo = Object.keys(base.repos)[0]
  const value = { ...base, schema: 'mnstry.atelier-boundary-policy@v3', contractVersion: '3.0.0', artifactScan: { artifacts: [{ repo, path: 'bundle.zip', blob: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 40, coverage: 'zip-flat-entries' }], limits: { maxArtifactBytes: 100, maxExpandedBytes: 100, maxEntryBytes: 100, maxEntries: 10, maxWorkBytes: 1000, timeoutMs: 1000 } }, contentRuleExceptions: [{ repo, paths: ['bundle.zip'], rule: 'browser-persistence', reason: 'Invented retained archival reference.', artifactEntry: { purpose: 'archival-source-reference', blob: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 40, chain: [{ path: 'leaf.html', sha256: 'c'.repeat(64), bytes: 10 }] } }] }
  delete value.contentRules
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(readJson(path.join(ROOT, 'contracts/atelier-boundary-policy.v3.schema.json')))
  assert.equal(validate(value), true, formatErrors(validate)); assert.deepEqual(validateBoundaryPolicy(value), [])
  for (const version of [1, 2]) {
    const older = new Ajv2020({ strict: false }).compile(readJson(path.join(ROOT, `contracts/atelier-boundary-policy.v${version}.schema.json`)))
    assert.equal(older(value), false)
    const disguised = structuredClone(value); disguised.schema = `mnstry.atelier-boundary-policy@v${version}`; disguised.contractVersion = `${version}.0.0`
    if (version === 1) delete disguised.artifactScan
    assert.equal(older(disguised), false, 'older schema never accepts a disguised new exception')
    assert.ok(validateBoundaryPolicy(disguised).length)
  }
  const mutations = [
    v => { v.contentRuleExceptions[0].paths = ['**/bundle.zip'] },
    v => { v.contentRuleExceptions[0].paths.push('another.zip') },
    v => { v.contentRuleExceptions[0].rule = 'secret-material' },
    v => { v.contentRuleExceptions[0].artifactEntry.purpose = 'execute' },
    v => { v.contentRuleExceptions[0].artifactEntry.chain[0].path = '../leaf.html' },
    v => { v.contentRuleExceptions[0].artifactEntry.chain[0].path = 'a//leaf.html' },
    v => { v.contentRuleExceptions[0].artifactEntry.chain[0].path = 'leaf*.html' },
    v => { v.contentRuleExceptions[0].artifactEntry.chain[0].bytes = '10' },
    v => { v.contentRuleExceptions[0].artifactEntry.chain[0].sha256 = ['c'.repeat(64)] },
    v => { v.contentRuleExceptions[0].artifactEntry.chain[0].ext = null },
    v => { v.contentRuleExceptions[0].artifactEntry.ext = [] },
    v => { delete v.contentRuleExceptions[0].artifactEntry.purpose; v.contentRuleExceptions[0].artifactEntry.ext = { purpose: 'archival-source-reference' } },
    v => { v.contentRuleExceptions[0].artifactEntry.chain = [] },
  ]
  for (const [i, change] of mutations.entries()) {
    const candidate = structuredClone(value); change(candidate)
    assert.equal(validate(candidate), false, `case ${i}: ${formatErrors(validate)}`)
    assert.ok(validateBoundaryPolicy(candidate).length, `case ${i}`)
  }
  for (const change of [
    v => { v.contentRuleExceptions[0].artifactEntry.sha256 = 'd'.repeat(64) },
    v => { v.contentRuleExceptions[0].artifactEntry.bytes++ },
    v => { v.contentRuleExceptions.push(structuredClone(v.contentRuleExceptions[0])) },
  ]) { const candidate = structuredClone(value); change(candidate); assert.ok(validateBoundaryPolicy(candidate).length, 'runtime validates cross-field identities and duplicate dispositions') }
  value.contentRuleExceptions[0].artifactEntry.ext = { purpose: 'execute' }
  value.contentRuleExceptions[0].artifactEntry.chain[0].ext = { path: 'another.html' }
  assert.equal(validate(value), true); assert.deepEqual(validateBoundaryPolicy(value), [])
})
