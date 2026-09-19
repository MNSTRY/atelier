import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildCanonicalGraph } from '../src/graph/graph.mjs'
import { resolveProjectConfig, writeJson } from '../src/project/config.mjs'
import { identitySuffix, validateObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import {
  POLICY_SETTINGS_PATH,
  allocateWorkspacePaths,
  collisionKey,
  isUserOwnedSettingsPath,
  prepareSettings,
  prepareView,
  readMarkdownLens,
  sha256Digest,
  stagePreparedView,
  withEligibility,
} from '../src/projection/obsidian/materialize/index.mjs'

// Invented fixtures only. The workspace is written into a temporary directory,
// read by the real canonical graph builder, and prepared in memory.

const root = fileURLToPath(new URL('..', import.meta.url))
const fixtureRoot = path.join(root, 'fixtures/obsidian/materialization')
const workspace = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'workspace.json'), 'utf8'))
const EXT = 'mnstry.atelier.obsidian'
const clock = () => '2026-01-05T10:00:05.000Z'
const sourceBytes = (file) => (file.hex ? Buffer.from(file.hex, 'hex') : Buffer.from(file.text, 'utf8'))

const profile = {
  schema: 'atelier-obsidian-corpus-profile/v1',
  workspaceId: 'ws-synthetic-0002',
  repositories: workspace.repositories.map((repoId) => ({ repoId, root: `repos/${repoId}`, enrollment: 'enrolled' })),
  audience: { allow: ['team', 'private'] },
}
const fullScope = { schema: 'atelier-obsidian-scope/v1', scopeId: 'scope-full', mode: 'full', selector: { all: true } }
const scopedScope = {
  schema: 'atelier-obsidian-scope/v1',
  scopeId: 'scope-harbor',
  mode: 'scoped',
  selector: { ids: ['north-desk:harbor-plan', 'south-desk:tide-table'] },
}

function snapshotFor(graph, read) {
  const repositories = workspace.repositories.map((repoId) => ({
    repoId,
    head: null,
    dirty: true,
    files: graph.nodes
      .filter((node) => node.repo === repoId)
      .map((node) => ({ path: node.path, rawDigest: sha256Digest(read(repoId, node.path)), byteLength: read(repoId, node.path).length })),
  }))
  return {
    document: {
      schema: 'atelier-obsidian-source-snapshot/v1',
      snapshotId: 'snap-0002',
      workspaceId: profile.workspaceId,
      capturedAt: '2026-01-05T10:00:00Z',
      readConsistency: 'single-read',
      graphPin: { graphDigest: sha256Digest(Buffer.from(JSON.stringify([graph.nodes, graph.edges]))), nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
      versions: { source: '1', config: '1', emitter: '1.0.0' },
      repositories,
    },
    graph,
    readSource: read,
  }
}

function makeWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-materialize-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [relative, file] of Object.entries(workspace.files)) {
    const absolute = path.join(dir, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, sourceBytes(file))
  }
  for (const name of workspace.repositories) fs.mkdirSync(path.join(dir, name, '.git'), { recursive: true })
  writeJson(path.join(dir, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'materialization-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: workspace.repositories.map((name) => ({ name, path: name, readBoundary: 'team' })),
  })
  writeJson(path.join(dir, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: Object.fromEntries(workspace.repositories.map((name) => [name, { readBoundary: 'team' }])),
  })
  const canonical = buildCanonicalGraph(resolveProjectConfig({ argv: [`--project=${path.join(dir, 'atelier.project.json')}`], cwd: dir }))
  assert.equal(canonical.ok, true, canonical.errors.join('\n'))
  const graph = withEligibility(canonical, (node) => !workspace.withheldByEligibility.includes(node.id))
  return snapshotFor(graph, (repoId, relative) => fs.readFileSync(path.join(dir, repoId, relative)))
}

const prepare = (snapshot, scope, extra = {}) => prepareView({ snapshot, profile, scope, clock, ...extra })
const fileOf = (prepared, filePath) => prepared.files.find((file) => file.path === filePath)
const noteOf = (prepared, nodeId) => prepared.manifest.notes.find((note) => note.nodeId === nodeId)
const noteBytes = (prepared, nodeId) => fileOf(prepared, noteOf(prepared, nodeId).path).bytes
const original = (repoId, relative) => sourceBytes(workspace.files[`${repoId}/${relative}`])

