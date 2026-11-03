import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EDGE_RECORD_SCHEMA, edgeDigest, edgeIdentity } from '../src/edge-policy/contract.mjs'
import { edgeEvidenceOccurrences } from '../src/edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../src/edge-policy/source-citation-adapter.mjs'
import { buildRepositoryContribution } from '../src/graph/repo-contribution.mjs'
import { adaptMultiRecordProjection } from '../src/graph-access/multi-record-projection-adapter.mjs'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'

const invalid = error => error instanceof TypeError && error.message === 'Invalid multi-record projection input'
const duplicate = error => error instanceof TypeError && error.message === 'Duplicate graph edge or evidence identity'
const missing = error => error instanceof TypeError && error.message === 'Required edge record repository is not selected'
const oversized = error => error instanceof TypeError && error.message === 'Graph projection exceeds graph access bounds'
const note = (id, target, body = '[local](target.md)') => [
  '---', 'title: Invented source', 'summary: Synthetic record projection.', 'kg:', `  id: ${id}`,
  '  type: document', '  status: active', '  audience: private',
  ...(target ? ['  relations:', `    supports: "${target}"`] : []), '---', body, '',
].join('\n')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-record-projection-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const selected = ['a', 'b', 'c'].map((letter, index) => {
    const repo = { name: `repo-${letter}`, path: path.join(root, letter), identity: { provider: 'github', id: String(1001 + index) } }
    fs.mkdirSync(repo.path)
    const git = args => execFileSync('git', ['-C', repo.path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(['init', '--quiet']); git(['config', 'user.name', 'Synthetic Source Author']); git(['config', 'user.email', 'author@example.invalid'])
    fs.writeFileSync(path.join(repo.path, 'source.md'), note(`${letter}:source`, letter === 'a' ? 'b:target' : 'a:target', '[local](target.md)\nSYNTHETIC_BODY_ONLY').replaceAll('\n', '\r\n'))
    fs.writeFileSync(path.join(repo.path, 'target.md'), note(`${letter}:target`, '', 'An invented target.'))
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic record projection fixture'])
    return { contribution: buildRepositoryContribution(repo), ownerRef: `owner:${letter}` }
  })
  const policyDigest = edgeDigest({ version: 'synthetic-record-projection', allowProposerReview: false, allowSharedSteward: false })
  const records = [0, 1].map(index => {
    const source = selected[index].contribution, target = selected[1 - index].contribution
    const home = selected[index === 0 ? 2 : 0].contribution
    return { schema: EDGE_RECORD_SCHEMA, family: 'source-declaration', subject: source.declaredRelations[0].source,
      predicate: 'supports', object: target.nodes.find(node => node.ref.localId.endsWith(':target')).ref,
      home: { repoId: home.repository.repoId, path: 'source.md', readership: 'synthetic-selected-readers' },
      origin: sourceCitationFromProvenance(source, source.declaredRelations[0].provenance),
      supports: [target, selected[2].contribution].map((contribution, i) => ({ id: `support:${i}`,
        source: sourceCitationFromProvenance(contribution, contribution.ordinaryLinks[0].provenance) })),
      policyDigest, proposalRef: 'proposal:synthetic',
      sourceChange: { repoId: home.repository.repoId, path: 'source.md', baseRevision: 'synthetic-base',
        diffDigest: edgeDigest('Synthetic proposed change'), reviewRef: 'review:synthetic' }, qualifications: [`Synthetic assertion ${index}.`],
    }
  })
  return { selected, records }
}

async function accessGraph(candidates) {
  const evaluated = []
  const access = createGraphAccess({
    resolveAccess: async (_, { operation }) => ({ operation, principalRef: 'principal:synthetic', proofRef: 'proof:synthetic',
      grantRevision: 'grant:synthetic', policyRevision: 'policy:synthetic', expiresAt: 2000,
      repositories: candidates.map(candidate => ({ ...candidate.repository, head: candidate.snapshot.head, tree: candidate.snapshot.tree,
        scope: candidate.snapshot.scope, snapshotDigest: candidate.snapshot.digest, contributionDigest: digestAccessCandidate(candidate) })),
    }),
    loadContribution: async ({ repoId }) => candidates.find(candidate => candidate.repository.repoId === repoId),
    verifyContribution: async () => true,
    evaluateEdge: edge => { evaluated.push(edge); return { eligible: false } }, revalidate: async () => true,
  }, { now: () => 1000 })
  return { ...(await access.loadAuthorizedGraph({})), evaluated }
}

test('multiple records retain exact IDs, source evidence placement and ordered supports independent of input order', async t => {
  const f = fixture(t)
  const before = JSON.stringify(f)
  const candidates = adaptMultiRecordProjection(f.records, f.selected)
  assert.deepEqual(candidates, adaptMultiRecordProjection([...f.records].reverse(), [...f.selected].reverse()))
  const edges = candidates.flatMap(candidate => candidate.edges)
  assert.equal(edges.length, 2)
  for (const record of f.records) {
    const edge = edges.find(value => value.edgeId === edgeIdentity(record).edgeId)
    assert.ok(edge)
    assert.equal(edge.family, record.family)
    assert.deepEqual(edge.supportRefs, edgeEvidenceOccurrences(record).map(value => value.id))
    assert.equal(candidates.find(candidate => candidate.edges.includes(edge)).repository.repoId, record.home.repoId)
  }
  for (const candidate of candidates) {
    assert.deepEqual(candidate.edges.map(edge => edge.edgeId), candidate.edges.map(edge => edge.edgeId).sort())
    assert.deepEqual(candidate.evidence.map(value => value.evidenceId), candidate.evidence.map(value => value.evidenceId).sort())
    assert.equal(candidate.evidence.every(value => value.sourceRef.repoId === candidate.repository.repoId), true)
  }
  assert.equal(candidates.reduce((total, candidate) => total + candidate.evidence.length, 0), 6)
  const { graph, evaluated } = await accessGraph(candidates)
  assert.equal(graph.completeness, 'complete')
  assert.deepEqual(graph.counts, { nodes: 6, edges: 0, evidence: 6 })
  assert.equal(evaluated.length, 2)
  assert.equal(JSON.stringify(f), before)
  assert.doesNotMatch(JSON.stringify(candidates), /SYNTHETIC_BODY_ONLY|readership|proposal:synthetic/)
  assert.throws(() => { candidates[0].evidence.push({}) }, TypeError)
})

test('different complete assertions of the same triple retain separate evidence occurrences', t => {
  const f = fixture(t)
  const other = structuredClone(f.records[0])
  other.qualifications = ['A separate complete assertion.']
  const candidates = adaptMultiRecordProjection([f.records[0], other], f.selected)
  const edges = candidates.flatMap(candidate => candidate.edges)
  assert.equal(edges.length, 2)
  assert.notEqual(edges[0].edgeId, edges[1].edgeId)
  const evidence = candidates.flatMap(candidate => candidate.evidence)
  assert.equal(evidence.length, 6)
  assert.equal(new Set(evidence.map(value => value.evidenceId)).size, 6)
})

test('duplicate identity and caller-supplied conflicting identities refuse instead of deduplicating', t => {
  const f = fixture(t)
  for (const records of [[f.records[0], f.records[0]], [f.records[0], structuredClone(f.records[0])], [...f.records, f.records[0]]]) {
    assert.throws(() => adaptMultiRecordProjection(records, f.selected), duplicate)
  }
  const forgedEdge = structuredClone(f.records[1]); forgedEdge.edgeId = edgeIdentity(f.records[0]).edgeId
  assert.throws(() => adaptMultiRecordProjection([f.records[0], forgedEdge], f.selected), invalid)
  const forgedEvidence = structuredClone(f.records[1]); forgedEvidence.supports[0].evidenceId = edgeEvidenceOccurrences(f.records[0])[0].id
  assert.throws(() => adaptMultiRecordProjection([f.records[0], forgedEvidence], f.selected), invalid)
})

test('one missing dependency or invalid later record refuses the entire projection', t => {
  const f = fixture(t)
  assert.throws(() => adaptMultiRecordProjection(f.records, f.selected.slice(0, 2)), missing)
  assert.throws(() => adaptMultiRecordProjection(f.records, []), missing)
  const changed = structuredClone(f.records[1]); changed.supports[0].source.citedDigest = edgeDigest('forged citation')
  assert.throws(() => adaptMultiRecordProjection([f.records[0], changed], f.selected), invalid)
  assert.throws(() => adaptMultiRecordProjection(f.records, [...f.selected, f.selected[0]]), invalid)
})

test('empty permitted records retain source nodes without ordinary edges or evidence, including A-only selection', async t => {
  const f = fixture(t)
  const onlyA = [f.selected[0]]
  assert.throws(() => adaptMultiRecordProjection(f.records, onlyA), missing)
  const candidates = adaptMultiRecordProjection([], onlyA)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].nodes.length, 2)
  assert.deepEqual(candidates[0].edges, [])
  assert.deepEqual(candidates[0].evidence, [])
  const { graph, evaluated } = await accessGraph(candidates)
  assert.deepEqual(graph.counts, { nodes: 2, edges: 0, evidence: 0 })
  assert.deepEqual(graph.diagnostics, [])
  assert.deepEqual(evaluated, [])
  const visible = JSON.stringify(graph)
  for (const absent of ['github:1002', 'github:1003', ...f.records.map(record => edgeIdentity(record).edgeId),
    ...f.records.flatMap(record => edgeEvidenceOccurrences(record).map(value => value.id))]) assert.equal(visible.includes(absent), false)
  assert.deepEqual(adaptMultiRecordProjection([], []), [])
})

