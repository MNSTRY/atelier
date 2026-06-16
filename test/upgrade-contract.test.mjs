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
    name: 'atelier lock',
    schemaPath: path.join(ROOT, 'contracts', 'atelier-lock.v1.schema.json'),
    fixtureRoot: path.join(ROOT, 'fixtures', 'atelier-lock'),
    invalidExpectations: new Map([
      ['absolute-contract-path.v1.json', /\/package\/source\/path.*must NOT be valid/],
      ['runtime-mutation-enabled.v1.json', /\/runtime\/mutation.*must be equal to constant/],
      ['unknown-top-level-field.v1.json', /must NOT have additional properties/],
    ]),
  },
  {
    name: 'atelier migration',
    schemaPath: path.join(ROOT, 'contracts', 'atelier-migration.v1.schema.json'),
    fixtureRoot: path.join(ROOT, 'fixtures', 'atelier-migration'),
    invalidExpectations: new Map([
      ['live-apply-mode.v1.json', /\/class.*must be equal to one of the allowed values/],
      ['missing-review-evidence.v1.json', /must have required property 'title'/],
      ['runtime-mutation-enabled.v1.json', /\/authority\/runtimeMutation.*must be equal to constant/],
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
