import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPair, signDocument } from '../src/attestation/sign.mjs'
import { EDGE_RECORD_SCHEMA, EDGE_DECISION_SCHEMA, bytesDigest, edgeDigest, edgeIdentity, validateEdgeRecord } from '../src/edge-policy/contract.mjs'
import { evaluateEdge, groupEligibleEdges, displayEligibleEdge, edgeEvidenceOccurrences } from '../src/edge-policy/policy.mjs'

const now = '2026-01-02T12:00:00.000Z'
function fixture({ family = 'reviewed-assertion', crossRepo = true, supportId = 'support:one', policy: policyPatch = {} } = {}) {
  const policy = { version: 'synthetic-policy-1', allowProposerReview: false, allowSharedSteward: false, ...policyPatch }
  const policyDigest = edgeDigest(policy)
  const body = Buffer.from('A synthetic observation.\n')
  const source = { repoId: 'repo:one', path: 'notes/observation.md', revision: 'revision-one', fileDigest: bytesDigest(body), locator: { byteStart: 2, byteEnd: 11 }, citedDigest: bytesDigest(body.subarray(2, 11)) }
  const record = { schema: EDGE_RECORD_SCHEMA, family, subject: { repoId: 'repo:one', localId: 'record:a' }, predicate: family === 'hyperlink' ? 'links-to' : 'supports',
    object: { repoId: crossRepo ? 'repo:two' : 'repo:one', localId: 'record:b' }, home: { repoId: 'repo:one', path: 'edges/assertion.json', readership: 'readers:restricted' },
    origin: structuredClone(source), supports: [{ id: supportId, source: structuredClone(source) }], policyDigest, proposalRef: 'proposal:synthetic:one',
    sourceChange: family === 'hyperlink' ? null : { repoId: 'repo:one', path: 'edges/assertion.json', baseRevision: 'base-one', diffDigest: bytesDigest('synthetic proposed diff'), reviewRef: 'owner-review:synthetic:one' }, qualifications: ['Observed in a synthetic case.'] }
  const actors = new Map(['proposer', 'home', 'steward-one', 'steward-two', 'impostor'].map((actorId) => [actorId, generateKeyPair({ keyId: `synthetic-${actorId}` })]))
  const events = []
  let storedRecord = edgeDigest(record), storedCount = 0, storedHead = null
  const roles = [{ repoId: 'repo:one', role: 'home-owner', actorId: 'home' }, { repoId: 'repo:one', role: 'endpoint-steward', actorId: 'steward-one' }, { repoId: crossRepo ? 'repo:two' : 'repo:one', role: 'endpoint-steward', actorId: crossRepo ? 'steward-two' : 'steward-one' }]
  const host = {
    now, policy, bindingId: 'snapshot:synthetic:one',
    readRecordHead: async () => ({ recordDigest: storedRecord, eventCount: storedCount, eventDigest: storedHead }),
    verifyOrigin: async ({ recordDigest }) => ({ recordDigest, bindingId: host.bindingId, matches: true }),
    checkSourceHome: async ({ recordDigest }) => ({ recordDigest, policyDigest, bindingId: host.bindingId, allowed: true }),
    resolveEndpoint: async (ref) => ({ ref, current: true, stewardId: ref.repoId === 'repo:one' ? 'steward-one' : 'steward-two' }),
    resolveHomeOwner: async () => ({ actorId: 'home' }),
    readSource: async () => ({ revision: source.revision, bytes: body }),
    resolveActorKey: async ({ actorId }) => ({ actorId, publicKey: actors.get(actorId)?.publicKeyDoc, revoked: false, notBefore: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-03T00:00:00.000Z' }),
    authorizeDecision: async ({ event }) => ({ eventDigest: edgeDigest(event), policyDigest, bindingId: host.bindingId, revoked: false, notBefore: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-03T00:00:00.000Z', allowed: event.action === 'propose' ? event.actorId === 'proposer' : event.action === 'approve' ? event.roles.every((r) => roles.some((rr) => rr.actorId === event.actorId && rr.repoId === r.repoId && rr.role === r.role)) : event.actorId === 'home' }),
  }
  function sealHead() { storedRecord = edgeDigest(record); storedCount = events.length; storedHead = events.length ? edgeDigest(events.at(-1)) : null }
  function decision(action, actorId, reviewRoles = [], patch = {}, signer = actorId) {
    const event = { schema: EDGE_DECISION_SCHEMA, recordDigest: edgeDigest(record), sequence: events.length + 1, previousDigest: events.length ? edgeDigest(events.at(-1)) : null,
      action, actorId, at: '2026-01-02T10:00:00.000Z', policyDigest, reason: 'Synthetic review decision.', roles: reviewRoles, signature: null, ...patch }
    const key = actors.get(signer).privateKeyDoc
    events.push(signDocument(event, { privateKey: key.privateKeyJwk, keyId: key.keyId, algorithm: key.algorithm }))
    sealHead()
  }
  function accept() {
    decision('propose', 'proposer')
    decision('approve', 'home', [{ repoId: 'repo:one', role: 'home-owner' }])
    decision('approve', 'steward-one', [{ repoId: 'repo:one', role: 'endpoint-steward' }])
    if (crossRepo) decision('approve', 'steward-two', [{ repoId: 'repo:two', role: 'endpoint-steward' }])
    decision('accept', 'home')
  }
  return { record, events, host, body, source, decision, accept, sealHead, evaluate: () => evaluateEdge({ record, events }, host) }
}

test('authenticated reviews activate an immutable source-bound assertion and a bounded display', async () => {
  const f = fixture(); f.accept()
  const result = await f.evaluate()
  assert.equal(result.state, 'active'); assert.equal(result.eligible, true)
  assert.equal(result.history.length, 5); assert.equal(result.reviewRefs.length, 3)
  assert.equal(result.edgeId, edgeIdentity(f.record).edgeId)
  assert.throws(() => { result.history[0].actorId = 'impostor' }, TypeError)
  assert.equal(f.events[0].actorId, 'proposer')
  const display = displayEligibleEdge(result)
  assert.equal(display.source.repoId, 'repo:one'); assert.equal(display.target.repoId, 'repo:two')
  assert.equal(display.supportRefs.length, 2); assert.equal(display.history, undefined)
  assert.equal(display.sourceChange, undefined); assert.equal(displayEligibleEdge(structuredClone(result)), null)
})

test('a forged actor, signature, local asserted review or loose receipt never activates an assertion', async () => {
  const f = fixture(); f.decision('propose', 'proposer', [], {}, 'impostor')
  assert.equal((await f.evaluate()).reason, 'actor-key-unavailable')
  const local = fixture(); local.events.push({ actorId: 'home', accepted: true }); local.sealHead()
  assert.equal((await local.evaluate()).eligible, false)
  const g = fixture(); g.accept(); g.host.authorizeDecision = async () => ({ allowed: true })
  assert.equal((await g.evaluate()).reason, 'decision-grant-unavailable')
})

test('secret endpoints or evidence in a shared source home fail closed before source reads', async () => {
  const f = fixture(); f.accept()
  let reads = 0
  f.host.checkSourceHome = async () => ({ recordDigest: edgeDigest(f.record), policyDigest: f.record.policyDigest, allowed: false })
  f.host.readSource = async () => { reads++; throw new Error('hidden source') }
  assert.equal((await f.evaluate()).reason, 'unsafe-source-home'); assert.equal(reads, 0)
})

test('changed revision, file bytes and exact citation range become stale without replacing evidence pins', async (t) => {
  for (const change of ['revision', 'bytes', 'range']) await t.test(change, async () => {
    const f = fixture(); f.accept(); const before = structuredClone(f.record)
    if (change === 'revision') f.host.readSource = async () => ({ revision: 'revision-two', bytes: f.body })
    if (change === 'bytes') f.host.readSource = async () => ({ revision: f.source.revision, bytes: Buffer.from('Changed synthetic observation.') })
    if (change === 'range') { f.record.supports[0].source.locator.byteEnd++; f.sealHead(); f.events.length = 0; f.accept() }
    const result = await f.evaluate(); assert.equal(result.state, 'stale'); assert.equal(result.eligible, false)
    if (change !== 'range') assert.deepEqual(f.record, before)
  })
})

test('kg.relations cross-repository source declarations cannot bypass endpoint review', async () => {
  const f = fixture({ family: 'source-declaration' })
  assert.equal((await f.evaluate()).state, 'draft')
  f.decision('propose', 'proposer'); f.decision('approve', 'home', [{ repoId: 'repo:one', role: 'home-owner' }]); f.decision('accept', 'home')
  assert.equal((await f.evaluate()).reason, 'missing-reviewer')
  const complete = fixture({ family: 'source-declaration' }); complete.accept()
  assert.equal((await complete.evaluate()).assurance, 'reviewed-assertion')
})

test('same-repository declarations and cross-repository links keep their distinct assurance', async () => {
  const local = fixture({ family: 'source-declaration', crossRepo: false })
  assert.equal((await local.evaluate()).assurance, 'source-declaration')
  const link = fixture({ family: 'hyperlink' })
  const result = await link.evaluate()
  assert.equal(result.assurance, 'navigation'); assert.equal(result.reviewRefs.length, 0)
  link.decision('propose', 'proposer'); assert.equal((await link.evaluate()).eligible, false)
})

test('revoked keys and grants, expired authority and policy change suspend previously active edges', async (t) => {
  for (const change of ['key', 'grant', 'revoked-grant', 'expired-grant', 'expiry', 'policy']) await t.test(change, async () => {
    const f = fixture(); f.accept(); assert.equal((await f.evaluate()).eligible, true)
    const resolve = f.host.resolveActorKey
    if (change === 'key') f.host.resolveActorKey = async (v) => ({ ...await resolve(v), revoked: true })
    if (change === 'expiry') f.host.resolveActorKey = async (v) => ({ ...await resolve(v), expiresAt: now })
    if (change === 'grant') f.host.authorizeDecision = async () => ({ allowed: false })
    const grant = f.host.authorizeDecision
    if (change === 'revoked-grant') f.host.authorizeDecision = async (v) => ({ ...await grant(v), revoked: true })
    if (change === 'expired-grant') f.host.authorizeDecision = async (v) => ({ ...await grant(v), expiresAt: now })
    if (change === 'policy') f.host.policy = { ...f.host.policy, version: 'synthetic-policy-2' }
    const result = await f.evaluate(); assert.equal(result.state, 'suspended'); assert.equal(result.eligible, false)
    assert.equal(result.history.length, 5)
  })
})

test('a relation cannot be relabelled as a hyperlink or detached from its exact parsed origin', async () => {
  const f = fixture({ family: 'hyperlink' })
  f.host.verifyOrigin = async ({ recordDigest }) => ({ recordDigest, bindingId: f.host.bindingId, matches: false })
  assert.equal((await f.evaluate()).reason, 'origin-mismatch')
  const g = fixture(); g.accept()
  g.host.checkSourceHome = async ({ recordDigest, policyDigest }) => ({ recordDigest, policyDigest, bindingId: 'old-snapshot', allowed: true })
  assert.equal((await g.evaluate()).eligible, false)
})

test('truncated history, changed records, reordering and unsigned event edits cannot replay acceptance', async (t) => {
  for (const change of ['truncate', 'record', 'reorder', 'event']) await t.test(change, async () => {
    const f = fixture(); f.accept()
    if (change === 'truncate') f.events.pop()
    if (change === 'record') f.record.predicate = 'contradicts'
    if (change === 'reorder') { [f.events[1], f.events[2]] = [f.events[2], f.events[1]]; f.sealHead() }
    if (change === 'event') { f.events[2].reason = 'Modified review'; f.sealHead() }
    assert.equal((await f.evaluate()).eligible, false)
  })
})

test('withdrawn, suspended and superseded assertions retain the entire signed history', async (t) => {
  for (const action of ['withdraw', 'suspend', 'supersede']) await t.test(action, async () => {
    const f = fixture(); f.accept(); f.decision(action, 'home')
    const result = await f.evaluate()
    assert.equal(result.state, { withdraw: 'withdrawn', suspend: 'suspended', supersede: 'superseded' }[action])
    assert.equal(result.eligible, false); assert.equal(result.history.length, 6)
    assert.equal(displayEligibleEdge(result), null)
    f.decision('accept', 'home'); assert.equal((await f.evaluate()).reason, 'terminal-history-continued')
  })
})

test('same triple retains multiple assertions and every supporting occurrence deterministically', async () => {
  const first = fixture(), second = fixture({ supportId: 'support:two' })
  first.accept(); second.accept()
  const a = await first.evaluate(), b = await second.evaluate()
  const groups = groupEligibleEdges([b, a, a])
  assert.equal(groups.length, 1); assert.equal(groups[0].assertions.length, 2)
  assert.equal(groups[0].assertions.flatMap((r) => r.supportRefs).length, 4)
  assert.deepEqual(groups, groupEligibleEdges([a, b]))
  assert.throws(() => groupEligibleEdges([structuredClone(a)]), /unverified/)
  second.decision('withdraw', 'home')
  assert.equal(groupEligibleEdges([a, await second.evaluate()])[0].assertions.length, 1)
})

test('malformed refs, traversal, caller acceptance flags and invalid byte locators refuse structurally', () => {
  const f = fixture(); assert.equal(validateEdgeRecord(f.record), true)
  for (const mutate of [(r) => { r.subject.localId = '' }, (r) => { r.home.path = '../shared.json' }, (r) => { r.accepted = true }, (r) => { r.origin.locator.byteStart = -1 }]) {
    const r = structuredClone(f.record); mutate(r); assert.equal(validateEdgeRecord(r), false)
  }
})

test('port failures expose no hidden diagnostic text and never activate an edge', async () => {
  const f = fixture(); f.accept(); f.host.resolveEndpoint = async () => { throw new Error('sensitive hidden target detail') }
  const result = await f.evaluate()
  assert.deepEqual(result, { state: 'suspended', eligible: false, reason: 'verification-unavailable' })
  assert.equal(JSON.stringify(result).includes('sensitive'), false)
})

test('repository-scoped roles refuse conflicting endpoint stewards and undelegated shared stewards', async () => {
  const sameRepo = fixture({ crossRepo: false }); sameRepo.accept()
  sameRepo.host.resolveEndpoint = async (ref) => ({ ref, current: true, stewardId: ref.localId === 'record:a' ? 'steward-one' : 'steward-two' })
  assert.equal((await sameRepo.evaluate()).reason, 'endpoint-steward-conflict')
  const shared = fixture(); shared.accept()
  shared.host.resolveEndpoint = async (ref) => ({ ref, current: true, stewardId: 'steward-one' })
  assert.equal((await shared.evaluate()).reason, 'shared-steward-not-delegated')
})

test('grouping refuses decisions bound to different reader/source snapshots', async () => {
  const a = fixture(), b = fixture({ supportId: 'support:two' }); a.accept(); b.accept()
  b.host.bindingId = 'snapshot:synthetic:other-reader'
  const first = await a.evaluate(), second = await b.evaluate()
  assert.equal(first.eligible, true); assert.equal(second.eligible, true)
  assert.throws(() => groupEligibleEdges([first, second]), /mixed edge decision bindings/)
})

test('evidence occurrence helper preserves exact evaluator identities, source refs and support order', async () => {
  const f = fixture()
  f.record.supports.push({ id: 'support:later', source: { ...structuredClone(f.source), path: 'notes/alternate.md' } },
    { id: 'support:earlier', source: structuredClone(f.source) })
  f.accept()
  const before = JSON.stringify({ record: f.record, events: f.events })
  const occurrences = edgeEvidenceOccurrences(f.record)
  assert.deepEqual(occurrences.map((s) => s.occurrenceId), ['origin', 'support:support:one', 'support:support:later', 'support:support:earlier'])
  assert.deepEqual(occurrences.map((s) => s.source), [f.record.origin, ...f.record.supports.map((s) => s.source)])
  assert.equal(new Set(occurrences.map((s) => s.id)).size, 4)
  assert.equal(Object.isFrozen(f.record.origin), false)
  assert.equal(Object.isFrozen(f.record.supports[1].source), false)
  assert.throws(() => { occurrences[1].source.path = 'notes/changed.md' }, TypeError)
  assert.throws(() => { occurrences.reverse() }, TypeError)
  const decision = await f.evaluate()
  assert.equal(decision.eligible, true)
  assert.deepEqual(decision.supportRefs, occurrences)
  assert.deepEqual(displayEligibleEdge(decision).supportRefs, occurrences.map((s) => s.id))
  assert.equal(displayEligibleEdge({ ...decision }), null)
  assert.equal(JSON.stringify({ record: f.record, events: f.events }), before)
  assert.equal(decision.recordDigest, edgeDigest(f.record))
})

test('every evidence occurrence remains bound to the complete record', async (t) => {
  for (const [name, change] of [
    ['predicate', (r) => { r.predicate = 'contradicts' }],
    ['qualification', (r) => { r.qualifications.push('Applies only to an invented second case.') }],
    ['endpoint', (r) => { r.object.localId = 'record:other' }],
    ['home readership', (r) => { r.home.readership = 'readers:other' }],
    ['support identity', (r) => { r.supports[0].id = 'support:other' }],
    ['support source', (r) => { r.supports[0].source.path = 'notes/other.md' }],
    ['support order', (r) => { r.supports.reverse() }],
  ]) await t.test(name, async () => {
    const f = fixture({ family: 'source-declaration', crossRepo: false })
    f.record.supports.push({ id: 'support:another', source: structuredClone(f.source) })
    const original = edgeEvidenceOccurrences(f.record)
    change(f.record)
    f.sealHead()
    const changed = edgeEvidenceOccurrences(f.record)
    assert.equal(changed.some((s) => original.some((old) => old.id === s.id)), false)
    const decision = await f.evaluate()
    assert.equal(decision.eligible, true)
    assert.deepEqual(decision.supportRefs, changed)
  })
})

test('evidence occurrence helper refuses malformed complete records', async (t) => {
  const f = fixture()
  for (const [name, invalid] of [
    ['missing record', null], ['empty record', {}],
    ['extra field', { ...f.record, eligible: true }],
    ['missing qualifications', Object.fromEntries(Object.entries(f.record).filter(([key]) => key !== 'qualifications'))],
    ['invalid endpoint', { ...f.record, subject: { repoId: 'repo:one', localId: '' } }],
    ['invalid family', { ...f.record, family: 'unknown' }],
    ['invalid home', { ...f.record, home: { ...f.record.home, path: '../outside.json' } }],
    ['invalid source', { ...f.record, origin: { ...f.source, locator: { byteStart: -1, byteEnd: 1 } } }],
    ['duplicate support identity', { ...f.record, supports: [...f.record.supports, structuredClone(f.record.supports[0])] }],
  ]) await t.test(name, () => assert.throws(() => edgeEvidenceOccurrences(invalid), { name: 'TypeError', message: 'invalid edge record' }))
})