test('malformed empty selections, options and missing ownerRefs still refuse', t => {
  const f = fixture(t)
  for (const [records, selected, options] of [
    [null, f.selected, {}], [[], null, {}], [[], [f.selected[0], f.selected[0]], {}],
    [[], [{ contribution: f.selected[0].contribution }], {}], [[], f.selected, { grantRevision: 'browser:claim' }],
  ]) assert.throws(() => adaptMultiRecordProjection(records, selected, options), invalid)
})

test('input budget overflow refuses before any source validation work', () => {
  const uninspected = { get contribution() { throw new Error('source must not be inspected') }, ownerRef: 'owner:synthetic' }
  assert.throws(() => adaptMultiRecordProjection(Array(10001).fill({}), [uninspected]), oversized)
  assert.throws(() => adaptMultiRecordProjection([], Array(65).fill(uninspected)), oversized)
})

test('completed candidate byte bounds refuse instead of clipping source data', t => {
  const f = fixture(t)
  const selected = structuredClone([f.selected[0]])
  const native = selected[0].contribution
  native.nodes[0].summary = 'X'.repeat(8 * 1024 * 1024)
  native.digest = edgeDigest(Object.fromEntries(Object.entries(native).filter(([name]) => name !== 'digest')))
  assert.throws(() => adaptMultiRecordProjection([], selected), oversized)
})

