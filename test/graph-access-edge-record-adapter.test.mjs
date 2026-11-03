import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EDGE_RECORD_SCHEMA, edgeDigest, edgeIdentity, validateEdgeRecord } from '../src/edge-policy/contract.mjs'
import { edgeEvidenceOccurrences, evaluateEdge } from '../src/edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../src/edge-policy/source-citation-adapter.mjs'
import { buildRepositoryContribution } from '../src/graph/repo-contribution.mjs'
import { adaptEdgeDecision } from '../src/graph-access/edge-decision-adapter.mjs'
import { adaptEdgeRecord } from '../src/graph-access/edge-record-adapter.mjs'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'

const invalid = error => error instanceof TypeError && error.message === 'Invalid graph access edge record input'
const external = error => error instanceof TypeError && error.message === 'Cross-repository edge record binding is unsupported'
const oversized = error => error instanceof TypeError && error.message === 'Edge record exceeds graph access bounds'
const owner = { ownerRef: 'owner:synthetic' }
const policy = { version: 'synthetic-record-binding', allowProposerReview: false, allowSharedSteward: false }
const note = (id, body, relations = '') => [
  '---', 'title: Invented source', 'summary: Synthetic record binding.', 'kg:', `  id: ${id}`,
  '  type: document', '  status: active', '  audience: private',
  ...(relations ? ['  relations:', relations] : []), '---', body, '',
].join('\n')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-edge-record-binding-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = { name: 'synthetic-records', path: root, identity: { provider: 'github', id: '1001' } }
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '--quiet'])
  git(['config', 'user.name', 'Synthetic Source Author'])
  git(['config', 'user.email', 'author@example.invalid'])
  const files = new Map([
    ['source.md', Buffer.from(note('source:one', 'é 🧭 [target](target.md#part)\nSYNTHETIC_RAW_BODY_ONLY', '    supports: "target:one"').replaceAll('\n', '\r\n'))],
    ['target.md', Buffer.from(note('target:one', '[source](source.md)\nSYNTHETIC_SUPPORT_BODY_ONLY'))],
    ['edge-home.json', Buffer.from('{"syntheticPlacement":true}\n')],
  ])
  for (const [file, bytes] of files) fs.writeFileSync(path.join(root, file), bytes)
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic record binding fixture'])
  const contribution = buildRepositoryContribution(repo, { inputPaths: { config: 'edge-home.json' } })
  return { repo, contribution, files }
}

function recordFor(contribution, family = 'hyperlink', supportCount = 1) {
  const originOccurrence = family === 'hyperlink' ? contribution.ordinaryLinks[0] : contribution.declaredRelations[0]
  const supportOccurrence = contribution.ordinaryLinks.at(-1)
  const record = {
    schema: EDGE_RECORD_SCHEMA, family, subject: { repoId: contribution.repository.repoId, localId: 'source:one' },
    predicate: family === 'hyperlink' ? 'links-to' : 'supports',
    object: { repoId: contribution.repository.repoId, localId: 'target:one' },
    home: { repoId: contribution.repository.repoId, path: 'edge-home.json', readership: 'synthetic-readers' },
    origin: sourceCitationFromProvenance(contribution, originOccurrence.provenance),
    supports: Array.from({ length: supportCount }, (_, i) => ({ id: `support:${i}`, source: sourceCitationFromProvenance(contribution, supportOccurrence.provenance) })),
    policyDigest: edgeDigest(policy), proposalRef: family === 'hyperlink' ? null : 'proposal:synthetic',
    sourceChange: family === 'hyperlink' ? null : { repoId: contribution.repository.repoId, path: 'edge-home.json',
      baseRevision: 'synthetic-base', diffDigest: edgeDigest('Synthetic source change'), reviewRef: 'review:synthetic' },
    qualifications: ['Limited to the invented fixture.'],
  }
  assert.equal(validateEdgeRecord(record), true)
  return record
}

