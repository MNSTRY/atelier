import assert from 'node:assert/strict'
import test from 'node:test'
import { publicApiCompatibilityFindings } from '../scripts/check-public-api-compat.mjs'

const baseline = {
  requiredSubpaths: ['.', './graph'],
  requiredModuleExports: { '.': ['buildGraph'], './graph': ['buildGraph', 'runGraphCommand'] },
}

test('public API compatibility accepts additive exports', () => {
  const findings = publicApiCompatibilityFindings({
    baseline,
    packageJson: { exports: { '.': './src/index.mjs', './graph': './src/graph.mjs', './new': './src/new.mjs' } },
    moduleExports: { '.': ['buildGraph', 'newRootExport'], './graph': ['buildGraph', 'runGraphCommand', 'newGraphExport'] },
  })
  assert.deepEqual(findings, [])
})

test('public API compatibility names every removed subpath and symbol', () => {
  const findings = publicApiCompatibilityFindings({
    baseline,
    packageJson: { exports: { '.': './src/index.mjs' } },
    moduleExports: { '.': [], './graph': ['buildGraph'] },
  })
  assert.deepEqual(findings, [
    'published package subpath removed: ./graph',
    'published named export removed: . -> buildGraph',
    'published named export removed: ./graph -> runGraphCommand',
  ])
})
