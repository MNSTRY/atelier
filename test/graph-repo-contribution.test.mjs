import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { canonicalize } from '../src/attestation/jcs.mjs'
import { buildKnowledgeGraph } from '../src/graph/knowledge-graph.mjs'
import { buildRepositoryContribution as build, nodeRefKey, resolveLegacyNodeRef, resolveContributionTopology, validateRepositoryContribution } from '../src/graph/repo-contribution.mjs'

const digest = (v) => `sha256:${createHash('sha256').update(canonicalize(Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'digest')))).digest('hex')}`
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const doc = (id, body = '', relation = '') => ['---', 'title: "Invented record"', 'kg:', `  id: "${id}"`, '  type: "document"', '  status: "active"', '  audience: "team"', ...(relation ? ['  relations:', relation] : []), '---', '', body, ''].join('\n')
const write = (repo, file, bytes) => { fs.mkdirSync(path.dirname(path.join(repo.path, file)), { recursive: true }); fs.writeFileSync(path.join(repo.path, file), bytes) }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-contribution-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const make = (name, id) => {
    const repo = { name, path: path.join(root, name), identity: { provider: 'github', id } }
    fs.mkdirSync(repo.path)
    git(repo.path, ['init', '--quiet'])
    git(repo.path, ['config', 'user.name', 'Synthetic Builder'])
    git(repo.path, ['config', 'user.email', 'builder@example.invalid'])
    write(repo, 'record.md', doc('same'))
    git(repo.path, ['add', '.'])
    git(repo.path, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic fixture'])
    return repo
  }
  return { root, a: make('alpha', '1001'), b: make('beta', '1002') }
}
const code = (value) => (e) => e?.code === value

test('A/B contributions are deterministic, preserve local IDs and refuse ambiguous legacy lookup', (t) => {
  const { a, b } = fixture(t)
  const first = build(a)
  assert.deepEqual(first, build(a))
  const second = build(b)
  assert.equal(first.snapshot.dirty, false)
  assert.equal(validateRepositoryContribution(first).ok, true)
  assert.notEqual(nodeRefKey(first.nodes[0].ref), nodeRefKey(second.nodes[0].ref))
  assert.deepEqual(resolveLegacyNodeRef('same', [first]), { repoId: 'github:1001', localId: 'same' })
  assert.throws(() => resolveLegacyNodeRef('same', [first, second]), code('legacy-node-id-ambiguous-use-qualified-ref'))
  assert.throws(() => resolveLegacyNodeRef('absent', [first]), code('legacy-node-id-unresolved'))
  assert.throws(() => resolveLegacyNodeRef('same', [first, first]), code('duplicate-repository-contribution'))
  assert.equal(JSON.stringify(first).includes(a.path), false)
})

test('rename preserves qualified identity and snapshot; dirty bytes change the source pin', (t) => {
  const { root, a } = fixture(t)
  const before = build(a)
  const renamed = { ...a, name: 'renamed', path: path.join(root, 'renamed') }
  fs.renameSync(a.path, renamed.path)
  const after = build(renamed)
  assert.deepEqual(before.nodes[0].ref, after.nodes[0].ref)
  assert.equal(before.snapshot.digest, after.snapshot.digest)
  write(renamed, 'record.md', doc('same', 'changed body'))
  const dirty = build(renamed)
  assert.equal(dirty.snapshot.head, after.snapshot.head)
  assert.equal(dirty.snapshot.dirty, true)
  assert.notEqual(dirty.snapshot.digest, after.snapshot.digest)
  assert.notEqual(dirty.nodes[0].source.digest, after.nodes[0].source.digest)
  assert.equal(dirty.nodes[0].source.revision, dirty.snapshot.digest)
})

test('filesystem aliases preserve root identity while a nested directory is refused', (t) => {
  const { a } = fixture(t)
  const original = build(a)
  const alias = path.join(path.dirname(a.path), 'ALPHA')
  if (fs.existsSync(alias)) assert.deepEqual(build({ ...a, path: alias }), original)
  const nested = path.join(a.path, 'nested')
  fs.mkdirSync(nested)
  assert.throws(() => build({ ...a, path: nested }), code('repository-root-mismatch'))
})

