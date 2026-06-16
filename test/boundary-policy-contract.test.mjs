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
  ])

  for (const file of fixtureFiles('invalid')) {
    const doc = readJson(file)
    assert.equal(validate(doc), false, `${path.basename(file)} unexpectedly passed`)
    const errors = formatErrors(validate)
    assert.match(errors, expected.get(path.basename(file)), `${path.basename(file)} failed for the wrong reason:\n${errors}`)
  }
})