function policyHost(f) {
  const bindingId = 'snapshot:synthetic'
  return {
    policy, now: '2030-01-01T12:00:00.000Z', bindingId,
    readRecordHead: async ({ recordDigest }) => ({ recordDigest, eventCount: 0, eventDigest: null }),
    verifyOrigin: async ({ recordDigest }) => ({ recordDigest, bindingId, matches: true }),
    checkSourceHome: async ({ recordDigest, policyDigest }) => ({ recordDigest, policyDigest, bindingId, allowed: true }),
    resolveEndpoint: async ref => ({ ref, current: true, stewardId: 'steward:synthetic' }),
    resolveHomeOwner: async () => ({ actorId: 'owner:synthetic' }),
    readSource: async source => ({ revision: f.contribution.snapshot.digest, bytes: f.files.get(source.path) }),
  }
}

async function throughAccess(candidate, decision) {
  const access = createGraphAccess({
    resolveAccess: async (_, { operation }) => ({ operation, principalRef: 'principal:synthetic', proofRef: 'proof:synthetic',
      grantRevision: 'grant:synthetic', policyRevision: 'policy:synthetic', expiresAt: 2000,
      repositories: [{ ...candidate.repository, head: candidate.snapshot.head, tree: candidate.snapshot.tree,
        scope: candidate.snapshot.scope, snapshotDigest: candidate.snapshot.digest, contributionDigest: digestAccessCandidate(candidate) }],
    }),
    loadContribution: async () => candidate, verifyContribution: async () => true,
    evaluateEdge: raw => adaptEdgeDecision(raw, decision), revalidate: async () => true,
  }, { now: () => 1000 })
  return (await access.loadAuthorizedGraph({})).graph
}

test('identities and ordered evidence exactly match the shared helper and actual evaluator for every family', async t => {
  const f = fixture(t)
  for (const family of ['hyperlink', 'source-declaration', 'reviewed-assertion']) await t.test(family, async () => {
    const record = recordFor(f.contribution, family)
    const before = JSON.stringify({ record, contribution: f.contribution })
    const candidate = adaptEdgeRecord(record, f.contribution, owner)
    const candidateDigest = digestAccessCandidate(candidate)
    const expected = edgeEvidenceOccurrences(record)
    assert.equal(candidate.edges.length, 1)
    const edge = candidate.edges[0]
    assert.equal(edge.edgeId, edgeIdentity(record).edgeId)
    assert.equal(edge.family, family)
    assert.equal(edge.predicate, record.predicate)
    assert.deepEqual(edge.supportRefs, expected.map(value => value.id))
    assert.deepEqual(candidate.evidence.map(value => value.evidenceId), edge.supportRefs)
    const decision = await evaluateEdge({ record, events: [] }, policyHost(f))
    assert.equal(decision.edgeId, edge.edgeId)
    assert.deepEqual(decision.supportRefs, expected)
    assert.equal(digestAccessCandidate(candidate), candidateDigest)
    assert.equal(JSON.stringify({ record, contribution: f.contribution }), before)
    const graph = await throughAccess(candidate, decision)
    assert.equal(graph.completeness, 'complete')
    assert.equal(graph.edges.length, family === 'reviewed-assertion' ? 0 : 1)
    if (family !== 'reviewed-assertion') assert.equal(graph.edges[0].family, family)
    else assert.equal(decision.state, 'draft')
    for (const field of ['eligible', 'acceptanceState', 'assurance', 'verification', 'reviewRefs']) assert.equal(Object.hasOwn(edge, field), false)
    assert.equal(candidate.evidence.some(value => Object.hasOwn(value, 'verification')), false)
  })
})

