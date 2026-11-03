import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generateKeyPair, signDocument } from '../src/attestation/sign.mjs'
import { EDGE_RECORD_SCHEMA, EDGE_DECISION_SCHEMA, bytesDigest, edgeDigest, edgeIdentity } from '../src/edge-policy/contract.mjs'
import { edgeEvidenceOccurrences, evaluateEdge } from '../src/edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../src/edge-policy/source-citation-adapter.mjs'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'
import { adaptEdgeDecision } from '../src/graph-access/edge-decision-adapter.mjs'
import { adaptMultiContributionRecord } from '../src/graph-access/multi-contribution-record-adapter.mjs'
import { adaptRepositoryContribution } from '../src/graph-access/source-adapter.mjs'
import { buildRepositoryContribution, validateRepositoryContribution } from '../src/graph/repo-contribution.mjs'
import { createGraphViewReader, parseGraphView } from '../src/graph-view/index.mjs'

const note = (id, title, body, relation = false) => [
  '---', `title: ${title}`, 'summary: Invented federation fixture.', 'kg:', `  id: ${id}`,
  '  type: document', '  status: active', '  audience: private',
  ...(relation ? ['  relations:', '    supports: "b:target"'] : []), '---', '', body, '',
].join('\r\n')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-multi-policy-view-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const specs = [
    ['a', '910000001', 'a.md', note('a:source', 'Invented source A', 'SYNTHETIC_A_RAW_BODY', true)],
    ['b', '910000002', 'b.md', note('b:target', 'SYNTHETIC_B_PRIVATE_TITLE', '[café 🧭](b.md)\r\nSYNTHETIC_B_RAW_BODY')],
    ['c', '910000003', 'assertion-home.md', note('c:home', 'SYNTHETIC_C_PRIVATE_TITLE', 'SYNTHETIC_C_RAW_BODY')],
  ]
  const repositories = specs.map(([name, id, file, content]) => {
    const dir = path.join(root, name)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, file), content)
    const git = args => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(['init', '--quiet'])
    git(['config', 'user.name', 'Synthetic Federation Author'])
    git(['config', 'user.email', 'author@example.invalid'])
    git(['add', '.'])
    git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic federation fixture'])
    const repository = { name, path: dir, identity: { provider: 'github', id } }
    const contribution = buildRepositoryContribution(repository)
    assert.equal(validateRepositoryContribution(contribution).ok, true)
    return { name, repository, contribution, ownerRef: `owner:synthetic-${name}` }
  })
  const [a, b, c] = repositories
  const origin = sourceCitationFromProvenance(a.contribution, a.contribution.declaredRelations[0].provenance)
  const support = sourceCitationFromProvenance(b.contribution, b.contribution.ordinaryLinks[0].provenance)
  const policy = { version: 'synthetic-multi-policy-1', allowProposerReview: false, allowSharedSteward: false }
  const record = {
    schema: EDGE_RECORD_SCHEMA, family: 'source-declaration', subject: a.contribution.nodes[0].ref,
    predicate: 'supports', object: b.contribution.nodes[0].ref,
    home: { repoId: c.contribution.repository.repoId, path: 'assertion-home.md', readership: 'readers:synthetic-coalition' },
    origin, supports: [{ id: 'synthetic-b-corroboration', source: support }], policyDigest: edgeDigest(policy),
    proposalRef: 'proposal:synthetic-coalition',
    sourceChange: { repoId: c.contribution.repository.repoId, path: 'assertion-home.md', baseRevision: c.contribution.snapshot.digest,
      diffDigest: bytesDigest('Invented source change'), reviewRef: 'review:synthetic-source-owner' },
    qualifications: ['Applies only to the invented federation fixture.'],
  }
  const identity = edgeIdentity(record), occurrences = edgeEvidenceOccurrences(record)
  const roles = [
    { repoId: a.contribution.repository.repoId, role: 'endpoint-steward', actorId: 'steward:synthetic-a' },
    { repoId: b.contribution.repository.repoId, role: 'endpoint-steward', actorId: 'steward:synthetic-b' },
    { repoId: c.contribution.repository.repoId, role: 'home-owner', actorId: c.ownerRef },
  ]
  const actors = new Map(['proposer:synthetic', ...roles.map(role => role.actorId)].map(actorId => [actorId,
    generateKeyPair({ keyId: `key:${actorId}` })]))
  const events = []
  function event(action, actorId, approvalRoles = []) {
    const unsigned = { schema: EDGE_DECISION_SCHEMA, recordDigest: identity.recordDigest, sequence: events.length + 1,
      previousDigest: events.length ? edgeDigest(events.at(-1)) : null, action, actorId, at: '2030-01-01T10:00:00.000Z',
      policyDigest: record.policyDigest, reason: 'Invented review decision.', roles: approvalRoles, signature: null }
    const key = actors.get(actorId).privateKeyDoc
    events.push(signDocument(unsigned, { privateKey: key.privateKeyJwk, keyId: key.keyId, algorithm: key.algorithm }))
  }
  event('propose', 'proposer:synthetic')
  for (const { actorId, ...role } of roles) event('approve', actorId, [role])
  event('accept', c.ownerRef)

  let authorized = new Set(repositories.map(repo => repo.name)), grantRevision = 1, currentCandidates = new Map()
  const decisions = [], loaded = [], sourceReads = []
  const now = () => Date.parse('2030-01-01T12:00:00.000Z')
  const selectedEntries = names => repositories.filter(repo => names.has(repo.name)).map(({ contribution, ownerRef }) => ({ contribution, ownerRef }))
  // The synthetic trusted host selects complete records after resolving grants.
  // An omitted dependency produces fresh base contributions, never partial
  // slices of an earlier bundle whose evidence IDs encode the hidden record.
  const selectCandidates = names => names.size === repositories.length
    ? adaptMultiContributionRecord(record, selectedEntries(names))
    : selectedEntries(names).map(({ contribution, ownerRef }) => adaptRepositoryContribution(contribution, { ownerRef }))
  const host = {
    policy, now: new Date(now()).toISOString(), bindingId: 'binding:synthetic-coalition-private',
    readRecordHead: async () => ({ recordDigest: identity.recordDigest, eventCount: events.length, eventDigest: edgeDigest(events.at(-1)) }),
    verifyOrigin: async ({ record: observed, recordDigest }) => ({ recordDigest, bindingId: host.bindingId,
      matches: recordDigest === identity.recordDigest && edgeDigest(observed) === identity.recordDigest &&
        edgeDigest(observed.origin) === edgeDigest(sourceCitationFromProvenance(a.contribution, a.contribution.declaredRelations[0].provenance)) }),
    checkSourceHome: async ({ record: observed, recordDigest, policyDigest }) => ({ recordDigest, policyDigest, bindingId: host.bindingId,
      allowed: authorized.size === repositories.length && edgeDigest(observed.home) === edgeDigest(record.home) && policyDigest === record.policyDigest }),
    resolveEndpoint: async ref => {
      const repository = repositories.find(repo => repo.contribution.nodes.some(node => edgeDigest(node.ref) === edgeDigest(ref)))
      return repository && authorized.has(repository.name)
        ? { ref, current: true, stewardId: `steward:synthetic-${repository.name}` } : null
    },
    resolveHomeOwner: async repoId => repoId === c.contribution.repository.repoId ? { actorId: c.ownerRef } : null,
    readSource: async source => {
      sourceReads.push(source)
      const repo = repositories.find(value => value.contribution.repository.repoId === source.repoId)
      if (!repo || !authorized.has(repo.name) || !repo.contribution.snapshot.files.some(file => file.path === source.path)) return null
      return { revision: repo.contribution.snapshot.digest, bytes: fs.readFileSync(path.join(repo.repository.path, source.path)) }
    },
    resolveActorKey: async ({ actorId }) => ({ actorId, publicKey: actors.get(actorId)?.publicKeyDoc, revoked: false,
      notBefore: '2030-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z' }),
    authorizeDecision: async ({ event: observed, policyDigest }) => ({ eventDigest: edgeDigest(observed), policyDigest,
      bindingId: host.bindingId, revoked: false, notBefore: '2030-01-01T00:00:00.000Z', expiresAt: '2031-01-01T00:00:00.000Z',
      allowed: observed.action === 'propose' ? observed.actorId === 'proposer:synthetic'
        : observed.action === 'accept' ? observed.actorId === c.ownerRef
          : observed.action === 'approve' && observed.roles.every(role => roles.some(required =>
            required.actorId === observed.actorId && required.repoId === role.repoId && required.role === role.role)) }),
  }
  const access = createGraphAccess({
    resolveAccess: async (_context, { operation }) => {
      const candidates = selectCandidates(authorized)
      currentCandidates = new Map(candidates.map(candidate => [candidate.repository.repoId, candidate]))
      return { operation, principalRef: 'principal:synthetic-coalition-private', proofRef: 'proof:synthetic-coalition',
        grantRevision: `grant:synthetic-${grantRevision}`, policyRevision: 'policy:synthetic-1',
        expiresAt: Date.parse('2031-01-01T00:00:00.000Z'), repositories: candidates.map(candidate => ({ ...candidate.repository,
          head: candidate.snapshot.head, tree: candidate.snapshot.tree, scope: candidate.snapshot.scope,
          snapshotDigest: candidate.snapshot.digest, contributionDigest: digestAccessCandidate(candidate) })) }
    },
    loadContribution: async approved => { loaded.push(approved.repoId); return currentCandidates.get(approved.repoId) },
    verifyContribution: async (candidate, approved) => {
      const repository = repositories.find(repo => repo.contribution.repository.repoId === approved.repoId)
      const fresh = buildRepositoryContribution(repository.repository)
      return authorized.has(repository.name) && fresh.digest === repository.contribution.digest &&
        fresh.snapshot.digest === approved.snapshotDigest && candidate.repository.ownerRef === repository.ownerRef &&
        digestAccessCandidate(candidate) === approved.contributionDigest &&
        digestAccessCandidate(selectCandidates(authorized).find(value => value.repository.repoId === approved.repoId)) === approved.contributionDigest
    },
    evaluateEdge: async raw => {
      if (raw.edgeId !== identity.edgeId) return { eligible: false }
      const decision = await evaluateEdge({ record, events }, host)
      decisions.push(decision)
      return adaptEdgeDecision(raw, decision)
    },
    revalidate: async decision => decision.grantRevision === `grant:synthetic-${grantRevision}` &&
      edgeDigest(decision.repositories.map(repo => repo.repoId).sort()) ===
        edgeDigest(repositories.filter(repo => authorized.has(repo.name)).map(repo => repo.contribution.repository.repoId).sort()),
  }, { now })
  const reader = createGraphViewReader({ loadAuthorizedGraph: options => access.loadAuthorizedGraph({}, options),
    revalidate: binding => access.revalidate(binding), now })
  const authorize = names => { authorized = new Set(names); grantRevision++ }
  return { repositories, a, b, c, record, identity, occurrences, events, host, access, reader, decisions, loaded, sourceReads,
    selectCandidates, selectedEntries, authorize }
}

