import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalize } from '../src/attestation/jcs.mjs'
import { createGraphAccess, digestAccessCandidate, GraphAccessRefusal } from '../src/graph-access/index.mjs'

const digest = value => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
const rev = n => String(n).repeat(40)
const nodeRef = repoId => ({ repoId, localId: 'record:one' })
const sourceRef = repoId => ({ repoId, path: 'records/one.md', revision: digest(['snapshot', repoId]), digest: digest(repoId), locator: { range: { start: 0, end: 4, byteStart: 0, byteEnd: 4 } } })
const A = 'github:1001', B = 'github:2002'

function contribution(repoId) {
  const pin = sourceRef(repoId)
  return {
    repository: { repoId, ownerRef: `owner:${repoId}` },
    snapshot: { repoId, head: rev(repoId === A ? 1 : 2), tree: rev(3), dirty: false, scope: { base: '', include: null, exclude: null },
      files: [{ path: pin.path, rawDigest: pin.digest, byteLength: 10 }], digest: digest(['snapshot', repoId]) },
    nodes: [{ ref: nodeRef(repoId), sourceKind: 'document', title: `Record ${repoId}`, summary: 'Invented source.',
      classification: 'source', lifecycle: 'active', tags: ['concept:example'], sourceRef: pin,
      // These source-wide/untrusted fields must never become view fields.
      relations: { related: ['private:target'] }, degree: 999, hiddenCount: 73, searchTerms: ['unshared-keyword'] }],
    evidence: [{ evidenceId: `evidence:${repoId}`, sourceRef: pin }],
    edges: [{ edgeId: `edge:${repoId}`, source: nodeRef(repoId), target: nodeRef(repoId), sourceRef: pin,
      supportRefs: [`evidence:${repoId}`], predicate: 'related', family: 'source-declaration' }],
    diagnostics: [{ message: 'private:target unshared-keyword', globalCount: 999 }],
  }
}

function fixture(repoIds = [A, B], options = {}) {
  let clock = 1000, active = true
  const data = new Map([[A, contribution(A)], [B, contribution(B)]])
  const loaded = [], evaluated = [], verified = []
  data.get(A).edges.push({ edgeId: 'edge:cross', source: nodeRef(A), target: nodeRef(B), sourceRef: sourceRef(A),
    supportRefs: [`evidence:${A}`, `evidence:${B}`], predicate: 'supports', family: 'reviewed-assertion' })
  const approved = id => {
    const c = data.get(id)
    return { repoId: id, ownerRef: c.repository.ownerRef, head: c.snapshot.head, tree: c.snapshot.tree,
      scope: structuredClone(c.snapshot.scope), snapshotDigest: c.snapshot.digest, contributionDigest: digest(c) }
  }
  let decision = { principalRef: 'principal:one', proofRef: 'proof:one', grantRevision: 'grant:1', policyRevision: 'policy:1',
    expiresAt: 2000, operation: 'read', repositories: repoIds.map(approved) }
  const ports = {
    async resolveAccess(_context, { operation }) { return { ...decision, operation } },
    async loadContribution(r) { loaded.push(r.repoId); return data.get(r.repoId) },
    async verifyContribution(c, r) { verified.push(r.repoId); return c.repository.ownerRef === r.ownerRef },
    async evaluateEdge(e) {
      evaluated.push(e.edgeId)
      return { edgeId: e.edgeId, source: e.source, target: e.target, supportRefs: e.supportRefs,
        predicate: e.predicate, family: e.family, eligible: true, acceptanceState: 'active', sourceRef: e.supportRefs[0],
        assurance: e.family, qualifications: ['Synthetic bounded scope.'], reviewRefs: ['review:synthetic'],
        recordDigest: digest(e), policyDigest: digest('policy:1') }
    },
    async revalidate() { return active },
    ...options.ports,
  }
  const access = createGraphAccess(ports, { now: () => clock })
  return { access, data, loaded, evaluated, verified, ports, approved,
    repin() { decision.repositories = repoIds.map(approved) },
    changeDecision(fn) { fn(decision) }, revoke() { active = false }, tick(value) { clock = value } }
}