// ---------------------------------------------------------------------------
// Assertions shared with the mutation controls
// ---------------------------------------------------------------------------

function goldenOf(prepared) {
  return {
    nodes: prepared.manifest.notes.map((note) => note.nodeId),
    edges: prepared.manifest.links.map((link) => [link.sourceNodeId, link.type, link.targetNodeId]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    attachments: prepared.manifest.attachments,
    files: Object.fromEntries(
      prepared.files.map((file) => [file.path, { digest: sha256Digest(file.bytes), ...(file.kind === 'attachment' ? { hex: file.bytes.toString('hex') } : { text: file.bytes.toString('utf8') }) }]),
    ),
    manifestDigest: sha256Digest(prepared.manifestBytes),
  }
}

function assertMatchesGolden(prepared, name, { mayUpdate = false } = {}) {
  const goldenPath = path.join(fixtureRoot, `expected-${name}.json`)
  if (mayUpdate && process.env.ATELIER_UPDATE_MATERIALIZATION_GOLDEN === '1') fs.writeFileSync(goldenPath, `${JSON.stringify(goldenOf(prepared), null, 2)}\n`)
  assert.deepEqual(goldenOf(prepared), JSON.parse(fs.readFileSync(goldenPath, 'utf8')))
}

// Every emitted byte: notes, attachments, settings, the manifest and the
// registry entries of the view.
function emittedBytes(prepared) {
  const viewRegistry = prepared.manifest.notes.map((note) => `${note.repoId}\n${note.nodeId}\n${note.path}`).join('\n')
  return Buffer.concat([...prepared.files.flatMap((file) => [Buffer.from(file.path), file.bytes]), prepared.manifestBytes, Buffer.from(viewRegistry)])
}

function occurrences(haystack, needle) {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) count += 1
  return count
}

function assertNothingWithheld(prepared) {
  const everything = emittedBytes(prepared)
  for (const sentinel of workspace.sentinels) assert.equal(occurrences(everything, sentinel), 0, `withheld sentinel ${sentinel} was emitted`)
  // What a visible author wrote about a withheld target stays exactly where
  // they wrote it and appears nowhere else.
  for (const sentinel of workspace.authoredOnlySentinels) {
    let authored = 0
    for (const note of prepared.manifest.notes) {
      const bytes = fileOf(prepared, note.path).bytes
      const end = note.regions.body.end
      authored += occurrences(bytes.subarray(0, end), sentinel)
    }
    assert.ok(authored > 0, `fixture no longer exercises ${sentinel}`)
    assert.equal(occurrences(everything, sentinel), authored, `${sentinel} appears outside authored bytes`)
  }
}

// Applies the manifest's inversion map to one note and returns source bytes.
function invertNote(prepared, nodeId) {
  const note = noteOf(prepared, nodeId)
  const bytes = fileOf(prepared, note.path).bytes
  const authoredEnd = note.regions.body.end
  const inversions = prepared.manifest.links
    .filter((link) => link.sourceNodeId === nodeId)
    .flatMap((link) => link.inversions ?? [])
    .sort((left, right) => right.note.start - left.note.start)
  let restored = bytes.subarray(0, authoredEnd)
  for (const inversion of inversions) {
    assert.deepEqual(restored.subarray(inversion.note.start, inversion.note.end), Buffer.from(inversion.ext[EXT].emitted, 'base64url'))
    restored = Buffer.concat([restored.subarray(0, inversion.note.start), Buffer.from(inversion.ext[EXT].original, 'base64url'), restored.subarray(inversion.note.end)])
  }
  return restored
}

function assertAuthoredBytesPreserved(prepared) {
  for (const note of prepared.manifest.notes) {
    const record = note.ext[EXT].source
    if (record.kind !== 'markdown') continue
    assert.deepEqual(invertNote(prepared, note.nodeId), original(note.repoId, record.path), `${note.nodeId} does not invert to its source`)
  }
}

// ---------------------------------------------------------------------------
// Full and scoped views
// ---------------------------------------------------------------------------

