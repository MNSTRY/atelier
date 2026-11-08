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