for (const [label, ids] of [['A only', [A]], ['B only', [B]], ['both', [A, B]], ['neither', []]]) {
  test(`reader matrix: ${label}`, async () => {
    const f = fixture(ids)
    const result = await f.access.loadAuthorizedGraph({ browserPrincipal: 'ignored' })
    assert.deepEqual(f.loaded.sort(), [...ids].sort())
    assert.deepEqual(result.graph.nodes.map(n => n.ref.repoId).sort(), [...ids].sort())
    assert.equal(result.graph.edges.length, ids.length === 2 ? 3 : ids.length)
    assert.deepEqual(result.graph.counts, { nodes: ids.length, edges: result.graph.edges.length, evidence: ids.length })
    for (const denied of [A, B].filter(id => !ids.includes(id))) assert.equal(JSON.stringify(result.graph).includes(denied), false)
    assert.equal(JSON.stringify(result.graph).includes('unshared-keyword'), false)
    assert.equal(JSON.stringify(result.graph).includes('hiddenCount'), false)
    assert.equal(JSON.stringify(result.graph).includes('relations'), false)
    assert.equal(JSON.stringify(result.graph).includes('principal:one'), false)
    assert.equal(f.evaluated.includes('edge:cross'), ids.length === 2)
    assert.equal(await f.access.revalidate(result.binding), true)
  })
}

test('denied topology, malformed data, errors and search terms cannot alter the authorized result or key', async () => {
  const first = fixture([A]), second = fixture([A])
  second.data.set(B, { malformed: 'denied-secret-path.md', nodes: Array(77).fill({ term: 'hidden-query' }) })
  const a = await first.access.loadAuthorizedGraph({}), b = await second.access.loadAuthorizedGraph({})
  assert.deepEqual(a.graph, b.graph)
  assert.equal(a.binding.cacheKey, b.binding.cacheKey)
  assert.deepEqual(second.loaded, [A])
})

test('duplicate local IDs remain distinct qualified refs', async () => {
  const { graph } = await fixture().access.loadAuthorizedGraph({})
  assert.equal(graph.nodes[0].ref.localId, graph.nodes[1].ref.localId)
  assert.notEqual(graph.nodes[0].ref.repoId, graph.nodes[1].ref.repoId)
})

test('trusted owner verification is required even with a valid contribution hash', async () => {
  const f = fixture([A], { ports: { verifyContribution: async () => false } })
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(graph.nodes.length, 0)
  assert.deepEqual(graph.diagnostics.map(d => [d.repoId, d.code]), [[A, 'authorized-source-unavailable']])
})

for (const length of [40, 64]) {
  test(`exact ${length}-character Git object IDs retain source snapshot pins`, async () => {
    const f = fixture([A]), snapshot = f.data.get(A).snapshot
    snapshot.head = 'a'.repeat(length); snapshot.tree = 'b'.repeat(length)
    f.repin()
    const { graph } = await f.access.loadAuthorizedGraph({})
    assert.equal(graph.completeness, 'complete')
    assert.deepEqual(graph.counts, { nodes: 1, edges: 1, evidence: 1 })
    assert.equal(graph.sourceSnapshot.repositories[0].head, snapshot.head)
    assert.equal(graph.sourceSnapshot.repositories[0].tree, snapshot.tree)
    assert.equal(graph.sourceSnapshot.repositories[0].digest, snapshot.digest)
    assert.equal(graph.nodes[0].sourceRef.revision, snapshot.digest)
    assert.deepEqual(f.verified, [A])
  })
}

test('malformed Git object IDs refuse access before contribution loading', async () => {
  const invalid = ['', ...[39, 41, 63, 65].map(length => 'a'.repeat(length)),
    'a'.repeat(39) + 'g', 'a'.repeat(63) + 'g', 'A'.repeat(40), 'A'.repeat(64),
    'a'.repeat(40) + '\n', 'a'.repeat(64) + '\n']
  for (const field of ['head', 'tree']) for (const value of invalid) {
    const f = fixture([A])
    f.changeDecision(d => { d.repositories[0][field] = value })
    await assert.rejects(f.access.loadAuthorizedGraph({}), GraphAccessRefusal)
    assert.deepEqual(f.loaded, [])
  }
})

test('SHA-256 Git object IDs preserve exact snapshot and contribution digest binding', async () => {
  for (const field of ['head', 'tree', 'snapshotDigest', 'contributionDigest']) {
    const f = fixture([A]), snapshot = f.data.get(A).snapshot
    snapshot.head = 'a'.repeat(64); snapshot.tree = 'b'.repeat(64)
    f.repin()
    f.changeDecision(d => { d.repositories[0][field] = field.endsWith('Digest') ? digest('different') : 'c'.repeat(64) })
    const { graph } = await f.access.loadAuthorizedGraph({})
    assert.equal(graph.completeness, 'incomplete')
    assert.deepEqual(graph.counts, { nodes: 0, edges: 0, evidence: 0 })
    assert.deepEqual(graph.sourceSnapshot.repositories, [])
    assert.deepEqual(graph.diagnostics.map(d => [d.repoId, d.code]), [[A, 'authorized-source-unavailable']])
  }
})

