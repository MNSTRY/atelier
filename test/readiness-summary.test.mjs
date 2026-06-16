import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReadiness, stableReadinessForCheck } from '../src/readiness/readiness.mjs'

test('readiness summarizes graph, projection, contracts, and live checks', () => {
  const readiness = buildReadiness({
    generatedAt: '2026-06-16T00:00:00.000Z',
    workspace: { root: 'workspace', repoOpsHead: 'abc123' },
    graph: {
      schema: 'mnstry.knowledge-graph@v1',
      nodeCount: 2,
      edgeCount: 1,
      diagnostics: [{ type: 'private-repo-recommended' }],
    },
    projection: {
      schema: 'mnstry.alignment-projection@v1',
      summary: {
        graphNodes: 2,
        graphEdges: 1,
        alignmentNodes: 1,
        alignmentEdges: 1,
        gaps: 0,
        diagnostics: 1,
      },
    },
    contracts: [{ path: 'contracts/source-sidecar.v1.schema.json', present: true }],
    kitManifest: { ok: true, schema: 'mnstry-atelier-kit-manifest@v1', extensionPacks: ['base'] },
    runtimeDryRun: { ok: true, root: 'env:MNSTRY_RUNTIME_ROOT', rootSource: 'env:MNSTRY_RUNTIME_ROOT' },
    checks: [{ label: 'knowledge graph is fresh', ok: true }],
    analysis: { ok: true, enabled: false },
  })

  assert.equal(readiness.schema, 'mnstry.atelier-readiness@v1')
  assert.equal(readiness.ready, true)
  assert.deepEqual(readiness.blockers, [])
  assert.deepEqual(readiness.warnings, ['private-or-sensitive-nodes-in-team-readable-repos', 'analysis-disabled-by-default'])
  assert.equal(readiness.graph.nodes, 2)
  assert.equal(readiness.alignment.alignmentNodes, 1)
})

test('readiness records blockers for missing artifacts and failed checks', () => {
  const readiness = buildReadiness({
    graph: { schema: 'wrong' },
    projection: { schema: 'wrong' },
    contracts: [{ path: 'contracts/missing.json', present: false }],
    kitManifest: { ok: false },
    runtimeDryRun: { ok: false },
    checks: [{ label: 'projection is fresh', ok: false }],
    analysis: { ok: true, enabled: true },
  })

  assert.equal(readiness.ready, false)
  assert.deepEqual(readiness.blockers, [
    'knowledge-graph-missing-or-invalid',
    'alignment-projection-missing-or-invalid',
    'runtime-dry-run-missing',
    'kit-manifest-missing-or-invalid',
    'missing-contract:contracts/missing.json',
    'live-check-failed:projection is fresh',
  ])
})

test('readiness freshness ignores volatile runtime root and git head fields', () => {
  const base = {
    schema: 'mnstry.atelier-readiness@v1',
    generatedAt: '2026-06-16T00:00:00.000Z',
    workspace: {
      root: 'workspace',
      repoOpsHead: 'abc123',
    },
    runtimeDryRun: {
      ok: true,
      root: 'workspace-parent/runtime',
      rootSource: 'sibling',
    },
    checks: [
      {
        label: 'runtime dry-run consumer passes',
        cwd: 'workspace-parent/runtime',
      },
    ],
  }
  const refreshed = {
    ...base,
    generatedAt: '2026-06-17T00:00:00.000Z',
    workspace: {
      ...base.workspace,
      repoOpsHead: 'def456',
    },
    runtimeDryRun: {
      ...base.runtimeDryRun,
      root: 'env:MNSTRY_RUNTIME_ROOT',
      rootSource: 'env:MNSTRY_RUNTIME_ROOT',
    },
    checks: [
      {
        label: 'runtime dry-run consumer passes',
        cwd: 'env:MNSTRY_RUNTIME_ROOT',
      },
    ],
  }

  assert.deepEqual(stableReadinessForCheck(base), stableReadinessForCheck(refreshed))
})
