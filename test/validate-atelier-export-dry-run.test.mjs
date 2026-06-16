import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateAtelierExportDryRun } from '../src/validate-atelier-export-dry-run.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_JSON = join(ROOT, 'package.json')
const VALIDATOR = 'src/validate-atelier-export-dry-run.mjs'
const VALIDATOR_TEST = 'test/validate-atelier-export-dry-run.test.mjs'
const FIXTURE_DIR = join(ROOT, 'fixtures/atelier-export')
const SAMPLE_FIXTURE = join(FIXTURE_DIR, 'sample-studio-offer.v1.json')
const RUNTIME_VISIBILITIES = ['private', 'shared', 'platform', 'public']
const LOCAL_AUDIENCE_VISIBILITIES = ['team', 'operator', 'staff', 'sensitive']

function runValidator(filePath) {
  const result = spawnSync(process.execPath, [VALIDATOR, filePath], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return {
    ...result,
    report: JSON.parse(result.stdout),
  }
}

function fixtureDoc() {
  return JSON.parse(readFileSync(SAMPLE_FIXTURE, 'utf8'))
}

function writeFixtureVariant(name, mutate) {
  const dir = mkdtempSync(join(tmpdir(), `atelier-export-${name}-`))
  const file = join(dir, `${name}.json`)
  const doc = fixtureDoc()
  mutate(doc)
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  return file
}

function setAllObjectVisibilities(doc, visibility) {
  for (const rows of Object.values(doc.objects)) {
    for (const object of rows) {
      if (Object.hasOwn(object, 'visibility')) object.visibility = visibility
    }
  }
}

function setImportPlanReady(doc) {
  for (const operation of doc.importPlan.operations) {
    operation.status = 'ready'
    operation.reason = 'Ready for fixture import.'
  }
  doc.validation.status = 'pass'
  doc.validation.checks = doc.validation.checks.map((check) => ({ ...check, status: 'pass' }))
  doc.blockers = []
}

function graphNodesFromDoc(doc) {
  return doc.provenance.sourceNodes.map((sourceNode) => ({
    id: sourceNode.kgId,
    audience: sourceNode.audience,
  }))
}

function assertTopLevelKeys(report) {
  assert.deepEqual(Object.keys(report), [
    'accepted',
    'importable',
    'worstOperationStatus',
    'graphProvenanceMode',
    'operationSummary',
    'errors',
    'warnings',
    'objects',
    'sourceNodes',
    'runtimeTargets',
    'semanticProfileViolations',
  ])
}

test('accepts the neutral sample atelier-export@v1 fixture as a dry run', () => {
  const before = readFileSync(SAMPLE_FIXTURE, 'utf8')
  const result = runValidator(SAMPLE_FIXTURE)
  const after = readFileSync(SAMPLE_FIXTURE, 'utf8')

  assert.equal(result.status, 0)
  assertTopLevelKeys(result.report)
  assert.equal(result.report.accepted, true)
  assert.equal(result.report.importable, false)
  assert.equal(result.report.worstOperationStatus, 'blocked')
  assert.equal(result.report.graphProvenanceMode, 'self-attested')
  assert.equal(result.report.operationSummary.worstOperationStatus, 'blocked')
  assert.deepEqual(result.report.errors, [])
  assert.deepEqual(result.report.semanticProfileViolations, [])
  assert.equal(after, before)
  assert.equal(result.report.objects.byCollection.offers.count, 1)
  assert.equal(result.report.sourceNodes.length, 4)
  assert.ok(
    result.report.runtimeTargets.some((target) => target.targetObject === 'scheduling.commitment')
  )
  assert.ok(result.report.runtimeTargets.some((target) => target.targetObject === 'core.trackable'))
})

test('keeps public dry-run accepted but not importable without external graph proof', () => {
  const file = writeFixtureVariant('ready-public-self-attested', setImportPlanReady)
  const result = runValidator(file)

  assert.equal(result.status, 0)
  assert.equal(result.report.accepted, true)
  assert.equal(result.report.importable, false)
  assert.equal(result.report.worstOperationStatus, 'ready')
  assert.equal(result.report.graphProvenanceMode, 'self-attested')
  assert.deepEqual(result.report.errors, [])
})

test('marks ready public dry-run importable when graph provenance is externally verified', () => {
  const doc = fixtureDoc()
  setImportPlanReady(doc)
  const report = validateAtelierExportDryRun(doc, { graphNodes: graphNodesFromDoc(doc) })

  assert.equal(report.accepted, true)
  assert.equal(report.importable, true)
  assert.equal(report.worstOperationStatus, 'ready')
  assert.equal(report.graphProvenanceMode, 'verified')
  assert.deepEqual(report.errors, [])
})

for (const runtimeVisibility of RUNTIME_VISIBILITIES) {
  test(`accepts runtime/export object visibility ${runtimeVisibility}`, () => {
    const file = writeFixtureVariant(`runtime-visibility-${runtimeVisibility}`, (doc) => {
      setAllObjectVisibilities(doc, runtimeVisibility)
    })
    const result = runValidator(file)

    assert.equal(result.status, 0)
    assert.equal(result.report.accepted, true)
    assert.deepEqual(result.report.errors, [])
    assert.deepEqual(result.report.semanticProfileViolations, [])
  })
}

test('package scripts wire the atelier export dry-run validator and focused test', () => {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))

  assert.equal(
    packageJson.scripts['dry-run'],
    `node ${VALIDATOR} ${relative(ROOT, SAMPLE_FIXTURE)}`
  )
  assert.match(packageJson.scripts.test, /node --test test\/\*\.test\.mjs/)
  assert.match(packageJson.scripts.contract, /check-atelier-export-contract/)
  assert.ok(readFileSync(join(ROOT, VALIDATOR_TEST), 'utf8').includes('rejects mutation or apply intent'))
})