for (const field of ['ownerRef', 'scope', 'head', 'tree', 'snapshotDigest', 'contributionDigest']) {
  test(`mismatched ${field} excludes the entire contribution`, async () => {
    const f = fixture([A])
    f.changeDecision(d => { d.repositories[0][field] = field === 'scope' ? { base: '.', include: 'other.md', exclude: null } : field.endsWith('Digest') ? digest('different') : ['head', 'tree'].includes(field) ? rev(9) : 'owner:wrong' })
    const { graph } = await f.access.loadAuthorizedGraph({})
    assert.equal(graph.nodes.length, 0)
    assert.equal(graph.edges.length, 0)
    assert.equal(graph.diagnostics.length, 1)
  })
}

test('raw exceptions are replaced with a fixed authorized-source diagnostic', async () => {
  const f = fixture([A], { ports: { loadContribution: async () => { throw new Error('hidden-query secret/repo/path.md') } } })
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(JSON.stringify(graph).includes('hidden-query'), false)
  assert.equal(JSON.stringify(graph).includes('secret/repo'), false)
  assert.equal(graph.diagnostics[0].repoId, A)
})

test('stale revision, outside-scope paths and unverified evidence never reach edges', async () => {
  const f = fixture([A])
  f.data.get(A).nodes[0].sourceRef.path = 'outside.md'
  f.data.get(A).evidence[0].sourceRef.revision = digest('stale')
  f.repin()
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.deepEqual(graph.counts, { nodes: 0, edges: 0, evidence: 0 })
  assert.equal(graph.completeness, 'incomplete')
  assert.deepEqual(f.evaluated, [])
})

test('missing evidence in a permitted third-party repo removes the edge without a hidden-topology badge', async () => {
  const f = fixture([A, B])
  f.data.get(A).edges.at(-1).supportRefs.push('evidence:missing')
  f.repin()
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(graph.edges.some(e => e.edgeId === 'edge:cross'), false)
  assert.equal(graph.diagnostics.length, 0)
  assert.equal(f.evaluated.includes('edge:cross'), false)
})

test('self-asserted eligible/accepted flags cannot replace edge policy', async () => {
  const f = fixture([A], { ports: { evaluateEdge: async () => ({ eligible: false }) } })
  f.data.get(A).edges[0].eligible = true
  f.data.get(A).edges[0].acceptanceState = 'active'
  f.repin()
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(graph.edges.length, 0)
})

test('an edge decision for a different triple or support set is refused', async () => {
  const f = fixture([A], { ports: { evaluateEdge: async e => ({ ...e, eligible: true, target: nodeRef(B), acceptanceState: 'active' }) } })
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(graph.edges.length, 0)
})

test('revoked at start refuses before any contribution read', async () => {
  const f = fixture(); f.revoke()
  await assert.rejects(f.access.loadAuthorizedGraph({}), GraphAccessRefusal)
  assert.deepEqual(f.loaded, [])
})

test('revocation during source verification blocks the prepared graph', async () => {
  const f = fixture([A])
  f.ports.verifyContribution = async () => { f.revoke(); return true }
  await assert.rejects(f.access.loadAuthorizedGraph({}), GraphAccessRefusal)
})

test('expiry during edge evaluation blocks delivery', async () => {
  const f = fixture([A])
  const original = f.ports.evaluateEdge
  f.ports.evaluateEdge = async (...args) => { f.tick(2000); return original(...args) }
  await assert.rejects(f.access.loadAuthorizedGraph({}), GraphAccessRefusal)
})

test('delivery guard rejects revoked, expired, aborted and copied bindings', async () => {
  const f = fixture([A]), result = await f.access.loadAuthorizedGraph({})
  assert.equal(await f.access.revalidate({ ...result.binding }), false)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(f.access.guardArtifact(result.binding, result.graph, { signal: controller.signal }), GraphAccessRefusal)
  f.revoke()
  await assert.rejects(f.access.guardArtifact(result.binding, result.graph), GraphAccessRefusal)
  assert.equal(await f.access.revalidate(result.binding), false)
  const g = fixture([A]), expired = await g.access.loadAuthorizedGraph({}); g.tick(2000)
  assert.equal(await g.access.revalidate(expired.binding), false)
})

