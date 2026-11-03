import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EDGE_RECORD_SCHEMA, edgeDigest, edgeIdentity } from '../src/edge-policy/contract.mjs'
import { edgeEvidenceOccurrences, evaluateEdge } from '../src/edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../src/edge-policy/source-citation-adapter.mjs'
import { buildRepositoryContribution, resolveContributionTopology } from '../src/graph/repo-contribution.mjs'
import { adaptEdgeDecision } from '../src/graph-access/edge-decision-adapter.mjs'
import { adaptMultiContributionRecord } from '../src/graph-access/multi-contribution-record-adapter.mjs'
import { adaptRepositoryContribution } from '../src/graph-access/source-adapter.mjs'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'

const invalid = error => error instanceof TypeError && error.message === 'Invalid multi-contribution edge record input'
const missing = error => error instanceof TypeError && error.message === 'Required edge record repository is not selected'
const oversized = error => error instanceof TypeError && error.message === 'Edge record exceeds graph access bounds'
const policy = { version: 'synthetic-multi-binding', allowProposerReview: false, allowSharedSteward: false }
const note = (id, body = '', relation = '') => [
  '---', 'title: Invented source', 'summary: Synthetic multi-repository fixture.', 'kg:', `  id: ${id}`,
  '  type: document', '  status: active', '  audience: private',
  ...(relation ? ['  relations:', relation] : []), '---', body, '',
].join('\n')

