import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildAlignmentProjection, stableProjectionForCheck } from '../src/projection/alignment-projection.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function fixtureGraph() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/projects/neutral-project/project-knowledge.graph.json'), 'utf8'))
}

function namedGraph() {
  return {
    schema: 'mnstry.knowledge-graph@v1',
    workspace: 'neutral-project',
    diagnostics: [],
    nodes: [
      {
        id: 'project-docs:loom-notes',
        repo: 'project-docs',
        path: 'docs/loom-notes.md',
        title: 'LoomGraph Notes',
        summary: 'Notes about the LoomGraph root.',
        audience: 'team',
        status: 'active',
        tags: [],
        relations: {},
      },
      {
        id: 'project-docs:kiln-guide',
        repo: 'project-docs',
        path: 'docs/kiln-guide.md',
        title: 'Kiln Guide',
        summary: 'Covers the KilnGraph surface.',
        audience: 'team',
        status: 'active',
        tags: [],
        relations: {},
      },
    ],
    edges: [],
    nodeCount: 2,
    edgeCount: 0,
  }
}

test('alignment projection selects configured alignment path and preserves projection gate data', () => {
  const graph = fixtureGraph()
  graph.nodes.push({
    id: 'project-notes:private-note',
    repo: 'project-notes',
    path: 'notes/private.md',
    title: 'Private Note',
    summary: '',
    audience: 'private',
    status: 'active',
    tags: [],
    relations: {},
  })

  const projection = buildAlignmentProjection({
    graph,
    target: 'team',
    alignmentRepo: 'project-app',
    alignmentRoot: 'APP/mnstry-alignment',
    now: () => new Date('2026-06-16T00:00:00.000Z'),
  })

  assert.equal(projection.schema, 'mnstry.alignment-projection@v1')
  assert.equal(projection.summary.alignmentNodes, 1)
  assert.equal(projection.summary.blockedByProjection, 1)
  assert.deepEqual(projection.nodes.map((node) => node.id), ['project-app:alignment-overview'])
  assert.ok(projection.projectionGate.blocked.some((entry) => entry.id === 'project-notes:private-note'))
})

test('empty default root graphs classify no nodes by name', () => {
  const projection = buildAlignmentProjection({
    graph: namedGraph(),
    target: 'team',
    now: () => new Date('2026-06-16T00:00:00.000Z'),
  })

  assert.deepEqual(projection.rootGraphs, [])
  assert.equal(projection.summary.rootGraphs, 0)
  assert.equal(projection.summary.alignmentNodes, 0)
  assert.deepEqual(projection.nodes, [])
})

test('workspace-supplied root graphs classify nodes by name', () => {
  const projection = buildAlignmentProjection({
    graph: namedGraph(),
    target: 'team',
    sduiMap: { rootGraphs: ['LoomGraph', 'KilnGraph'] },
    now: () => new Date('2026-06-16T00:00:00.000Z'),
  })

  assert.deepEqual(projection.rootGraphs, ['LoomGraph', 'KilnGraph'])
  assert.equal(projection.summary.rootGraphs, 2)
  assert.equal(projection.summary.alignmentNodes, 2)
  assert.deepEqual(projection.nodes.map((node) => node.id), ['project-docs:loom-notes', 'project-docs:kiln-guide'])
})

test('stable projection comparison ignores generated time and source commits', () => {
  const graph = fixtureGraph()
  const local = buildAlignmentProjection({
    graph,
    target: 'team',
    now: () => new Date('2026-06-16T00:00:00.000Z'),
    sourceCommitResolver: () => 'abc123',
  })
  const ci = {
    ...local,
    generatedAt: '2026-06-17T00:00:00.000Z',
    projectionRecords: local.projectionRecords.map((record) => ({ ...record, sourceCommit: 'def456' })),
  }

  assert.deepEqual(stableProjectionForCheck(local), stableProjectionForCheck(ci))
})