test('full view: exact nodes, edges, emitted bytes and attachment hashes', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  assert.deepEqual(prepared.manifest.notes.map((note) => note.nodeId), [
    'north-desk:depth-chart',
    'north-desk:harbor-plan',
    'north-desk:journal-signal-log',
    'north-desk:shared-a',
    'north-desk:shared-b',
    'south-desk:tide-table',
  ])
  assert.deepEqual(goldenOf(prepared).edges, [
    ['north-desk:depth-chart', 'evidences', 'north-desk:harbor-plan'],
    ['north-desk:harbor-plan', 'depends_on', 'north-desk:shared-a'],
    ['north-desk:harbor-plan', 'links_to', 'north-desk:depth-chart'],
    ['north-desk:harbor-plan', 'links_to', 'north-desk:shared-a'],
    ['north-desk:harbor-plan', 'links_to', 'south-desk:tide-table'],
    ['north-desk:harbor-plan', 'supports', 'south-desk:tide-table'],
    ['north-desk:shared-a', 'links_to', 'north-desk:harbor-plan'],
    ['north-desk:shared-b', 'contradicts', 'north-desk:shared-a'],
    ['south-desk:tide-table', 'links_to', 'north-desk:harbor-plan'],
  ])
  const pdf = original('north-desk', 'charts/depth-chart.pdf')
  assert.deepEqual(prepared.manifest.attachments, [
    { path: `attachments/Depth chart--${identitySuffix('north-desk', 'north-desk:depth-chart')}.pdf`, digest: sha256Digest(pdf), byteLength: pdf.length },
  ])
  assert.deepEqual(prepared.manifest.completeness, { status: 'complete', expectedNotes: 6, writtenNotes: 6 })
  assertMatchesGolden(prepared, 'full', { mayUpdate: true })
})

test('scoped view: exact nodes and edges; links leaving the selection stay as written', (t) => {
  const prepared = prepare(makeWorkspace(t), scopedScope)
  assert.deepEqual(prepared.manifest.notes.map((note) => note.nodeId), ['north-desk:harbor-plan', 'south-desk:tide-table'])
  assert.deepEqual(goldenOf(prepared).edges, [
    ['north-desk:harbor-plan', 'links_to', 'south-desk:tide-table'],
    ['north-desk:harbor-plan', 'supports', 'south-desk:tide-table'],
    ['south-desk:tide-table', 'links_to', 'north-desk:harbor-plan'],
  ])
  assert.deepEqual(prepared.manifest.attachments, [])
  const plan = noteBytes(prepared, 'north-desk:harbor-plan').toString('utf8')
  assert.ok(plan.includes('[depth chart](../charts/depth-chart.pdf)'))
  assert.ok(plan.includes('[shared](shared-a.md)'))
  // A selected-out target gives away neither its allocated path nor its title.
  const everything = emittedBytes(prepared).toString('utf8')
  for (const hidden of ['Shared concept', 'Depth chart', 'Signal', identitySuffix('north-desk', 'north-desk:shared-a'), identitySuffix('north-desk', 'north-desk:depth-chart')]) {
    assert.equal(everything.includes(hidden), false, `${hidden} leaked into a scoped view`)
  }
  assert.ok(plan.includes('Relationships leading outside this view: 5\n'))
  assertMatchesGolden(prepared, 'scoped', { mayUpdate: true })
})

test('the same identity has the same path in full and scoped views, with or without a shared registry', (t) => {
  const snapshot = makeWorkspace(t)
  const full = prepare(snapshot, fullScope)
  const scoped = prepare(snapshot, scopedScope, { persistentPathRegistry: full.persistentPathRegistry })
  const independent = prepare(snapshot, scopedScope)
  for (const note of scoped.manifest.notes) {
    assert.equal(note.path, noteOf(full, note.nodeId).path)
    assert.equal(note.path, noteOf(independent, note.nodeId).path)
  }
  // The registry is allocated for the workspace, not for the view.
  assert.deepEqual(independent.persistentPathRegistry, full.persistentPathRegistry)
  assert.deepEqual(scoped.persistentPathRegistry, full.persistentPathRegistry)
  assert.deepEqual(full.persistentPathRegistry.entries.map((entry) => entry.nodeId), [...full.persistentPathRegistry.entries.map((entry) => entry.nodeId)].sort())
})