test('a selected nested repository is refused rather than attributed to its parent', (t) => {
  const { a } = fixture(t)
  write(a, 'record.md', doc('same', '![[missing.png]]'))
  const nested = path.join(a.path, 'nested')
  fs.mkdirSync(nested)
  git(nested, ['init', '--quiet'])
  fs.writeFileSync(path.join(nested, 'other.md'), doc('different-local-id'))
  assert.throws(() => build(a), code('nested-repository-source'))
  assert.throws(() => build(a, { scope: { exclude: 'nested/' }, inputPaths: { plan: 'nested/other.md' } }), code('nested-repository-source'))
  const original = fs.readdirSync
  fs.readdirSync = function(directory, ...args) {
    if (path.resolve(directory) === nested) throw new Error('excluded repository must not be visited')
    return original.call(this, directory, ...args)
  }
  let scoped
  try { scoped = build(a, { scope: { exclude: 'nested/' } }) } finally { fs.readdirSync = original }
  assert.deepEqual(scoped.nodes.map((node) => node.ref.localId), ['same'])
  assert.equal(scoped.snapshot.files.some((file) => file.path.startsWith('nested/')), false)
  assert.equal(scoped.ordinaryLinks[0].embed, true)
  assert.equal(scoped.ordinaryLinks[0].target, null)
  assert.throws(() => build(a, { scope: { exclude: 'nested/' }, inputPaths: { config: '.git/config' } }), code('invalid-source-path'))
})

test('each Unicode/CRLF link occurrence keeps exact source and target offsets', (t) => {
  const { a } = fixture(t)
  const raw = doc('same', 'é 🧭 [one](target.md#one) [two](target.md#two) [[target]] [away](../beta/record.md)').replaceAll('\n', '\r\n')
  write(a, 'record.md', raw)
  write(a, 'target.md', doc('target'))
  const contribution = build(a)
  assert.equal(contribution.ordinaryLinks.length, 4)
  const bytes = Buffer.from(raw)
  for (const link of contribution.ordinaryLinks) {
    const { range, targetRange } = link.provenance.locator
    assert.equal(bytes.subarray(range.byteStart, range.byteEnd).toString(), raw.slice(range.start, range.end))
    assert.equal(bytes.subarray(targetRange.byteStart, targetRange.byteEnd).toString(), link.href)
    assert.equal(link.provenance.digest, contribution.nodes.find((n) => n.path === 'record.md').source.digest)
  }
  assert.deepEqual(contribution.ordinaryLinks.slice(0, 3).map((l) => l.target.localId), ['target', 'target', 'target'])
  assert.equal(contribution.ordinaryLinks[3].target, null)
  assert.equal(contribution.ordinaryLinks[3].resolution, 'unresolved')
})