test('A and B evidence with C assertion home retain exact approved provenance through source, policy, access and view', async t => {
  const f = fixture(t)
  const candidates = f.selectCandidates(new Set(['a', 'b', 'c']))
  assert.equal(candidates.reduce((count, candidate) => count + candidate.edges.length, 0), 1)
  for (const candidate of candidates) {
    assert.equal(Object.isFrozen(candidate), true)
    assert.equal(Object.hasOwn(candidate.edges[0] ?? {}, 'eligible'), false)
    assert.deepEqual(candidate.evidence.map(item => item.evidenceId), f.occurrences.filter(item =>
      item.source.repoId === candidate.repository.repoId).map(item => item.id))
  }
  const home = candidates.find(candidate => candidate.repository.repoId === f.c.contribution.repository.repoId)
  assert.equal(home.edges[0].sourceRef.path, 'assertion-home.md')
  assert.equal(home.evidence.length, 0)
  const bytes = await f.reader.exportGraphView(), view = parseGraphView(bytes)
  assert.equal(view.completeness, 'complete')
  assert.equal(view.nodes.length, 3)
  assert.equal(view.edges.length, 1)
  assert.equal(view.evidence.length, 2)
  assert.equal(view.edges[0].assurance, 'reviewed-assertion')
  assert.equal(view.edges[0].edgeId, f.identity.edgeId)
  assert.equal(view.edges[0].recordDigest, f.identity.recordDigest)
  assert.equal(view.edges[0].policyDigest, f.record.policyDigest)
  assert.equal(view.edges[0].reviewRefs.length, 3)
  assert.deepEqual(view.edges[0].supportRefs, f.occurrences.map(item => item.id).sort())
  assert.equal(view.edges[0].sourceRef, f.occurrences[0].id)
  assert.equal(f.decisions[0].eligible, true)
  assert.equal(f.decisions[0].history.length, 5)
  assert.deepEqual(f.sourceReads.map(source => source.repoId), [f.a.contribution.repository.repoId, f.b.contribution.repository.repoId])
  for (const occurrence of f.occurrences) {
    const evidence = view.evidence.find(item => item.evidenceId === occurrence.id)
    assert.equal(evidence.sourceRef.repoId, occurrence.source.repoId)
    assert.equal(evidence.sourceRef.path, occurrence.source.path)
    assert.equal(evidence.sourceRef.revision, occurrence.source.revision)
    assert.equal(evidence.sourceRef.digest, occurrence.source.fileDigest)
    assert.equal(evidence.sourceRef.locator.rangeDigest, occurrence.source.citedDigest)
    assert.equal(evidence.sourceRef.locator.range.byteStart, occurrence.source.locator.byteStart)
    assert.equal(evidence.sourceRef.locator.range.byteEnd, occurrence.source.locator.byteEnd)
    const repo = f.repositories.find(value => value.contribution.repository.repoId === occurrence.source.repoId)
    const raw = fs.readFileSync(path.join(repo.repository.path, occurrence.source.path))
    assert.equal(bytesDigest(raw.subarray(occurrence.source.locator.byteStart, occurrence.source.locator.byteEnd)), occurrence.source.citedDigest)
  }
  assert.doesNotMatch(bytes, /SYNTHETIC_[ABC]_RAW_BODY|bindingId|principalRef|ownerRef|privateKey|signature/)
})

