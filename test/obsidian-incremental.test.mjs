import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildCanonicalGraph } from '../src/graph/graph.mjs'
import { resolveProjectConfig, writeJson } from '../src/project/config.mjs'
import { createPreparationCache, prepareView, sha256Digest, withEligibility } from '../src/projection/obsidian/materialize/index.mjs'

// Incremental preparation is proven equal to full preparation, not argued:
// after every change, the view prepared through a cache is compared byte for
// byte, manifest for manifest, with a view prepared from nothing. The changes
// are the materialization fixture under both of its scopes, and random change
// sequences over a synthetic workspace of the tiny scale profile's size.

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = path.join(root, 'fixtures/obsidian/materialization')
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'workspace.json'), 'utf8'))
const EXT = 'mnstry.atelier.obsidian'
const clock = () => '2026-01-05T10:00:05.000Z'
const TMP = fs.realpathSync(os.tmpdir())
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

// mulberry32: a small deterministic generator, so a failing sequence is reproducible from its seed.
function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// A workspace on disk, read through the real canonical graph builder
// ---------------------------------------------------------------------------

function writeProject(dir, repositories, name) {
  for (const repoId of repositories) fs.mkdirSync(path.join(dir, repoId, '.git'), { recursive: true })
  writeJson(path.join(dir, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name,
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: repositories.map((repoId) => ({ name: repoId, path: repoId, readBoundary: 'team' })),
  })
  writeJson(path.join(dir, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: Object.fromEntries(repositories.map((repoId) => [repoId, { readBoundary: 'team' }])),
  })
}

