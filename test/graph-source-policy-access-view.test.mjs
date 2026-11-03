import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EDGE_RECORD_SCHEMA, bytesDigest, edgeDigest, edgeIdentity } from '../src/edge-policy/contract.mjs'
import { edgeEvidenceOccurrences, evaluateEdge } from '../src/edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../src/edge-policy/source-citation-adapter.mjs'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'
import { adaptEdgeDecision } from '../src/graph-access/edge-decision-adapter.mjs'
import { adaptEdgeRecord } from '../src/graph-access/edge-record-adapter.mjs'
import { buildRepositoryContribution, validateRepositoryContribution } from '../src/graph/repo-contribution.mjs'
import { createGraphViewReader, parseGraphView } from '../src/graph-view/index.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-source-policy-view-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '--quiet'])
  git(['config', 'user.name', 'Synthetic Source Author'])
  git(['config', 'user.email', 'author@example.invalid'])
  const note = (id, body) => Buffer.from([
    '---', 'title: Invented note', 'summary: Synthetic integration fixture.', 'kg:',
    `  id: ${id}`, '  type: document', '  status: active', '  audience: private', '---', '', body, '',
  ].join('\r\n'))
  const raw = note('synthetic:source', 'Élan 🧭 [café\r\n🧭](target.md)\r\nSYNTHETIC_PRIVATE_SOURCE_BODY\r\nAnother [reference](target.md#section).')
  fs.writeFileSync(path.join(root, 'source.md'), raw)
  fs.writeFileSync(path.join(root, 'target.md'), note('synthetic:target', 'An invented target.'))
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic integration fixture'])

  const repository = { name: 'synthetic', path: root, identity: { provider: 'github', id: '900000001' } }
  const native = buildRepositoryContribution(repository)
  assert.equal(validateRepositoryContribution(native).ok, true)
  assert.equal(native.ordinaryLinks.length, 2)
  const [link, support] = native.ordinaryLinks
  const origin = sourceCitationFromProvenance(native, link.provenance)
  const supportCitation = sourceCitationFromProvenance(native, support.provenance)
  const ownerRef = 'owner:synthetic-private'
  const policy = { version: 'synthetic-navigation-1', allowProposerReview: false, allowSharedSteward: false }
  const record = {
    schema: EDGE_RECORD_SCHEMA, family: 'hyperlink', subject: link.source, predicate: 'links-to', object: link.target,
    home: { repoId: native.repository.repoId, path: link.provenance.path, readership: 'synthetic-readers' },
    origin, supports: [{ id: 'corroborating-link', source: supportCitation }], policyDigest: edgeDigest(policy),
    proposalRef: null, sourceChange: null, qualifications: ['Synthetic source navigation only.'],
  }
  const identity = edgeIdentity(record)
  // Candidate identities are fixed before digesting or evaluating the record.
  const candidate = adaptEdgeRecord(record, native, { ownerRef })
  const contributionDigest = digestAccessCandidate(candidate)
  const approved = {
    repoId: native.repository.repoId, ownerRef, head: native.snapshot.head, tree: native.snapshot.tree,
    scope: native.snapshot.scope, snapshotDigest: native.snapshot.digest, contributionDigest,
  }
  const decisions = [], sourceReads = []
  let currentGrant = true, loaded = 0
  const now = () => Date.parse('2030-01-01T00:00:00.000Z')
  // These synthetic trusted ports own the fixed policy/home/current-byte
  // bindings. Source audience, Git authors and candidate flags grant nothing.
  const host = {
    policy, now: new Date(now()).toISOString(), bindingId: 'binding:synthetic-policy-private',
    readRecordHead: async () => ({ recordDigest: identity.recordDigest, eventCount: 0, eventDigest: null }),
    verifyOrigin: async ({ record: observed, recordDigest }) => ({
      recordDigest, bindingId: host.bindingId,
      matches: recordDigest === identity.recordDigest && edgeDigest(observed) === identity.recordDigest &&
        edgeDigest(observed.origin) === edgeDigest(sourceCitationFromProvenance(native, link.provenance)) &&
        edgeDigest(observed.subject) === edgeDigest(link.source) && edgeDigest(observed.object) === edgeDigest(link.target),
    }),
    checkSourceHome: async ({ record: observed, recordDigest, policyDigest }) => ({
      recordDigest, policyDigest, bindingId: host.bindingId,
      allowed: policyDigest === edgeDigest(policy) && edgeDigest(observed.home) === edgeDigest(record.home) &&
        native.snapshot.files.some(file => file.path === observed.home.path),
    }),
    resolveEndpoint: async ref => native.nodes.some(node => edgeDigest(node.ref) === edgeDigest(ref))
      ? { ref, current: true, stewardId: 'steward:synthetic' } : null,
    resolveHomeOwner: async repoId => repoId === native.repository.repoId ? { actorId: ownerRef } : null,
    readSource: async source => {
      sourceReads.push(source)
      if (source.repoId !== native.repository.repoId || !native.snapshot.files.some(file => file.path === source.path)) return null
      return { revision: native.snapshot.digest, bytes: fs.readFileSync(path.join(root, source.path)) }
    },
  }
  const access = createGraphAccess({
    resolveAccess: async (_context, { operation }) => ({
      operation, principalRef: 'principal:synthetic-private', proofRef: 'proof:synthetic-public',
      grantRevision: 'grant:synthetic-1', policyRevision: 'policy:synthetic-1',
      expiresAt: Date.parse('2031-01-01T00:00:00.000Z'), repositories: [approved],
    }),
    loadContribution: async () => { loaded++; return candidate },
    verifyContribution: async (observed, pin) => {
      const current = buildRepositoryContribution(repository)
      return pin.ownerRef === ownerRef && validateRepositoryContribution(current).ok &&
        current.digest === native.digest && current.snapshot.digest === pin.snapshotDigest &&
        digestAccessCandidate(adaptEdgeRecord(record, current, { ownerRef })) === pin.contributionDigest &&
        digestAccessCandidate(observed) === pin.contributionDigest
    },
    evaluateEdge: async edge => {
      const decision = await evaluateEdge({ record, events: [] }, host)
      decisions.push(decision)
      return adaptEdgeDecision(edge, decision)
    },
    revalidate: async () => currentGrant,
  }, { now })
  const reader = createGraphViewReader({
    loadAuthorizedGraph: options => access.loadAuthorizedGraph({}, options),
    revalidate: binding => access.revalidate(binding), now,
  })
  return { native, raw, record, candidate, origin, supportCitation, identity, host, access, reader, decisions, sourceReads,
    loaded: () => loaded, revoke: () => { currentGrant = false } }
}