test('exact producer provenance and structural home pin survive without source bytes or filesystem reads', t => {
  const f = fixture(t)
  const record = recordFor(f.contribution)
  const io = Object.fromEntries(['readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'realpathSync', 'openSync'].map(name => [name, fs[name]]))
  for (const name of Object.keys(io)) fs[name] = () => { throw new Error('record adapter must not read files') }
  let candidate
  try { candidate = adaptEdgeRecord(record, f.contribution, owner) } finally { Object.assign(fs, io) }
  assert.deepEqual(candidate.repository, { repoId: f.contribution.repository.repoId, ...owner })
  assert.deepEqual(candidate.snapshot, f.contribution.snapshot)
  assert.deepEqual(candidate.inputs, f.contribution.inputs)
  assert.deepEqual(candidate.evidence[0].sourceRef, f.contribution.ordinaryLinks[0].provenance)
  assert.deepEqual(candidate.evidence[1].sourceRef, f.contribution.ordinaryLinks.at(-1).provenance)
  const home = f.contribution.snapshot.files.find(file => file.path === record.home.path)
  assert.deepEqual(candidate.edges[0].sourceRef, { repoId: record.home.repoId, path: home.path,
    revision: f.contribution.snapshot.digest, digest: home.rawDigest })
  const bytes = JSON.stringify(candidate)
  assert.doesNotMatch(bytes, /SYNTHETIC_RAW_BODY_ONLY|SYNTHETIC_SUPPORT_BODY_ONLY|syntheticPlacement|proposal:synthetic|readership/)
  assert.throws(() => { candidate.evidence[0].sourceRef.locator.rangeDigest = edgeDigest('changed') }, TypeError)
})

test('changing any full-record content changes edge and occurrence IDs before candidate digesting', t => {
  const { contribution } = fixture(t)
  const record = recordFor(contribution)
  const first = adaptEdgeRecord(record, contribution, owner)
  const changed = structuredClone(record)
  changed.qualifications = ['A different synthetic qualification.']
  const second = adaptEdgeRecord(changed, contribution, owner)
  assert.notEqual(second.edges[0].edgeId, first.edges[0].edgeId)
  assert.notEqual(digestAccessCandidate(second), digestAccessCandidate(first))
  assert.equal(second.evidence.every((row, index) => row.evidenceId !== first.evidence[index].evidenceId), true)
  assert.deepEqual(second.evidence.map(row => row.sourceRef), first.evidence.map(row => row.sourceRef))
})

test('missing or forged home pins, endpoints and malformed records refuse without source details', t => {
  const f = fixture(t)
  const record = recordFor(f.contribution)
  for (const change of [
    value => { value.home.path = 'absent-home.json' },
    value => { value.home.path = '../outside.json' },
    value => { value.subject.localId = '' },
    value => { value.object.localId = 'absent:node' },
    value => { value.subject.extra = true },
    value => { value.eligible = true },
  ]) {
    const value = structuredClone(record); change(value)
    assert.throws(() => adaptEdgeRecord(value, f.contribution, owner), invalid)
  }
  const badContribution = structuredClone(f.contribution)
  badContribution.snapshot.files.find(file => file.path === record.home.path).rawDigest = edgeDigest('forged home')
  assert.throws(() => adaptEdgeRecord(record, badContribution, owner), invalid)
  const noHome = buildRepositoryContribution(f.repo)
  assert.throws(() => adaptEdgeRecord(recordFor(noHome), noHome, owner), invalid)
  for (const value of [null, {}, [], { ...record, origin: null }]) assert.throws(() => adaptEdgeRecord(value, f.contribution, owner), invalid)
  for (const options of [undefined, null, {}, { ownerRef: ' ' }, { ownerRef: 1 }, { ...owner, grantRevision: 'browser:claim' }]) assert.throws(() => adaptEdgeRecord(record, f.contribution, options), invalid)
})

test('origin and every support must match an exact observed citation and the source family', t => {
  const { contribution } = fixture(t)
  const record = recordFor(contribution)
  for (const change of [
    value => { value.origin.citedDigest = edgeDigest('forged range') },
    value => { value.origin.revision = edgeDigest('changed snapshot') },
    value => { value.origin.locator.byteStart++ },
    value => { value.supports[0].source.path = 'absent-source.md' },
    value => { value.supports[0].source.fileDigest = edgeDigest('forged file') },
    value => { value.supports[0].source.locator.byteEnd++ },
    value => { value.origin = sourceCitationFromProvenance(contribution, contribution.declaredRelations[0].provenance) },
  ]) {
    const value = structuredClone(record); change(value)
    assert.throws(() => adaptEdgeRecord(value, contribution, owner), invalid)
  }
  const semantic = recordFor(contribution, 'source-declaration')
  semantic.origin = sourceCitationFromProvenance(contribution, contribution.ordinaryLinks[0].provenance)
  assert.throws(() => adaptEdgeRecord(semantic, contribution, owner), invalid)
})

test('external homes, endpoints, origins or supports refuse rather than drop evidence', t => {
  const { contribution } = fixture(t)
  const record = recordFor(contribution)
  for (const change of [
    value => { value.home.repoId = 'github:2002' },
    value => { value.subject.repoId = 'github:2002' },
    value => { value.object.repoId = 'github:2002' },
    value => { value.origin.repoId = 'github:2002' },
    value => { value.supports[0].source.repoId = 'github:2002' },
  ]) {
    const value = structuredClone(record); change(value)
    assert.equal(validateEdgeRecord(value), true)
    assert.throws(() => adaptEdgeRecord(value, contribution, owner), external)
  }
})

test('observed navigation and declarations cannot supply a different subject, target or predicate', t => {
  const { contribution } = fixture(t)
  for (const family of ['hyperlink', 'source-declaration']) {
    const record = recordFor(contribution, family)
    for (const change of [
      value => { value.subject = structuredClone(value.object) },
      value => { value.object = structuredClone(value.subject) },
      value => { value.predicate = 'contradicts' },
    ]) {
      const value = structuredClone(record); change(value)
      assert.throws(() => adaptEdgeRecord(value, contribution, owner), invalid)
    }
  }
  const unresolved = structuredClone(contribution)
  unresolved.declaredRelations[0].target = 'absent:target'
  unresolved.digest = edgeDigest(Object.fromEntries(Object.entries(unresolved).filter(([name]) => name !== 'digest')))
  assert.throws(() => adaptEdgeRecord(recordFor(unresolved, 'source-declaration'), unresolved, owner), invalid)
})

test('port bounds retain all 64 allowed occurrences and refuse overflow or long predicates', t => {
  const { contribution } = fixture(t)
  const bounded = adaptEdgeRecord(recordFor(contribution, 'source-declaration', 63), contribution, owner)
  assert.equal(bounded.edges[0].supportRefs.length, 64)
  assert.equal(bounded.evidence.length, 64)
  assert.equal(new Set(bounded.edges[0].supportRefs).size, 64)
  assert.throws(() => adaptEdgeRecord(recordFor(contribution, 'source-declaration', 64), contribution, owner), oversized)
  const record = recordFor(contribution, 'source-declaration')
  record.predicate = 'p'.repeat(129)
  assert.equal(validateEdgeRecord(record), true)
  assert.throws(() => adaptEdgeRecord(record, contribution, owner), oversized)
})

test('a structural home pin cannot replace the policy host placement or current-byte check', async t => {
  const f = fixture(t)
  const record = recordFor(f.contribution)
  const candidate = adaptEdgeRecord(record, f.contribution, owner)
  const placement = policyHost(f)
  placement.checkSourceHome = async ({ recordDigest, policyDigest }) => ({ recordDigest, policyDigest, bindingId: placement.bindingId, allowed: false })
  const refused = await evaluateEdge({ record, events: [] }, placement)
  assert.equal(refused.reason, 'unsafe-source-home')
  assert.equal((await throughAccess(candidate, refused)).edges.length, 0)
  const stale = policyHost(f)
  stale.readSource = async source => ({ revision: source.revision, bytes: Buffer.from('Changed synthetic bytes.') })
  const decision = await evaluateEdge({ record, events: [] }, stale)
  assert.equal(decision.reason, 'citation-changed')
  assert.equal((await throughAccess(candidate, decision)).edges.length, 0)
})