test('a source title change keeps the allocated path and shows the new title', (t) => {
  const snapshot = makeWorkspace(t)
  const first = prepare(snapshot, fullScope)
  const renamed = { ...snapshot, graph: { ...snapshot.graph, nodes: snapshot.graph.nodes.map((node) => (node.id === 'south-desk:tide-table' ? { ...node, title: 'Tidal almanac' } : node)) } }
  const second = prepare(renamed, fullScope, { persistentPathRegistry: first.persistentPathRegistry, priorManifest: first.manifest })
  assert.equal(noteOf(second, 'south-desk:tide-table').path, noteOf(first, 'south-desk:tide-table').path)
  assert.equal(noteOf(second, 'south-desk:tide-table').title, 'Tidal almanac')
  assert.ok(noteBytes(second, 'north-desk:harbor-plan').toString('utf8').includes('|Tidal almanac]]'))
  // The prior manifest alone also pins the path when the registry was lost.
  const recovered = prepare(renamed, fullScope, { priorManifest: first.manifest })
  assert.equal(noteOf(recovered, 'south-desk:tide-table').path, noteOf(first, 'south-desk:tide-table').path)
  assert.deepEqual(second.changes.removed, [])
  assert.ok(second.changes.changed.includes(noteOf(first, 'north-desk:harbor-plan').path))
  assert.ok(second.changes.unchanged.includes(noteOf(first, 'north-desk:shared-b').path))
})

test('duplicate titles stay readable and distinct; duplicate identities refuse', (t) => {
  const snapshot = makeWorkspace(t)
  const prepared = prepare(snapshot, fullScope)
  const [first, second] = ['north-desk:shared-a', 'north-desk:shared-b'].map((id) => noteOf(prepared, id).path)
  assert.match(first, /^notes\/Shared concept--[0-9a-f]{12}\.md$/)
  assert.match(second, /^notes\/Shared concept--[0-9a-f]{12}\.md$/)
  assert.notEqual(first, second)

  const twin = snapshot.graph.nodes.find((node) => node.id === 'north-desk:shared-a')
  const repeated = { ...snapshot, graph: { ...snapshot.graph, nodes: [...snapshot.graph.nodes, { ...twin, path: 'plans/shared-b.md' }] } }
  assert.throws(() => prepare(repeated, fullScope), { code: 'duplicate-identity' })
})

test('path allocation detects case, normalization and length collisions', () => {
  const nodes = [
    { repo: 'r', id: 'one', title: 'Résumé' },
    { repo: 'r', id: 'two', title: 'Résumé' },
  ]
  const { registry } = allocateWorkspacePaths({ registry: null, workspaceId: 'ws', nodes })
  assert.equal(registry.entries[0].path.normalize('NFC'), registry.entries[0].path)
  assert.equal(registry.entries[0].path.split('--')[0], registry.entries[1].path.split('--')[0])

  // Names a case-insensitive or normalization-insensitive filesystem would merge share a key.
  assert.equal(collisionKey('notes/Straße--0a'), collisionKey('notes/STRASSE--0A'))
  assert.equal(collisionKey('notes/Re\u0301sume\u0301'), collisionKey('notes/RÉSUMÉ'))
  assert.notEqual(collisionKey(registry.entries[0].path), collisionKey(registry.entries[1].path))
  // A registry whose entry was not derived from its identity refuses.
  const stolen = { ...registry, entries: [registry.entries[0], { repoId: 'r', nodeId: 'two', path: registry.entries[0].path }] }
  assert.throws(() => allocateWorkspacePaths({ registry: stolen, workspaceId: 'ws', nodes: [] }), { code: 'invalid-path-registry' })
  assert.throws(() => allocateWorkspacePaths({ registry, workspaceId: 'other', nodes: [] }), { code: 'invalid-path-registry' })

  const long = allocateWorkspacePaths({ registry: null, workspaceId: 'ws', nodes: [{ repo: 'r', id: 'long', title: '語'.repeat(120) }] })
  assert.ok(Buffer.byteLength(long.registry.entries[0].path.slice('notes/'.length)) <= 255)
  assert.throws(() => allocateWorkspacePaths({ registry: null, workspaceId: 'ws', nodes, vaultRootBytes: 1000 }), { code: 'path-too-long' })
  assert.throws(() => allocateWorkspacePaths({ registry: null, workspaceId: 'ws', nodes: [nodes[0], nodes[0]] }), { code: 'duplicate-identity' })
})

