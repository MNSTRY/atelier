import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  checkFixtureSet,
  claimSchema,
  collectContractAttempts,
  defaultAnalysisClaimContract,
  fixtureRoot,
  harnessPolicy,
  localAnalysisRoot,
  manifestSchema,
  provider,
  runAnalysisClaimContractCheck,
  validateContractShape,
  validateAdapterOutput,
  validateManifest,
} from '../src/analysis/analysis-claim-contract.mjs'

const baseManifest = {
  schema: manifestSchema,
  provider,
  enabled: false,
  outputRoot: `${localAnalysisRoot}/output`,
  claimContract: claimSchema,
  harness: {
    policy: harnessPolicy,
    hiddenModelProvider: false,
    network: 'none',
    analysisExecution: false,
  },
  canonicalMutation: false,
  authority: {
    claimOnly: true,
    frontMatterMutation: false,
    graphRelationMutation: false,
    publicExportFeed: false,
    mcpFeed: false,
    runtimeImport: false,
    directCanonicalWrite: false,
  },
}

const baseClaim = {
  schema: claimSchema,
  claimId: 'claim:analysis:2026-06-17:test',
  subject: 'project:source-node',
  predicate: 'supports',
  object: 'project:claim-target',
  provider,
  status: 'proposed',
  promoted: false,
  confidence: 0.6,
  evidence: ['docs/source.md#claim'],
  createdAt: '2026-06-17T00:00:00Z',
}

test('contract and fixture set preserve claim-only model-assisted analysis posture', () => {
  assert.deepEqual(validateContractShape(defaultAnalysisClaimContract), [])
  const result = checkFixtureSet()
  assert.deepEqual(result.errors, [])
  assert.equal(result.fixtureCount, 1)
  assert.equal(result.invalidFixtureCount, 3)
})

test('manifest defaults disabled and rejects authority creep', () => {
  const manifest = { ...baseManifest }
  delete manifest.enabled
  const defaulted = validateManifest(manifest)
  assert.deepEqual(defaulted.errors, [])
  assert.equal(defaulted.manifest.enabled, false)
  assert.match(defaulted.warnings.join('\n'), /defaulting to false/)

  const cases = [
    [{ ...baseManifest, provider: 'other' }, /provider must be analysis/],
    [{ ...baseManifest, outputRoot: '/tmp/analysis' }, /outputRoot must not be absolute/],
    [{ ...baseManifest, outputRoot: 'analysis/output' }, /outputRoot must live under/],
    [{ ...baseManifest, harness: { ...baseManifest.harness, hiddenModelProvider: true } }, /hiddenModelProvider must be false/],
    [{ ...baseManifest, harness: { ...baseManifest.harness, modelProvider: 'openai' } }, /harness has unknown property modelProvider/],
    [{ ...baseManifest, canonicalMutation: true }, /canonicalMutation must be false/],
    [{ ...baseManifest, authority: { ...baseManifest.authority, runtimeImport: true } }, /runtimeImport must be false|runtime import/],
    [{ ...baseManifest, installCommand: 'analysis install' }, /manifest has unknown property installCommand/],
  ]
  for (const [candidate, pattern] of cases) {
    assert.match(validateManifest(candidate).errors.join('\n'), pattern)
  }
})

test('model-assisted analysis output is valid only as proposed atelier claims', () => {
  const valid = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'valid', 'output.claims.v1.json'), 'utf8'))
  assert.deepEqual(validateAdapterOutput(valid).errors, [])
  assert.equal(validateAdapterOutput(valid).claimCount, 1)

  const cases = [
    [{ nodes: [], edges: [] }, /single atelier-claim@v1|graph relation mutation/],
    [[{ ...baseClaim, frontmatter: { kg: { audience: 'public' } } }], /front matter mutation|canonical front matter|unknown key frontmatter/],
    [[{ ...baseClaim, graphRelations: [{ type: 'supports' }] }], /graph relation mutation|graph relations|unknown key graphRelations/],
    [[{ ...baseClaim, publicExport: { schema: 'atelier-export@v1' } }], /public export feed|public exports|unknown key publicExport/],
    [[{ ...baseClaim, mcpFeed: { resources: ['mnstry://unsafe'] } }], /MCP feed|unknown key mcpFeed/],
    [[{ ...baseClaim, runtimeImport: { mode: 'apply' } }], /runtime import|unknown key runtimeImport/],
    [[{ ...baseClaim, provider: 'other', claimId: 'claim:other:test' }], /provider must be analysis/],
    [[{ ...baseClaim, promoted: true }], /promoted must remain false/],
  ]
  for (const [output, pattern] of cases) {
    assert.match(validateAdapterOutput(output).errors.join('\n'), pattern)
  }
})

test('dry-run report never grants execution', () => {
  const report = runAnalysisClaimContractCheck({ manifestPath: path.join(fixtureRoot, 'missing-adapter.json') })
  assert.equal(report.status, 'disabled')
  assert.equal(report.enabled, false)
  assert.equal(report.analysisExecuted, false)
  assert.equal(report.networkCalls, false)
  assert.equal(report.canonicalMutation, false)
  assert.deepEqual(collectContractAttempts({ executeCommand: 'analysis run' }), [
    'executeCommand attempts model-assisted analysis execution command',
  ])
})