test('mixed artifacts, copied graphs and a read-only binding cannot be exported', async () => {
  const a = fixture([A]), both = fixture([A, B])
  const one = await a.access.loadAuthorizedGraph({}), mixed = await both.access.loadAuthorizedGraph({})
  await assert.rejects(a.access.guardArtifact(one.binding, mixed.graph), GraphAccessRefusal)
  await assert.rejects(a.access.guardArtifact(one.binding, structuredClone(one.graph)), GraphAccessRefusal)
  await assert.rejects(a.access.guardArtifact(one.binding, one.graph, { operation: 'export' }), GraphAccessRefusal)
  const exported = await a.access.loadAuthorizedGraph({}, { operation: 'export' })
  assert.equal(await a.access.guardArtifact(exported.binding, exported.graph, { operation: 'export' }), exported.graph)
})

for (const field of ['principalRef', 'grantRevision', 'policyRevision', 'expiresAt']) {
  test(`cache binding changes with ${field}`, async () => {
    const a = fixture([A]), b = fixture([A])
    b.changeDecision(d => { d[field] = field === 'expiresAt' ? 3000 : `${d[field]}:changed` })
    const x = await a.access.loadAuthorizedGraph({}), y = await b.access.loadAuthorizedGraph({})
    assert.notEqual(x.binding.cacheKey, y.binding.cacheKey)
  })
}

test('unknown decision, missing trusted ports and browser claims fail closed', async () => {
  assert.throws(() => createGraphAccess({}), GraphAccessRefusal)
  const f = fixture([A], { ports: { resolveAccess: async c => c } })
  await assert.rejects(f.access.loadAuthorizedGraph({ principalRef: 'browser:one', audience: 'public', readBoundary: 'public', author: 'trusted' }), GraphAccessRefusal)
})

test('source inputs remain exact pins; a config or plan outside the verified snapshot is null', async () => {
  const f = fixture([A])
  f.data.get(A).inputs = { config: sourceRef(A), plan: { ...sourceRef(B), path: 'hidden-plan.json' } }
  f.repin()
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.deepEqual(graph.sourceSnapshot.repositories[0].inputs, { config: sourceRef(A), plan: null })
  assert.equal(JSON.stringify(graph).includes('hidden-plan.json'), false)
})

test('malformed or out-of-range locators cannot create inspectable source pins', async () => {
  for (const locator of [{ range: { start: 0, end: 100 } }, { pointer: 'not-a-pointer' }, { range: { start: 0, end: 4, byteStart: 0 } }, { query: 'private-term' }]) {
    const f = fixture([A])
    f.data.get(A).nodes[0].sourceRef.locator = locator
    f.repin()
    const { graph } = await f.access.loadAuthorizedGraph({})
    assert.equal(graph.nodes.length, 0)
    assert.equal(graph.edges.length, 0)
    assert.equal(graph.completeness, 'incomplete')
    assert.equal(JSON.stringify(graph).includes('private-term'), false)
  }
})

test('policy is not called when an edge record home is outside its contribution', async () => {
  const f = fixture([A, B])
  for (const e of f.data.get(A).edges) e.sourceRef = sourceRef(B)
  f.repin()
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.deepEqual(f.evaluated, [`edge:${B}`])
  assert.equal(graph.edges.length, 1)
})

test('an unavailable approved repo makes the graph explicitly incomplete', async () => {
  const f = fixture([A, B]), load = f.ports.loadContribution
  f.ports.loadContribution = async r => { if (r.repoId === B) throw new Error('private text'); return load(r) }
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(graph.completeness, 'incomplete')
  assert.deepEqual(graph.nodes.map(n => n.ref.repoId), [A])
  assert.equal(graph.edges.some(e => e.edgeId === 'edge:cross'), false)
  assert.equal(graph.diagnostics[0].repoId, B)
})

test('source projection pin uses existing canonical JSON semantics and rejects lossy input', () => {
  assert.equal(digestAccessCandidate({ z: 1, a: ['x'] }), digest({ a: ['x'], z: 1 }))
  assert.throws(() => digestAccessCandidate({ field: undefined }))
})

test('cache keys bind both repo set and selected source/scope changes', async () => {
  const a = fixture([A]), b = fixture([A, B]), c = fixture([A])
  c.data.get(A).snapshot.scope.include = 'records/*.md'; c.repin()
  const [x, y, z] = await Promise.all([a.access.loadAuthorizedGraph({}), b.access.loadAuthorizedGraph({}), c.access.loadAuthorizedGraph({})])
  assert.equal(new Set([x.binding.cacheKey, y.binding.cacheKey, z.binding.cacheKey]).size, 3)
})