// ---------------------------------------------------------------------------
// Byte fidelity
// ---------------------------------------------------------------------------

test('CRLF, byte order prefix, missing final newline and non-ASCII sources are preserved byte-exactly', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  assertAuthoredBytesPreserved(prepared)

  const crlf = noteOf(prepared, 'north-desk:shared-a')
  const crlfSource = original('north-desk', 'plans/shared-a.md')
  assert.ok(crlfSource.includes('\r\n') && !crlfSource.toString('latin1').replace(/\r\n/g, '').includes('\n'))
  assert.deepEqual(crlf.regions.frontmatter, readMarkdownLens(crlfSource).frontmatter)
  assert.deepEqual(noteBytes(prepared, crlf.nodeId).subarray(0, crlf.regions.frontmatter.end), crlfSource.subarray(0, crlf.regions.frontmatter.end))
  assert.equal(crlf.ext[EXT].source.finalNewline, 'crlf')

  const prefixed = noteOf(prepared, 'north-desk:journal-signal-log')
  assert.deepEqual(prefixed.ext[EXT].source.bom, { start: 0, end: 3 })
  assert.deepEqual(prefixed.regions.body, { start: 3, end: original('north-desk', 'journal/signal-log.md').length })
  assert.deepEqual(noteBytes(prepared, prefixed.nodeId), original('north-desk', 'journal/signal-log.md'))

  const unterminated = noteOf(prepared, 'north-desk:shared-b')
  const unterminatedSource = original('north-desk', 'plans/shared-b.md')
  assert.equal(unterminated.ext[EXT].source.finalNewline, 'none')
  assert.equal(unterminated.regions.body.end, unterminatedSource.length)
  assert.deepEqual(noteBytes(prepared, unterminated.nodeId).subarray(0, unterminatedSource.length), unterminatedSource)
  assert.equal(unterminated.regions.generated[0].range.start, unterminatedSource.length)

  // Regions tile each note exactly: nothing unaccounted for, nothing shared.
  for (const note of prepared.manifest.notes) {
    const ranges = [note.ext[EXT].source.bom, note.regions.frontmatter, note.regions.body, ...note.regions.generated.map((region) => region.range)]
      .filter((range) => range && range.end > range.start)
      .sort((left, right) => left.start - right.start)
    let cursor = 0
    for (const range of ranges) {
      assert.equal(range.start, cursor, `${note.nodeId} has a gap or overlap at byte ${cursor}`)
      cursor = range.end
    }
    assert.equal(cursor, fileOf(prepared, note.path).bytes.length)
    assert.equal(note.noteDigest, sha256Digest(fileOf(prepared, note.path).bytes))
  }
})

test('malformed encodings, ambiguous front matter and mixed reads refuse', (t) => {
  const snapshot = makeWorkspace(t)
  const swap = (bytes) => {
    const read = (repoId, relative) => (repoId === 'south-desk' ? bytes : snapshot.readSource(repoId, relative))
    return snapshotFor(snapshot.graph, read)
  }
  assert.throws(() => prepare(swap(Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a])), fullScope), { code: 'malformed-utf8' })
  assert.throws(() => prepare(swap(Buffer.from([0x23, 0x20, 0xed, 0xa0, 0x80])), fullScope), { code: 'malformed-utf8' })
  for (const ambiguous of ['---\ntitle: x\n', '---\ntitle: x\n---', '--- \ntitle: x\n---\n', '﻿---\ntitle: x\n---\n', '---\n---\nbody\n', '---\rtitle: x\r---\n']) {
    assert.throws(() => readMarkdownLens(Buffer.from(ambiguous)), { code: 'ambiguous-frontmatter' }, JSON.stringify(ambiguous))
  }
  assert.deepEqual(readMarkdownLens(Buffer.from('----\nrule\n')).frontmatter, null)

  // Bytes that differ from the pinned digest, or from what the graph read.
  const drifted = { ...snapshot, readSource: (repoId, relative) => (repoId === 'south-desk' ? Buffer.from('changed') : snapshot.readSource(repoId, relative)) }
  assert.throws(() => prepare(drifted, fullScope), { code: 'mixed-read' })
  const moved = Buffer.from(original('north-desk', 'plans/harbor-plan.md').toString('utf8').replace('See the', 'Do see the'))
  const read = (repoId, relative) => (relative === 'plans/harbor-plan.md' ? moved : snapshot.readSource(repoId, relative))
  assert.throws(() => prepare(snapshotFor(snapshot.graph, read), fullScope), { code: 'mixed-read' })
  assert.throws(() => prepareView({ snapshot, profile, scope: fullScope }), { code: 'missing-clock' })
})

