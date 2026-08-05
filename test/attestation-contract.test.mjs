import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const CONTRACTS = [
  {
    name: 'atelier attestation',
    schemaPath: path.join(ROOT, 'contracts', 'atelier-attestation.v1.schema.json'),
    fixtureRoot: path.join(ROOT, 'fixtures', 'atelier-attestation'),
    invalidExpectations: new Map([
      ['bad-digest.v1.json', /\/subject\/payloadHash\/digest.*must match pattern/],
      ['conformance-scope.v1.json', /\/verdict\/scope.*must be equal to constant/],
      ['missing-signature.v1.json', /must have required property 'signature'/],
      ['unknown-root-field.v1.json', /must NOT have additional properties/],
    ]),
  },
]

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fixtureFiles(contract, kind) {
  return fs.readdirSync(path.join(contract.fixtureRoot, kind))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(contract.fixtureRoot, kind, name))
}

function formatErrors(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('\n')
}

function compileSchema(schemaPath) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  })
  addFormats(ajv)
  return ajv.compile(readJson(schemaPath))
}

for (const contract of CONTRACTS) {
  test(`${contract.name} schema accepts valid fixtures`, () => {
    const validate = compileSchema(contract.schemaPath)
    const files = fixtureFiles(contract, 'valid')

    assert.notEqual(files.length, 0, `${contract.name} needs at least one valid fixture`)

    for (const file of files) {
      const doc = readJson(file)
      assert.equal(validate(doc), true, `${path.basename(file)} failed:\n${formatErrors(validate)}`)
    }
  })

  test(`${contract.name} schema rejects invalid fixtures`, () => {
    const validate = compileSchema(contract.schemaPath)
    const files = fixtureFiles(contract, 'invalid')

    assert.notEqual(files.length, 0, `${contract.name} needs at least one invalid fixture`)

    for (const file of files) {
      const basename = path.basename(file)
      const expected = contract.invalidExpectations.get(basename)
      assert.ok(expected, `missing expected failure matcher for ${basename}`)

      const doc = readJson(file)
      assert.equal(validate(doc), false, `${basename} unexpectedly passed`)

      const errors = formatErrors(validate)
      assert.match(errors, expected, `${basename} failed for the wrong reason:\n${errors}`)
    }
  })
}