test('real source occurrences retain policy-derived identities and cited bytes through access and view export', async t => {
  const f = fixture(t)
  assert.deepEqual(f.decisions, [])
  assert.equal(Object.hasOwn(f.candidate.edges[0], 'eligible'), false)
  const occurrences = edgeEvidenceOccurrences(f.record)
  assert.equal(f.candidate.edges[0].edgeId, f.identity.edgeId)
  assert.deepEqual(f.candidate.evidence.map(item => item.evidenceId), occurrences.map(item => item.id))
  const slice = f.raw.subarray(f.origin.locator.byteStart, f.origin.locator.byteEnd)
  assert.equal(slice.toString(), '[café\r\n🧭](target.md)')
  assert.equal(f.origin.citedDigest, bytesDigest(slice))
  assert.notEqual(f.origin.citedDigest, bytesDigest(Buffer.from(slice.toString().replaceAll('\r\n', '\n'))))

  const bytes = await f.reader.exportGraphView()
  const view = parseGraphView(bytes)
  assert.equal(view.completeness, 'complete')
  assert.equal(view.nodes.length, 2)
  assert.equal(view.edges.length, 1)
  assert.equal(view.evidence.length, 2)
  assert.equal(f.decisions.length, 1)
  assert.equal(f.decisions[0].eligible, true)
  assert.equal(f.decisions[0].assurance, 'navigation')
  assert.equal(f.sourceReads.length, 2)
  assert.equal(view.edges[0].edgeId, f.identity.edgeId)
  assert.equal(view.edges[0].recordDigest, f.identity.recordDigest)
  assert.equal(view.edges[0].policyDigest, f.record.policyDigest)
  assert.equal(view.edges[0].predicate, 'links_to')
  assert.deepEqual(view.edges[0].qualifications, f.record.qualifications)
  assert.deepEqual(view.edges[0].supportRefs, occurrences.map(item => item.id).sort())
  assert.equal(view.edges[0].sourceRef, occurrences[0].id)
  assert.deepEqual(view.evidence.map(item => item.evidenceId), occurrences.map(item => item.id).sort())
  for (const occurrence of occurrences) {
    const evidence = view.evidence.find(item => item.evidenceId === occurrence.id)
    assert.equal(evidence.sourceRef.revision, f.native.snapshot.digest)
    assert.equal(evidence.sourceRef.digest, occurrence.source.fileDigest)
    assert.equal(evidence.sourceRef.locator.rangeDigest, occurrence.source.citedDigest)
    assert.equal(evidence.sourceRef.locator.range.byteStart, occurrence.source.locator.byteStart)
    assert.equal(evidence.sourceRef.locator.range.byteEnd, occurrence.source.locator.byteEnd)
  }
  assert.doesNotMatch(bytes, /SYNTHETIC_PRIVATE_SOURCE_BODY|principalRef|cacheKey|bindingId|ownerRef|principal:synthetic-private|binding:synthetic-policy-private/)
  assert.doesNotMatch(bytes, /ordinary-link-evidence:|ordinary-link:/)
})