function fixture(t, { ambiguousTarget = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-multi-record-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = new Map(), repos = []
  const selected = ['alpha', 'beta', 'gamma'].map((name, index) => {
    const letter = ['a', 'b', 'c'][index]
    const repo = { name, path: path.join(root, name), identity: { provider: 'github', id: String(1001 + index) } }
    repos.push(repo); fs.mkdirSync(repo.path)
    const git = args => execFileSync('git', ['-C', repo.path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(['init', '--quiet']); git(['config', 'user.name', 'Synthetic Source Author']); git(['config', 'user.email', 'author@example.invalid'])
    const body = index === 0 ? 'é 🧭 [local](target.md) [remote](../beta/target.md)\nSYNTHETIC_A_BODY_ONLY' : `[local](target.md)\nSYNTHETIC_${letter.toUpperCase()}_BODY_ONLY`
    const content = new Map([
      ['source.md', Buffer.from(note(`${letter}:source`, body, index === 0 ? '    supports: "b:target"' : '').replaceAll('\n', '\r\n'))],
      ['target.md', Buffer.from(note(ambiguousTarget && index === 2 ? 'b:target' : `${letter}:target`))],
    ])
    if (index === 2) content.set('edge-home.json', Buffer.from('{"syntheticPlacement":true}\n'))
    for (const [file, bytes] of content) fs.writeFileSync(path.join(repo.path, file), bytes)
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic multi-repository fixture'])
    const contribution = buildRepositoryContribution(repo, index === 2 ? { inputPaths: { config: 'edge-home.json' } } : {})
    files.set(contribution.repository.repoId, content)
    return { contribution, ownerRef: `owner:${letter}` }
  })
  const [a, b, c] = selected.map(value => value.contribution)
  const citation = (contribution, occurrence) => sourceCitationFromProvenance(contribution, occurrence.provenance)
  const record = { schema: EDGE_RECORD_SCHEMA, family: 'source-declaration',
    subject: a.nodes.find(node => node.ref.localId === 'a:source').ref, predicate: 'supports',
    object: b.nodes.find(node => node.ref.localId === 'b:target').ref,
    home: { repoId: c.repository.repoId, path: 'edge-home.json', readership: 'synthetic-abc-readers' },
    origin: citation(a, a.declaredRelations[0]),
    supports: [{ id: 'support:b', source: citation(b, b.ordinaryLinks[0]) }, { id: 'support:c', source: citation(c, c.ordinaryLinks[0]) }],
    policyDigest: edgeDigest(policy), proposalRef: 'proposal:synthetic',
    sourceChange: { repoId: c.repository.repoId, path: 'edge-home.json', baseRevision: 'synthetic-base',
      diffDigest: edgeDigest('Synthetic proposed change'), reviewRef: 'review:synthetic' }, qualifications: ['Bounded synthetic record.'],
  }
  const topology = () => resolveContributionTopology(selected.map(value => value.contribution), {
    enrollment: selected.map((value, index) => ({ repoId: value.contribution.repository.repoId, root: repos[index].name })),
  })
  return { selected, record, files, repos, topology }
}

function hostFor(f) {
  const bindingId = 'snapshot:synthetic-abc'
  return {
    policy, now: '2030-01-01T12:00:00.000Z', bindingId,
    readRecordHead: async ({ recordDigest }) => ({ recordDigest, eventCount: 0, eventDigest: null }),
    verifyOrigin: async ({ recordDigest }) => ({ recordDigest, bindingId, matches: true }),
    checkSourceHome: async ({ recordDigest, policyDigest }) => ({ recordDigest, policyDigest, bindingId, allowed: true }),
    resolveEndpoint: async ref => ({ ref, current: true, stewardId: `steward:${ref.repoId}` }),
    resolveHomeOwner: async () => ({ actorId: 'home:synthetic-c' }),
    readSource: async source => ({ revision: f.selected.find(value => value.contribution.repository.repoId === source.repoId).contribution.snapshot.digest,
      bytes: f.files.get(source.repoId).get(source.path) }),
  }
}

async function throughAccess(candidates, evaluate = () => ({ eligible: false })) {
  const loaded = [], evaluated = []
  const access = createGraphAccess({
    resolveAccess: async (_, { operation }) => ({ operation, principalRef: 'principal:synthetic', proofRef: 'proof:synthetic',
      grantRevision: 'grant:synthetic', policyRevision: 'policy:synthetic', expiresAt: 2000,
      repositories: candidates.map(candidate => ({ ...candidate.repository, head: candidate.snapshot.head, tree: candidate.snapshot.tree,
        scope: candidate.snapshot.scope, snapshotDigest: candidate.snapshot.digest, contributionDigest: digestAccessCandidate(candidate) })),
    }),
    loadContribution: async ({ repoId }) => { loaded.push(repoId); return candidates.find(value => value.repository.repoId === repoId) },
    verifyContribution: async () => true,
    evaluateEdge: edge => { evaluated.push(edge); return evaluate(edge) }, revalidate: async () => true,
  }, { now: () => 1000 })
  return { ...(await access.loadAuthorizedGraph({})), loaded, evaluated }
}

test('A/B/C candidates distribute exact helper evidence to source repositories and the edge only to C', async t => {
  const f = fixture(t)
  const before = JSON.stringify({ selected: f.selected, record: f.record })
  const candidates = adaptMultiContributionRecord(f.record, f.selected)
  assert.deepEqual(candidates, adaptMultiContributionRecord(f.record, [...f.selected].reverse()))
  assert.deepEqual(candidates.map(value => value.repository.repoId), ['github:1001', 'github:1002', 'github:1003'])
  const occurrences = edgeEvidenceOccurrences(f.record)
  for (const candidate of candidates) {
    const native = f.selected.find(value => value.contribution.repository.repoId === candidate.repository.repoId).contribution
    assert.deepEqual(candidate.snapshot, native.snapshot)
    assert.deepEqual(candidate.inputs, native.inputs)
    assert.deepEqual(candidate.evidence.map(value => value.evidenceId), occurrences.filter(value => value.source.repoId === candidate.repository.repoId).map(value => value.id))
    assert.equal(candidate.evidence.every(value => value.sourceRef.repoId === candidate.repository.repoId && !Object.hasOwn(value, 'verification')), true)
  }
  const [a, b, c] = candidates
  assert.deepEqual(a.edges, []); assert.deepEqual(b.edges, [])
  assert.equal(c.edges.length, 1)
  assert.equal(c.edges[0].edgeId, edgeIdentity(f.record).edgeId)
  assert.equal(c.edges[0].sourceRef.repoId, c.repository.repoId)
  assert.equal(c.edges[0].sourceRef.path, 'edge-home.json')
  assert.deepEqual(c.edges[0].supportRefs, occurrences.map(value => value.id))
  assert.deepEqual(a.evidence[0].sourceRef, f.selected[0].contribution.declaredRelations[0].provenance)
  const hashes = candidates.map(digestAccessCandidate)
  const decision = await evaluateEdge({ record: f.record, events: [] }, hostFor(f))
  assert.equal(decision.state, 'draft')
  assert.deepEqual(decision.supportRefs, occurrences)
  const result = await throughAccess(candidates, edge => adaptEdgeDecision(edge, decision))
  assert.equal(result.graph.completeness, 'complete')
  assert.deepEqual(result.graph.counts, { nodes: 6, edges: 0, evidence: 3 })
  assert.deepEqual(result.evaluated, c.edges)
  assert.deepEqual(candidates.map(digestAccessCandidate), hashes)
  assert.equal(JSON.stringify({ selected: f.selected, record: f.record }), before)
  assert.doesNotMatch(JSON.stringify(candidates), /SYNTHETIC_[ABC]_BODY_ONLY|syntheticPlacement|readership|proposal:synthetic/)
  assert.throws(() => { c.edges[0].supportRefs.reverse() }, TypeError)
})

test('every required repository is all-or-nothing and an A-only host output contains no record-derived evidence or counts', async t => {
  const f = fixture(t)
  for (const indices of [[0], [0, 1], [0, 2], [1, 2]]) assert.throws(() => adaptMultiContributionRecord(f.record, indices.map(index => f.selected[index])), missing)
  // Current grants permit only A, so the host omits this ineligible record and
  // derives A's ordinary local candidate afresh rather than slicing an old bundle.
  const a = adaptRepositoryContribution(f.selected[0].contribution, { ownerRef: f.selected[0].ownerRef })
  const baseline = await throughAccess([a])
  const changedHiddenRecord = structuredClone(f.record)
  changedHiddenRecord.qualifications.push('A changed hidden assertion.')
  assert.throws(() => adaptMultiContributionRecord(changedHiddenRecord, [f.selected[0]]), missing)
  const current = await throughAccess([adaptRepositoryContribution(f.selected[0].contribution, { ownerRef: f.selected[0].ownerRef })])
  assert.deepEqual(current.graph, baseline.graph)
  assert.deepEqual(current.loaded, ['github:1001'])
  assert.deepEqual(current.graph.counts, { nodes: 2, edges: 0, evidence: 1 })
  assert.deepEqual(current.graph.diagnostics, [])
  const visible = JSON.stringify(current.graph)
  for (const absent of ['github:1002', 'github:1003', 'b:target', 'c:source', 'edge-home.json', edgeIdentity(f.record).edgeId,
    ...edgeEvidenceOccurrences(f.record).map(value => value.id)]) assert.equal(visible.includes(absent), false)
  assert.deepEqual(Object.keys(current.graph.counts).sort(), ['edges', 'evidence', 'nodes'])
})

test('duplicate selections, missing or malformed ownerRefs and invalid selected data refuse', t => {
  const f = fixture(t)
  for (const selected of [null, [], [f.selected[0], f.selected[0]],
    f.selected.map((entry, index) => index === 1 ? { contribution: entry.contribution } : entry),
    f.selected.map((entry, index) => index === 1 ? { ...entry, ownerRef: ' ' } : entry),
    f.selected.map((entry, index) => index === 1 ? { ...entry, ownerRef: 'owner\nclaim' } : entry),
    f.selected.map((entry, index) => index === 1 ? { ...entry, audience: 'public' } : entry),
  ]) assert.throws(() => adaptMultiContributionRecord(f.record, selected), invalid)
  assert.throws(() => adaptMultiContributionRecord(f.record, f.selected, { grantRevision: 'browser:claim' }), invalid)
})

test('missing C home and altered citation, manifest or endpoint pins refuse without partial candidates', t => {
  const f = fixture(t)
  for (const change of [
    value => { value.home.path = 'absent-home.json' },
    value => { value.origin.citedDigest = edgeDigest('changed range') },
    value => { value.supports[0].source.locator.byteStart++ },
    value => { value.supports[1].source.revision = edgeDigest('changed snapshot') },
    value => { value.object.localId = 'absent:target' },
    value => { value.predicate = 'contradicts' },
    value => { value.subject = structuredClone(value.object) },
  ]) {
    const value = structuredClone(f.record); change(value)
    assert.throws(() => adaptMultiContributionRecord(value, f.selected), invalid)
  }
  const manifest = structuredClone(f.selected)
  manifest[2].contribution.snapshot.files.find(file => file.path === 'edge-home.json').rawDigest = edgeDigest('forged home')
  assert.throws(() => adaptMultiContributionRecord(f.record, manifest), invalid)
  const noHome = [...f.selected]
  noHome[2] = { ...noHome[2], contribution: buildRepositoryContribution(f.repos[2]) }
  assert.throws(() => adaptMultiContributionRecord(f.record, noHome), invalid)
})

test('ambiguous source occurrences and unqualified declared targets refuse', t => {
  const f = fixture(t)
  const duplicate = structuredClone(f.selected)
  duplicate[0].contribution.declaredRelations.push(structuredClone(duplicate[0].contribution.declaredRelations[0]))
  duplicate[0].contribution.digest = edgeDigest(Object.fromEntries(Object.entries(duplicate[0].contribution).filter(([name]) => name !== 'digest')))
  assert.throws(() => adaptMultiContributionRecord(f.record, duplicate), invalid)
  const ambiguous = fixture(t, { ambiguousTarget: true })
  assert.throws(() => adaptMultiContributionRecord(ambiguous.record, ambiguous.selected), invalid)
})

test('resolved cross-repository navigation requires exact host topology and retains its family', t => {
  const f = fixture(t)
  const record = structuredClone(f.record)
  record.family = 'hyperlink'; record.predicate = 'links-to'; record.sourceChange = null; record.proposalRef = null
  record.origin = sourceCitationFromProvenance(f.selected[0].contribution, f.selected[0].contribution.ordinaryLinks[1].provenance)
  assert.throws(() => adaptMultiContributionRecord(record, f.selected), invalid)
  const candidates = adaptMultiContributionRecord(record, f.selected, { topology: f.topology() })
  assert.equal(candidates[2].edges[0].family, 'hyperlink')
  assert.equal(candidates[2].edges[0].predicate, 'links-to')
  const changed = structuredClone(record); changed.object = f.selected[0].contribution.nodes[0].ref
  assert.throws(() => adaptMultiContributionRecord(changed, f.selected, { topology: f.topology() }), invalid)
  const outsider = f.topology()
  outsider.nodes.push({ ref: { repoId: 'github:9999', localId: 'outside:node' } })
  assert.throws(() => adaptMultiContributionRecord(record, f.selected, { topology: outsider }), invalid)
})

test('full-record changes replace every evidence identity while preserving source refs and support order', t => {
  const f = fixture(t)
  const first = adaptMultiContributionRecord(f.record, f.selected)
  const record = structuredClone(f.record)
  record.qualifications.push('A changed bounded qualification.')
  record.supports.reverse()
  const second = adaptMultiContributionRecord(record, [...f.selected].reverse())
  assert.notEqual(second[2].edges[0].edgeId, first[2].edges[0].edgeId)
  assert.deepEqual(second[2].edges[0].supportRefs, edgeEvidenceOccurrences(record).map(value => value.id))
  for (const [index, candidate] of second.entries()) {
    assert.notEqual(digestAccessCandidate(candidate), digestAccessCandidate(first[index]))
    assert.deepEqual(candidate.evidence.map(value => value.sourceRef), first[index].evidence.map(value => value.sourceRef))
  }
})

test('bounds retain all permitted occurrences and refuse excess without clipping', t => {
  const f = fixture(t)
  const record = structuredClone(f.record)
  record.supports = Array.from({ length: 63 }, (_, index) => ({ id: `support:${index}`, source: structuredClone(f.record.supports[1].source) }))
  const candidates = adaptMultiContributionRecord(record, f.selected)
  assert.equal(candidates[2].edges[0].supportRefs.length, 64)
  assert.equal(candidates.reduce((total, value) => total + value.evidence.length, 0), 64)
  record.supports.push({ id: 'support:overflow', source: structuredClone(f.record.supports[1].source) })
  assert.throws(() => adaptMultiContributionRecord(record, f.selected), oversized)
  const long = structuredClone(f.record); long.predicate = 'p'.repeat(129)
  assert.throws(() => adaptMultiContributionRecord(long, f.selected), oversized)
  assert.throws(() => adaptMultiContributionRecord(f.record, Array(65).fill(f.selected[0])), oversized)
})