// ---------------------------------------------------------------------------
// Links and relations
// ---------------------------------------------------------------------------

test('only canonical resolved links are rewritten; a cross-repository link inverts exactly from the manifest', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  const plan = noteBytes(prepared, 'north-desk:harbor-plan').toString('utf8')
  const tide = noteOf(prepared, 'south-desk:tide-table').path.slice('notes/'.length)
  const stem = tide.slice(0, -'.md'.length)
  assert.ok(plan.includes(`[tide table](${encodeURIComponent(tide)}#spring)`))
  assert.ok(plan.includes(`[[${stem}|Tide table]] or [[${stem}#Spring|spring tides]]`))
  assert.ok(plan.includes(`[depth chart](${encodeURIComponent(noteOf(prepared, 'north-desk:depth-chart').path.slice('notes/'.length))})`))

  // Code, unresolved, external and withheld targets are byte-identical.
  for (const untouched of ['[ledger](../sealed/ledger.md)', '[gone](missing.md)', '[site](https://example.invalid/page.md)', '`[[Tide table]]` in inline code', '```\n[fenced](../../south-desk/tables/tide-table.md)\n[[Tide table]]\n```']) {
    assert.ok(plan.includes(untouched), `${untouched} was altered`)
  }
  assert.ok(noteBytes(prepared, 'south-desk:tide-table').toString('utf8').includes(`![[${noteOf(prepared, 'north-desk:harbor-plan').path.slice('notes/'.length, -3)}]]`))

  const crossRepository = prepared.manifest.links.find((link) => link.sourceNodeId === 'north-desk:harbor-plan' && link.targetNodeId === 'south-desk:tide-table' && link.type === 'links_to')
  assert.equal(crossRepository.origin, 'markdown')
  assert.equal(crossRepository.inversions.length, 4)
  assert.equal(Buffer.from(crossRepository.inversions[0].ext[EXT].original, 'base64url').toString(), '../../south-desk/tables/tide-table.md')
  assert.deepEqual(invertNote(prepared, 'north-desk:harbor-plan'), original('north-desk', 'plans/harbor-plan.md'))
  assert.deepEqual(invertNote(prepared, 'south-desk:tide-table'), original('south-desk', 'tables/tide-table.md'))

  // The emitter adds no edge: every rewritten occurrence is a canonical one.
  const rewritten = prepared.manifest.links.flatMap((link) => (link.inversions ?? []).map(() => `${link.sourceNodeId}>${link.targetNodeId}`))
  const canonicalPairs = new Set(makeWorkspace(t).graph.links.map((link) => `${link.source}>${link.target}`))
  for (const pair of rewritten) assert.ok(canonicalPairs.has(pair))
})

