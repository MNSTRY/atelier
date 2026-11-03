import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, signDocument } from '../src/attestation/sign.mjs'
import { EDGE_RECORD_SCHEMA, EDGE_DECISION_SCHEMA, bytesDigest, edgeDigest } from '../src/edge-policy/contract.mjs'
import { evaluateEdge, displayEligibleEdge } from '../src/edge-policy/policy.mjs'
import { adaptEdgeDecision } from '../src/graph-access/edge-decision-adapter.mjs'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'

function fixture({ family = 'source-declaration', accepted = true, supports = 1, qualifications = ['Applies only to this synthetic observation.'], predicate } = {}) {
  const repoId = 'repo:synthetic'
  const body = Buffer.from('An invented bounded observation.\n')
  const policy = { version: 'synthetic-policy-1', allowProposerReview: false, allowSharedSteward: false }
  const policyDigest = edgeDigest(policy)
  const source = { repoId, path: 'notes/observation.md', revision: edgeDigest('synthetic-snapshot'),
    fileDigest: bytesDigest(body), locator: { byteStart: 0, byteEnd: 12 }, citedDigest: bytesDigest(body.subarray(0, 12)) }
  const record = { schema: EDGE_RECORD_SCHEMA, family, subject: { repoId, localId: 'record:alpha' },
    predicate: predicate ?? (family === 'hyperlink' ? 'links-to' : 'supports'), object: { repoId, localId: 'record:beta' },
    home: { repoId, path: 'edges/assertion.json', readership: 'synthetic-readers' }, origin: structuredClone(source),
    supports: Array.from({ length: supports }, (_, i) => ({ id: `support:${i}`, source: structuredClone(source) })),
    policyDigest, proposalRef: 'proposal:synthetic', qualifications,
    sourceChange: family === 'hyperlink' ? null : { repoId, path: 'edges/assertion.json', baseRevision: 'synthetic-base',
      diffDigest: bytesDigest('An invented proposed change.'), reviewRef: 'review:synthetic-owner' } }
  const events = []
  const actors = new Map()
  const host = { now: '2026-01-02T12:00:00.000Z', policy, bindingId: 'snapshot:synthetic',
    readRecordHead: async () => ({ recordDigest: edgeDigest(record), eventCount: events.length, eventDigest: events.length ? edgeDigest(events.at(-1)) : null }),
    verifyOrigin: async ({ recordDigest }) => ({ recordDigest, bindingId: host.bindingId, matches: true }),
    checkSourceHome: async ({ recordDigest }) => ({ recordDigest, policyDigest, bindingId: host.bindingId, allowed: true }),
    resolveEndpoint: async ref => ({ ref, current: true, stewardId: 'steward' }),
    resolveHomeOwner: async () => ({ actorId: 'home' }),
    readSource: async () => ({ revision: source.revision, bytes: body }),
    resolveActorKey: async ({ actorId }) => ({ actorId, publicKey: actors.get(actorId)?.publicKeyDoc, revoked: false,
      notBefore: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-03T00:00:00.000Z' }),
    authorizeDecision: async ({ event }) => ({ eventDigest: edgeDigest(event), policyDigest, bindingId: host.bindingId,
      revoked: false, notBefore: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-03T00:00:00.000Z',
      allowed: event.action === 'propose' ? event.actorId === 'proposer' : event.action === 'approve'
        ? event.roles.every(role => role.repoId === repoId && event.actorId === ({ 'home-owner': 'home', 'endpoint-steward': 'steward' })[role.role])
        : event.actorId === 'home' }) }
  function event(action, actorId, roles = []) {
    if (!actors.has(actorId)) actors.set(actorId, generateKeyPair({ keyId: `synthetic-${actorId}` }))
    const key = actors.get(actorId).privateKeyDoc
    const value = { schema: EDGE_DECISION_SCHEMA, recordDigest: edgeDigest(record), sequence: events.length + 1,
      previousDigest: events.length ? edgeDigest(events.at(-1)) : null, action, actorId, at: '2026-01-02T10:00:00.000Z',
      policyDigest, reason: 'An invented review decision.', roles, signature: null }
    events.push(signDocument(value, { privateKey: key.privateKeyJwk, keyId: key.keyId, algorithm: key.algorithm }))
  }
  if (family === 'reviewed-assertion' && accepted) {
    event('propose', 'proposer')
    event('approve', 'home', [{ repoId, role: 'home-owner' }])
    event('approve', 'steward', [{ repoId, role: 'endpoint-steward' }])
    event('accept', 'home')
  }
  return { record, events, host, source, body, evaluate: () => evaluateEdge({ record, events }, host) }
}

function candidateFor(decision) {
  const display = displayEligibleEdge(decision)
  assert.ok(display)
  return { edgeId: display.edgeId, source: structuredClone(display.source), target: structuredClone(display.target),
    supportRefs: [...display.supportRefs], predicate: display.predicate, family: display.family }
}

async function throughGraphAccess(f, decision, candidate) {
  const repoId = f.source.repoId
  const pin = { repoId, path: f.source.path, revision: f.source.revision, digest: f.source.fileDigest }
  const contribution = { repository: { repoId, ownerRef: 'owner:synthetic' },
    snapshot: { repoId, head: '1'.repeat(40), tree: '2'.repeat(40), dirty: false,
      scope: { base: '', include: null, exclude: null }, digest: f.source.revision,
      files: [{ path: pin.path, rawDigest: pin.digest, byteLength: f.body.length }] },
    nodes: [f.record.subject, f.record.object].map(ref => ({ ref, sourceKind: 'document', title: ref.localId,
      summary: 'An invented record.', classification: 'source', lifecycle: 'active', tags: [], sourceRef: pin })),
    evidence: decision.supportRefs.map(support => ({ evidenceId: support.id, sourceRef: pin })),
    edges: [{ ...candidate, sourceRef: pin }] }
  const approved = { repoId, ownerRef: contribution.repository.ownerRef, head: contribution.snapshot.head,
    tree: contribution.snapshot.tree, scope: contribution.snapshot.scope, snapshotDigest: contribution.snapshot.digest,
    contributionDigest: digestAccessCandidate(contribution) }
  const access = createGraphAccess({
    resolveAccess: async (_context, { operation }) => ({ operation, principalRef: 'principal:synthetic', proofRef: 'proof:synthetic',
      grantRevision: 'grant:1', policyRevision: 'policy:1', expiresAt: 2000, repositories: [approved] }),
    loadContribution: async () => contribution, verifyContribution: async () => true,
    evaluateEdge: raw => adaptEdgeDecision(raw, decision), revalidate: async () => true,
  }, { now: () => 1000 })
  return (await access.loadAuthorizedGraph({})).graph
}

test('original evaluator decisions bridge into the exact graph-access port for each assurance', async t => {
  for (const [family, assurance] of [['hyperlink', 'navigation'], ['source-declaration', 'source-declaration'], ['reviewed-assertion', 'reviewed-assertion']]) {
    await t.test(family, async () => {
      const f = fixture({ family })
      const before = JSON.stringify({ record: f.record, events: f.events })
      const decision = await f.evaluate()
      assert.equal(decision.eligible, true)
      const raw = candidateFor(decision)
      const result = adaptEdgeDecision(raw, decision)
      assert.equal(result.eligible, true)
      assert.equal(result.family, family)
      assert.equal(result.assurance, assurance)
      assert.equal(result.acceptanceState, 'active')
      assert.deepEqual(result.source, decision.triple.subject)
      assert.deepEqual(result.target, decision.triple.object)
      assert.deepEqual(result.supportRefs, decision.supportRefs.map(s => s.id))
      assert.equal(result.sourceRef, decision.supportRefs[0].id)
      assert.deepEqual(result.qualifications, f.record.qualifications)
      assert.deepEqual(result.reviewRefs, decision.reviewRefs)
      assert.equal(result.recordDigest, edgeDigest(f.record))
      assert.equal(result.policyDigest, f.record.policyDigest)
      assert.deepEqual(Object.keys(result).sort(), ['edgeId', 'source', 'target', 'predicate', 'family', 'acceptanceState', 'supportRefs', 'sourceRef', 'assurance', 'qualifications', 'reviewRefs', 'recordDigest', 'policyDigest', 'eligible'].sort())
      assert.equal(result.predicate, family === 'hyperlink' ? 'links_to' : f.record.predicate)
      assert.equal(JSON.stringify({ record: f.record, events: f.events }), before)
      assert.equal(decision.triple.predicate, f.record.predicate)
      assert.throws(() => { result.qualifications.push('changed') }, TypeError)
      assert.throws(() => { result.source.localId = 'changed' }, TypeError)
      const graph = await throughGraphAccess(f, decision, raw)
      assert.deepEqual(graph.edges, [result])
      assert.equal(graph.completeness, 'complete')
    })
  }
})

test('eligible flags, serialized decisions and unsealed display objects never supply authority', async t => {
  const decision = await fixture().evaluate()
  const raw = { ...candidateFor(decision), eligible: true, acceptanceState: 'active' }
  const result = adaptEdgeDecision(raw, decision)
  for (const [label, unverified] of [
    ['forged eligible', { ...raw, ...displayEligibleEdge(decision), eligible: true }],
    ['JSON round trip', JSON.parse(JSON.stringify(decision))],
    ['structured clone', structuredClone(decision)], ['spread copy', { ...decision }],
    ['frozen copy', Object.freeze({ ...decision })], ['inherited copy', Object.create(decision)],
    ['display projection', displayEligibleEdge(decision)], ['adapted projection', result],
    ['proxy', new Proxy(decision, {})], ['null', null], ['missing', undefined],
  ]) await t.test(label, () => assert.deepEqual(adaptEdgeDecision(raw, unverified), { eligible: false }))
})

test('candidate identity, qualified endpoints and the complete ordered supports must match', async t => {
  const decision = await fixture().evaluate()
  const original = candidateFor(decision)
  const cases = [
    ['edge identity', raw => { raw.edgeId = 'edge:other' }],
    ['source repository', raw => { raw.source.repoId = 'repo:other' }],
    ['source identity', raw => { raw.source.localId = 'record:other' }],
    ['target repository', raw => { raw.target.repoId = 'repo:other' }],
    ['target identity', raw => { raw.target.localId = 'record:other' }],
    ['extra endpoint fields', raw => { raw.source.extra = true }],
    ['missing support', raw => { raw.supportRefs.pop() }],
    ['replaced support', raw => { raw.supportRefs[1] = 'evidence:other' }],
    ['added support', raw => { raw.supportRefs.push('evidence:other') }],
    ['duplicate support', raw => { raw.supportRefs.push(raw.supportRefs[0]) }],
    ['reordered supports', raw => { raw.supportRefs.reverse() }],
  ]
  for (const [label, change] of cases) await t.test(label, async () => {
    const raw = structuredClone(original)
    change(raw)
    raw.eligible = true
    assert.deepEqual(adaptEdgeDecision(raw, decision), { eligible: false })
    // Mismatched supports fail in graph-access's earlier evidence filter too.
    if (!label.includes('support')) assert.equal((await throughGraphAccess(fixture(), decision, raw)).edges.length, 0)
  })
  assert.equal(adaptEdgeDecision(original, decision).eligible, true)
})

test('ineligible evaluator decisions and unavailable verification fail closed without audit details', async t => {
  const active = await fixture().evaluate()
  const raw = candidateFor(active)
  const draft = fixture({ family: 'reviewed-assertion', accepted: false })
  const stale = fixture()
  stale.host.readSource = async () => ({ revision: 'changed', bytes: stale.body })
  const suspended = fixture()
  suspended.host.verifyOrigin = async () => { throw new Error('An owner-only observation.') }
  for (const [label, decision] of [
    ['draft', await draft.evaluate()], ['stale', await stale.evaluate()], ['unavailable', await suspended.evaluate()],
    ['invalid input', await evaluateEdge({ record: {}, events: [] }, {})],
  ]) await t.test(label, () => assert.deepEqual(adaptEdgeDecision(raw, decision), { eligible: false }))
  const throwing = { get edgeId() { throw new Error('An owner-only candidate.') } }
  assert.deepEqual(adaptEdgeDecision(throwing, active), { eligible: false })
})

test('candidate metadata cannot replace evaluated assurance, qualifications or predicate', async () => {
  const decision = await fixture().evaluate()
  const raw = { ...candidateFor(decision), predicate: 'contradicts', family: 'reviewed-assertion',
    assurance: 'reviewed-assertion', qualifications: [], reviewRefs: ['review:unverified'], recordDigest: edgeDigest('other'), eligible: false }
  const result = adaptEdgeDecision(raw, decision)
  assert.equal(result.eligible, true)
  assert.equal(result.predicate, 'supports')
  assert.equal(result.family, 'source-declaration')
  assert.equal(result.assurance, 'source-declaration')
  assert.deepEqual(result.qualifications, decision.qualifications)
  assert.deepEqual(result.reviewRefs, [])
  assert.equal(result.recordDigest, decision.recordDigest)
  const semantic = await fixture({ predicate: 'links-to' }).evaluate()
  assert.equal(adaptEdgeDecision(candidateFor(semantic), semantic).predicate, 'links-to')
})

test('the complete result must fit port limits without clipping supports or qualifications', async () => {
  const full = await fixture({ supports: 63, qualifications: ['Q'.repeat(2048)] }).evaluate()
  const accepted = adaptEdgeDecision(candidateFor(full), full)
  assert.equal(accepted.eligible, true)
  assert.equal(accepted.supportRefs.length, 64)
  assert.deepEqual(accepted.qualifications, ['Q'.repeat(2048)])
  const oversized = await fixture({ supports: 64 }).evaluate()
  assert.equal(oversized.eligible, true)
  assert.deepEqual(adaptEdgeDecision(candidateFor(oversized), oversized), { eligible: false })
  const longPredicate = await fixture({ predicate: 'p'.repeat(129) }).evaluate()
  assert.equal(longPredicate.eligible, true)
  assert.deepEqual(adaptEdgeDecision(candidateFor(longPredicate), longPredicate), { eligible: false })
})
