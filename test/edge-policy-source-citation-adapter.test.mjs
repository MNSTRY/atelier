import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildRepositoryContribution, validateRepositoryContribution } from '../src/graph/repo-contribution.mjs'
import { bytesDigest, edgeDigest, EDGE_RECORD_SCHEMA, immutable, validSourceRef } from '../src/edge-policy/contract.mjs'
import { evaluateEdge } from '../src/edge-policy/policy.mjs'
import { sourceCitationFromProvenance } from '../src/edge-policy/source-citation-adapter.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-source-citation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '--quiet'])
  git(['config', 'user.name', 'Synthetic Builder'])
  git(['config', 'user.email', 'builder@example.invalid'])
  const doc = (id, body, relations = []) => Buffer.from(['---', 'title: "Invented note"', 'kg:', `  id: "${id}"`,
    '  type: "document"', '  status: "active"', '  audience: "team"', ...relations, '---', '', body, ''].join('\r\n'))
  const raw = doc('note', 'Élan 🧭 [café\r\n🧭](target.md)', ['  relations:', '    supports: "target"'])
  fs.writeFileSync(path.join(root, 'note.md'), raw)
  fs.writeFileSync(path.join(root, 'target.md'), doc('target', 'Invented target.'))
  git(['add', '.'])
  git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic fixture'])
  const contribution = buildRepositoryContribution({ name: 'synthetic', path: root, identity: { provider: 'github', id: '1001' } })
  return { contribution, raw }
}

const invalid = (error) => error instanceof TypeError && error.message === 'Invalid source citation input'

test('a Unicode/CRLF occurrence converts the exact outer raw-byte slice without changing provenance', (t) => {
  const { contribution, raw } = fixture(t)
  const before = structuredClone(contribution)
  immutable(contribution)
  const provenance = contribution.ordinaryLinks[0].provenance
  const io = Object.fromEntries(['readFileSync', 'readdirSync', 'lstatSync', 'statSync'].map((name) => [name, fs[name]]))
  let citation
  try {
    for (const name of Object.keys(io)) fs[name] = () => { throw new Error('citation conversion must not read files') }
    citation = sourceCitationFromProvenance(contribution, structuredClone(provenance))
  } finally { Object.assign(fs, io) }
  assert.equal(validSourceRef(citation), true)
  assert.deepEqual(citation, {
    repoId: provenance.repoId, path: provenance.path, revision: contribution.snapshot.digest,
    fileDigest: bytesDigest(raw), locator: { byteStart: provenance.locator.range.byteStart, byteEnd: provenance.locator.range.byteEnd },
    citedDigest: bytesDigest(raw.subarray(provenance.locator.range.byteStart, provenance.locator.range.byteEnd)),
  })
  const slice = raw.subarray(citation.locator.byteStart, citation.locator.byteEnd)
  assert.equal(slice.toString(), '[café\r\n🧭](target.md)')
  assert.notEqual(citation.citedDigest, bytesDigest(Buffer.from(slice.toString().replaceAll('\r\n', '\n'))))
  assert.notEqual(citation.fileDigest, bytesDigest(Buffer.from(raw.toString().replaceAll('\r\n', '\n'))))
  assert.ok(citation.locator.byteStart > provenance.locator.range.start)
  assert.notDeepEqual(citation.locator, { byteStart: provenance.locator.targetRange.byteStart, byteEnd: provenance.locator.targetRange.byteEnd })
  citation.locator.byteStart++
  assert.deepEqual(contribution, before)
})

test('a declared relation retains its pointer and raw range in the original contribution', (t) => {
  const { contribution, raw } = fixture(t)
  const provenance = contribution.declaredRelations[0].provenance
  const before = structuredClone(provenance)
  const citation = sourceCitationFromProvenance(contribution, provenance)
  assert.equal(validSourceRef(citation), true)
  assert.equal(raw.subarray(citation.locator.byteStart, citation.locator.byteEnd).toString(), '"target"')
  assert.equal(citation.citedDigest, bytesDigest(raw.subarray(citation.locator.byteStart, citation.locator.byteEnd)))
  assert.deepEqual(provenance, before)
  assert.equal(provenance.locator.pointer, '/kg/relations/supports')
  assert.deepEqual(Object.keys(citation.locator).sort(), ['byteEnd', 'byteStart'])
})