test('per-repository evidence overflow refuses the complete batch without dropping occurrences', t => {
  const f = fixture(t)
  const records = Array.from({ length: 159 }, (_, index) => {
    const record = structuredClone(f.records[0])
    record.qualifications = [`Synthetic bounded assertion ${index}.`]
    record.supports = Array.from({ length: 63 }, (_, i) => ({ id: `support:${i}`, source: structuredClone(f.records[0].supports[1].source) }))
    return record
  })
  assert.throws(() => adaptMultiRecordProjection(records, f.selected), oversized)
})

test('a measured small batch completes with deterministic candidates and no large-batch throughput claim', t => {
  const f = fixture(t)
  const records = Array.from({ length: 32 }, (_, index) => ({ ...structuredClone(f.records[index % 2]), qualifications: [`Synthetic batch assertion ${index}.`] }))
  const start = performance.now()
  const candidates = adaptMultiRecordProjection(records, f.selected)
  t.diagnostic(`32 records across 3 selected repositories normalized in ${(performance.now() - start).toFixed(1)} ms`)
  assert.equal(candidates.reduce((total, candidate) => total + candidate.edges.length, 0), 32)
  assert.equal(candidates.reduce((total, candidate) => total + candidate.evidence.length, 0), 96)
  assert.deepEqual(candidates, adaptMultiRecordProjection([...records].reverse(), [...f.selected].reverse()))
})