test('withheld assertion home or evidence repository removes the whole assertion before policy evaluation', async t => {
  for (const names of [['a', 'b'], ['a', 'c'], ['a']]) await t.test(names.join('+'), async t => {
    const f = fixture(t)
    f.authorize(names)
    assert.throws(() => adaptMultiContributionRecord(f.record, f.selectedEntries(new Set(names))),
      { name: 'TypeError', message: 'Required edge record repository is not selected' })
    const bytes = await f.reader.exportGraphView(), view = parseGraphView(bytes)
    assert.equal(view.completeness, 'complete')
    assert.equal(view.nodes.length, names.length)
    assert.equal(view.edges.length, 0)
    assert.equal(f.decisions.length, 0)
    assert.equal(f.sourceReads.length, 0)
    assert.deepEqual(f.loaded.sort(), f.repositories.filter(repo => names.includes(repo.name)).map(repo => repo.contribution.repository.repoId).sort())
    for (const occurrence of f.occurrences) assert.equal(bytes.includes(occurrence.id), false)
    assert.equal(bytes.includes(f.identity.edgeId), false)
    assert.equal(bytes.includes(f.identity.recordDigest), false)
    for (const repo of f.repositories.filter(repo => !names.includes(repo.name))) {
      assert.equal(bytes.includes(repo.contribution.repository.repoId), false)
      assert.equal(bytes.includes(`SYNTHETIC_${repo.name.toUpperCase()}_PRIVATE_TITLE`), false)
    }
    if (!names.includes('c')) assert.equal(bytes.includes('assertion-home.md'), false)
  })
})