test('issued graphs and nested source bindings cannot be mutated after authorization', async () => {
  const { graph } = await fixture([A]).access.loadAuthorizedGraph({})
  assert.throws(() => { graph.nodes[0].title = 'changed' }, TypeError)
  assert.throws(() => { graph.sourceSnapshot.repositories[0].files.push({}) }, TypeError)
})

test('edge policy exceptions fail with the same public refusal and no raw diagnostics', async () => {
  const f = fixture([A], { ports: { evaluateEdge: async () => { throw new Error('denied/source.md hidden-query') } } })
  await assert.rejects(f.access.loadAuthorizedGraph({}), e => e instanceof GraphAccessRefusal && e.message === 'Graph access unavailable')
})

test('host revocation notifications can synchronously retire an issued binding', async () => {
  const f = fixture([A]), result = await f.access.loadAuthorizedGraph({})
  assert.equal(result.binding.expiresAt, result.graph.accessContext.expiresAt)
  assert.equal(f.access.invalidate(result.binding), true)
  assert.equal(await f.access.revalidate(result.binding), false)
  await assert.rejects(f.access.guardArtifact(result.binding, result.graph), GraphAccessRefusal)
  assert.equal(f.access.invalidate({ ...result.binding }), false)
})

test('qualified assertions retain policy provenance and are not collapsed to a bare triple', async () => {
  const { graph } = await fixture([A, B]).access.loadAuthorizedGraph({})
  const e = graph.edges.find(e => e.edgeId === 'edge:cross')
  assert.deepEqual(e.qualifications, ['Synthetic bounded scope.'])
  assert.deepEqual(e.reviewRefs, ['review:synthetic'])
  assert.ok(e.recordDigest.startsWith('sha256:'))
  assert.ok(e.policyDigest.startsWith('sha256:'))
  assert.ok(e.supportRefs.includes(e.sourceRef))
})

test('scope metadata cannot smuggle arbitrary diagnostic or query fields into a source snapshot', async () => {
  const f = fixture([A])
  f.data.get(A).snapshot.scope.hiddenQuery = 'unshared-term'
  f.repin()
  await assert.rejects(f.access.loadAuthorizedGraph({}), GraphAccessRefusal)
  assert.deepEqual(f.loaded, [])
})

test('synchronous revocation while delivery revalidation is awaiting cannot return the graph', async () => {
  const f = fixture([A]), result = await f.access.loadAuthorizedGraph({})
  let resume, entered
  const started = new Promise(resolve => { entered = resolve })
  f.ports.revalidate = async () => { entered(); return new Promise(resolve => { resume = resolve }) }
  const delivering = f.access.guardArtifact(result.binding, result.graph)
  await started
  f.access.invalidate(result.binding)
  resume(true)
  await assert.rejects(delivering, GraphAccessRefusal)
  assert.equal(await f.access.revalidate(result.binding), false)
})

test('source occurrence range digests survive the authorized evidence projection', async () => {
  const f = fixture([A])
  f.data.get(A).evidence[0].sourceRef.locator.rangeDigest = digest('synthetic verified raw range')
  f.repin()
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(graph.completeness, 'complete')
  assert.equal(graph.evidence[0].sourceRef.locator.rangeDigest, digest('synthetic verified raw range'))
})

test('invalid, orphaned or out-of-bounds range digests make the approved source incomplete', async () => {
  for (const locator of [{ rangeDigest: digest('range') }, { range: { start: 0, end: 4, byteStart: 0, byteEnd: 4 }, rangeDigest: 'not-a-digest' }, { range: { start: 0, end: 4, byteStart: 0, byteEnd: 100 }, rangeDigest: digest('range') }]) {
    const f = fixture([A]); f.data.get(A).evidence[0].sourceRef.locator = locator; f.repin()
    const { graph } = await f.access.loadAuthorizedGraph({})
    assert.equal(graph.completeness, 'incomplete')
    assert.equal(graph.evidence.length, 0)
    assert.equal(graph.edges.length, 0)
  }
})

test('invalidation queued between host verification and the final promise handoff wins', async () => {
  for (const operation of ['guard', 'revalidate']) {
    const f = fixture([A]), result = await f.access.loadAuthorizedGraph({})
    f.ports.revalidate = async () => {
      queueMicrotask(() => queueMicrotask(() => f.access.invalidate(result.binding)))
      return true
    }
    if (operation === 'guard') await assert.rejects(f.access.guardArtifact(result.binding, result.graph), GraphAccessRefusal)
    else assert.equal(await f.access.revalidate(result.binding), false)
  }
})