test('unobserved home, range and support pins refuse before a candidate can be digested', t => {
  const f = fixture(t)
  const mutations = [
    ['home', record => { record.home.path = 'unlisted.md' }],
    ['origin range', record => { record.origin.locator.byteStart++ }],
    ['support digest', record => { record.supports[0].source.citedDigest = bytesDigest('unobserved support') }],
    ['support range', record => { record.supports[0].source.locator.byteEnd-- }],
  ]
  for (const [name, mutate] of mutations) {
    const changed = structuredClone(f.record)
    mutate(changed)
    assert.throws(() => adaptEdgeRecord(changed, f.native, { ownerRef: f.candidate.repository.ownerRef }),
      { name: 'TypeError', message: 'Invalid graph access edge record input' }, name)
  }
  assert.deepEqual(f.decisions, [])
  assert.equal(f.loaded(), 0)
})

test('actual policy placement and current-byte refusals remove the edge from the exported view', async t => {
  const f = fixture(t)
  const checkHome = f.host.checkSourceHome
  f.host.checkSourceHome = async input => ({ ...await checkHome(input), allowed: false })
  let view = parseGraphView(await f.reader.exportGraphView())
  assert.equal(view.edges.length, 0)
  assert.equal(f.decisions.at(-1).reason, 'unsafe-source-home')
  assert.equal(f.sourceReads.length, 0)

  f.host.checkSourceHome = checkHome
  const readSource = f.host.readSource
  f.host.readSource = async source => {
    const observed = await readSource(source)
    return { ...observed, bytes: Buffer.from(observed.bytes.toString().replaceAll('\r\n', '\n')) }
  }
  view = parseGraphView(await f.reader.exportGraphView())
  assert.equal(view.edges.length, 0)
  assert.equal(f.decisions.at(-1).reason, 'citation-changed')
  assert.doesNotMatch(JSON.stringify(view), /SYNTHETIC_PRIVATE_SOURCE_BODY|bindingId|principalRef/)
})

test('grant revocation during real policy evaluation blocks view delivery and retires earlier bindings', async t => {
  const f = fixture(t)
  const issued = await f.access.loadAuthorizedGraph({})
  assert.equal(issued.graph.edges.length, 1)
  const readSource = f.host.readSource
  f.host.readSource = async source => {
    const observed = await readSource(source)
    f.revoke()
    return observed
  }
  await assert.rejects(f.reader.exportGraphView(), error => error.code === 'policy_refusal')
  assert.equal(f.decisions.at(-1).eligible, true)
  assert.equal(await f.access.revalidate(issued.binding), false)
  await assert.rejects(f.access.guardArtifact(issued.binding, issued.graph), { name: 'GraphAccessRefusal', message: 'Graph access unavailable' })
  const loads = f.loaded()
  await assert.rejects(f.reader.exportGraphView(), error => error.code === 'policy_refusal')
  assert.equal(f.loaded(), loads)
})
