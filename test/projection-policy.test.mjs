import assert from 'node:assert/strict'
import test from 'node:test'
import { projectGraph, publicSourceVerdict } from '../src/projection/policy.mjs'

test('public projection excludes team and private nodes and their edges', () => {
  const graph = {
    nodes: [
      { id: 'public:doc', audience: 'public' },
      { id: 'team:doc', audience: 'team' },
      { id: 'private:doc', audience: 'private' },
    ],
    edges: [
      { source: 'public:doc', target: 'team:doc', type: 'supports' },
      { source: 'public:doc', target: 'public:doc', type: 'related' },
    ],
  }

  const projected = projectGraph(graph, { target: 'public' })
  assert.deepEqual(projected.nodes.map((node) => node.id), ['public:doc'])
  assert.deepEqual(projected.edges.map((edge) => edge.type), ['related'])
  assert.ok(projected.blocked.some((entry) => entry.id === 'team:doc'))
  assert.ok(projected.blocked.some((entry) => entry.id === 'private:doc'))
  assert.ok(projected.blocked.some((entry) => entry.edge?.target === 'team:doc'))
})

test('public source verdict requires public-projectable source nodes', () => {
  const verdict = publicSourceVerdict([
    { id: 'kg:public', audience: 'public' },
    { id: 'kg:team', audience: 'team' },
  ], ['kg:public', 'kg:team', 'kg:missing'])

  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.failures.map((failure) => failure.kgId), ['kg:team', 'kg:missing'])
})
