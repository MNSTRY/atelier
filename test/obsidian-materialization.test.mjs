import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildCanonicalGraph } from '../src/graph/graph.mjs'
import { scanMarkdownLinks, unclosedFenceAtEnd } from '../src/graph/knowledge-graph.mjs'
import { resolveProjectConfig, writeJson } from '../src/project/config.mjs'
import { identityLineTexts, identitySuffix, validateObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import {
  POLICY_SETTINGS_PATH,
  allocateViewPaths,
  collisionKey,
  createPreparationCache,
  isUserOwnedSettingsPath,
  prepareSettings,
  prepareView,
  readMarkdownLens,
  sha256Digest,
  stagePreparedView,
  withEligibility,
} from '../src/projection/obsidian/materialize/index.mjs'
import { createViewPreparationForOracleTests } from '../src/projection/obsidian/materialize/prepare-view.mjs'
import { REDACTION_RULES, assertViewRedaction, createDenyMatcher } from '../src/projection/obsidian/materialize/redaction.mjs'

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

// Layout 1 goldens are what the earlier release prepared from this fixture and
// are never regenerated; layout 2 goldens may be, with the environment flag.
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

// Applies the manifest's inversion map to one note and returns source bytes:
// every rewrite inverted, then the generated identity lines removed.
function invertNote(prepared, nodeId) {
  const note = noteOf(prepared, nodeId)
  const bytes = fileOf(prepared, note.path).bytes
  const authoredEnd = note.regions.body.end
  const inversions = [
    ...prepared.manifest.links.filter((link) => link.sourceNodeId === nodeId).flatMap((link) => link.inversions ?? []),
    ...(note.ext[EXT].assetEmbeds ?? []).flatMap((embed) => embed.inversions),
  ].sort((left, right) => right.note.start - left.note.start)
  let restored = bytes.subarray(0, authoredEnd)
  for (const inversion of inversions) {
    assert.deepEqual(restored.subarray(inversion.note.start, inversion.note.end), Buffer.from(inversion.ext[EXT].emitted, 'base64url'))
    restored = Buffer.concat([restored.subarray(0, inversion.note.start), Buffer.from(inversion.ext[EXT].original, 'base64url'), restored.subarray(inversion.note.end)])
  }
  const identity = note.regions.identity
  if (identity && identity.end <= note.regions.body.start) restored = Buffer.concat([restored.subarray(0, identity.start), restored.subarray(identity.end)])
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
  // A wrapped file keeps its name, in its own folder, beside its note.
  assert.deepEqual(prepared.manifest.attachments, [
    { path: 'north-desk/charts/depth-chart.pdf', digest: sha256Digest(pdf), byteLength: pdf.length },
  ])
  assert.deepEqual(prepared.manifest.notes.map((note) => note.path), [
    'north-desk/charts/depth-chart.pdf.md',
    'north-desk/plans/Harbor plan.md',
    'north-desk/journal/signal-log.md',
    'north-desk/plans/Shared concept.md',
    'north-desk/plans/Shared concept (shared-b).md',
    'south-desk/tables/Tide table.md',
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
  // (What the author wrote about them, `[shared](shared-a.md)` or a relation to `north-desk:shared-a`, stays as written.)
  for (const hidden of ['Shared concept', 'Depth chart', 'Signal', 'north-desk/charts/depth-chart.pdf', 'north-desk/plans/Shared concept', 'north-desk/journal/signal-log', 'north-desk:depth-chart']) {
    assert.equal(everything.includes(hidden), false, `${hidden} leaked into a scoped view`)
  }
  assert.ok(plan.includes('Relationships leading outside this view: 5\n'))
  assertMatchesGolden(prepared, 'scoped', { mayUpdate: true })
})

test('layout 1: a view prepared in the earlier layout is byte for byte what the earlier release prepared', (t) => {
  const snapshot = makeWorkspace(t)
  for (const [scope, name] of [[fullScope, 'full'], [scopedScope, 'scoped']]) {
    const prepared = prepare(snapshot, scope, { layout: 1 })
    assert.equal(prepared.manifest.schema, 'atelier-obsidian-generation-manifest/v1')
    assertMatchesGolden(prepared, `${name}.layout-1`)
    assertAuthoredBytesPreserved(prepared)
    assertNothingWithheld(prepared)
  }
})

test('each view allocates its own paths, with or without a shared registry, and keeps them in its own section', (t) => {
  const snapshot = makeWorkspace(t)
  const full = prepare(snapshot, fullScope)
  const scoped = prepare(snapshot, scopedScope, { persistentPathRegistry: full.persistentPathRegistry })
  const independent = prepare(snapshot, scopedScope)
  // Nothing collides in the scoped view, so its notes have the names they have in the full view.
  for (const note of scoped.manifest.notes) {
    assert.equal(note.path, noteOf(full, note.nodeId).path)
    assert.equal(note.path, noteOf(independent, note.nodeId).path)
  }
  // A view's section names its own notes only; a shared registry keeps every view's section.
  const sectionIds = (prepared, scopeId) => prepared.persistentPathRegistry.views[scopeId].entries.map((entry) => entry.nodeId)
  assert.deepEqual(sectionIds(full, 'scope-full'), full.manifest.notes.map((note) => note.nodeId).sort())
  assert.deepEqual(sectionIds(independent, 'scope-harbor'), ['north-desk:harbor-plan', 'south-desk:tide-table'])
  assert.deepEqual(Object.keys(scoped.persistentPathRegistry.views).sort(), ['scope-full', 'scope-harbor'])
  assert.deepEqual(scoped.persistentPathRegistry.views['scope-harbor'], independent.persistentPathRegistry.views['scope-harbor'])
  assert.deepEqual([scoped.persistentPathRegistry.entries, scoped.persistentPathRegistry.assets], [[], []])
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
  // The first in identity order keeps the title; the second is told apart by its source file, never by a hash.
  assert.equal(first, 'north-desk/plans/Shared concept.md')
  assert.equal(second, 'north-desk/plans/Shared concept (shared-b).md')

  const twin = snapshot.graph.nodes.find((node) => node.id === 'north-desk:shared-a')
  const repeated = { ...snapshot, graph: { ...snapshot.graph, nodes: [...snapshot.graph.nodes, { ...twin, path: 'plans/shared-b.md' }] } }
  assert.throws(() => prepare(repeated, fullScope), { code: 'duplicate-identity' })
})

test('path allocation detects case, normalization and length collisions', () => {
  const nodes = [
    { repo: 'r', id: 'one', path: 'a/one.md', title: 'Résumé', extension: 'md' },
    // The same title in decomposed form: one name to a normalization-insensitive file system.
    { repo: 'r', id: 'two', path: 'A/two.md', title: 'Re\u0301sume\u0301', extension: 'md' },
  ]
  const { section } = allocateViewPaths({ nodes })
  // Folders mirror the source, spelled the way they were first allocated; names are NFC.
  assert.deepEqual(section.entries.map((entry) => entry.path), ['r/a/Résumé.md', 'r/a/Résumé (two).md'])
  for (const entry of section.entries) assert.equal(entry.path.normalize('NFC'), entry.path)

  // Names a case-insensitive or normalization-insensitive filesystem would merge share a key.
  assert.equal(collisionKey('r/Straße.md'), collisionKey('r/STRASSE.md'))
  assert.equal(collisionKey('r/Re\u0301sume\u0301.md'), collisionKey('r/RÉSUMÉ.md'))
  assert.notEqual(collisionKey(section.entries[0].path), collisionKey(section.entries[1].path))
  // Published paths that give one path to two identities, or spell one folder two ways, refuse.
  const stolen = { ...section, entries: [section.entries[0], { repoId: 'r', nodeId: 'two', path: 'r/a/RÉSUMÉ.md' }] }
  assert.throws(() => allocateViewPaths({ published: stolen, nodes }), { code: 'path-collision' })
  const twoSpellings = { ...section, entries: [section.entries[0], { repoId: 'r', nodeId: 'two', path: 'r/A/Other.md' }] }
  assert.throws(() => allocateViewPaths({ published: twoSpellings, nodes }), { code: 'invalid-path-registry' })

  // A long title is cut to 150 bytes on a character boundary.
  const long = allocateViewPaths({ nodes: [{ repo: 'r', id: 'long', path: 'long.md', title: '語'.repeat(120), extension: 'md' }] })
  assert.equal(long.section.entries[0].path, `r/${'語'.repeat(50)}.md`)
  // A path over the full-path bound is shortened by cutting the title, never below 16 bytes; a vault root that leaves
  // no room for any name refuses the view.
  const title = 'x'.repeat(150)
  const fitted = allocateViewPaths({ nodes: [{ repo: 'r', id: 'fit', path: 'a/fit.md', title, extension: 'md' }], vaultRootBytes: 1024 - 1 - 'r/a/.md'.length - 40 })
  assert.equal(fitted.section.entries[0].path, `r/a/${'x'.repeat(40)}.md`)
  assert.throws(() => allocateViewPaths({ nodes, vaultRootBytes: 1010 }), { code: 'path-too-long' })
  assert.throws(() => allocateViewPaths({ nodes: [nodes[0], nodes[0]] }), { code: 'duplicate-identity' })
})

// ---------------------------------------------------------------------------
// Byte fidelity
// ---------------------------------------------------------------------------

test('CRLF, byte order prefix, missing final newline and non-ASCII sources are preserved byte-exactly', (t) => {
  const prepared = prepare(makeWorkspace(t), fullScope)
  assertAuthoredBytesPreserved(prepared)

  // The identity lines close the source's own front matter, in its line ending; the rest of it is byte for byte the source's.
  const crlf = noteOf(prepared, 'north-desk:shared-a')
  const crlfSource = original('north-desk', 'plans/shared-a.md')
  const crlfBytes = noteBytes(prepared, crlf.nodeId)
  assert.ok(crlfSource.includes('\r\n') && !crlfSource.toString('latin1').replace(/\r\n/g, '').includes('\n'))
  const sourceFrontmatter = readMarkdownLens(crlfSource).frontmatter
  const identityBytes = Buffer.from(identityLineTexts({ id: 'north-desk:shared-a', repo: 'north-desk', path: 'plans/shared-a.md' }).map((line) => `${line}\r\n`).join(''))
  assert.deepEqual(crlf.regions.frontmatter, { start: 0, end: sourceFrontmatter.end + identityBytes.length })
  assert.deepEqual(crlfBytes.subarray(crlf.regions.identity.start, crlf.regions.identity.end), identityBytes)
  assert.deepEqual(crlfBytes.subarray(crlf.regions.identity.end, crlf.regions.frontmatter.end), Buffer.from('---\r\n'))
  assert.deepEqual(Buffer.concat([crlfBytes.subarray(0, crlf.regions.identity.start), crlfBytes.subarray(crlf.regions.identity.end, crlf.regions.frontmatter.end)]), crlfSource.subarray(0, sourceFrontmatter.end))
  assert.equal(crlf.ext[EXT].source.finalNewline, 'crlf')

  // A source with a byte order prefix and no front matter gets a generated front matter after the prefix.
  const prefixed = noteOf(prepared, 'north-desk:journal-signal-log')
  const prefixedSource = original('north-desk', 'journal/signal-log.md')
  const generatedFrontmatter = `---\n${identityLineTexts({ id: 'north-desk:journal-signal-log', repo: 'north-desk', path: 'journal/signal-log.md' }).map((line) => `${line}\n`).join('')}---\n`
  assert.deepEqual(prefixed.ext[EXT].source.bom, { start: 0, end: 3 })
  assert.deepEqual(prefixed.regions.identity, { start: 3, end: 3 + generatedFrontmatter.length })
  assert.deepEqual(prefixed.regions.frontmatter, prefixed.regions.identity)
  assert.deepEqual(prefixed.regions.body, { start: 3 + generatedFrontmatter.length, end: prefixedSource.length + generatedFrontmatter.length })
  assert.deepEqual(noteBytes(prepared, prefixed.nodeId), Buffer.concat([prefixedSource.subarray(0, 3), Buffer.from(generatedFrontmatter), prefixedSource.subarray(3)]))

  const unterminated = noteOf(prepared, 'north-desk:shared-b')
  const unterminatedSource = original('north-desk', 'plans/shared-b.md')
  const identityLength = unterminated.regions.identity.end - unterminated.regions.identity.start
  assert.equal(unterminated.ext[EXT].source.finalNewline, 'none')
  assert.equal(unterminated.regions.body.end, unterminatedSource.length + identityLength)
  assert.deepEqual(invertNote(prepared, unterminated.nodeId), unterminatedSource)
  assert.equal(unterminated.regions.generated[0].range.start, unterminated.regions.body.end)

  // Regions tile each note exactly: nothing unaccounted for, nothing shared. The identity lies inside the front matter.
  for (const note of prepared.manifest.notes) {
    assert.ok(note.regions.identity.start >= note.regions.frontmatter.start && note.regions.identity.end <= note.regions.frontmatter.end, `${note.nodeId}: the identity is inside the front matter`)
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
  // A rewritten target is the full vault path: a wikilink keeps `.md`, a Markdown link is percent-encoded per segment.
  assert.equal(noteOf(prepared, 'south-desk:tide-table').path, 'south-desk/tables/Tide table.md')
  assert.ok(plan.includes('[tide table](south-desk/tables/Tide%20table.md#spring)'))
  assert.ok(plan.includes('[[south-desk/tables/Tide table.md|Tide table]] or [[south-desk/tables/Tide table.md#Spring|spring tides]]'))
  assert.ok(plan.includes('[depth chart](north-desk/charts/depth-chart.pdf.md)'))

  // Code, unresolved, external and withheld targets are byte-identical.
  for (const untouched of ['[ledger](../sealed/ledger.md)', '[gone](missing.md)', '[site](https://example.invalid/page.md)', '`[[Tide table]]` in inline code', '```\n[fenced](../../south-desk/tables/tide-table.md)\n[[Tide table]]\n```']) {
    assert.ok(plan.includes(untouched), `${untouched} was altered`)
  }
  assert.ok(noteBytes(prepared, 'south-desk:tide-table').toString('utf8').includes('![[north-desk/plans/Harbor plan.md]]'))

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
  const plan = noteBytes(prepared, 'north-desk:harbor-plan').toString('utf8')
  const section = plan.slice(plan.indexOf('## Relations (generated)'))
  assert.ok(section.includes('- supports → [[south-desk/tables/Tide table.md|Tide table]]\n'))
  assert.ok(section.includes('- depends_on → [[north-desk/plans/Shared concept.md|Shared concept]]\n'))
  assert.ok(section.includes('- links_to → [[north-desk/charts/depth-chart.pdf.md|Depth chart]]\n'))
  assert.ok(section.includes('- evidences ← Depth chart\n'))
  assert.equal(section.includes('related'), false, 'a relation to a withheld node was listed')
  const sharedA = noteBytes(prepared, 'north-desk:shared-a').toString('utf8')
  assert.ok(sharedA.includes('- contradicts ← Shared concept\n'))

  const wrapper = noteBytes(prepared, 'north-desk:depth-chart').toString('utf8')
  assert.ok(wrapper.startsWith(`---\n${identityLineTexts({ id: 'north-desk:depth-chart', repo: 'north-desk', path: 'charts/depth-chart.pdf' }).join('\n')}\n---\n# Depth chart\n`))
  assert.ok(wrapper.includes('with \\[\\[brackets\\]\\] and a \\#tag'))
  assert.ok(wrapper.includes('- Original: [[north-desk/charts/depth-chart.pdf|Open the original file]]\n'))
  assert.ok(wrapper.includes('![[north-desk/charts/depth-chart.pdf]]'))
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

// ---------------------------------------------------------------------------
// Embedded assets. A second invented workspace, written per test, so the
// goldens above stay as they are. `spec.files` maps a workspace-relative path
// to text or bytes; `spec.assetEligible` is the fail-closed asset predicate.
// ---------------------------------------------------------------------------

const ASSET_REPOS = ['east-desk', 'west-desk']
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>\n')
const doc = (id, title, body) => `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n${body}`
const LOGBOOK_BODY = [
  '# Logbook — café',
  '',
  'Gauge ![gauge](img/gauge.png) then spaced ![two words](img/two%20words.png#crop) then far ![swell](../../west-desk/charts/swell.svg).',
  '',
  'Wiki ![[pages/img/gauge.png|200]] and ![[west-desk/charts/swell.svg]] and bare ![[buoy.gif|120x80]] beside [[Signal sheet]] and [sheet](signal.md).',
  '',
  'Sealed ![sealed](img/sealed.png) and ![[sealed.png]] stay as written.',
  '',
  '```',
  '![fenced](img/gauge.png)',
  '```',
  '',
].join('\n')
const assetFiles = () => ({
  'east-desk/pages/logbook.md': doc('east-desk:logbook', 'Logbook', LOGBOOK_BODY),
  'east-desk/pages/signal.md': doc('east-desk:signal', 'Signal sheet', '# Signal sheet\n\nAgain ![gauge](img/gauge.png).\n'),
  'east-desk/pages/img/gauge.png': PNG,
  'east-desk/pages/img/two words.png': Buffer.concat([PNG, Buffer.from([1])]),
  'east-desk/pages/img/sealed.png': Buffer.from('ZQXSEALEDASSET'),
  'east-desk/pool/buoy.gif': Buffer.from('GIF89a'),
  'west-desk/charts/swell.svg': SVG,
  'west-desk/notes/swell.md': doc('west-desk:swell', 'Swell notes', '# Swell notes\n'),
})
const assetProfile = { ...profile, workspaceId: 'ws-synthetic-0003', repositories: ASSET_REPOS.map((repoId) => ({ repoId, root: `repos/${repoId}`, enrollment: 'enrolled' })) }
const sealedAsset = (asset) => asset.path !== 'pages/img/sealed.png'

function makeAssetSnapshot(t, { files = assetFiles(), assetEligible = sealedAsset, graphEligible = sealedAsset } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-materialize-assets-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
    fs.writeFileSync(path.join(dir, relative), contents)
  }
  for (const name of ASSET_REPOS) fs.mkdirSync(path.join(dir, name, '.git'), { recursive: true })
  writeJson(path.join(dir, 'atelier.project.json'), {
    schema: 'mnstry.atelier-project-config@v1',
    name: 'asset-fixture',
    roots: { workspace: '.', repoOps: '.' },
    graph: { repoAccessPath: 'repo-access.v1.json', outputPath: 'atelier-output/knowledge.graph.json' },
    projection: { outputRoot: 'atelier-output', readinessPath: 'atelier-output/atelier-readiness.json' },
    repos: ASSET_REPOS.map((name) => ({ name, path: name, readBoundary: 'team' })),
  })
  writeJson(path.join(dir, 'repo-access.v1.json'), {
    schema: 'mnstry.atelier-repo-access@v1',
    defaultReadBoundary: 'team',
    repos: Object.fromEntries(ASSET_REPOS.map((name) => [name, { readBoundary: 'team' }])),
  })
  const canonical = buildCanonicalGraph(resolveProjectConfig({ argv: [`--project=${path.join(dir, 'atelier.project.json')}`], cwd: dir }), {
    isAssetEligible: ({ path: relative }) => graphEligible({ path: relative }),
  })
  assert.equal(canonical.ok, true, canonical.errors.join('\n'))
  const graph = withEligibility(canonical, () => true, assetEligible)
  const read = (repoId, relative) => fs.readFileSync(path.join(dir, repoId, relative))
  const pinned = [...graph.nodes, ...graph.assets]
  const snapshot = snapshotFor(graph, read)
  snapshot.document.workspaceId = assetProfile.workspaceId
  snapshot.document.repositories = ASSET_REPOS.map((repoId) => ({
    repoId,
    head: null,
    dirty: true,
    files: pinned.filter((item) => item.repo === repoId).map((item) => ({ path: item.path, rawDigest: sha256Digest(read(repoId, item.path)), byteLength: read(repoId, item.path).length })),
  }))
  return snapshot
}

const assetScope = { ...fullScope, scopeId: 'scope-assets' }
const prepareAssets = (snapshot, scope = assetScope, extra = {}) => prepareView({ snapshot, profile: assetProfile, scope, clock, ...extra })
// An embedded file is copied to its own path, mirrored under its repository's folder, under its own name.
const assetName = (repoId, relative) => `${repoId}/${relative}`
const everyOutput = (prepared) => [prepared.files.map((file) => [file.path, file.kind, file.bytes.toString('hex')]), prepared.manifestBytes.toString('utf8'), prepared.diagnostics]

function assertAssetsEmitted(prepared) {
  const gauge = assetName('east-desk', 'pages/img/gauge.png')
  const spaced = assetName('east-desk', 'pages/img/two words.png')
  const buoy = assetName('east-desk', 'pool/buoy.gif')
  const swell = assetName('west-desk', 'charts/swell.svg')
  // One copy per asset: the gauge is embedded three times, from two notes.
  assert.deepEqual(prepared.manifest.attachments, [
    { path: buoy, digest: sha256Digest(Buffer.from('GIF89a')), byteLength: 6, ext: { [EXT]: { kind: 'embedded-asset', repoId: 'east-desk', assetPath: 'pool/buoy.gif' } } },
    { path: gauge, digest: sha256Digest(PNG), byteLength: PNG.length, ext: { [EXT]: { kind: 'embedded-asset', repoId: 'east-desk', assetPath: 'pages/img/gauge.png' } } },
    { path: swell, digest: sha256Digest(SVG), byteLength: SVG.length, ext: { [EXT]: { kind: 'embedded-asset', repoId: 'west-desk', assetPath: 'charts/swell.svg' } } },
    { path: spaced, digest: sha256Digest(Buffer.concat([PNG, Buffer.from([1])])), byteLength: PNG.length + 1, ext: { [EXT]: { kind: 'embedded-asset', repoId: 'east-desk', assetPath: 'pages/img/two words.png' } } },
  ].sort((left, right) => (left.path < right.path ? -1 : 1)))
  assert.deepEqual(prepared.files.filter((file) => file.kind === 'attachment').map((file) => file.path), prepared.manifest.attachments.map((item) => item.path))
  assert.deepEqual(fileOf(prepared, gauge).bytes, PNG)
  assert.deepEqual(fileOf(prepared, swell).bytes, SVG)

  const logbook = noteBytes(prepared, 'east-desk:logbook').toString('utf8')
  const encoded = (attachment) => attachment.split('/').map(encodeURIComponent).join('/')
  assert.ok(logbook.includes(`Gauge ![gauge](${gauge}) then spaced ![two words](${encoded(spaced)}#crop) then far ![swell](${swell}).`))
  assert.ok(encoded(spaced).endsWith('/two%20words.png'))
  assert.ok(logbook.includes(`Wiki ![[${gauge}|200]] and ![[${swell}]] and bare ![[${buoy}|120x80]] beside [[`))
  // A withheld asset and an embed inside code keep their authored bytes.
  assert.ok(logbook.includes('Sealed ![sealed](img/sealed.png) and ![[sealed.png]] stay as written.'))
  assert.ok(logbook.includes('```\n![fenced](img/gauge.png)\n```'))

  const embeds = noteOf(prepared, 'east-desk:logbook').ext[EXT].assetEmbeds
  assert.deepEqual(embeds.map((item) => [item.attachment, item.inversions.length]), [[buoy, 1], [gauge, 2], [swell, 2], [spaced, 1]].sort((left, right) => (left[0] < right[0] ? -1 : 1)))
  assert.deepEqual(Object.keys(embeds[0].inversions[0]), ['source', 'note', 'ext'])
  assert.deepEqual(noteOf(prepared, 'east-desk:signal').ext[EXT].assetEmbeds.map((item) => item.attachment), [gauge])
  assert.equal(noteOf(prepared, 'west-desk:swell').ext[EXT].assetEmbeds, undefined)
  assert.deepEqual(validateObsidianContract('generation-manifest', JSON.parse(prepared.manifestBytes.toString('utf8'))), [])
}

// A note with links and asset embeds inverts to the pinned source digest.
function assertInvertsToSourceDigest(prepared, snapshot, nodeId, invert = invertNote) {
  const note = noteOf(prepared, nodeId)
  const pinned = snapshot.document.repositories.find((repo) => repo.repoId === note.repoId).files.find((file) => file.path === note.ext[EXT].source.path)
  assert.equal(sha256Digest(invert(prepared, nodeId)), pinned.rawDigest)
}

test('embedded assets are copied once, rewritten through the inversion map and invert exactly', (t) => {
  const snapshot = makeAssetSnapshot(t)
  const prepared = prepareAssets(snapshot)
  assertAssetsEmitted(prepared)
  const logbook = noteOf(prepared, 'east-desk:logbook')
  assert.ok(prepared.manifest.links.some((link) => link.sourceNodeId === logbook.nodeId && (link.inversions ?? []).length > 0), 'fixture no longer mixes links and asset embeds')
  for (const nodeId of ['east-desk:logbook', 'east-desk:signal', 'west-desk:swell']) assertInvertsToSourceDigest(prepared, snapshot, nodeId)

  // Mutation controls: an inversion that forgets asset embeds, a second copy
  // of one asset and a rewritten size tail each fail.
  const linksOnly = (view, nodeId) => invertNote({ ...view, manifest: { ...view.manifest, notes: view.manifest.notes.map((note) => ({ ...note, ext: { [EXT]: { source: note.ext[EXT].source } } })) } }, nodeId)
  assert.throws(() => assertInvertsToSourceDigest(prepared, snapshot, 'east-desk:logbook', linksOnly), assert.AssertionError)
  const twice = { ...prepared, manifest: { ...prepared.manifest, attachments: [...prepared.manifest.attachments, { ...prepared.manifest.attachments[0], path: 'attachments/copy.gif' }] } }
  assert.throws(() => assertAssetsEmitted(twice), assert.AssertionError)
  const aliased = mutateNotes(prepared, (bytes) => Buffer.from(bytes.toString('utf8').replace('.gif|120x80]]', '.gif|120x80|buoy.gif]]')))
  assert.throws(() => assertAssetsEmitted(aliased), assert.AssertionError)
})

test('asset preparation is deterministic: two runs are byte-identical', (t) => {
  const [first, second] = [prepareAssets(makeAssetSnapshot(t)), prepareAssets(makeAssetSnapshot(t))]
  const assertSame = (left, right) => assert.deepEqual(everyOutput(left), everyOutput(right))
  assertSame(first, second)
  assert.throws(() => assertSame(first, mutateNotes(second, (bytes) => Buffer.concat([bytes, Buffer.from('\n')]))), assert.AssertionError)
})

test('a withheld asset leaves exactly what a deleted asset leaves, at the graph and at the emitter', (t) => {
  const { 'east-desk/pages/img/sealed.png': removed, ...withoutSealed } = assetFiles()
  assert.ok(removed)
  const deleted = prepareAssets(makeAssetSnapshot(t, { files: withoutSealed }))
  const assertSameAsDeleted = (prepared) => assert.deepEqual(everyOutput(prepared), everyOutput(deleted))
  // Withheld by the graph predicate: the graph never reports it.
  assertSameAsDeleted(prepareAssets(makeAssetSnapshot(t)))
  // Reported by the graph, withheld only by the fail-closed flag.
  const flagged = makeAssetSnapshot(t, { graphEligible: () => true })
  assert.ok(flagged.graph.assets.some((asset) => asset.path === 'pages/img/sealed.png' && asset.eligible === false))
  assertSameAsDeleted(prepareAssets(flagged))
  // No second predicate at all withholds every asset.
  const unflagged = makeAssetSnapshot(t)
  const none = prepareAssets({ ...unflagged, graph: withEligibility(unflagged.graph, () => true) })
  assert.deepEqual(none.manifest.attachments, [])
  assert.ok(noteBytes(none, 'east-desk:logbook').toString('utf8').includes('Gauge ![gauge](img/gauge.png) then spaced ![two words](img/two%20words.png#crop) then far ![swell](../../west-desk/charts/swell.svg).'))
  assertInvertsToSourceDigest(none, unflagged, 'east-desk:logbook')
  // Anything but exactly true is withheld.
  const truthy = prepareAssets({ ...unflagged, graph: { ...unflagged.graph, assets: unflagged.graph.assets.map((asset) => ({ ...asset, eligible: 'true' })) } })
  assert.deepEqual(truthy.manifest.attachments, [])

  // Mutation control: an eligible sealed asset is emitted, so the comparison fails.
  const open = prepareAssets(makeAssetSnapshot(t, { graphEligible: () => true, assetEligible: () => true }))
  assert.ok(open.manifest.attachments.some((item) => item.ext[EXT].assetPath === 'pages/img/sealed.png'))
  assert.throws(() => assertSameAsDeleted(open), assert.AssertionError)
})

test('an asset embedded only from outside the view, or from a repository the profile does not enrol, leaves nothing', (t) => {
  const snapshot = makeAssetSnapshot(t)
  const assertNoAssetTrace = (prepared) => {
    assert.deepEqual(prepared.manifest.attachments, [])
    const everything = JSON.stringify(everyOutput(prepared))
    for (const trace of ['attachments/', 'embedded-asset', 'assetEmbeds', identitySuffix('east-desk', 'east-desk:asset:pages/img/gauge.png')]) assert.equal(everything.includes(trace), false, trace)
  }
  assertNoAssetTrace(prepareAssets(snapshot, { ...scopedScope, scopeId: 'scope-swell', selector: { ids: ['west-desk:swell'] } }))
  // Mutation control: the full view does carry them.
  assert.throws(() => assertNoAssetTrace(prepareAssets(snapshot)), assert.AssertionError)

  // A paused repository's asset stays as authored inside a visible note.
  const paused = { ...assetProfile, repositories: assetProfile.repositories.map((repo) => (repo.repoId === 'west-desk' ? { ...repo, enrollment: 'paused' } : repo)) }
  const prepared = prepareView({ snapshot, profile: paused, scope: assetScope, clock })
  assert.deepEqual(prepared.manifest.attachments.map((item) => item.ext[EXT].repoId), ['east-desk', 'east-desk', 'east-desk'])
  const logbook = noteBytes(prepared, 'east-desk:logbook').toString('utf8')
  assert.ok(logbook.includes('![swell](../../west-desk/charts/swell.svg)') && logbook.includes('![[west-desk/charts/swell.svg]]'))
  assertInvertsToSourceDigest(prepared, snapshot, 'east-desk:logbook')
})

test('an emitted asset is read through the pinned snapshot: unpinned refuses, drifted bytes refuse', (t) => {
  const snapshot = makeAssetSnapshot(t)
  const unpinned = { ...snapshot, document: { ...snapshot.document, repositories: snapshot.document.repositories.map((repo) => ({ ...repo, files: repo.files.filter((file) => file.path !== 'pool/buoy.gif') })) } }
  assert.throws(() => prepareAssets(unpinned), { code: 'source-not-in-snapshot' })
  const drifted = { ...snapshot, readSource: (repoId, relative) => (relative === 'pool/buoy.gif' ? Buffer.from('GIF87a') : snapshot.readSource(repoId, relative)) }
  assert.throws(() => prepareAssets(drifted), { code: 'mixed-read' })
  // A withheld asset is never read, pinned or not.
  const reads = []
  prepareAssets({ ...snapshot, readSource: (repoId, relative) => (reads.push(relative), snapshot.readSource(repoId, relative)) })
  assert.ok(reads.includes('pool/buoy.gif') && !reads.includes('pages/img/sealed.png'))
  // An embed moved off the bytes the graph read refuses instead of rewriting.
  const moved = { ...snapshot, graph: { ...snapshot.graph, embeds: snapshot.graph.embeds.map((embed, index) => (index === 0 ? { ...embed, href: 'img/other.png' } : embed)) } }
  assert.throws(() => prepareAssets(moved), { code: 'mixed-read' })
  const overlapping = { ...snapshot, graph: { ...snapshot.graph, embeds: [...snapshot.graph.embeds, snapshot.graph.embeds[0]] } }
  assert.throws(() => prepareAssets(overlapping), { code: 'link-overlap' })
})

// ---------------------------------------------------------------------------
// An authored body that ends inside a fenced code block
// ---------------------------------------------------------------------------

const FRONT = '---\ntitle: "Fenced page"\nkg:\n  id: "east-desk:fenced"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n'
const FENCE_CASES = [
  { name: 'backtick fence', source: `${FRONT}See [sheet](signal.md).\n\n\`\`\`js\nlet depth = 4\n`, closure: '```\n', fence: '```' },
  { name: 'tilde fence', source: `${FRONT}See [sheet](signal.md).\n\n~~~\ncode\n`, closure: '~~~\n', fence: '~~~' },
  { name: 'longer fence holding a shorter one', source: `${FRONT}See [sheet](signal.md).\n\n\`\`\`\`\`\n\`\`\`\ninner\n\`\`\`\n`, closure: '`````\n', fence: '`````' },
  { name: 'CRLF source', source: `${FRONT}See [sheet](signal.md).\n\n~~~~\ncode\n`.replace(/\n/g, '\r\n'), closure: '~~~~\r\n', fence: '~~~~' },
  { name: 'body not ending in a line break', source: `${FRONT}See [sheet](signal.md).\n\n\`\`\`\ncode`, closure: '\n```\n', fence: '```' },
  { name: 'CRLF body not ending in a line break', source: `${FRONT}See [sheet](signal.md).\n\n\`\`\`\ncode`.replace(/\n/g, '\r\n'), closure: '\r\n```\r\n', fence: '```' },
  { name: 'indented opener inside a list item', source: `${FRONT}See [sheet](signal.md).\n\n- step\n\n  \`\`\`\n  code\n`, closure: '  ```\n', fence: '  ```' },
  { name: 'no front matter', nodeId: 'east-desk:pages-fenced', source: 'See [sheet](signal.md).\n\n```\ncode\n', closure: '```\n', fence: '```' },
  { name: 'fence-like line inside front matter', source: `${FRONT.replace('kg:', 'sample: |\n  ~~~~~\nkg:')}See [sheet](signal.md).\n\n\`\`\`\ncode\n`, closure: '```\n', fence: '```', anyNode: true },
]

function fencedSnapshot(t, source) {
  return makeAssetSnapshot(t, {
    files: {
      'east-desk/pages/fenced.md': source,
      'east-desk/pages/signal.md': doc('east-desk:signal', 'Signal sheet', '# Signal sheet\n'),
      'east-desk/pages/alone.md': doc('east-desk:alone', 'Alone', '# Alone\n\n```\nnever closed\n'),
      'west-desk/notes/swell.md': doc('west-desk:swell', 'Swell notes', '# Swell notes\n'),
    },
  })
}

function assertFenceClosed(prepared, snapshot, nodeId, { closure, fence }) {
  const note = noteOf(prepared, nodeId)
  const bytes = fileOf(prepared, note.path).bytes
  const [first, ...rest] = note.regions.generated
  assert.deepEqual(first.ext, { [EXT]: { fenceClosure: { fence, byteLength: Buffer.byteLength(closure) } } })
  for (const region of rest) assert.equal(region.ext, undefined)
  // The closing fence is the first bytes of the first generated region, directly after the authored body.
  assert.equal(first.range.start, note.regions.body.end)
  assert.deepEqual(bytes.subarray(first.range.start, first.range.start + Buffer.byteLength(closure)), Buffer.from(closure))
  // By the scanner's own rules the note no longer ends in code, and the generated relation is a live link.
  const text = bytes.toString('utf8')
  assert.equal(unclosedFenceAtEnd(text), null)
  const generatedLinks = scanMarkdownLinks(text).filter((item) => item.range.start >= text.indexOf('## Relations (generated)'))
  assert.ok(text.includes('## Relations (generated)') && generatedLinks.length > 0, 'the generated section was swallowed by the fence')
  assert.ok(prepared.diagnostics.includes('unclosed-code-fence-closed-in-generated-region'))
  assertInvertsToSourceDigest(prepared, snapshot, nodeId)
}

test('an unclosed code fence at the end of a source is closed inside the first generated region', async (t) => {
  for (const item of FENCE_CASES) {
    await t.test(item.name, (t) => {
      const snapshot = fencedSnapshot(t, item.source)
      const prepared = prepareAssets(snapshot)
      const nodeId = item.anyNode ? snapshot.graph.nodes.find((node) => node.path === 'pages/fenced.md').id : item.nodeId ?? 'east-desk:fenced'
      assertFenceClosed(prepared, snapshot, nodeId, item)
      // Authored bytes before the generated region are the source, link rewrite aside.
      assert.deepEqual(validateObsidianContract('generation-manifest', JSON.parse(prepared.manifestBytes.toString('utf8'))), [])

      // No generated section follows the lone note: nothing is emitted for it.
      const alone = noteOf(prepared, 'east-desk:alone')
      assert.deepEqual(alone.regions.generated, [])
      assert.deepEqual(invertNote(prepared, 'east-desk:alone'), snapshot.readSource('east-desk', 'pages/alone.md'))
      assert.equal(alone.regions.body.end, fileOf(prepared, alone.path).bytes.length, 'the lone note ends with its authored body')
    })
  }
})

test('a closed fence changes nothing, and a lone unclosed fence yields no closure and no diagnostic', (t) => {
  const closed = fencedSnapshot(t, `${FRONT}See [sheet](signal.md).\n\n\`\`\`\ncode\n\`\`\`\n`)
  const prepared = prepareAssets(closed)
  const note = noteOf(prepared, 'east-desk:fenced')
  assert.deepEqual(note.regions.generated.map((region) => [region.kind, region.ext]), [['relations', undefined]])
  assert.ok(noteBytes(prepared, note.nodeId).toString('utf8').includes('code\n```\n\n## Relations (generated)'))
  assert.deepEqual(prepared.diagnostics, [])
  assertInvertsToSourceDigest(prepared, closed, note.nodeId)

  // Only the lone note ends in a fence, and nothing generated follows it.
  const lone = prepareAssets(closed, { ...scopedScope, scopeId: 'scope-alone', selector: { ids: ['east-desk:alone'] } })
  assert.deepEqual(noteOf(lone, 'east-desk:alone').regions.generated, [])
  assert.equal(lone.diagnostics.includes('unclosed-code-fence-closed-in-generated-region'), false)
  assert.equal(JSON.stringify(lone.manifest).includes('fenceClosure'), false)
})

test('mutation control: a missing, misplaced or mismatched closing fence fails the fence oracle', (t) => {
  const item = FENCE_CASES[0]
  const snapshot = fencedSnapshot(t, item.source)
  const prepared = prepareAssets(snapshot)
  const target = noteOf(prepared, 'east-desk:fenced')
  const start = target.regions.generated[0].range.start
  const rewrite = (transform) => mutateNotes(prepared, (bytes, file) => (file.path === target.path ? transform(bytes) : bytes))
  // The fence removed: the heading is code again.
  const swallowed = rewrite((bytes) => Buffer.concat([bytes.subarray(0, start), Buffer.from('   \n'), bytes.subarray(start + 4)]))
  assert.throws(() => assertFenceClosed(swallowed, snapshot, target.nodeId, item), assert.AssertionError)
  // A tilde run does not close a backtick fence.
  const mismatched = rewrite((bytes) => Buffer.concat([bytes.subarray(0, start), Buffer.from('~~~\n'), bytes.subarray(start + 4)]))
  assert.throws(() => assertFenceClosed(mismatched, snapshot, target.nodeId, item), assert.AssertionError)
  // A closure recorded on the region but claimed as authored bytes breaks inversion.
  const claimed = { ...prepared, manifest: { ...prepared.manifest, notes: prepared.manifest.notes.map((note) => (note.nodeId === target.nodeId ? { ...note, regions: { ...note.regions, body: { ...note.regions.body, end: start + 4 } } } : note)) } }
  assert.throws(() => assertFenceClosed(claimed, snapshot, target.nodeId, item), assert.AssertionError)
  // A diagnostic that is dropped fails too.
  assert.throws(() => assertFenceClosed({ ...prepared, diagnostics: [] }, snapshot, target.nodeId, item), assert.AssertionError)
})

// Review finding (brokered review of the merged range): the redaction guard must not
// mistake an author's own hex-suffixed names for allocated identities.
function makeWorkspaceVariant(t, extraFiles) {
  const saved = workspace.files
  workspace.files = { ...saved, ...extraFiles }
  try { return makeWorkspace(t) } finally { workspace.files = saved }
}

test('author text that merely looks like an identity suffix is not a redaction failure', (t) => {
  const asset = 'north-desk/assets/app--0f1e2d3c4b5a.css'
  const snapshot = makeWorkspaceVariant(t, {
    [asset]: { text: 'body { color: teal }\n' },
    [`${asset}.kg.json`]: { text: JSON.stringify({ schema: 'mnstry.source-sidecar@v1', asset: 'app--0f1e2d3c4b5a.css', title: 'Build asset--0f1e2d3c4b5a', summary: 'Invented content-hashed asset.', tags: ['build--0f1e2d3c4b5a'],
      kg: { id: 'north-desk:build-asset', type: 'evidence', domain: 'sample', lifecycle: 'source', status: 'active', audience: 'team', relations: { evidences: ['north-desk:harbor-plan'] } } }) },
  })
  const prepared = prepare(snapshot, fullScope)
  const wrapper = prepared.manifest.notes.find((note) => note.ext[EXT].source.path === 'assets/app--0f1e2d3c4b5a.css')
  assert.ok(wrapper, 'the asset has a wrapper note in the full view')
  assert.ok(fileOf(prepared, wrapper.path).bytes.toString('utf8').includes('app--0f1e2d3c4b5a'), 'the author name is shown as written')
  assertNothingWithheld(prepared)
})

// A note that relates to the harbor plan, so its title reaches the plan's generated relation rows.
const relatedNote = (id, title) => ({ text: `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n  relations:\n    supports:\n      - "north-desk:harbor-plan"\n---\n\n# Related\n\nBody.\n` })

test('generated text that names a census identity outside the view is still refused', (t) => {
  // An author title that carries the withheld node's canonical identity, or its
  // repository-qualified source path, reaches the relation rows of the notes
  // it relates to, and the guard refuses it: this is the mutation the benign
  // cases around it must not have disabled.
  for (const title of ['Names north-desk:sealed-ledger', 'Replaces north-desk:sealed-ledger.', 'See north-desk/sealed/ledger.md first', 'See sealed/ledger.md']) {
    const snapshot = makeWorkspaceVariant(t, { 'north-desk/notes/naming.md': relatedNote('north-desk:naming', title) })
    assert.throws(() => prepare(snapshot, fullScope), /redaction-failure/, title)
  }
  // A whole token only: the identity inside a longer word is not the identity.
  for (const title of ['Names xnorth-desk:sealed-ledger', 'Names north-desk:sealed-ledgers', 'Names north-desk:sealed-ledger.v2', 'See sealed/ledger.mdx']) {
    const snapshot = makeWorkspaceVariant(t, { 'north-desk/notes/naming.md': relatedNote('north-desk:naming', title) })
    assert.ok(prepare(snapshot, fullScope).manifest.notes.some((note) => note.nodeId === 'north-desk:naming'), title)
  }
  // In layout 1 the identity suffix of a withheld node is refused as well, as the earlier release refused it.
  const sealed = identitySuffix('north-desk', 'north-desk:sealed-ledger', 64)
  const suffixed = makeWorkspaceVariant(t, { 'north-desk/notes/naming.md': relatedNote('north-desk:naming', `Names it--${sealed.slice(0, 12)}`) })
  assert.throws(() => prepare(suffixed, fullScope, { layout: 1 }), /redaction-failure/)
  assert.ok(prepare(suffixed, fullScope).manifest.notes.length > 0, 'a suffix is no identity in layout 2, where no path carries one')
})

test('what an in-view author wrote about a withheld node stays authored and is not a redaction failure', (t) => {
  // The harbor plan's front matter relates it to the withheld ledger and its body links to the ledger's path.
  const prepared = prepare(makeWorkspace(t), fullScope)
  const plan = noteBytes(prepared, 'north-desk:harbor-plan').toString('utf8')
  assert.ok(plan.includes('- "north-desk:sealed-ledger"') && plan.includes('[ledger](../sealed/ledger.md)'))
  assertNothingWithheld(prepared)
})

test('a wikilink whose author-chosen words look like an identity suffix is not a redaction failure', (t) => {
  // The rewrite appends `|<what the author wrote>` so the editor shows those words;
  // that tail is the author's, not an emitted path.
  const snapshot = makeWorkspaceVariant(t, {
    'north-desk/notes/weekly--202401151230.md': { text: '---\ntitle: "Weekly"\nkg:\n  id: "north-desk:weekly"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# Weekly\n' },
    'north-desk/notes/log.md': { text: '---\ntitle: "Log"\nkg:\n  id: "north-desk:log"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# Log\n\nSee [[weekly--202401151230]].\n' },
  })
  const prepared = prepare(snapshot, fullScope)
  const log = fileOf(prepared, noteOf(prepared, 'north-desk:log').path).bytes.toString('utf8')
  assert.ok(log.includes('|weekly--202401151230]]'), log)
  assertNothingWithheld(prepared)
})

test('an asset the view does not copy, named in generated text, refuses the view when the audience may not see it and is reported when it may', (t) => {
  // A real asset (id `<repo>:asset:<path>`), not a census node: only the asset
  // branch of the deny-list can catch it, so this is a control for it.
  const swellWithheld = (asset) => sealedAsset(asset) && asset.path !== 'charts/swell.svg'
  const naming = { ...assetScope, scopeId: 'scope-naming', mode: 'scoped', selector: { ids: ['east-desk:naming', 'east-desk:signal'] } }
  for (const named of ['west-desk:asset:charts/swell.svg', 'west-desk/charts/swell.svg']) {
    const files = { ...assetFiles(), 'east-desk/notes/naming.md': doc('east-desk:naming', `Names ${named}`, '# Names it\n').replace('  audience: "team"\n', '  audience: "team"\n  relations:\n    supports:\n      - "east-desk:signal"\n') }
    const snapshot = makeAssetSnapshot(t, { files })
    // The full view copies the swell asset (the logbook embeds it): the title names it there, and that is allowed...
    const full = prepare(snapshot, assetScope, { profile: assetProfile })
    assert.ok(full.manifest.attachments.some((attachment) => attachment.ext[EXT].assetPath === 'charts/swell.svg'))
    // ...a view that does not copy it reports the title, since the audience may see the asset...
    const reported = prepare(snapshot, naming, { profile: assetProfile })
    assert.deepEqual((reported.manifest.ext[EXT].diagnostics ?? []).map((item) => [item.code, item.nodeId]), [['unselected-identity-in-generated-text', 'east-desk:signal']], named)
    // ...and when the audience may not see it, the title refuses the view.
    assert.throws(() => prepare(makeAssetSnapshot(t, { files, assetEligible: swellWithheld }), naming, { profile: assetProfile }), /redaction-failure/, named)
  }
})

test('a census record with an empty repository or identity neither joins a view nor aborts it', (t) => {
  const snapshot = makeWorkspace(t)
  // The snapshot boundary requires string id and repo on a node but not that
  // they are non-empty; asset records are not validated there at all. Each
  // half of the guard is load-bearing: an empty id and an empty repo, on a
  // node and on an asset, must each be skipped exactly as visibleAssets skips them.
  snapshot.graph.nodes.push({ id: 'north-desk:ghost', repo: '', path: 'ghost.md', title: 'Ghost', eligible: false })
  snapshot.graph.assets = [...(snapshot.graph.assets ?? []),
    { id: '', repo: 'north-desk', path: 'ghost.bin', eligible: false },
    { id: 'north-desk:asset:ghost2.bin', repo: '', path: 'ghost2.bin', eligible: false }]
  const prepared = prepare(snapshot, fullScope)
  assert.ok(prepared.manifest.notes.length > 0)
  assertNothingWithheld(prepared)
})

test('a withheld identity that reaches only a relations row (never a path) is still refused', (t) => {
  // A title longer than the name budget is cut in the allocated path, so the
  // withheld identity it carries appears only in the generated relation rows of
  // the notes that relate to it. Only the free-text scan can catch it.
  const title = `${'Long name '.repeat(14)}north-desk:sealed-ledger`
  const snapshot = makeWorkspaceVariant(t, { 'north-desk/notes/long.md': relatedNote('north-desk:long', title) })
  assert.throws(() => prepare(snapshot, fullScope), /redaction-failure/)
  // Control: the same title without the withheld identity prepares, and its path does not carry the title's tail.
  const benign = makeWorkspaceVariant(t, { 'north-desk/notes/long.md': relatedNote('north-desk:long', `${'Long name '.repeat(14)}north-desk:ffffffffffff`) })
  const prepared = prepare(benign, fullScope)
  assert.ok(!noteOf(prepared, 'north-desk:long').path.includes('ffffffffffff'), 'the long title is cut before its tail')
})

// One more withheld source, whose path and identity carry an underscore, a
// character the emitter escapes in generated prose.
const SEALED_UNDERSCORE = {
  'north-desk/sealed/q3_layoffs.md': { text: '---\ntitle: "Q3 plan"\nkg:\n  id: "north-desk:q3_layoffs"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# Q3 plan\n' },
}
function makeWorkspaceWithheld(t, extraFiles, extraWithheld = []) {
  const savedFiles = workspace.files
  const savedWithheld = workspace.withheldByEligibility
  workspace.files = { ...savedFiles, ...SEALED_UNDERSCORE, ...extraFiles }
  workspace.withheldByEligibility = [...savedWithheld, 'north-desk:q3_layoffs', ...extraWithheld]
  try { return makeWorkspace(t) } finally { workspace.files = savedFiles; workspace.withheldByEligibility = savedWithheld }
}
const sidecarWith = (fields) => ({ text: JSON.stringify({ ...JSON.parse(workspace.files['north-desk/charts/depth-chart.pdf.kg.json'].text), ...fields }) })

test('the deny-list reads generated prose as a reader sees it: what the emitter escaped is matched unescaped', (t) => {
  const outcome = (snapshot) => {
    try { prepare(snapshot, fullScope); return 'accepted' } catch (error) { if (error.code === 'redaction-failure') return 'refused'; throw error }
  }
  const outcomes = {}
  for (const named of ['north-desk/sealed/q3_layoffs.md', 'north-desk:q3_layoffs']) {
    // An in-view title, repeated in the incoming relation row of the note it relates to.
    outcomes[`title ${named}`] = outcome(makeWorkspaceWithheld(t, { 'north-desk/notes/naming.md': relatedNote('north-desk:naming', `See ${named}`) }))
    // A wrapped file's summary and tags, repeated in its note.
    outcomes[`summary ${named}`] = outcome(makeWorkspaceWithheld(t, { 'north-desk/charts/depth-chart.pdf.kg.json': sidecarWith({ summary: `Soundings, see ${named} first.` }) }))
    outcomes[`tag ${named}`] = outcome(makeWorkspaceWithheld(t, { 'north-desk/charts/depth-chart.pdf.kg.json': sidecarWith({ tags: ['chart', named] }) }))
  }
  assert.deepEqual(outcomes, Object.fromEntries(Object.keys(outcomes).map((label) => [label, 'refused'])))
  // Controls: the same prose naming nothing outside the view prepares, escaped exactly as before.
  const benign = makeWorkspaceWithheld(t, { 'north-desk/notes/naming.md': relatedNote('north-desk:naming', 'See north-desk/plans/q3_notes.md') })
  const plan = noteBytes(prepare(benign, fullScope), 'north-desk:harbor-plan').toString('utf8')
  assert.ok(plan.includes('- supports ← See north-desk/plans/q3\\_notes.md\n'), plan)
})

test('a title that reaches generated text only in a sanitized form is carried as authored and not matched', (t) => {
  // The note is only ever a relation target, so its title appears only as the alias of other notes' outgoing rows
  // and in its file name, where `:` and `/` are unsafe and become spaces. Atelier generated no reference to the
  // withheld node here; the author's words are carried in that form, and the deny-list, which is defence in depth
  // over author text, does not match a sanitized form (see "What redaction covers").
  const snapshot = makeWorkspaceWithheld(t, {
    'north-desk/notes/target.md': { text: '---\ntitle: "About north-desk:q3_layoffs"\nkg:\n  id: "north-desk:target"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# About\n' },
    'north-desk/notes/pointer.md': { text: '---\ntitle: "Pointer"\nkg:\n  id: "north-desk:pointer"\n  type: "document"\n  status: "active"\n  audience: "team"\n  relations:\n    supports:\n      - "north-desk:target"\n---\n\n# Pointer\n' },
  })
  const prepared = prepare(snapshot, fullScope)
  const pointer = noteBytes(prepared, 'north-desk:pointer').toString('utf8')
  assert.ok(pointer.includes('|About north-desk q3_layoffs]]\n'), pointer)
  assert.equal(noteOf(prepared, 'north-desk:target').path, 'north-desk/notes/About north-desk q3_layoffs.md')
})

test('the deny matcher answers the strongest class a text holds: a refused value, then a bare one, then an unselected one, compared in NFC', () => {
  const deny = createDenyMatcher({ refuse: ['north-desk:re\u0301sume\u0301'], diagnose: ['harbor'], notice: ['docs/README.md'] })
  assert.equal(deny('update docs/README.md'), 'notice')
  assert.equal(deny('the harbor and docs/README.md'), 'diagnose')
  assert.equal(deny('the harbor and north-desk:r\u00e9sum\u00e9'), 'refuse')
  assert.equal(deny('north-desk:re\u0301sume\u0301'), 'refuse')
  assert.equal(deny('harbors and xdocs/README.md'), null)
})

test('the deny-list refuses unambiguous identifiers of notes outside the view, reports a bare word, and names the in-view note and the rule, never the value', (t) => {
  const refusalOf = (snapshot, scope = fullScope) => { try { prepare(snapshot, scope); return null } catch (error) { if (error.code !== 'redaction-failure') throw error; return error } }
  const doc = (id, title) => ({ text: `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n` })
  const sealed = { 'north-desk/sealed/bare.md': doc('harbor', 'Bare'), 'north-desk/q3_budget.md': doc('north-desk:q3_budget', 'Budget') }
  const withheld = ['harbor', 'north-desk:q3_budget']
  // Refused: a repository-qualified identity, a repository-qualified path, and a repository-relative path with a folder.
  for (const named of ['north-desk:q3_layoffs', 'north-desk/sealed/q3_layoffs.md', 'sealed/q3_layoffs.md', 'north-desk/q3_budget.md']) {
    const error = refusalOf(makeWorkspaceWithheld(t, { ...sealed, 'north-desk/notes/naming.md': relatedNote('north-desk:naming', `See ${named}`) }, withheld))
    assert.ok(error, named)
    assert.deepEqual(error.detail, { rule: 'deny-list', notePath: 'north-desk/plans/Harbor plan.md' }, named)
    assert.equal(/q3_(layoffs|budget)/.test(`${error.message} ${JSON.stringify(error.detail)}`), false, 'the refusal never names the withheld value')
  }
  // Reported, not refused: an identity that is a bare word, and a file name at a repository's root.
  for (const title of ['Lights by the harbor', 'See q3_budget.md']) {
    const bare = makeWorkspaceWithheld(t, { ...sealed, 'north-desk/notes/naming.md': relatedNote('north-desk:naming', title) }, withheld)
    const prepared = prepare(bare, fullScope)
    assert.deepEqual(prepared.manifest.ext[EXT].diagnostics, [{ code: 'bare-identity-in-generated-text', rule: 'deny-list', repoId: 'north-desk', nodeId: 'north-desk:harbor-plan', notePath: 'north-desk/plans/Harbor plan.md' }], title)
  }
  // A value that is also an identifier of a note in the view is no identifier of the one outside it.
  // (The sealed ledger is `north-desk/sealed/ledger.md`; an in-view note of another repository has the same repository-relative path.)
  const shared = makeWorkspaceWithheld(t, { 'north-desk/notes/naming.md': relatedNote('north-desk:naming', 'See sealed/ledger.md'), 'south-desk/sealed/ledger.md': doc('south-desk:ledger', 'Tide ledger') })
  assert.ok(prepare(shared, fullScope).manifest.notes.some((note) => note.nodeId === 'south-desk:ledger'))
})

test('a withheld README.md at a repository root never refuses a view whose notes mention README.md: the file name is reported, in a full or a scoped view', (t) => {
  const doc = (id, title) => ({ text: `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n` })
  const withReadme = (title) => makeWorkspaceWithheld(t, { 'north-desk/README.md': doc('north-desk:readme', 'Read me'), 'north-desk/notes/naming.md': relatedNote('north-desk:naming', title) }, ['north-desk:readme'])
  const snapshot = withReadme('See README.md first')
  const reported = [{ code: 'bare-identity-in-generated-text', rule: 'deny-list', repoId: 'north-desk', nodeId: 'north-desk:harbor-plan', notePath: 'north-desk/plans/Harbor plan.md' }]
  const scoped = { ...scopedScope, scopeId: 'scope-naming', selector: { ids: ['north-desk:harbor-plan', 'north-desk:naming'] } }
  for (const scope of [fullScope, scoped]) {
    const prepared = prepare(snapshot, scope)
    assert.deepEqual(prepared.manifest.ext[EXT].diagnostics, reported, scope.scopeId)
    assert.ok(prepared.manifest.notes.some((note) => note.nodeId === 'north-desk:naming'), scope.scopeId)
  }
  // With its repository, the same file names the withheld note unambiguously.
  assert.throws(() => prepare(withReadme('See north-desk/README.md first'), scoped), /redaction-failure/)
})

test('the deny-list follows the audience: an identifier of a note the audience may see but the view does not select is reported, never refused', (t) => {
  const doc = (id, title) => ({ text: `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n` })
  const files = { 'north-desk/docs/README.md': doc('north-desk:docs-readme', 'Docs'), 'north-desk/notes/naming.md': relatedNote('north-desk:naming', 'Update docs/README.md') }
  const scoped = { ...scopedScope, scopeId: 'scope-naming', selector: { ids: ['north-desk:harbor-plan', 'north-desk:naming'] } }
  // Every view of a workspace has one audience today, so a note outside the selection is no secret from it.
  const visible = makeWorkspaceWithheld(t, files)
  assert.deepEqual(prepare(visible, scoped).manifest.ext[EXT].diagnostics, [{ code: 'unselected-identity-in-generated-text', rule: 'deny-list', repoId: 'north-desk', nodeId: 'north-desk:harbor-plan', notePath: 'north-desk/plans/Harbor plan.md' }])
  assert.equal(prepare(visible, fullScope).manifest.ext[EXT].diagnostics, undefined, 'the full view holds that note')
  // The same text refuses when the audience may not see the note it names.
  assert.throws(() => prepare(makeWorkspaceWithheld(t, files, ['north-desk:docs-readme']), scoped), /redaction-failure/)
})

test('an identity qualified by any repository of the census is unambiguous, whichever repository holds its note', (t) => {
  const doc = (id, title) => ({ text: `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n` })
  const snapshot = makeWorkspaceWithheld(t, { 'north-desk/sealed/cross.md': doc('south-desk:sealed-cross', 'Sealed'), 'north-desk/notes/naming.md': relatedNote('north-desk:naming', 'Follows south-desk:sealed-cross') }, ['south-desk:sealed-cross'])
  assert.throws(() => prepare(snapshot, fullScope), /redaction-failure/)
})

test('a value this view holds names nothing outside it, compared in NFC: an in-view path in NFD beside the same path withheld in NFC', (t) => {
  const doc = (id, title) => ({ text: `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n` })
  const snapshot = makeWorkspaceWithheld(t, {
    'north-desk/Réunions/plan.md': doc('north-desk:reunion-plan', 'Reunion plan'),
    'north-desk/notes/naming.md': relatedNote('north-desk:naming', 'See Réunions/plan.md'),
    'south-desk/Réunions/plan.md': doc('south-desk:reunion-plan', 'Sealed reunion plan'),
  }, ['south-desk:reunion-plan'])
  const prepared = prepare(snapshot, fullScope)
  assert.ok(prepared.manifest.notes.some((note) => note.nodeId === 'north-desk:reunion-plan'))
  assert.equal(prepared.manifest.ext[EXT].diagnostics, undefined)
})

test('an allow-list refusal names the note by its allocated path, or the rule alone, never the path in question', () => {
  const view = { allocatedPathOf: (id) => (id === 'r:in' ? 'r/In.md' : null), attachments: new Set(), linkTargets: new Set(['r/In.md']) }
  const base = { files: [], reused: new Set(), nodeOf: () => ({ id: 'r:in', repo: 'r', path: 'in.md' }), ownOf: () => ({}), view, deny: () => null, layoutVersion: 1 }
  const refusalOf = (manifest) => { try { assertViewRedaction({ ...base, manifest }); return null } catch (error) { return error } }
  const note = (nodeId) => ({ nodeId, path: 'r/sealed/Layoffs Q3 plan.md', regions: { generated: [] }, ext: {} })
  const cases = [
    [{ notes: [], links: [], attachments: [{ path: 'r/sealed/Layoffs Q3 plan.pdf' }] }, { rule: 'allow-list' }],
    [{ notes: [note('r:in')], links: [], attachments: [] }, { rule: 'allow-list', notePath: 'r/In.md' }],
    [{ notes: [note('r:out')], links: [], attachments: [] }, { rule: 'allow-list' }],
  ]
  for (const [manifest, detail] of cases) {
    const error = refusalOf(manifest)
    assert.deepEqual([error?.code, error?.detail], ['redaction-failure', detail])
    assert.equal(/Layoffs|r:out/.test(error.message), false, error.message)
  }
})

test('the published materialization subpath carries no test seam of the redaction guard', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./obsidian/materialize'], './src/projection/obsidian/materialize/index.mjs')
  const published = await import('../src/projection/obsidian/materialize/index.mjs')
  assert.equal('createViewPreparationForOracleTests' in published, false)
  assert.equal(typeof createViewPreparationForOracleTests, 'function', 'the tests reach it in its own module')
})

// ---------------------------------------------------------------------------
// The redaction guard, rule by rule. Each mutation control removes one rule
// through createViewPreparationForOracleTests and shows that the view that
// rule refuses is then accepted, and leaks.
// ---------------------------------------------------------------------------

// Rewrites one cached note in place, keeping every recorded range, digest and
// inversion consistent with the new bytes, so only the guard stands between
// the forged entry and the result.
function forgeCachedNote(cache, notePath, from, to) {
  const entry = cache.notes.get(notePath)
  const file = entry.files.find((item) => item.path === notePath)
  const at = file.bytes.indexOf(Buffer.from(from))
  assert.notEqual(at, -1, `the cached note no longer holds ${from}`)
  const delta = Buffer.byteLength(to) - Buffer.byteLength(from)
  file.bytes = Buffer.concat([file.bytes.subarray(0, at), Buffer.from(to), file.bytes.subarray(at + Buffer.byteLength(from))])
  file.digest = sha256Digest(file.bytes)
  entry.note.noteDigest = file.digest
  const shift = (range) => { if (range.start > at) range.start += delta; if (range.end > at) range.end += delta }
  const { frontmatter, identity, body, generated } = entry.note.regions
  for (const range of [frontmatter, identity, body, ...generated.map((region) => region.range)].filter(Boolean)) shift(range)
  for (const [, inversions] of entry.edgeInversions) for (const inversion of inversions) shift(inversion.note)
  for (const embed of entry.note.ext[EXT].assetEmbeds ?? []) for (const inversion of embed.inversions) shift(inversion.note)
}

const withoutRule = (rule) => createViewPreparationForOracleTests({ [rule]: () => {} })
const judgingEmittedOnly = createViewPreparationForOracleTests({ judged: ({ notes, reused }) => notes.filter((note) => !reused.has(note.path)) })

test('rule 1, allow-list: a generated link, a rewritten link or an identity block that names a file or note outside the view refuses', (t) => {
  const snapshot = makeWorkspace(t)
  const primed = () => { const cache = createPreparationCache(); prepare(snapshot, scopedScope, { cache }); return cache }
  const plan = 'north-desk/plans/Harbor plan.md'
  const outside = 'north-desk/plans/Shared concept.md'
  const forgeries = {
    'a relation row to a note outside the view': (cache) => forgeCachedNote(cache, plan, '- supports → [[south-desk/tables/Tide table.md|', `- supports → [[${outside}|`),
    'a rewritten link to a note outside the view': (cache) => {
      forgeCachedNote(cache, plan, '[[south-desk/tables/Tide table.md|Tide table]] or', `[[${outside}|Tide table]] or`)
      const [, inversions] = cache.notes.get(plan).edgeInversions.find(([edgeKey]) => edgeKey === 'south-desk:tide-table')
      const forged = inversions.find((inversion) => Buffer.from(inversion.ext[EXT].emitted, 'base64url').toString() === 'south-desk/tables/Tide table.md' && fileOf({ files: cache.notes.get(plan).files }, plan).bytes.subarray(inversion.note.start, inversion.note.end).toString() !== 'south-desk/tables/Tide table.md')
      forged.ext[EXT].emitted = Buffer.from(outside).toString('base64url')
      forged.note.end = forged.note.start + Buffer.byteLength(outside)
    },
    'an identity block naming another note': (cache) => forgeCachedNote(cache, plan, 'atelier-id: "north-desk:harbor-plan"', 'atelier-id: "north-desk:shared-a"'),
  }
  for (const [label, forge] of Object.entries(forgeries)) {
    const forged = primed()
    forge(forged)
    assert.throws(() => prepare(snapshot, scopedScope, { cache: forged }), { code: 'redaction-failure' }, label)
    // Mutation control: without the allow-list the forged note is served.
    const leaky = primed()
    forge(leaky)
    const served = withoutRule('allowList')({ snapshot, profile, scope: scopedScope, clock, cache: leaky })
    assert.ok(noteBytes(served, 'north-desk:harbor-plan').toString('utf8').includes(label.startsWith('an identity') ? 'north-desk:shared-a' : outside), label)
  }
})

test('rule 2, deny-list: a withheld identity in generated free text refuses; without the rule it is emitted', (t) => {
  const snapshot = makeWorkspaceVariant(t, { 'north-desk/notes/naming.md': relatedNote('north-desk:naming', 'Names north-desk:sealed-ledger') })
  assert.throws(() => prepare(snapshot, fullScope), { code: 'redaction-failure' })
  const leaked = withoutRule('denyList')({ snapshot, profile, scope: fullScope, clock })
  const plan = noteOf(leaked, 'north-desk:harbor-plan')
  const bytes = noteBytes(leaked, 'north-desk:harbor-plan')
  const generated = plan.regions.generated.map((region) => bytes.subarray(region.range.start, region.range.end).toString('utf8')).join('')
  assert.ok(generated.includes('north-desk:sealed-ledger'), 'without the deny-list the withheld identity reaches generated text')
  // The allow-list alone does not catch it: the words are free text, not a link.
  assert.throws(() => withoutRule('allowList')({ snapshot, profile, scope: fullScope, clock }), { code: 'redaction-failure' })
})

test('the deny matcher finds whole tokens only, wherever a value starts, and in any text', () => {
  const deny = createDenyMatcher({ refuse: ['north-desk:sealed-ledger', 'north-desk/sealed/q3_layoffs.md', '_drafts/notes/n-1.md', '.hidden:x', 'harbor', 'north-desk/plans/Plan (b).md', '___'] })
  const matches = (text) => deny(text) === 'refuse'
  for (const text of [
    'Names north-desk:sealed-ledger', 'north-desk:sealed-ledger.', '(north-desk:sealed-ledger)', 'see north-desk/sealed/q3_layoffs.md, then',
    'a _drafts/notes/n-1.md b', '.hidden:x', 'the harbor', 'Harbor, harbor.', 'at north-desk/plans/Plan (b).md', 'a ___ b', '___',
  ]) assert.equal(matches(text), true, text)
  for (const text of [
    'xnorth-desk:sealed-ledger', 'north-desk:sealed-ledgers', 'north-desk:sealed-ledger.v2', 'x.north-desk:sealed-ledger', 'north-desk:sealed-ledger-2',
    'x_drafts/notes/n-1.md', 'harbors', 'harbor-wall', 'Harbor', 'north-desk/plans/Plan (b).mdx', 'a____b', 'plain words',
  ]) assert.equal(matches(text), false, text)
})

test('the deny matcher agrees with a direct search for every occurrence of every value, on random values and texts', () => {
  // The reference: every occurrence of every value, judged by the documented token rule.
  const alnum = (character) => character !== undefined && /^[\p{L}\p{N}]$/u.test(character)
  const joined = (character, beyond) => ['.', '_', ':', '/', '-'].includes(character) && alnum(beyond)
  const reference = (values, text) => values.some((value) => {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
      const end = at + value.length
      if (!alnum(text[at - 1]) && !joined(text[at - 1], text[at - 2]) && !alnum(text[end]) && !joined(text[end], text[end + 1])) return true
    }
    return false
  })
  let seed = 7
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const alphabet = ['a', 'b', 'é', '1', '_', '.', ':', '/', '-', ' ', '(', ')']
  const word = (length) => Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
  for (let round = 0; round < 400; round += 1) {
    const values = Array.from({ length: 1 + Math.floor(random() * 6) }, () => word(1 + Math.floor(random() * 5))).filter((value) => value.trim() !== '')
    const deny = createDenyMatcher({ refuse: values })
    const matches = (text) => deny(text) === 'refuse'
    for (let sample = 0; sample < 20; sample += 1) {
      const text = word(Math.floor(random() * 24))
      assert.equal(matches(text), reference(values, text), JSON.stringify({ values, text }))
    }
  }
})

test('the deny matcher is one automaton, linear in the text: 15,000 to 30,000 values of repositories named like words, `_archive` and `.github`', (t) => {
  // Repository identities that are ordinary words the titles use (`notes`), or that start with neither a letter nor a
  // digit: every value shares its start with the text, which a matcher that compares candidates one by one pays for.
  const values = []
  for (let index = 0; index < 10000; index += 1) {
    const repo = ['notes', '_archive', '.github'][index % 3]
    values.push(`${repo}:note-${index}`, `${repo}/notes/b${index % 50}/note ${index}.md`, `${repo}/notes/b${index % 50}/Title ${index}.md`)
  }
  const texts = Array.from({ length: 4000 }, (_, index) => `Weekly notes ${index}: notes on the notes wall, _archive of .github notes and notes: ${index}`)
  const elapsed = {}
  for (const count of [15000, 30000]) {
    const started = performance.now()
    const deny = createDenyMatcher({ refuse: values.slice(0, count) })
    for (const text of texts) assert.equal(deny(text), null)
    elapsed[count] = Math.round(performance.now() - started)
  }
  t.diagnostic(`deny matcher: 15,000 values ${elapsed[15000]} ms, 30,000 values ${elapsed[30000]} ms, over ${texts.length} titles, build included`)
  // Generous bounds, far below what a candidate-by-candidate matcher takes here (seconds to tens of seconds).
  assert.ok(elapsed[15000] < 2000 && elapsed[30000] < 2000, JSON.stringify(elapsed))
  // The same automaton finds each value where it is a whole token.
  const deny = createDenyMatcher({ refuse: values })
  for (const value of [values[0], values[4], values[29998]]) assert.equal(deny(`See ${value}, then`), 'refuse', value)
})

test('rule 3, coverage: a reused note is judged like an emitted one; a guard that skipped the cache would serve a forged entry', (t) => {
  const snapshot = makeWorkspace(t)
  const primed = () => { const cache = createPreparationCache(); prepare(snapshot, fullScope, { cache }); return cache }
  const forge = (cache) => forgeCachedNote(cache, 'north-desk/plans/Harbor plan.md', '- evidences ← Depth chart', '- evidences ← Depth chart north-desk:sealed-ledger')
  const forged = primed()
  forge(forged)
  const refused = (() => { try { prepare(snapshot, fullScope, { cache: forged }); return null } catch (error) { return error.code } })()
  assert.equal(refused, 'redaction-failure')
  const leaky = primed()
  forge(leaky)
  const served = judgingEmittedOnly({ snapshot, profile, scope: fullScope, clock, cache: leaky })
  assert.equal(served.preparation.emitted, 0, 'every note was reused')
  assert.ok(noteBytes(served, 'north-desk:harbor-plan').toString('utf8').includes('north-desk:sealed-ledger'))
  // The production rules judge every note: the same inputs without the forged entry prepare as before.
  assert.deepEqual(prepare(snapshot, fullScope, { cache: createPreparationCache() }).manifestBytes, prepare(snapshot, fullScope).manifestBytes)
  assert.equal(REDACTION_RULES.judged({ notes: [1, 2], reused: new Set([1]) }).length, 2)
})