test('declared relations retain scalar/list source pointers and unresolved written targets', (t) => {
  const { a } = fixture(t)
  const raw = doc('same', 'é 🧭', '    supports: ["elsewhere", "another"]\n    related: "elsewhere"').replaceAll('\n', '\r\n')
  write(a, 'record.md', raw)
  const c = build(a)
  assert.deepEqual(c.declaredRelations.map((r) => [r.target, r.provenance.locator.pointer]), [['elsewhere', '/kg/relations/supports/0'], ['another', '/kg/relations/supports/1'], ['elsewhere', '/kg/relations/related']])
  assert.equal(c.declaredRelations.every((r) => r.origin === 'declared' && r.provenance.path === 'record.md'), true)
  for (const relation of c.declaredRelations) {
    const { range, rangeDigest } = relation.provenance.locator
    const bytes = Buffer.from(raw).subarray(range.byteStart, range.byteEnd)
    assert.equal(bytes.toString(), `"${relation.target}"`)
    assert.equal(rangeDigest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`)
  }
  write(a, 'record.md', doc('same', '', '    supports:\n      - "first"\n      - "second"'))
  assert.deepEqual(build(a).declaredRelations.map((r) => r.provenance.locator.pointer), ['/kg/relations/supports/0', '/kg/relations/supports/1'])
})

test('duplicate local IDs and unstable or unsupported identities fail explicitly', (t) => {
  const { a } = fixture(t)
  assert.throws(() => build({ ...a, identity: undefined }), code('stable-repository-identity-required'))
  assert.throws(() => build({ ...a, identity: { provider: 'adopted', id: 'proposed' } }), code('stable-repository-identity-required'))
  write(a, 'duplicate.md', doc('same'))
  assert.throws(() => build(a), code('source-graph-invalid'))
  fs.rmSync(path.join(a.path, 'duplicate.md'))
  write(a, 'unclassified.md', '# No explicit stable ID\n')
  assert.throws(() => build(a), code('explicit-source-identity-required'))
})

test('scope and config/plan inputs bind exact bytes without inventing absent pins', (t) => {
  const { a } = fixture(t)
  write(a, 'extra/other.md', doc('other'))
  write(a, 'knowledge-plan.json', '{"questions":[]}\n')
  write(a, 'atelier.project.json', '{"scope":"synthetic"}\n')
  const all = build(a)
  assert.deepEqual(all.inputs, { config: null, plan: null })
  const scoped = build(a, { scope: { exclude: 'extra/' }, inputPaths: { config: 'atelier.project.json', plan: 'knowledge-plan.json' } })
  assert.equal(scoped.nodes.length, 1)
  assert.notEqual(scoped.snapshot.digest, all.snapshot.digest)
  assert.equal(scoped.inputs.plan.path, 'knowledge-plan.json')
  write(a, 'knowledge-plan.json', '{"questions":["changed"]}\n')
  assert.notEqual(build(a, { scope: { exclude: 'extra/' }, inputPaths: { config: 'atelier.project.json', plan: 'knowledge-plan.json' } }).snapshot.digest, scoped.snapshot.digest)
  assert.throws(() => build(a, { inputPaths: { plan: 'missing.json' } }), code('source-unavailable'))
  assert.throws(() => build(a, { inputPaths: { plan: '../outside.json' } }), code('invalid-source-path'))
  assert.throws(() => build(a, { scope: { base: 'C:/machine-local' } }), code('invalid-census-scope'))
  assert.throws(() => build(a, { scope: { include: '/machine-local' } }), code('invalid-census-scope'))
})

test('missing repository, redirected inputs and unsupported formats never produce partial contributions', (t) => {
  const { a } = fixture(t)
  assert.throws(() => build({ ...a, path: path.join(a.path, 'missing') }), code('source-unavailable'))
  fs.symlinkSync('record.md', path.join(a.path, 'redirect.json'))
  assert.throws(() => build(a, { inputPaths: { config: 'redirect.json' } }), code('source-unavailable'))
  write(a, 'source.pdf', '%PDF synthetic')
  assert.throws(() => build(a), code('source-profile-unsupported'))
})

test('a changed source during capture refuses and legacy graph results stay unchanged', (t) => {
  const f = fixture(t)
  const options = { workspaceRoot: f.root, repoEntries: [f.a] }
  const before = buildKnowledgeGraph(options)
  build(f.a)
  assert.deepEqual(buildKnowledgeGraph(options), before)
  const original = fs.readFileSync
  let changed = false
  fs.readFileSync = function(file, ...args) {
    const result = original.call(this, file, ...args)
    if (!changed && typeof file === 'number') {
      changed = true
      write(f.a, 'record.md', doc('same', 'changed during capture'))
    }
    return result
  }
  try { assert.throws(() => build(f.a), code('source-snapshot-changed')) } finally { fs.readFileSync = original }
})

test('validator refuses tampering, unknown fields and refs detached from their source pins', (t) => {
  const { a } = fixture(t)
  const c = build(a)
  const mutations = [
    (v) => { v.nodes[0].title = 'tampered' },
    (v) => { v.snapshot.files[0].rawDigest = `sha256:${'0'.repeat(64)}`; v.snapshot.digest = digest(v.snapshot); v.digest = digest(v) },
    (v) => { v.repository.repoId = 'github:999'; v.digest = digest(v) },
    (v) => { v.nodes[0].source.path = '../outside'; v.digest = digest(v) },
    (v) => { v.snapshot.files[0].path = '.git/record.md'; v.snapshot.digest = digest(v.snapshot); v.nodes[0].path = '.git/record.md'; v.nodes[0].source.path = '.git/record.md'; v.nodes[0].source.revision = v.snapshot.digest; v.digest = digest(v) },
    (v) => { v.nodes.push(structuredClone(v.nodes[0])); v.digest = digest(v) },
    (v) => { v.accepted = true; v.digest = digest(v) },
  ]
  for (const mutate of mutations) {
    const value = structuredClone(c)
    mutate(value)
    assert.equal(validateRepositoryContribution(value).ok, false)
  }
  assert.equal(validateRepositoryContribution(null).ok, false)
  assert.equal(validateRepositoryContribution({}).ok, false)
})

test('a TypeScript consumer can import source DTOs and receives qualified-ref type checks', (t) => {
  const { root } = fixture(t)
  const consumer = path.join(root, 'consumer.mts')
  const types = path.resolve('src/graph/repo-contribution.types.mjs').split(path.sep).join('/')
  fs.writeFileSync(consumer, `import type {NodeRef, RepositoryContribution} from ${JSON.stringify(types)};\nconst ref:NodeRef={repoId:'github:1001',localId:'same'};\n// @ts-expect-error localId is source text, never a number\nconst invalid:NodeRef={repoId:'github:1001',localId:42};\ndeclare const contribution:RepositoryContribution;\nconst revision:string=contribution.nodes[0].source.revision;\n`)
  execFileSync(process.execPath, [path.resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--allowJs', '--skipLibCheck', consumer], { stdio: 'pipe' })
})

test('pure topology binds cross-repository paths only through the supplied enrollment', (t) => {
  const { a, b } = fixture(t)
  write(a, 'record.md', doc('same', '[other](../beta/record.md) [[beta/record]] [[record]] ![[absent.png]] [[Distinct target]] [[Only A]]'))
  write(a, 'z-local.md', doc('local-target').replace('Invented record', 'Only A'))
  write(b, 'record.md', doc('same').replace('Invented record', 'Distinct target'))
  const ca = build(a)
  const cb = build(b)
  const supplied = [ca, cb]
  const enrollment = [{ repoId: 'github:1001', root: 'alpha' }, { repoId: 'github:1002', root: 'beta' }]
  const expected = { repoId: 'github:1002', localId: 'same' }
  const original = Object.fromEntries(['readFileSync', 'readdirSync', 'lstatSync'].map((key) => [key, fs[key]]))
  for (const key of Object.keys(original)) fs[key] = () => { throw new Error('pure resolver must not read files') }
  let together
  try { together = resolveContributionTopology(supplied, { enrollment }) } finally { Object.assign(fs, original) }
  assert.equal(together.nodes.length, 3)
  assert.deepEqual(together.ordinaryLinks.slice(0, 2).map((link) => link.target), [expected, expected])
  assert.equal(together.ordinaryLinks[0].resolution, 'resolved-cross-repository')
  assert.deepEqual(together.ordinaryLinks[0].provenance, ca.ordinaryLinks[0].provenance)
  assert.equal(together.ordinaryLinks[2].target, null)
  assert.equal(together.ordinaryLinks[3].target, null)
  assert.deepEqual(together.ordinaryLinks[4].target, expected)
  assert.deepEqual(together.ordinaryLinks[5].target, { repoId: 'github:1001', localId: 'local-target' })
  const alone = resolveContributionTopology([ca], { enrollment: [enrollment[0]] })
  assert.equal(alone.ordinaryLinks.every((link) => link.target === null || link.target.repoId === 'github:1001'), true)
  assert.equal(JSON.stringify(alone).includes('github:1002'), false)
  assert.deepEqual(resolveContributionTopology([cb, ca], { enrollment: [...enrollment].reverse() }), together)
  assert.throws(() => resolveContributionTopology(supplied, { enrollment: [enrollment[0]] }), code('invalid-contribution-enrollment'))
  assert.throws(() => resolveContributionTopology([ca], { enrollment: [{ repoId: 'github:1001', root: '../outside' }] }), code('invalid-contribution-enrollment'))
  assert.deepEqual(resolveContributionTopology([], { enrollment: [] }), { nodes: [], ordinaryLinks: [], declaredRelations: [] })
})