test('typed relations are listed by type and direction; generated prose cannot create a link or a tag', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  const stem = (id) => noteOf(prepared, id).path.slice('notes/'.length, -3)
  const plan = noteBytes(prepared, 'north-desk:harbor-plan').toString('utf8')
  const section = plan.slice(plan.indexOf('## Relations (generated)'))
  assert.ok(section.includes(`- supports → [[${stem('south-desk:tide-table')}|Tide table]]\n`))
  assert.ok(section.includes(`- depends_on → [[${stem('north-desk:shared-a')}|Shared concept]]\n`))
  assert.ok(section.includes(`- links_to → [[${stem('north-desk:depth-chart')}|Depth chart]]\n`))
  assert.ok(section.includes('- evidences ← Depth chart\n'))
  assert.equal(section.includes('related'), false, 'a relation to a withheld node was listed')
  const sharedA = noteBytes(prepared, 'north-desk:shared-a').toString('utf8')
  assert.ok(sharedA.includes('- contradicts ← Shared concept\n'))

  const wrapper = noteBytes(prepared, 'north-desk:depth-chart').toString('utf8')
  assert.ok(wrapper.startsWith('# Depth chart\n'))
  assert.ok(wrapper.includes('with \\[\\[brackets\\]\\] and a \\#tag'))
  assert.ok(wrapper.includes(`![[attachments/${stem('north-desk:depth-chart')}.pdf]]`))
  assert.deepEqual(noteOf(prepared, 'north-desk:depth-chart').regions.generated.map((region) => region.kind), ['representation', 'relations'])
  assert.deepEqual(fileOf(prepared, prepared.manifest.attachments[0].path).bytes, original('north-desk', 'charts/depth-chart.pdf'))
})

// ---------------------------------------------------------------------------
// Redaction, settings, determinism, contract
// ---------------------------------------------------------------------------

test('nothing about a withheld node reaches any emitted byte', (t) => {
  const snapshot = makeWorkspace(t)
  assertNothingWithheld(prepare(snapshot, fullScope))
  assertNothingWithheld(prepare(snapshot, { ...fullScope, scopeId: 'scope-focus', mode: 'focus', selector: { ids: ['north-desk:harbor-plan'] } }))
  const registry = JSON.stringify(prepare(snapshot, fullScope).persistentPathRegistry)
  for (const sentinel of workspace.sentinels) assert.equal(registry.includes(sentinel), false)

  // Asking for a withheld identity yields an empty view, not an error that confirms it.
  const asked = prepare(snapshot, { ...scopedScope, scopeId: 'scope-asked', selector: { ids: ['north-desk:sealed-ledger'] } })
  assert.deepEqual(asked.manifest.notes, [])
  assertNothingWithheldAnywhere(asked)
})

function assertNothingWithheldAnywhere(prepared) {
  const everything = emittedBytes(prepared)
  for (const sentinel of [...workspace.sentinels, ...workspace.authoredOnlySentinels]) assert.equal(occurrences(everything, sentinel), 0)
}

test('policy-owned settings disable Sync and Publish and never carry a file the person owns', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  const settings = prepared.files.filter((file) => file.path.startsWith('.obsidian/'))
  assert.deepEqual(settings.map((file) => file.path), [POLICY_SETTINGS_PATH])
  assert.deepEqual(JSON.parse(settings[0].bytes.toString('utf8')), { publish: false, sync: false })
  const ownership = prepared.manifest.ext[EXT].settings
  assert.deepEqual(ownership.policyOwned, [{ path: POLICY_SETTINGS_PATH, ownedKeys: ['publish', 'sync'], digest: sha256Digest(settings[0].bytes), byteLength: settings[0].bytes.length }])
  for (const owned of ['.obsidian/workspace.json', '.obsidian/graph.json', '.obsidian/app.json', '.obsidian/plugins/x/data.json']) assert.equal(isUserOwnedSettingsPath(owned), true)
  assert.equal(isUserOwnedSettingsPath(POLICY_SETTINGS_PATH), false)

  // Keys the person set survive; compliant bytes are returned untouched.
  const theirs = Buffer.from('{"graph":true,"sync":true,"canvas":false}')
  assert.deepEqual(JSON.parse(prepareSettings({ existing: theirs }).files[0].bytes.toString()), { graph: true, sync: false, canvas: false, publish: false })
  const compliant = Buffer.from('{ "sync": false,\t"publish": false, "graph": true }')
  assert.equal(prepareSettings({ existing: compliant }).files[0].bytes, compliant)
  assert.deepEqual(JSON.parse(prepareSettings({ existing: Buffer.from('["graph","sync"]') }).files[0].bytes.toString()), ['graph'])
  assert.throws(() => prepareSettings({ existing: Buffer.from('{not json') }), { code: 'invalid-settings' })
})

