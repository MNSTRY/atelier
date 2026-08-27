import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { CONTRACT_CORPUS, CORPUS_ROOT, corpusInvalidFiles, corpusValidFiles } from '../src/contracts/corpus.mjs'
import { validateProjectConfigDoc } from '../src/project/config.mjs'

// Expected-failure matchers per corpus entry; every invalid fixture must fail
// for its registered reason, not merely fail.
const INVALID_EXPECTATIONS = new Map([
  ['atelier-repository-observation', new Map([
    ['complete-with-blocker.v1.json', /\/blockers.*must NOT have more than 0 items/],
  ])],
  ['atelier-tenant-extension-binding', new Map([
    ['publication-authority.v1.json', /\/authority\/publicationMutation.*must be equal to constant/],
  ])],
  ['atelier-authoring-projection', new Map([
    ['implementation-path.v1.json', /must NOT have additional properties/],
  ])],
  ['atelier-authoring-action-intent', new Map([
    ['applied-authority.v1.json', /\/status.*must be equal to constant/],
  ])],
  ['atelier-claim', new Map([
    ['unknown-provider.v1.json', /\/provider.*must be equal to one of the allowed values/],
    ['wrong-schema-const.v1.json', /\/schema.*must be equal to constant/],
    ['unknown-top-level-field.v1.json', /must NOT have additional properties/],
  ])],
  ['atelier-project-config', new Map([
    ['unknown-top-level-field.v1.json', /must NOT have additional properties/],
    ['missing-repos-and-alignment.v1.json', /must match a schema in anyOf/],
    ['absolute-repo-path.v1.json', /\/repos\/0\/path.*must NOT be valid/],
    ['external-kind-read-boundary.v1.json', /\/repos\/0.*must NOT be valid/],
    ['ext-not-object.v1.json', /\/ext must be object/],
  ])],
  ['atelier-readiness', new Map([
    ['dry-run-only-false.v1.json', /\/runtimeDryRun\/dryRunOnly.*must be equal to constant/],
    ['support-bundle-send-path.v1.json', /\/supportBundle\/sendPath.*must be equal to constant/],
    ['unknown-top-level-field.v1.json', /must NOT have additional properties/],
  ])],
  ['atelier-action-intent', new Map([
    ['runtime-mutation-authority.v1.json', /\/authority\/runtimeMutation.*must be equal to constant/],
    ['writes-beyond-clipboard.v1.json', /\/writes\/1.*must be equal to constant/],
    ['unknown-top-level-field.v1.json', /must NOT have additional properties/],
  ])],
  ['atelier-analysis-adapter', new Map([
    ['inert-with-execute-command.v1.json', /\/execution\/executeCommand.*must be null/],
    ['hidden-model-provider.v1.json', /\/execution\/hiddenModelProvider.*must be equal to constant/],
    ['proposals-with-runtime-import.v1.json', /\/proposals\/0.*must NOT be valid/],
  ])],
  ['knowledge-source-sidecar', new Map([
    ['legacy-visibility-field.v1.json', /\/kg.*must NOT have additional properties/],
    ['unknown-relation-kind.v1.json', /\/kg\/relations.*must NOT have additional properties/],
    ['missing-audience.v1.json', /must have required property 'audience'/],
  ])],
  ['git-promote-event', new Map([
    ['provision-named-revocable.v1.json', /\/event\/(type|disclosure_class|revocable).*must be equal to constant/],
  ])],
  ['analysis-adapter-manifest', new Map([
    ['manifest-hidden-provider.v1.json', /\/harness\/hiddenModelProvider.*must be equal to constant/],
  ])],
  ['analysis-adapter-claim-output', new Map([
    ['output-frontmatter-mutation.v1.json', /\/0.*must NOT be valid/],
    ['output-native-graph.v1.json', /must be array/],
  ])],
])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function formatErrors(validate) {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('\n')
}

function compileEntry(entry) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  })
  addFormats(ajv)
  const schema = readJson(path.join(CORPUS_ROOT, entry.contractFile))
  if (!entry.docPointer) return ajv.compile(schema)
  // Validate a $defs subschema by re-rooting it in a wrapper; the contract's
  // internal refs are all '#/$defs/...' so they resolve against the wrapper.
  return ajv.compile({ $schema: schema.$schema, $defs: schema.$defs, $ref: entry.docPointer })
}

const registryEntries = CONTRACT_CORPUS.filter((entry) => entry.registry)

test('registry covers every corpus entry without a dedicated contract test', () => {
  assert.notEqual(registryEntries.length, 0)
  for (const name of INVALID_EXPECTATIONS.keys()) {
    assert.ok(registryEntries.some((entry) => entry.name === name), `expectations registered for unknown corpus entry ${name}`)
  }
})

for (const entry of registryEntries) {
  test(`${entry.name} contract accepts valid fixtures`, () => {
    const validate = compileEntry(entry)
    const files = corpusValidFiles(entry)
    assert.notEqual(files.length, 0, `${entry.name} needs at least one valid fixture`)
    for (const file of files) {
      const doc = readJson(file)
      assert.equal(validate(doc), true, `${path.basename(file)} failed:\n${formatErrors(validate)}`)
    }
  })

  test(`${entry.name} contract rejects invalid fixtures for the registered reasons`, () => {
    const validate = compileEntry(entry)
    const files = corpusInvalidFiles(entry)
    assert.notEqual(files.length, 0, `${entry.name} needs at least one invalid fixture`)
    const expectations = INVALID_EXPECTATIONS.get(entry.name)
    assert.ok(expectations, `missing invalid expectations for ${entry.name}`)
    for (const file of files) {
      const basename = path.basename(file)
      const expected = expectations.get(basename)
      assert.ok(expected, `missing expected failure matcher for ${basename}`)
      const doc = readJson(file)
      assert.equal(validate(doc), false, `${basename} unexpectedly passed`)
      const errors = formatErrors(validate)
      assert.match(errors, expected, `${basename} failed for the wrong reason:\n${errors}`)
    }
  })
}

// The project-config contract shadows a hand-rolled validator that is what
// actually runs; the schema and validateProjectConfigDoc must agree on every
// fixture in both directions.
test('project-config schema and validateProjectConfigDoc agree on all fixtures', () => {
  const entry = CONTRACT_CORPUS.find((item) => item.name === 'atelier-project-config')
  assert.ok(entry)
  const validate = compileEntry(entry)
  for (const file of corpusValidFiles(entry)) {
    const doc = readJson(file)
    assert.equal(validate(doc), true, `${path.basename(file)} rejected by schema:\n${formatErrors(validate)}`)
    assert.deepEqual(validateProjectConfigDoc(doc), [], `${path.basename(file)} rejected by validateProjectConfigDoc`)
  }
  for (const file of corpusInvalidFiles(entry)) {
    const doc = readJson(file)
    assert.equal(validate(doc), false, `${path.basename(file)} accepted by schema`)
    const errors = validateProjectConfigDoc(doc)
    assert.ok(errors.length > 0, `${path.basename(file)} accepted by validateProjectConfigDoc`)
  }
})