test('missing, altered, unlisted and nonpositive citation metadata refuses', (t) => {
  const { contribution } = fixture(t)
  const original = contribution.ordinaryLinks[0].provenance
  const mutations = [
    (v) => { delete v.repoId },
    (v) => { v.repoId = 'github:1002' },
    (v) => { delete v.revision },
    (v) => { v.revision = bytesDigest('another snapshot') },
    (v) => { v.path = 'unlisted.md' },
    (v) => { delete v.digest },
    (v) => { v.digest = bytesDigest('another file') },
    (v) => { delete v.locator },
    (v) => { delete v.locator.range },
    (v) => { delete v.locator.rangeDigest },
    (v) => { v.locator.rangeDigest = bytesDigest('another span') },
    (v) => { v.locator.range.byteEnd = v.locator.range.byteStart },
    (v) => { v.locator.range.byteStart = -1 },
    (v) => { v.locator.range.byteStart = 0.5 },
    (v) => { v.locator.range.byteEnd = Number.MAX_SAFE_INTEGER + 1 },
    (v) => { v.locator.range.byteEnd = contribution.snapshot.files.find((f) => f.path === v.path).byteLength + 1 },
    (v) => { v.locator.range = { start: 0, end: 1, byteStart: 0, byteEnd: 1 } },
    (v) => { v.unrecognized = true },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(original)
    mutate(value)
    assert.throws(() => sourceCitationFromProvenance(contribution, value), invalid)
  }
  assert.throws(() => sourceCitationFromProvenance(contribution, contribution.nodes[0].source), invalid)
  assert.throws(() => sourceCitationFromProvenance(contribution, null), invalid)
  assert.equal(validateRepositoryContribution(contribution).ok, true)
})

test('a contribution must pass its own validation and bind the exact file manifest', (t) => {
  const { contribution } = fixture(t)
  const provenance = contribution.ordinaryLinks[0].provenance
  const mutations = [
    (v) => { v.digest = bytesDigest('changed contribution') },
    (v) => { v.snapshot.files = [] },
    (v) => { v.snapshot.files.find((f) => f.path === provenance.path).byteLength = provenance.locator.range.byteEnd - 1 },
    (v) => { v.snapshot.files.find((f) => f.path === provenance.path).rawDigest = bytesDigest('changed pin') },
    (v) => { v.ordinaryLinks = [] },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(contribution)
    mutate(value)
    assert.throws(() => sourceCitationFromProvenance(value, provenance), invalid)
  }
  for (const value of [null, {}, []]) assert.throws(() => sourceCitationFromProvenance(value, provenance), invalid)
  const absent = structuredClone(contribution)
  absent.ordinaryLinks = []
  absent.digest = edgeDigest(Object.fromEntries(Object.entries(absent).filter(([key]) => key !== 'digest')))
  assert.equal(validateRepositoryContribution(absent).ok, true)
  assert.throws(() => sourceCitationFromProvenance(absent, provenance), invalid)
})

test('a converted citation still requires the policy host current-byte and custody checks', async (t) => {
  const { contribution, raw } = fixture(t)
  const origin = sourceCitationFromProvenance(contribution, contribution.ordinaryLinks[0].provenance)
  const policy = { version: 'synthetic-policy', allowProposerReview: false, allowSharedSteward: false }
  const record = {
    schema: EDGE_RECORD_SCHEMA, family: 'hyperlink', subject: contribution.ordinaryLinks[0].source,
    predicate: 'links-to', object: contribution.ordinaryLinks[0].target,
    home: { repoId: origin.repoId, path: origin.path, readership: 'synthetic-readers' },
    origin, supports: [], policyDigest: edgeDigest(policy), proposalRef: null, sourceChange: null, qualifications: [],
  }
  let sourceReads = 0
  const host = {
    policy, now: '2026-01-02T12:00:00.000Z', bindingId: 'synthetic-snapshot',
    readRecordHead: async ({ recordDigest }) => ({ recordDigest, eventCount: 0, eventDigest: null }),
    verifyOrigin: async ({ recordDigest }) => ({ recordDigest, bindingId: host.bindingId, matches: true }),
    checkSourceHome: async ({ recordDigest, policyDigest }) => ({ recordDigest, policyDigest, bindingId: host.bindingId, allowed: true }),
    resolveEndpoint: async (ref) => ({ ref, current: true, stewardId: 'synthetic-steward' }),
    resolveHomeOwner: async () => ({ actorId: 'synthetic-owner' }),
    readSource: async () => { sourceReads++; return { revision: origin.revision, bytes: raw } },
  }
  const evaluate = () => evaluateEdge({ record, events: [] }, host)
  assert.equal((await evaluate()).eligible, true)
  assert.equal(sourceReads, 1)
  host.readSource = async () => ({ revision: origin.revision, bytes: Buffer.from(raw.toString().replaceAll('\r\n', '\n')) })
  assert.equal((await evaluate()).reason, 'citation-changed')
  host.readSource = async () => ({ revision: 'changed-revision', bytes: raw })
  assert.equal((await evaluate()).reason, 'source-changed')
  sourceReads = 0
  host.readSource = async () => { sourceReads++; return { revision: origin.revision, bytes: raw } }
  host.verifyOrigin = async ({ recordDigest }) => ({ recordDigest, bindingId: host.bindingId, matches: false })
  assert.equal((await evaluate()).reason, 'origin-mismatch')
  assert.equal(sourceReads, 0)
  host.verifyOrigin = async ({ recordDigest }) => ({ recordDigest, bindingId: host.bindingId, matches: true })
  host.checkSourceHome = async ({ recordDigest, policyDigest }) => ({ recordDigest, policyDigest, bindingId: host.bindingId, allowed: false })
  assert.equal((await evaluate()).reason, 'unsafe-source-home')
  assert.equal(sourceReads, 0)
  assert.equal(validSourceRef(sourceCitationFromProvenance(contribution, contribution.ordinaryLinks[0].provenance)), true)
})
