import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGraphAccess, digestAccessCandidate } from '../src/graph-access/index.mjs'
import { adaptRepositoryContribution } from '../src/graph-access/source-adapter.mjs'
import { buildRepositoryContribution, resolveContributionTopology } from '../src/graph/repo-contribution.mjs'

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const note = (id, body = '', relations = '') => [
  '---', 'title: Invented source', 'summary: Synthetic adapter fixture.', 'kg:',
  `  id: ${id}`, '  type: document', '  status: active', '  audience: public',
  ...(relations ? ['  relations:', relations] : []), '---', body, '',
].join('\n')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-source-adapter-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return (name, id, files) => {
    const repo = { name, path: path.join(root, name), identity: { provider: 'github', id } }
    fs.mkdirSync(repo.path)
    const git = args => execFileSync('git', ['-C', repo.path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git(['init', '--quiet'])
    git(['config', 'user.name', 'Synthetic Source Author'])
    git(['config', 'user.email', 'author@example.invalid'])
    for (const [file, bytes] of Object.entries(files)) fs.writeFileSync(path.join(repo.path, file), bytes)
    git(['add', '.'])
    git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic adapter fixture'])
    return repo
  }
}

function accessFixture(candidates, approved = candidates, evaluate) {
  const loaded = [], evaluated = []
  const byRepo = new Map(candidates.map(c => [c.repository.repoId, c]))
  const access = createGraphAccess({
    resolveAccess: async (_, { operation }) => ({
      principalRef: 'principal:synthetic', proofRef: 'proof:synthetic',
      grantRevision: 'grant:synthetic', policyRevision: 'policy:synthetic', expiresAt: 2000, operation,
      repositories: approved.map(c => ({
        ...c.repository, scope: c.snapshot.scope, head: c.snapshot.head, tree: c.snapshot.tree,
        snapshotDigest: c.snapshot.digest, contributionDigest: digestAccessCandidate(c),
      })),
    }),
    loadContribution: async ({ repoId }) => { loaded.push(repoId); return byRepo.get(repoId) },
    verifyContribution: async () => true,
    evaluateEdge: async edge => {
      evaluated.push(edge)
      if (evaluate) return evaluate(edge)
      assert.equal(edge.family, 'hyperlink')
      assert.equal(edge.predicate, 'links_to')
      return {
        ...edge, acceptanceState: 'active', eligible: true, assurance: 'navigation',
        sourceRef: edge.supportRefs[0], qualifications: [], reviewRefs: [],
        recordDigest: digestAccessCandidate(edge), policyDigest: digest('Synthetic navigation policy'),
      }
    },
    revalidate: async () => true,
  }, { now: () => 1000 })
  return { access, loaded, evaluated }
}

test('owner binding must be explicit and well formed regardless of source audience or author', t => {
  const make = fixture(t)
  const native = buildRepositoryContribution(make('alpha', '1001', { 'source.md': note('source:one') }))
  for (const options of [undefined, null, {}, { ownerRef: undefined }, { ownerRef: null }, { ownerRef: '' }, { ownerRef: ' ' }, { ownerRef: 1 }, { ownerRef: [] }, { ownerRef: 'owner\nclaim' }, { ownerRef: 'x'.repeat(513) }, { ownerRef: 'owner:explicit', principalRef: 'browser:claim' }]) {
    assert.throws(() => adaptRepositoryContribution(native, options), TypeError)
  }
  const candidate = adaptRepositoryContribution(native, { ownerRef: 'owner:explicit' })
  assert.deepEqual(candidate.repository, { repoId: 'github:1001', ownerRef: 'owner:explicit' })
  assert.equal(JSON.stringify(candidate).includes('Synthetic Source Author'), false)
  assert.equal(Object.hasOwn(candidate.nodes[0], 'audience'), false)
  assert.equal(Object.hasOwn(candidate, 'accessContext'), false)
})

test('adapter preserves exact Unicode/CRLF source refs, input pins and cited range digests without reading files', t => {
  const make = fixture(t)
  const raw = note('source:one', 'é 🧭 [target](target.md#part)\nSYNTHETIC_SOURCE_BODY').replaceAll('\n', '\r\n')
  const repo = make('alpha', '1001', {
    'source.md': raw, 'target.md': note('target:one'),
    'project.json': '{"synthetic":true}\n', 'plan.json': '{"questions":[]}\n',
  })
  const native = buildRepositoryContribution(repo, { inputPaths: { config: 'project.json', plan: 'plan.json' } })
  const io = Object.fromEntries(['readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'realpathSync', 'openSync'].map(k => [k, fs[k]]))
  for (const name of Object.keys(io)) fs[name] = () => { throw new Error('adapter must not read source files') }
  let candidate
  try { candidate = adaptRepositoryContribution(native, { ownerRef: 'owner:explicit' }) } finally { Object.assign(fs, io) }
  assert.deepEqual(candidate.snapshot, native.snapshot)
  assert.deepEqual(candidate.inputs, native.inputs)
  assert.deepEqual(candidate.nodes.map(n => n.sourceRef), native.nodes.map(n => n.source))
  assert.deepEqual(candidate.edges[0].sourceRef, native.ordinaryLinks[0].provenance)
  assert.deepEqual(candidate.evidence[0].sourceRef, native.ordinaryLinks[0].provenance)
  const locator = candidate.evidence[0].sourceRef.locator
  const cited = Buffer.from(raw).subarray(locator.range.byteStart, locator.range.byteEnd)
  assert.equal(cited.toString(), '[target](target.md#part)')
  assert.equal(locator.rangeDigest, digest(cited))
  assert.equal(Buffer.from(raw).subarray(locator.targetRange.byteStart, locator.targetRange.byteEnd).toString(), native.ordinaryLinks[0].href)
  assert.equal(native.ordinaryLinks[0].fragment, '#part')
  assert.equal(JSON.stringify(candidate).includes('SYNTHETIC_SOURCE_BODY'), false)
  assert.deepEqual(candidate, adaptRepositoryContribution(native, { ownerRef: 'owner:explicit' }))
  assert.notEqual(candidate.snapshot, native.snapshot)
  assert.throws(() => { candidate.evidence[0].sourceRef.locator.rangeDigest = digest('changed') }, TypeError)
})

test('same local node IDs and source spellings remain distinct across repository identities', async t => {
  const make = fixture(t)
  const files = { 'source.md': note('shared:source', '[target](target.md)'), 'target.md': note('shared:target') }
  const candidates = ['1001', '1002'].map((id, i) => adaptRepositoryContribution(
    buildRepositoryContribution(make(`repo-${i}`, id, files)), { ownerRef: 'owner:explicit' }))
  assert.notEqual(candidates[0].edges[0].edgeId, candidates[1].edges[0].edgeId)
  assert.notEqual(candidates[0].evidence[0].evidenceId, candidates[1].evidence[0].evidenceId)
  const { graph } = await accessFixture(candidates).access.loadAuthorizedGraph({})
  assert.equal(graph.completeness, 'complete')
  assert.deepEqual(graph.counts, { nodes: 4, edges: 2, evidence: 2 })
  assert.deepEqual(graph.nodes.filter(n => n.ref.localId === 'shared:source').map(n => n.ref.repoId), ['github:1001', 'github:1002'])
})

test('declared semantic relations never become navigation edges or active assertions', async t => {
  const make = fixture(t)
  const native = buildRepositoryContribution(make('alpha', '1001', {
    'source.md': note('source:one', 'No ordinary link.', '    supports: "target:one"'),
    'target.md': note('target:one'),
  }))
  assert.equal(native.declaredRelations.length, 1)
  const candidate = adaptRepositoryContribution(native, { ownerRef: 'owner:explicit' })
  assert.deepEqual(candidate.edges, [])
  assert.deepEqual(candidate.evidence, [])
  assert.equal(Object.hasOwn(candidate, 'declaredRelations'), false)
  const f = accessFixture([candidate])
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(graph.edges.length, 0)
  assert.deepEqual(f.evaluated, [])
})

test('ordinary links remain navigation candidates and cannot activate without the edge owner', async t => {
  const make = fixture(t)
  const native = buildRepositoryContribution(make('alpha', '1001', {
    'source.md': note('source:one', '[target](target.md)', '    supports: "target:one"'),
    'target.md': note('target:one'),
  }))
  const candidate = adaptRepositoryContribution(native, { ownerRef: 'owner:explicit' })
  assert.equal(candidate.edges.length, 1)
  assert.equal(candidate.edges[0].family, 'hyperlink')
  assert.equal(candidate.edges[0].predicate, 'links_to')
  for (const field of ['acceptanceState', 'eligible', 'assurance', 'reviewRefs']) assert.equal(Object.hasOwn(candidate.edges[0], field), false)
  const f = accessFixture([candidate], [candidate], () => ({ eligible: false }))
  const { graph } = await f.access.loadAuthorizedGraph({})
  assert.equal(f.evaluated.length, 1)
  assert.equal(graph.edges.length, 0)
})

function crossRepository(t) {
  const make = fixture(t)
  const a = buildRepositoryContribution(make('alpha', '1001', { 'source.md': note('source:one', '[remote](../beta/withheld.md)') }))
  const b = buildRepositoryContribution(make('beta', '1002', { 'withheld.md': note('withheld:target') }))
  const topology = resolveContributionTopology([a, b], { enrollment: [{ repoId: a.repository.repoId, root: 'alpha' }, { repoId: b.repository.repoId, root: 'beta' }] })
  return { a, b, topology }
}

test('resolved topology changes only endpoints while retaining original source occurrences', t => {
  const { a, b, topology } = crossRepository(t)
  assert.equal(adaptRepositoryContribution(a, { ownerRef: 'owner:a' }).edges.length, 0)
  const candidate = adaptRepositoryContribution(a, { ownerRef: 'owner:a', topology })
  assert.deepEqual(candidate.edges[0].target, b.nodes[0].ref)
  assert.deepEqual(candidate.edges[0].sourceRef, a.ordinaryLinks[0].provenance)
  assert.equal(candidate.edges[0].family, 'hyperlink')
  assert.equal(candidate.nodes.length, a.nodes.length)
  const reversed = structuredClone(topology)
  reversed.nodes.reverse(); reversed.ordinaryLinks.reverse()
  assert.deepEqual(adaptRepositoryContribution(a, { ownerRef: 'owner:a', topology: reversed }), candidate)
})

test('topology cannot rewrite source pins, inject occurrences or invent missing endpoints', t => {
  const { a, topology } = crossRepository(t)
  const changes = [
    value => { value.nodes[0].title = 'changed source' },
    value => { value.ordinaryLinks[0].provenance.locator.rangeDigest = digest('changed range') },
    value => { value.ordinaryLinks[0].href = 'changed.md' },
    value => { value.ordinaryLinks[0].target.localId = 'invented:target' },
    value => { value.ordinaryLinks.push(structuredClone(value.ordinaryLinks[0])) },
    value => { value.ordinaryLinks = [] },
  ]
  for (const change of changes) {
    const value = structuredClone(topology); change(value)
    assert.throws(() => adaptRepositoryContribution(a, { ownerRef: 'owner:a', topology: value }))
  }
  assert.throws(() => adaptRepositoryContribution({}, { ownerRef: 'owner:a' }), TypeError)
})

test('an A-only grant never loads or exposes B through a preserved cross-repository candidate', async t => {
  const { a, b, topology } = crossRepository(t)
  const ca = adaptRepositoryContribution(a, { ownerRef: 'owner:a', topology })
  const cb = adaptRepositoryContribution(b, { ownerRef: 'owner:b', topology })
  const f = accessFixture([ca, cb], [ca])
  const { graph } = await f.access.loadAuthorizedGraph({ browserRepoIds: [b.repository.repoId] })
  assert.deepEqual(f.loaded, [a.repository.repoId])
  assert.deepEqual(f.evaluated, [])
  assert.equal(graph.completeness, 'complete')
  assert.deepEqual(graph.diagnostics, [])
  assert.deepEqual(graph.counts, { nodes: 1, edges: 0, evidence: 1 })
  const visible = JSON.stringify(graph)
  for (const withheld of [b.repository.repoId, 'withheld:target', 'withheld.md', 'owner:b']) assert.equal(visible.includes(withheld), false)
  assert.deepEqual(Object.keys(graph.counts).sort(), ['edges', 'evidence', 'nodes'])
})
