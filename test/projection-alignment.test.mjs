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