test('fixture and focused test do not embed absolute user paths', () => {
  const fixtureText = readFileSync(SAMPLE_FIXTURE, 'utf8')
  const testText = readFileSync(fileURLToPath(import.meta.url), 'utf8')

  assert.doesNotMatch(fixtureText, /\/Users\//)
  assert.doesNotMatch(testText, /\/Users\//)
})

test('rejects mutation or apply intent in import sections', () => {
  const file = writeFixtureVariant('apply-intent', (doc) => {
    doc.importPlan.mode = 'apply'
    doc.importPlan.databaseWrite = true
  })
  const result = runValidator(file)

  assert.equal(result.status, 1)
  assert.equal(result.report.accepted, false)
  assert.match(result.report.errors.join('\n'), /importPlan\/mode/)
  assert.match(result.report.errors.join('\n'), /databaseWrite/)
})

test('rejects provenance source nodes that use visibility instead of audience', () => {
  const file = writeFixtureVariant('source-node-visibility', (doc) => {
    doc.provenance.sourceNodes[0].visibility = 'public'
  })
  const result = runValidator(file)

  assert.equal(result.status, 1)
  assert.equal(result.report.accepted, false)
  assert.match(result.report.errors.join('\n'), /must use audience, not visibility/)
})

test('rejects unresolved source refs', () => {
  const file = writeFixtureVariant('unresolved-source-ref', (doc) => {
    doc.objects.offers[0].sourceRefs[0] = 'sample-strategy:missing-source-node'
  })
  const result = runValidator(file)

  assert.equal(result.status, 1)
  assert.equal(result.report.accepted, false)
  assert.match(result.report.errors.join('\n'), /sample-strategy:missing-source-node/)
  assert.match(result.report.errors.join('\n'), /does not resolve/)
})

test('rejects unsupported runtime target object classes', () => {
  const file = writeFixtureVariant('unsupported-runtime-object', (doc) => {
    doc.importPlan.operations[0].objectClass = 'raw_table'
  })
  const result = runValidator(file)

  assert.equal(result.status, 1)
  assert.equal(result.report.accepted, false)
  assert.match(
    result.report.semanticProfileViolations.map((violation) => violation.message).join('\n'),
    /unsupported target runtime object\/class raw_table/
  )
})

for (const localAudience of LOCAL_AUDIENCE_VISIBILITIES) {
  test(`rejects local audience word ${localAudience} in runtime object visibility`, () => {
    const file = writeFixtureVariant(`local-audience-runtime-visibility-${localAudience}`, (doc) => {
      doc.objects.spaces[0].visibility = localAudience
    })
    const result = runValidator(file)

    assert.equal(result.status, 1)
    assert.equal(result.report.accepted, false)
    assert.match(
      result.report.errors.join('\n'),
      new RegExp(`runtime/export visibility must be one of private, shared, platform, public`)
    )
    assert.match(result.report.errors.join('\n'), new RegExp(`local audience ${localAudience}`))
  })
}