test('the same inputs produce byte-identical notes, manifest and registry', (t) => {
  const first = prepare(makeWorkspace(t), fullScope)
  const second = prepare(makeWorkspace(t), fullScope)
  assert.deepEqual(first.files.map((file) => [file.path, file.bytes]), second.files.map((file) => [file.path, file.bytes]))
  assert.deepEqual(first.manifestBytes, second.manifestBytes)
  assert.equal(JSON.stringify(first.persistentPathRegistry), JSON.stringify(second.persistentPathRegistry))
  // The only time in the output is the injected one.
  const later = prepare(makeWorkspace(t), fullScope, { clock: () => new Date('2027-02-03T04:05:06Z') })
  assert.equal(later.manifest.freshness.checkedAt, '2027-02-03T04:05:06.000Z')
  assert.equal(later.manifest.generationId, first.manifest.generationId)
  assert.deepEqual(later.files.map((file) => file.bytes), first.files.map((file) => file.bytes))
})

test('the manifest satisfies the registered generation-manifest contract and carries no machine path', (t) => {
  const snapshot = makeWorkspace(t)
  for (const scope of [fullScope, scopedScope]) {
    const prepared = prepare(snapshot, scope)
    assert.deepEqual(validateObsidianContract('generation-manifest', JSON.parse(prepared.manifestBytes.toString('utf8'))), [])
    assert.equal(prepared.manifestBytes.includes(os.tmpdir()), false)
  }
})

test('staging writes exactly the prepared bytes into an empty caller-supplied directory', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-staging-'))
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }))
  const { root: stagedRoot } = stagePreparedView(prepared, staging)
  for (const file of prepared.files) assert.deepEqual(fs.readFileSync(path.join(stagedRoot, file.path)), file.bytes)
  assert.throws(() => stagePreparedView(prepared, staging), { code: 'staging-not-empty' })
  assert.throws(() => stagePreparedView({ files: [{ path: '../escape.md', bytes: Buffer.from('x'), digest: sha256Digest(Buffer.from('x')) }] }, fs.mkdtempSync(path.join(staging, 'inner-'))), { code: 'path-escapes-vault' })
})

// ---------------------------------------------------------------------------
// Mutation controls: the assertions above can fail. Each wraps a correct
// prepared view in a deliberately broken transformation; no broken code path
// ships.
// ---------------------------------------------------------------------------

function mutateNotes(prepared, transform) {
  return { ...prepared, files: prepared.files.map((file) => (file.kind === 'note' ? { ...file, bytes: transform(file.bytes, file) } : file)) }
}

test('mutation control: a wrapper that normalizes CRLF fails the byte and golden assertions', (t) => {
  const normalized = mutateNotes(prepare(makeWorkspace(t), fullScope), (bytes) => Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')))
  assert.throws(() => assertAuthoredBytesPreserved(normalized), assert.AssertionError)
  assert.throws(() => assertMatchesGolden(normalized, 'full'), assert.AssertionError)
})

test('mutation control: a wrapper that leaks a withheld title fails the redaction scan', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  const leaky = mutateNotes(prepared, (bytes, file) => (file.path === noteOf(prepared, 'north-desk:harbor-plan').path ? Buffer.concat([bytes, Buffer.from('- related → Sealed ledger ZQXWITHHELD\n')]) : bytes))
  assert.throws(() => assertNothingWithheld(leaky), /ZQXWITHHELD was emitted/)
  // Repeating what an author wrote about a withheld target, anywhere generated, also fails.
  const echoed = { ...prepared, manifestBytes: Buffer.concat([prepared.manifestBytes, Buffer.from('sealed/ledger')]) }
  assert.throws(() => assertNothingWithheld(echoed), /appears outside authored bytes/)
})

test('mutation control: a wrapper that strips the byte order prefix or adds a final newline fails', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  const stripped = mutateNotes(prepared, (bytes) => (bytes[0] === 0xef ? bytes.subarray(3) : bytes))
  assert.throws(() => assertAuthoredBytesPreserved(stripped), assert.AssertionError)
  const target = noteOf(prepared, 'north-desk:shared-b')
  const terminated = mutateNotes(prepared, (bytes, file) => (file.path === target.path ? Buffer.concat([bytes.subarray(0, target.regions.body.end), Buffer.from('\n'), bytes.subarray(target.regions.body.end)]) : bytes))
  assert.throws(() => assertMatchesGolden(terminated, 'full'), assert.AssertionError)
})
