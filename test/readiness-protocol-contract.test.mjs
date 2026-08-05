import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { bundledReadinessProtocols } from '@mnstry/atelier/readiness-protocols'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE_ROOT = path.join(ROOT, 'fixtures', 'readiness-protocols')

const CONTRACTS = [
  {
    name: 'readiness protocol',
    schemaPath: path.join(ROOT, 'contracts', 'atelier-readiness-protocol.v1.schema.json'),
    fixtureRoot: path.join(FIXTURE_ROOT, 'protocol'),
    invalidExpectations: new Map([
      ['missing-check-target.v1.json', /\/questions\/0.*must have required property 'inputFields'/],
      ['runtime-mutation-enabled.v1.json', /\/safety\/runtimeMutation.*must be equal to constant/],
    ]),
  },
  {
    name: 'readiness run',
    schemaPath: path.join(ROOT, 'contracts', 'atelier-readiness-run.v1.schema.json'),
    fixtureRoot: path.join(FIXTURE_ROOT, 'run'),
    invalidExpectations: new Map([
      ['missing-evidence.v1.json', /\/claims\/0\/evidence.*must NOT have fewer than 1 items/],
      ['pass-with-blocker.v1.json', /\/blockers.*must NOT have more than 0 items/],
      ['runtime-mutation-enabled.v1.json', /\/safety\/runtimeMutation.*must be equal to constant/],
    ]),
  },
]

const machineLocalRootPattern = new RegExp(`/${['Users'].join('')}/`)
const agentLocalStatePattern = new RegExp(`\\.${['codex'].join('')}`)
const privateKeyMarkerPattern = new RegExp(`BEGIN (RSA|OPENSSH|${['PRIVATE'].join('')}) KEY`, 'i')
const FORBIDDEN_FIXTURE_CONTENT = [
  machineLocalRootPattern,
  agentLocalStatePattern,
  privateKeyMarkerPattern,
]

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fixtureFiles(root, kind) {
  return fs.readdirSync(path.join(root, kind))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(root, kind, name))
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
    const files = fixtureFiles(contract.fixtureRoot, 'valid')

    assert.notEqual(files.length, 0, `${contract.name} needs at least one valid fixture`)

    for (const file of files) {
      const doc = readJson(file)
      assert.equal(validate(doc), true, `${path.basename(file)} failed:\n${formatErrors(validate)}`)
    }
  })

  test(`${contract.name} schema rejects invalid fixtures`, () => {
    const validate = compileSchema(contract.schemaPath)
    const files = fixtureFiles(contract.fixtureRoot, 'invalid')

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

test('bundled protocols validate against the readiness protocol contract', () => {
  const validate = compileSchema(path.join(ROOT, 'contracts', 'atelier-readiness-protocol.v1.schema.json'))

  assert.notEqual(bundledReadinessProtocols.length, 0, 'bundled pack must expose protocols')

  const failures = []
  for (const protocol of bundledReadinessProtocols) {
    if (!validate(protocol)) failures.push(`${protocol.id}:\n${formatErrors(validate)}`)
  }

  assert.deepEqual(failures, [], `bundled protocols failed the contract:\n${failures.join('\n\n')}`)
})

test('extension pack schema allows optional readiness protocol references', () => {
  const validate = compileSchema(path.join(ROOT, 'contracts', 'atelier-extension-pack.v1.schema.json'))
  const withProtocol = readJson(path.join(FIXTURE_ROOT, 'extension-pack', 'valid', 'with-protocol.v1.json'))
  const withoutProtocol = { ...withProtocol }
  delete withoutProtocol.protocols

  assert.equal(validate(withProtocol), true, `with-protocol.v1.json failed:\n${formatErrors(validate)}`)
  assert.equal(validate(withoutProtocol), true, `protocols should be optional:\n${formatErrors(validate)}`)
})

test('extension pack schema rejects malformed readiness protocol references', () => {
  const validate = compileSchema(path.join(ROOT, 'contracts', 'atelier-extension-pack.v1.schema.json'))
  const doc = readJson(path.join(FIXTURE_ROOT, 'extension-pack', 'invalid', 'protocol-missing-path.v1.json'))

  assert.equal(validate(doc), false, 'protocol-missing-path.v1.json unexpectedly passed')
  assert.match(formatErrors(validate), /must have required property 'path'/)
})

test('readiness protocol fixtures stay neutral', () => {
  const files = [
    ...fixtureFiles(path.join(FIXTURE_ROOT, 'protocol'), 'valid'),
    ...fixtureFiles(path.join(FIXTURE_ROOT, 'protocol'), 'invalid'),
    ...fixtureFiles(path.join(FIXTURE_ROOT, 'run'), 'valid'),
    ...fixtureFiles(path.join(FIXTURE_ROOT, 'run'), 'invalid'),
    ...fixtureFiles(path.join(FIXTURE_ROOT, 'extension-pack'), 'valid'),
    ...fixtureFiles(path.join(FIXTURE_ROOT, 'extension-pack'), 'invalid'),
  ]

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN_FIXTURE_CONTENT) {
      assert.doesNotMatch(text, pattern, `${path.relative(ROOT, file)} contains private fixture content`)
    }
  }
})
