import assert from 'node:assert/strict'
import test from 'node:test'
import { compareGraphSnapshots } from '../src/graph-refresh/compare.mjs'
import { ref, seal, view } from './graph-refresh-fixtures.mjs'

test('source impact preserves qualified identities with overlapping local ids and follows permitted paths', () => {
  const result = compareGraphSnapshots(view(1), view(2))
  assert.deepEqual(result.nodes.changed, [ref('repo-a')])
  assert.deepEqual(result.sources.changed, [{ repoId: 'repo-a', path: 'notes/note.md' }])
  assert.deepEqual(result.edges, { added: [], removed: [], changed: [] })
  assert.deepEqual(result.possibleImpact, { scope: 'supplied-authorized-slice', questionIds: ['question-1'] })
})

test('rename remains a source change, never a deletion or a silent identity merge by title', () => {
  const before = view()
  const after = view()
  after.nodes[0].title = 'New title'
  after.nodes[0].sourceRef.path = 'notes/renamed.md'
  after.evidence[0].sourceRef.path = 'notes/renamed.md'
  const result = compareGraphSnapshots(before, seal(after))
  assert.deepEqual(result.nodes.changed, [ref('repo-a')])
  assert.deepEqual(result.nodes.added, [])
  assert.deepEqual(result.nodes.removed, [])
  assert.deepEqual(result.sources.added, [{ repoId: 'repo-a', path: 'notes/renamed.md' }])
  assert.deepEqual(result.sources.removed, [{ repoId: 'repo-a', path: 'notes/note.md' }])
})

test('edge provenance changes and distinct assertions of the same triple remain separate', () => {
  const before = view(), after = view()
  after.edges[0].acceptanceState = 'suspended'
  after.edges.push({ ...after.edges[0], edgeId: 'edge-a-b-other-support', acceptanceState: 'active' })
  const result = compareGraphSnapshots(before, seal(after))
  assert.deepEqual(result.edges.changed, ['edge-a-b'])
  assert.deepEqual(result.edges.added, ['edge-a-b-other-support'])
  assert.deepEqual(result.possibleImpact.questionIds, ['question-1'])
})

test('changed question alone is reported even without source or topology change', () => {
  const before = view(), after = view()
  after.questions[0].abstention = 'insufficient-evidence'
  assert.deepEqual(compareGraphSnapshots(before, seal(after)).possibleImpact.questionIds, ['question-1'])
})

test('different principals, grants, expiry, repo sets, policy or query filters refuse comparison', () => {
  for (const [field, value] of Object.entries({ proofRef: 'other-reader', grantRevision: 'grant-2', expiresAt: '2100-01-01T00:00:00Z', authorizedRepoIds: ['repo-a'], policyRevision: 'policy-2', filter: { depth: 2 } })) {
    const after = view()
    after.accessContext[field] = value
    assert.throws(() => compareGraphSnapshots(view(), seal(after)), /matching authorized/)
  }
})

test('ambiguous refs, dangling edge/evidence/question refs and incompatible contracts refuse', () => {
  const mutations = [
    v => v.nodes.push(v.nodes[0]),
    v => { v.nodes[0].ref = 'note' },
    v => { v.edges[0].target = ref('absent-repo') },
    v => { v.edges[0].supportRefs = ['absent-evidence'] },
    v => { v.questions[0].nodeRefs = [ref('absent-repo')] },
    v => { v.questions[0].evidenceRefs = ['absent-evidence'] },
    v => { v.schema = 'unsupported' },
  ]
  for (const mutate of mutations) {
    const after = view()
    mutate(after)
    assert.throws(() => compareGraphSnapshots(view(), seal(after)), /matching authorized/)
  }
})

test('comparison is deterministic under source record reordering and unchanged views have empty impact', () => {
  const reordered = view()
  for (const field of ['nodes', 'edges', 'questions', 'evidence']) reordered[field].reverse()
  const result = compareGraphSnapshots(view(), seal(reordered))
  assert.deepEqual(result.nodes, { added: [], removed: [], changed: [] })
  assert.deepEqual(result.edges, { added: [], removed: [], changed: [] })
  assert.deepEqual(result.sources, { added: [], removed: [], changed: [] })
  assert.deepEqual(result.possibleImpact.questionIds, [])
})