test('grant change during policy reads refuses delivery and fresh reduced grants contain no retained assertion evidence', async t => {
  const f = fixture(t)
  const issued = await f.access.loadAuthorizedGraph({})
  assert.equal(issued.graph.edges.length, 1)
  const readSource = f.host.readSource
  let revoked = false
  f.host.readSource = async source => {
    const observed = await readSource(source)
    if (!revoked) { revoked = true; f.authorize(['a', 'c']) }
    return observed
  }
  await assert.rejects(f.reader.exportGraphView(), error => error.code === 'policy_refusal')
  assert.equal(await f.access.revalidate(issued.binding), false)
  await assert.rejects(f.access.guardArtifact(issued.binding, issued.graph), { name: 'GraphAccessRefusal', message: 'Graph access unavailable' })
  const evaluations = f.decisions.length
  const bytes = await f.reader.exportGraphView(), view = parseGraphView(bytes)
  assert.equal(view.nodes.length, 2)
  assert.equal(view.edges.length, 0)
  assert.equal(f.decisions.length, evaluations)
  assert.equal(bytes.includes(f.b.contribution.repository.repoId), false)
  assert.doesNotMatch(bytes, /SYNTHETIC_B_PRIVATE_TITLE/)
  for (const occurrence of f.occurrences) assert.equal(bytes.includes(occurrence.id), false)
})

test('a stale B citation and a refused C placement each keep the governed assertion out of the view', async t => {
  const f = fixture(t)
  const readSource = f.host.readSource
  f.host.readSource = async source => {
    const observed = await readSource(source)
    return source.repoId === f.b.contribution.repository.repoId ? { ...observed, bytes: Buffer.from('Invented changed evidence.') } : observed
  }
  let view = parseGraphView(await f.reader.exportGraphView())
  assert.equal(view.edges.length, 0)
  assert.equal(f.decisions.at(-1).reason, 'citation-changed')
  f.host.readSource = readSource
  const checkSourceHome = f.host.checkSourceHome
  f.host.checkSourceHome = async input => ({ ...await checkSourceHome(input), allowed: false })
  const reads = f.sourceReads.length
  view = parseGraphView(await f.reader.exportGraphView())
  assert.equal(view.edges.length, 0)
  assert.equal(f.decisions.at(-1).reason, 'unsafe-source-home')
  assert.equal(f.sourceReads.length, reads)
})