function snapshotOf({ dir, repositories, workspaceId, withheld = new Set(), assetEligible = () => true }) {
  const canonical = buildCanonicalGraph(resolveProjectConfig({ argv: [`--project=${path.join(dir, 'atelier.project.json')}`], cwd: dir }))
  assert.equal(canonical.ok, true, canonical.errors.join('\n'))
  const graph = withEligibility(canonical, (node) => !withheld.has(node.id), assetEligible)
  const read = (repoId, relative) => fs.readFileSync(path.join(dir, repoId, relative))
  const pinned = [...graph.nodes, ...graph.assets.filter((asset) => asset.eligible === true)]
  const files = new Map(repositories.map((repoId) => [repoId, []]))
  for (const item of pinned) {
    const bytes = read(item.repo, item.path)
    files.get(item.repo).push({ path: item.path, rawDigest: sha256Digest(bytes), byteLength: bytes.length })
  }
  return {
    document: {
      schema: 'atelier-obsidian-source-snapshot/v1',
      snapshotId: `snap-${sha256Digest(Buffer.from(JSON.stringify([...files]))).slice(7, 39)}`,
      workspaceId,
      capturedAt: '2026-01-05T10:00:00Z',
      readConsistency: 'single-read',
      graphPin: { graphDigest: sha256Digest(Buffer.from(JSON.stringify([graph.nodes, graph.edges]))), nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
      versions: { source: '1', config: '1', emitter: '1.0.0' },
      repositories: repositories.map((repoId) => ({ repoId, head: null, dirty: true, files: files.get(repoId).sort((left, right) => compare(left.path, right.path)) })),
    },
    graph,
    readSource: read,
  }
}

const profileFor = (workspaceId, repositories) => ({
  schema: 'atelier-obsidian-corpus-profile/v1',
  workspaceId,
  repositories: repositories.map((repoId) => ({ repoId, root: `repos/${repoId}`, enrollment: 'enrolled' })),
  audience: { allow: ['team', 'private'] },
})
const fullScope = { schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-full', mode: 'full', selector: { all: true } }
const scopedOn = (ids) => ({ schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-part', mode: 'scoped', selector: { ids } })

// ---------------------------------------------------------------------------
// The equality oracle
// ---------------------------------------------------------------------------

function comparable(prepared) {
  return {
    manifest: prepared.manifest,
    manifestBytes: prepared.manifestBytes.toString('utf8'),
    files: prepared.files.map((file) => ({ path: file.path, kind: file.kind, digest: file.digest, hex: file.bytes.toString('hex') })),
    registry: prepared.persistentPathRegistry,
    changes: prepared.changes,
    diagnostics: prepared.diagnostics,
  }
}

function assertEqualPreparations(incremental, full, label) {
  assert.deepEqual(comparable(incremental), comparable(full), label)
  assert.deepEqual(full.preparation, { emitted: full.manifest.notes.length, reused: 0 }, `${label}: a preparation without a cache emits everything`)
  assert.equal(incremental.preparation.emitted + incremental.preparation.reused, incremental.manifest.notes.length, label)
}

// The notes whose bytes or manifest entry differ between two full preparations: exactly what an incremental preparation must emit.
function changedNotes(before, after) {
  const previous = new Map(before.manifest.notes.map((note) => [note.path, JSON.stringify([note, before.files.find((file) => file.path === note.path).digest])]))
  return after.manifest.notes.filter((note) => previous.get(note.path) !== JSON.stringify([note, after.files.find((file) => file.path === note.path).digest])).map((note) => note.path)
}

// ---------------------------------------------------------------------------
// 1. The materialization fixture, under both scopes
// ---------------------------------------------------------------------------

function fixtureWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(TMP, 'atelier-incremental-fixture-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [relative, file] of Object.entries(fixture.files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
    fs.writeFileSync(path.join(dir, relative), file.hex ? Buffer.from(file.hex, 'hex') : Buffer.from(file.text, 'utf8'))
  }
  writeProject(dir, fixture.repositories, 'materialization-fixture')
  return dir
}

test('fixture: a cached preparation equals a full one under both scopes, before and after each kind of change', (t) => {
  const dir = fixtureWorkspace(t)
  const workspaceId = 'ws-synthetic-0002'
  const profile = profileFor(workspaceId, fixture.repositories)
  const withheld = new Set(fixture.withheldByEligibility)
  const scoped = { schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-harbor', mode: 'scoped', selector: { ids: ['north-desk:harbor-plan', 'south-desk:tide-table'] } }
  const caches = { [fullScope.scopeId]: createPreparationCache(), [scoped.scopeId]: createPreparationCache() }
  let registry = null
  const priors = {}
  const lastFull = {}
  const run = (label, expectEmitted) => {
    const snapshot = snapshotOf({ dir, repositories: fixture.repositories, workspaceId, withheld })
    for (const scope of [fullScope, scoped]) {
      const input = { snapshot, profile, scope, clock, persistentPathRegistry: registry, priorManifest: priors[scope.scopeId] ?? null }
      const full = prepareView(input)
      const incremental = prepareView({ ...input, cache: caches[scope.scopeId] })
      assertEqualPreparations(incremental, full, `${label} / ${scope.scopeId}`)
      if (lastFull[scope.scopeId] && expectEmitted) assert.equal(incremental.preparation.emitted, expectEmitted(scope, changedNotes(lastFull[scope.scopeId], full)), `${label} / ${scope.scopeId}: emitted exactly the notes that changed`)
      assert.deepEqual([...caches[scope.scopeId].notes.keys()].sort(), full.manifest.notes.map((note) => note.path).sort(), `${label}: the cache holds exactly the notes of the view`)
      registry = full.persistentPathRegistry
      priors[scope.scopeId] = full.manifest
      lastFull[scope.scopeId] = full
    }
  }
  const exact = (_scope, changed) => changed.length
  run('initial')
  run('same inputs', () => 0)
  fs.appendFileSync(path.join(dir, 'south-desk/tables/tide-table.md'), '\nA new line at the end.\n')
  run('body change', exact)
  const plan = path.join(dir, 'north-desk/plans/harbor-plan.md')
  fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('title: "Harbor plan"', 'title: "Harbour plan, revised"'))
  run('retitle: the path stays, the rows of related notes change', exact)
  fs.writeFileSync(plan, fs.readFileSync(plan, 'utf8').replace('    related:\n      - "north-desk:sealed-ledger"\n', ''))
  run('relation removed', exact)
  withheld.add('south-desk:tide-table')
  run('a node withheld: every note that named it changes, the rest are reused', exact)
  withheld.delete('south-desk:tide-table')
  run('the node returns', exact)
})

// ---------------------------------------------------------------------------
// 2. Random change sequences over a synthetic workspace
// ---------------------------------------------------------------------------

const REPOSITORIES = ['alpha-desk', 'beta-desk']
const RELATIONS = ['related', 'supports', 'depends_on', 'implements', 'evidences']
const WORDS = ['harbor', 'tide', 'lantern', 'ledger', 'compass', 'quarry', 'meadow', 'signal', 'anchor', 'orchard']
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f000501020052b1a4b50000000049454e44ae426082', 'hex')

// A synthetic corpus the size of the tiny scale profile: notes with declared
// relations, wikilinks and Markdown links between them, one wrapped source
// with a sidecar, and one embedded image.
class Corpus {
  constructor(seed, { notes = 50 } = {}) {
    this.random = mulberry32(seed)
    this.notes = new Map()
    this.next = notes
    for (let index = 0; index < notes; index += 1) this.addNote(index)
    const first = [...this.notes.values()]
    for (const note of first) {
      for (let count = 0; count < 2; count += 1) {
        const target = this.pick(first)
        if (target.id !== note.id) this.relate(note, target)
      }
      const linked = this.pick(first)
      if (linked.id !== note.id) note.links.push(linked.id)
    }
  }

  pick(items) { return items[Math.floor(this.random() * items.length)] }

  addNote(index) {
    const repoId = REPOSITORIES[index % REPOSITORIES.length]
    const id = `${repoId}:n-${String(index).padStart(3, '0')}`
    const note = { id, repoId, path: `notes/n-${String(index).padStart(3, '0')}.md`, title: `${this.pick(WORDS)} ${this.pick(WORDS)} ${index}`, body: [`Body of ${index}.`], relations: new Map(), links: [], embedsImage: index % 7 === 0 }
    this.notes.set(id, note)
    return note
  }

  relate(note, target) {
    const type = this.pick(RELATIONS)
    if (!note.relations.has(type)) note.relations.set(type, new Set())
    note.relations.get(type).add(target.id)
  }

  // One random change; returns its description.
  mutate() {
    const live = [...this.notes.values()]
    const note = this.pick(live)
    const kinds = ['body', 'body', 'retitle', 'relate', 'unrelate', 'link', 'unlink', 'add', 'remove']
    const kind = this.pick(kinds)
    switch (kind) {
      case 'body': note.body.push(`Line ${this.random().toFixed(6)}.`); return `body ${note.id}`
      case 'retitle': note.title = `${this.pick(WORDS)} ${this.random().toFixed(4)}`; return `retitle ${note.id}`
      case 'relate': { const target = this.pick(live); if (target.id !== note.id) this.relate(note, target); return `relate ${note.id}` }
      case 'unrelate': { const [type] = [...note.relations.keys()]; if (type) note.relations.delete(type); return `unrelate ${note.id}` }
      case 'link': { const target = this.pick(live); if (target.id !== note.id) note.links.push(target.id); return `link ${note.id}` }
      case 'unlink': note.links.pop(); return `unlink ${note.id}`
      case 'add': { const added = this.addNote(this.next++); const target = this.pick(live); this.relate(added, target); added.links.push(target.id); return `add ${added.id}` }
      case 'remove': {
        if (live.length < 10) return 'remove skipped'
        this.notes.delete(note.id)
        for (const other of this.notes.values()) {
          for (const targets of other.relations.values()) targets.delete(note.id)
          other.links = other.links.filter((id) => id !== note.id)
        }
        return `remove ${note.id}`
      }
      default: throw new Error(kind)
    }
  }

  write(dir) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const note of this.notes.values()) {
      const relations = [...note.relations].filter(([, targets]) => targets.size > 0).map(([type, targets]) => `    ${type}:\n${[...targets].sort().map((id) => `      - "${id}"`).join('\n')}`)
      const links = note.links.map((id, index) => {
        const target = this.notes.get(id)
        return index % 2 === 0 ? `[[${target.title}]]` : `[${target.title}](${target.repoId === note.repoId ? `../${target.path}` : `../../${target.repoId}/${target.path}`})`
      })
      const text = [
        '---', `title: "${note.title}"`, 'kg:', `  id: "${note.id}"`, '  type: "document"', '  status: "active"', '  audience: "team"',
        ...(relations.length > 0 ? ['  relations:', ...relations] : []), '---', '', `# ${note.title}`, '', ...note.body, '',
        ...(links.length > 0 ? [`See ${links.join(' and ')}.`, ''] : []),
        ...(note.embedsImage ? ['![gauge](../img/gauge.png)', ''] : []),
      ].join('\n')
      fs.mkdirSync(path.dirname(path.join(dir, note.repoId, note.path)), { recursive: true })
      fs.writeFileSync(path.join(dir, note.repoId, note.path), text)
    }
    for (const repoId of REPOSITORIES) {
      fs.mkdirSync(path.join(dir, repoId, 'img'), { recursive: true })
      fs.writeFileSync(path.join(dir, repoId, 'img/gauge.png'), PNG)
    }
    fs.mkdirSync(path.join(dir, 'alpha-desk/charts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'alpha-desk/charts/depth.pdf'), Buffer.from('%PDF-1.4 synthetic'))
    writeJson(path.join(dir, 'alpha-desk/charts/depth.pdf.kg.json'), {
      schema: 'mnstry.source-sidecar@v1', asset: 'depth.pdf', title: 'Depth chart', summary: 'Invented soundings.', tags: ['chart'],
      kg: { id: 'alpha-desk:depth-chart', type: 'evidence', domain: 'sample', lifecycle: 'source', status: 'active', audience: 'team', relations: { evidences: ['alpha-desk:n-000'] } },
    })
    writeProject(dir, REPOSITORIES, 'incremental-synthetic')
  }
}

for (const seed of [1, 2, 3]) {
  test(`random change sequence (seed ${seed}): every incremental preparation equals the full one and emits exactly the changed notes`, (t) => {
    const dir = fs.mkdtempSync(path.join(TMP, 'atelier-incremental-random-'))
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
    const corpus = new Corpus(seed)
    const workspaceId = `ws-synthetic-${String(seed).padStart(4, '0')}`
    const profile = profileFor(workspaceId, REPOSITORIES)
    const cache = createPreparationCache()
    const withheld = new Set()
    let registry = null
    let prior = null
    let lastFull = null
    let scope = fullScope
    let partial = 0
    const steps = []
    const run = (label) => {
      corpus.write(dir)
      const snapshot = snapshotOf({ dir, repositories: REPOSITORIES, workspaceId, withheld })
      const input = { snapshot, profile, scope, clock, persistentPathRegistry: registry, priorManifest: prior }
      const full = prepareView(input)
      const incremental = prepareView({ ...input, cache })
      steps.push(label)
      assertEqualPreparations(incremental, full, steps.join(' > '))
      if (lastFull) assert.equal(incremental.preparation.emitted, changedNotes(lastFull, full).length, `${steps.join(' > ')}: emitted exactly the changed notes`)
      if (lastFull && incremental.preparation.emitted > 0 && incremental.preparation.reused > 0) partial += 1
      registry = full.persistentPathRegistry
      prior = full.manifest
      lastFull = full
      return full
    }
    const initial = run('initial')
    assert.ok(initial.manifest.notes.length >= 50 && initial.manifest.links.length > 0 && initial.manifest.attachments.length >= 2, 'the corpus has notes, links, a wrapped source and an embedded image')
    for (let step = 0; step < 40; step += 1) {
      const roll = corpus.random()
      if (roll < 0.08) {
        // Eligibility changes: a note withheld or admitted again.
        const candidate = corpus.pick([...corpus.notes.keys()])
        if (withheld.has(candidate)) withheld.delete(candidate); else withheld.add(candidate)
        run(`eligibility ${candidate}`)
      } else if (roll < 0.14) {
        // The scope narrows to a few identities, or widens back to everything.
        scope = scope.mode === 'full' ? scopedOn([...corpus.notes.keys()].filter((id) => !withheld.has(id)).slice(0, 6)) : fullScope
        prior = null
        run(`scope ${scope.scopeId}`)
      } else {
        run(corpus.mutate())
      }
    }
    assert.ok(partial >= 20, `most steps reuse some notes and emit others (${partial} of 40 did; ${JSON.stringify(steps)})`)
  })
}

// ---------------------------------------------------------------------------
// 3. The cache's own contract
// ---------------------------------------------------------------------------

test('the cache is derived state: a reused note never aliases the result, and a foreign cache refuses', (t) => {
  const dir = fixtureWorkspace(t)
  const workspaceId = 'ws-synthetic-0002'
  const profile = profileFor(workspaceId, fixture.repositories)
  const snapshot = snapshotOf({ dir, repositories: fixture.repositories, workspaceId, withheld: new Set(fixture.withheldByEligibility) })
  const cache = createPreparationCache()
  const first = prepareView({ snapshot, profile, scope: fullScope, clock, cache })
  const second = prepareView({ snapshot, profile, scope: fullScope, clock, cache })
  assert.deepEqual(second.preparation, { emitted: 0, reused: first.manifest.notes.length })
  // Whatever a caller does to what it was handed leaves the next preparation intact.
  second.manifest.notes[0].title = 'defaced'
  second.manifest.notes[0].regions.generated.length = 0
  second.files.find((file) => file.kind === 'note').path = 'notes/defaced.md'
  for (const link of second.manifest.links) for (const inversion of link.inversions ?? []) inversion.note.start = -1
  const third = prepareView({ snapshot, profile, scope: fullScope, clock, cache })
  assert.deepEqual(comparable(third), comparable(first))
  for (const broken of [{}, { notes: [] }, 'cache', 7]) {
    assert.throws(() => prepareView({ snapshot, profile, scope: fullScope, clock, cache: broken }), { code: 'invalid-preparation-cache' })
  }
})

test('a reused note is bound to its pinned digest: a changed source is read and verified, an unchanged one is served from the cache', (t) => {
  const dir = fixtureWorkspace(t)
  const workspaceId = 'ws-synthetic-0002'
  const profile = profileFor(workspaceId, fixture.repositories)
  const withheld = new Set(fixture.withheldByEligibility)
  const cache = createPreparationCache()
  const primed = prepareView({ snapshot: snapshotOf({ dir, repositories: fixture.repositories, workspaceId, withheld }), profile, scope: fullScope, clock, cache })
  // The pinned digests are unchanged, so no source is read for a reused note: bytes that drift under an unchanged pin are not consulted, and the emitted note is the one the pin describes.
  const snapshot = snapshotOf({ dir, repositories: fixture.repositories, workspaceId, withheld })
  const reads = []
  const observed = { ...snapshot, readSource: (repoId, relative) => { reads.push(`${repoId}/${relative}`); return snapshot.readSource(repoId, relative) } }
  const reused = prepareView({ snapshot: observed, profile, scope: fullScope, clock, cache })
  assert.deepEqual(comparable(reused), comparable(primed))
  assert.deepEqual(reads.filter((file) => file.endsWith('.md')), [], 'no note source is read when every note is reused')
  // A changed pin is read and verified against the pin, as always.
  fs.appendFileSync(path.join(dir, 'south-desk/tables/tide-table.md'), '\nChanged.\n')
  const changed = snapshotOf({ dir, repositories: fixture.repositories, workspaceId, withheld })
  const drifted = { ...changed, readSource: (repoId, relative) => (relative === 'tables/tide-table.md' ? Buffer.from('drifted after the pin') : changed.readSource(repoId, relative)) }
  assert.throws(() => prepareView({ snapshot: drifted, profile, scope: fullScope, clock, cache }), { code: 'mixed-read' })
  const after = prepareView({ snapshot: changed, profile, scope: fullScope, clock, cache })
  assert.equal(after.preparation.emitted, 1)
  assert.deepEqual(comparable(after), comparable(prepareView({ snapshot: changed, profile, scope: fullScope, clock })))
  assert.equal(after.manifest.notes.find((note) => note.nodeId === 'south-desk:tide-table').ext[EXT].source.rawDigest, sha256Digest(fs.readFileSync(path.join(dir, 'south-desk/tables/tide-table.md'))))
})

test('mutation control: a cache entry whose bytes or manifest entry are wrong under a matching key fails the equality oracle', (t) => {
  const dir = fixtureWorkspace(t)
  const workspaceId = 'ws-synthetic-0002'
  const profile = profileFor(workspaceId, fixture.repositories)
  const snapshot = snapshotOf({ dir, repositories: fixture.repositories, workspaceId, withheld: new Set(fixture.withheldByEligibility) })
  const full = prepareView({ snapshot, profile, scope: fullScope, clock })
  const primed = () => {
    const cache = createPreparationCache()
    prepareView({ snapshot, profile, scope: fullScope, clock, cache })
    return cache
  }
  const tidePath = full.manifest.notes.find((note) => note.nodeId === 'south-desk:tide-table').path
  // Wrong bytes under the right key: the digest and the bytes both differ from the full preparation.
  const wrongBytes = primed()
  const noteFile = wrongBytes.notes.get(tidePath).files.find((file) => file.kind === 'note')
  noteFile.bytes = Buffer.from('not the note')
  assert.throws(() => assertEqualPreparations(prepareView({ snapshot, profile, scope: fullScope, clock, cache: wrongBytes }), full, 'wrong bytes'), assert.AssertionError)
  // A wrong manifest entry under the right key.
  const wrongEntry = primed()
  wrongEntry.notes.get(tidePath).note.title = 'not the title'
  assert.throws(() => assertEqualPreparations(prepareView({ snapshot, profile, scope: fullScope, clock, cache: wrongEntry }), full, 'wrong entry'), assert.AssertionError)
  // A dropped inversion under the right key.
  const wrongInversions = primed()
  const withInversions = [...wrongInversions.notes.values()].find((entry) => entry.edgeInversions.length > 0)
  withInversions.edgeInversions.length = 0
  assert.throws(() => assertEqualPreparations(prepareView({ snapshot, profile, scope: fullScope, clock, cache: wrongInversions }), full, 'dropped inversions'), assert.AssertionError)
  // A key that never matches only costs work: the result is still equal.
  const neverMatching = primed()
  for (const entry of neverMatching.notes.values()) entry.key = null
  const emitted = prepareView({ snapshot, profile, scope: fullScope, clock, cache: neverMatching })
  assertEqualPreparations(emitted, full, 'never matching')
  assert.equal(emitted.preparation.reused, 0)
})
