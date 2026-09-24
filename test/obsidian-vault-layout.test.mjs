import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import {
  fileNameParts, folderNameOf, identityLineTexts, isReadableVaultPath, joinFileName, noteNameOf, qualifierIdOf, vaultName, validateObsidianContract,
} from '../src/projection/obsidian/contracts.mjs'
import { applyEditLens, createEngineApplyOperation } from '../src/projection/obsidian/edits/index.mjs'
import { PATH_REGISTRY_SCHEMA, allocateViewPaths, collisionKey, prepareView, withEligibility } from '../src/projection/obsidian/materialize/index.mjs'
import { viewsOfRegistry } from '../src/projection/obsidian/materialize/path-registry.mjs'
import { resolveExchange } from '../src/projection/obsidian/publication/index.mjs'
import { planUnits } from '../src/projection/obsidian/publication/publisher.mjs'
import { protectedRoots } from '../src/runtime/obsidian/machine-settings.mjs'
import { scopeReport } from '../src/runtime/obsidian/opening.mjs'
import { FRESHNESS_SCHEMA, validateFreshness } from '../src/runtime/obsidian/state-store.mjs'
import { prepareWorkspace } from './support/obsidian-edits/workspace.mjs'
import { APPLY_WORKSPACE_ID, digestOf, makeApplyWorld, noteText, treeListing } from './support/obsidian-edits/apply-world.mjs'

// Vault layout 2: file names are titles, folders mirror the repository, and
// each note names its identity in generated properties. Invented, synthetic
// content only. See "Vault layout" in docs/obsidian-contract.md.

const EXT = 'mnstry.atelier.obsidian'
const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: the publisher refuses, which the recovery suite asserts' }
const bytes = (value) => Buffer.byteLength(value, 'utf8')
const node = (repo, id, sourcePath, title, extension = sourcePath.split('.').at(-1)) => ({ repo, id, path: sourcePath, title, extension })

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

test('a Markdown note is named by its title, with the author\'s casing and spacing, made safe', () => {
  const table = [
    // A title that is a file name loses the source's own extension, and only that one.
    ['07-tide-survey-brief.md', '07-tide-survey-brief'],
    ['Weekly notes.MD', 'Weekly notes'],
    ['Using .md', 'Using .md'],
    ['Node.js', 'Node.js'],
    ['Version 2.0', 'Version 2.0'],
    ['report.pdf', 'report.pdf'],
    // Casing and words as written; forbidden and link-breaking characters become a space, runs of spaces one.
    ['Harbor plan', 'Harbor plan'],
    ['hARBOR   PLAN', 'hARBOR PLAN'],
    ['Q&A: why/how?', 'Q&A why how'],
    ['C# [draft] | notes ^1', 'C draft notes 1'],
    ['a\\b*c"d<e>f', 'a b c d e f'],
    ['line\nbreak\ttab\u0000nul', 'line break tab nul'],
    ['...hidden', 'hidden'],
    ['trailing. ', 'trailing'],
    ['  spaced  ', 'spaced'],
    // Emoji, a joined emoji sequence, right-to-left scripts and a decomposed accent survive, normalized.
    ['Launch 🚀 plan', 'Launch 🚀 plan'],
    ['Family 👨\u200d👩\u200d👧 plan', 'Family 👨\u200d👩\u200d👧 plan'],
    ['שלום עולם', 'שלום עולם'],
    ['مرحبا بالعالم', 'مرحبا بالعالم'],
    ['Re\u0301sume\u0301', 'Résumé'],
    // Invisible bidirectional overrides are removed, so a name cannot read as another.
    ['invoice\u202egpj.md', 'invoicegpj'],
    // Windows device names, on the part before the first dot, in any case.
    ['CON', '_CON'],
    ['con.backup', '_con.backup'],
    ['Com1', '_Com1'],
    ['LPT¹', '_LPT¹'],
    ['CONOUT$', '_CONOUT$'],
    ['Console', 'Console'],
  ]
  for (const [title, expected] of table) {
    const name = noteNameOf(node('r', 'r:x', 'dir/x.md', title, 'md'))
    assert.equal(name, expected, JSON.stringify(title))
    assert.equal(name, name.normalize('NFC'))
    assert.ok(isReadableVaultPath(`r/${name}.md`), JSON.stringify(title))
  }
})

test('a title that is empty, only unsafe, or the graph\'s own fallback names the note by its file stem as written', () => {
  // The graph titles a document with no front-matter title and no H1 by its title-cased file name; the stem is the author's spelling.
  assert.equal(noteNameOf(node('r', 'r:a', 'docs/getting-started.md', 'Getting Started', 'md')), 'getting-started')
  assert.equal(noteNameOf(node('r', 'r:b', 'docs/07-tide-survey-brief.md', '07 Tide Survey Brief', 'md')), '07-tide-survey-brief')
  assert.equal(noteNameOf(node('r', 'r:c', 'docs/notes_2026.md', undefined, 'md')), 'notes_2026')
  assert.equal(noteNameOf(node('r', 'r:d', 'docs/brief.md', '###', 'md')), 'brief')
  assert.equal(noteNameOf(node('r', 'r:e', 'docs/###.md', '', 'md')), 'Untitled')
  // An author title that differs from the title-cased file name is the name.
  assert.equal(noteNameOf(node('r', 'r:f', 'docs/getting-started.md', 'Getting started with tides', 'md')), 'Getting started with tides')
})

test('a long name is cut to 150 bytes on a character boundary, never leaving a joiner or combining character at the end', () => {
  for (const title of ['x'.repeat(400), '語'.repeat(120), `${'a'.repeat(148)}👨\u200d👩\u200d👧`, `${'b'.repeat(147)}e\u0332\u0301\u0332tail`]) {
    const name = noteNameOf(node('r', 'r:long', 'long.md', title, 'md'))
    assert.ok(bytes(name) <= 150, `${bytes(name)} bytes`)
    assert.ok(title.normalize('NFC').startsWith(name), 'a prefix of the title')
    assert.doesNotMatch(name, /[\p{M}\u200d]$/u)
  }
  assert.equal(noteNameOf(node('r', 'r:long', 'long.md', '語'.repeat(120), 'md')), '語'.repeat(50))
})

test('a wrapped file keeps its own name, extension included; its note is that name and .md', () => {
  const table = [
    ['charts/depth-chart.pdf', 'depth-chart', 'pdf'],
    ['HARBOR-LIGHTS-STATIC-PREVIEW-2026-03-14.html', 'HARBOR-LIGHTS-STATIC-PREVIEW-2026-03-14', 'html'],
    ['aux.pdf', '_aux', 'pdf'],
    ['report?.pdf', 'report', 'pdf'],
    ['Photo.JPG', 'Photo', 'JPG'],
    [`${'y'.repeat(300)}.docx`, 'y'.repeat(150 - '.docx'.length), 'docx'],
  ]
  for (const [sourcePath, stem, extension] of table) assert.deepEqual(fileNameParts(sourcePath), { stem, extension }, sourcePath)
  assert.equal(joinFileName(fileNameParts('charts/depth-chart.pdf')), 'depth-chart.pdf')
  assert.equal(folderNameOf('.github'), 'github')
  assert.equal(folderNameOf('a:b'), 'a b')
  assert.equal(folderNameOf('###'), '_')
  assert.equal(vaultName(''), '')
})

// ---------------------------------------------------------------------------
// Allocation
// ---------------------------------------------------------------------------

const allocate = (nodes, published = null, assets = []) => allocateViewPaths({ published, nodes, assets })
const pathsOf = (result) => Object.fromEntries(result.section.entries.map((entry) => [entry.nodeId, entry.path]))

test('folders mirror the repository under a folder named after it, and a name that collides with nothing carries no qualifier', () => {
  const result = allocate([
    node('north-desk', 'north-desk:plan', 'plans/harbor/plan.md', 'Harbor plan'),
    node('north-desk', 'north-desk:readme', 'README.md', 'Read me first'),
    node('south-desk', 'south-desk:tide', 'tables/tide-table.md', 'Tide table'),
    node('north-desk', 'north-desk:chart', 'charts/depth-chart.pdf', 'Depth chart'),
  ])
  assert.deepEqual(pathsOf(result), {
    'north-desk:chart': 'north-desk/charts/depth-chart.pdf.md',
    'north-desk:plan': 'north-desk/plans/harbor/Harbor plan.md',
    'north-desk:readme': 'north-desk/Read me first.md',
    'south-desk:tide': 'south-desk/tables/Tide table.md',
  })
  assert.equal(result.attachmentOf('north-desk', 'north-desk:chart'), 'north-desk/charts/depth-chart.pdf')
  for (const entry of result.section.entries) assert.doesNotMatch(entry.path, /[0-9a-f]{6}\)/, 'no hash in a name that collides with nothing')
  assert.deepEqual(result.diagnostics, [])
})

test('collisions are readable: the later identity takes its source file stem, then a short stable id, compared as a case- and normalization-insensitive file system compares', () => {
  const nodes = [
    node('r', 'r:a', 'topics/alpha.md', 'Overview'),
    node('r', 'r:b', 'topics/beta.md', 'Overview'),
    node('r', 'r:c', 'Topics/beta.md', 'OVERVIEW'),
    node('r', 'r:d', 'topics/gamma.md', 'Re\u0301sume\u0301'),
    node('r', 'r:e', 'topics/delta.md', 'RÉSUMÉ'),
  ]
  assert.deepEqual(pathsOf(allocate(nodes)), {
    'r:a': 'r/topics/Overview.md',
    'r:b': 'r/topics/Overview (beta).md',
    // The folder `Topics` is the folder `topics` on a case-insensitive file system: it takes that spelling.
    'r:c': `r/topics/OVERVIEW (beta) (${qualifierIdOf('r', 'r:c')}).md`,
    'r:d': 'r/topics/Résumé.md',
    'r:e': 'r/topics/RÉSUMÉ (delta).md',
  })
  const keys = Object.values(pathsOf(allocate(nodes))).map(collisionKey)
  assert.equal(new Set(keys).size, keys.length)
})

test('allocation is deterministic in any listing order and stable across generations: an existing path never moves, a newcomer takes the qualifier', () => {
  const nodes = [
    node('r', 'r:1', 'a/one.md', 'Plan'), node('r', 'r:2', 'a/two.md', 'Plan'), node('r', 'r:3', 'b/three.md', 'Plan'),
    node('q', 'q:1', 'x.md', 'X'), node('r', 'r:4', 'a/chart.pdf', 'Chart'),
  ]
  const first = allocate(nodes)
  for (let shuffle = 0; shuffle < 5; shuffle += 1) {
    const order = [...nodes].sort(() => (shuffle % 2 === 0 ? -1 : 1)).reverse()
    assert.deepEqual(allocate(order).section, first.section)
  }
  // A newcomer that would take an allocated name is qualified; nothing allocated moves.
  const grown = allocate([...nodes, node('r', 'r:0', 'a/zero.md', 'Plan')], first.section)
  for (const entry of first.section.entries) assert.equal(pathsOf(grown)[entry.nodeId], entry.path)
  assert.equal(pathsOf(grown)['r:0'], 'r/a/Plan (zero).md', 'r:0 sorts first but came last: the existing Plan keeps its name')
  // A node that leaves the view releases its name there; back again, it is allocated again and gets the name when it is free.
  const without = allocate(nodes.filter((item) => item.id !== 'r:1'), grown.section)
  assert.equal(pathsOf(without)['r:1'], undefined)
  const returned = allocate(nodes, without.section)
  assert.equal(pathsOf(returned)['r:1'], pathsOf(first)['r:1'])
  // First come, first named: the same two titles in the other order of arrival swap names, and each keeps it afterwards.
  const earlyTwo = allocate([node('r', 'r:2', 'a/two.md', 'Plan')])
  const thenOne = allocate([node('r', 'r:1', 'a/one.md', 'Plan'), node('r', 'r:2', 'a/two.md', 'Plan')], earlyTwo.section)
  assert.deepEqual(pathsOf(thenOne), { 'r:1': 'r/a/Plan (one).md', 'r:2': 'r/a/Plan.md' })
})

test('a retitled source keeps its path; repositories whose folders would collide are told apart', () => {
  const first = allocate([node('r', 'r:1', 'a/one.md', 'Old title')])
  // (A title that is exactly the title-cased file name reads as the graph's fallback: the stem names the note.)
  assert.equal(pathsOf(allocate([node('r', 'r:2', 'a/intro.md', 'Intro')]))['r:2'], 'r/a/intro.md')
  const retitled = allocate([node('r', 'r:1', 'a/one.md', 'New title')], first.section)
  assert.equal(pathsOf(retitled)['r:1'], 'r/a/Old title.md')
  const repos = allocate([node('Tides', 'Tides:1', 'a.md', 'Alpha'), node('tides', 'tides:1', 'a.md', 'Alpha'), node('ti:des', 'ti:des:1', 'a.md', 'Alpha')])
  assert.equal(pathsOf(repos)['Tides:1'], 'Tides/Alpha.md')
  assert.match(pathsOf(repos)['tides:1'], /^tides \([0-9a-f]{6}\)\/Alpha\.md$/)
  assert.equal(pathsOf(repos)['ti:des:1'], 'ti des/Alpha.md')
})

test('wrapped files and embedded assets share the namespace with notes; a colliding file is qualified before its extension, beside its note', () => {
  const result = allocate([
    node('r', 'r:chart', 'charts/Chart.pdf', 'Chart'),
    node('r', 'r:chart2', 'Charts/chart.pdf', 'Chart'),
    node('r', 'r:named', 'charts/named.md', 'Chart.pdf'),
  ], null, [{ repo: 'r', id: 'r:asset:charts/img/wave.png', path: 'charts/img/wave.png' }, { repo: 'r', id: 'r:asset:charts/chart.pdf.md', path: 'charts/CHART.pdf.md' }])
  const id = qualifierIdOf('r', 'r:chart2')
  assert.equal(result.pathOf('r', 'r:chart'), 'r/charts/Chart.pdf.md')
  assert.equal(result.attachmentOf('r', 'r:chart'), 'r/charts/Chart.pdf')
  assert.equal(result.pathOf('r', 'r:chart2'), `r/charts/chart (${id}).pdf.md`)
  assert.equal(result.attachmentOf('r', 'r:chart2'), `r/charts/chart (${id}).pdf`)
  // A note titled like the wrapped file's note is qualified by its stem.
  assert.equal(result.pathOf('r', 'r:named'), 'r/charts/Chart.pdf (named).md')
  assert.equal(result.assetPathOf('r', 'charts/img/wave.png'), 'r/charts/img/wave.png')
  assert.equal(result.assetPathOf('r', 'charts/CHART.pdf.md'), `r/charts/CHART.pdf (${qualifierIdOf('r', 'r:asset:charts/chart.pdf.md')}).md`)
})

test('a layout 1 registry holds no view: layout 2 allocates anew, and a malformed registry or published path refuses', () => {
  const legacy = { schema: PATH_REGISTRY_SCHEMA, workspaceId: 'ws', entries: [{ repoId: 'r', nodeId: 'r:1', path: 'notes/One--0123456789ab.md' }] }
  assert.deepEqual(viewsOfRegistry(legacy, 'ws'), {})
  assert.throws(() => viewsOfRegistry(legacy, 'other'), { code: 'invalid-path-registry' })
  assert.throws(() => viewsOfRegistry({ ...legacy, layout: 2, views: { 'scope-a': { entries: 'x' } } }, 'ws'), { code: 'invalid-path-registry' })
  const readable = allocate([node('r', 'r:1', 'a/one.md', 'First one')]).section
  for (const entry of [{ repoId: 'r', nodeId: 'r:2', path: 'r/a/.hidden.md' }, { repoId: 'r', nodeId: 'r:2', path: 'r/a/b#c.md' }, { repoId: 'r', nodeId: 'r:2', path: 'r/a/two.txt' }, { repoId: 'r', nodeId: 'r:2', path: 'two.md' }]) {
    assert.throws(() => allocate([], { ...readable, entries: [...readable.entries, entry] }), { code: 'invalid-path-registry' }, entry.path)
  }
  const both = [node('r', 'r:1', 'a/one.md', 'First one'), node('q', 'q:1', 'x.md', 'X')]
  assert.throws(() => allocate(both, { ...readable, entries: [...readable.entries, { repoId: 'q', nodeId: 'q:1', path: 'r/b/x.md' }] }), { code: 'invalid-path-registry' }, 'two repositories, one folder')
})

// ---------------------------------------------------------------------------
// The identity block
// ---------------------------------------------------------------------------

const doc = (id, title, body, extra = '') => `---\ntitle: "${title}"\n${extra}kg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n\n${body}\n`
const IDENTITY_FILES = {
  'tide-desk/notes/block.md': { text: doc('tide-desk:block', 'Block mapping', 'See [the flow note](flow.md).') },
  'tide-desk/notes/crlf.md': { text: doc('tide-desk:crlf', 'Line endings', 'Carriage returns.').replace(/\n/g, '\r\n') },
  'tide-desk/notes/bare.md': { text: 'No front matter, see [block](block.md).\n' },
  'tide-desk/notes/marked.md': { hex: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Prefixed\n\nA byte order prefix.\n')]).toString('hex') },
  'tide-desk/notes/flow.md': { text: '---\n{title: "Flow", kg: {id: "tide-desk:flow", type: "document", status: "active", audience: "team"}}\n---\n\nFlow body.\n' },
  'tide-desk/notes/taken.md': { text: doc('tide-desk:taken', 'Taken key', 'Body.', 'atelier-id: "mine"\n') },
  'tide-desk/notes/indented.md': { text: '---\n  title: "Indented"\n  kg:\n    id: "tide-desk:indented"\n    type: "document"\n    status: "active"\n    audience: "team"\n---\n\nIndented root.\n' },
}

function identityWorkspace(t) {
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups) cleanup() })
  return prepareWorkspace({ after: (fn) => cleanups.push(fn) }, { repositories: ['tide-desk'], files: IDENTITY_FILES })
}

test('the identity closes a plain front matter, in its line ending; a source without one gets a generated one; any other goes to the end', (t) => {
  const { cases } = identityWorkspace(t)
  const placementOf = (sourcePath) => {
    const { note, publishedNoteBytes } = cases.get(sourcePath)
    const { identity, body, frontmatter } = note.regions
    const text = publishedNoteBytes.subarray(identity.start, identity.end).toString('utf8')
    return { text, inPrefix: identity.end <= body.start, wholeFrontmatter: frontmatter?.start === identity.start && frontmatter?.end === identity.end, last: note.regions.generated.at(-1)?.kind === 'identity' }
  }
  const lines = (sourcePath, id, eol = '\n') => identityLineTexts({ id, repo: 'tide-desk', path: sourcePath.slice('tide-desk/'.length) }).map((line) => `${line}${eol}`).join('')
  assert.deepEqual(placementOf('notes/block.md'), { text: lines('tide-desk/notes/block.md', 'tide-desk:block'), inPrefix: true, wholeFrontmatter: false, last: false })
  assert.deepEqual(placementOf('notes/crlf.md'), { text: lines('tide-desk/notes/crlf.md', 'tide-desk:crlf', '\r\n'), inPrefix: true, wholeFrontmatter: false, last: false })
  assert.deepEqual(placementOf('notes/bare.md').wholeFrontmatter, true)
  assert.equal(placementOf('notes/bare.md').text, `---\n${lines('tide-desk/notes/bare.md', 'tide-desk:notes-bare')}---\n`)
  const marked = cases.get('notes/marked.md')
  assert.deepEqual(marked.publishedNoteBytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'the byte order prefix stays first')
  assert.equal(marked.note.regions.identity.start, 3)
  for (const sourcePath of ['notes/flow.md', 'notes/taken.md', 'notes/indented.md']) {
    const placed = placementOf(sourcePath)
    assert.deepEqual([placed.inPrefix, placed.last], [false, true], sourcePath)
    assert.match(placed.text, /^\n?\n%%\natelier-id: /, sourcePath)
    // The source's own front matter is untouched.
    const { note, publishedNoteBytes, baseSourceBytes } = cases.get(sourcePath)
    assert.deepEqual(publishedNoteBytes.subarray(0, note.regions.body.start), baseSourceBytes.subarray(0, note.regions.body.start))
  }
  // Every note of the view, every placement, satisfies the v2 contract and names exactly its own identity.
  const [first] = cases.values()
  assert.deepEqual(validateObsidianContract('generation-manifest', first.manifest), [])
  for (const [sourcePath, context] of cases) {
    const text = context.publishedNoteBytes.toString('utf8')
    const own = `atelier-id: ${JSON.stringify(context.nodeId)}`
    assert.equal(text.split(own).length - 1, 1, `${sourcePath}: one identity block, naming its own note`)
  }
  // The author's own key of that name is left as written, beside the generated block at the end; it, not the generated
  // one, is what Properties shows, so the note is named in the manifest. Other front matter at the end is not.
  assert.ok(cases.get('notes/taken.md').publishedNoteBytes.toString('utf8').startsWith('---\ntitle: "Taken key"\natelier-id: "mine"\n'))
  assert.deepEqual(first.manifest.ext[EXT].diagnostics, [{ code: 'author-identity-properties', repoId: 'tide-desk', nodeId: 'tide-desk:taken', notePath: cases.get('notes/taken.md').note.path }])
})

test('the lens: an unedited note and a body edit invert to exact source bytes in every placement; the identity lines are never applied', (t) => {
  const { cases } = identityWorkspace(t)
  const run = (context, edited) => applyEditLens({ manifest: context.manifest, repoId: context.repoId, nodeId: context.nodeId, publishedNoteBytes: context.publishedNoteBytes, baseSourceBytes: context.baseSourceBytes, editedNoteBytes: edited })
  const replace = (buffer, from, to) => { const at = buffer.indexOf(from); assert.notEqual(at, -1, from); return Buffer.concat([buffer.subarray(0, at), Buffer.from(to), buffer.subarray(at + Buffer.byteLength(from))]) }
  let checked = 0
  for (const [sourcePath, context] of cases) {
    if (context.note.ext[EXT].source.kind !== 'markdown') continue
    const unedited = run(context, context.publishedNoteBytes)
    assert.equal(unedited.kind, 'body-replacement', `${sourcePath}: ${unedited.code}`)
    assert.deepEqual(unedited.newSourceBytes, context.baseSourceBytes, sourcePath)
    // A body edit at the very end of the authored body: exact.
    const at = context.note.regions.body.end
    const appended = Buffer.concat([context.publishedNoteBytes.subarray(0, at), Buffer.from('Added.\n'), context.publishedNoteBytes.subarray(at)])
    const edited = run(context, appended)
    const sourceEnd = context.baseSourceBytes.length
    assert.equal(edited.kind, 'body-replacement', `${sourcePath}: ${edited.code}`)
    assert.deepEqual(edited.newSourceBytes, Buffer.concat([context.baseSourceBytes.subarray(0, sourceEnd), Buffer.from('Added.\n')]), sourcePath)
    // The identity lines edited: never applied. In the front matter it is a front-matter edit, which becomes a proposal.
    const identityLine = `atelier-source: ${JSON.stringify(sourcePath)}`
    const retargeted = replace(context.publishedNoteBytes, identityLine, 'atelier-source: "elsewhere.md"')
    const refused = run(context, retargeted)
    assert.equal(refused.kind, 'refusal', sourcePath)
    const inPrefix = context.note.regions.identity.end <= context.note.regions.body.start
    assert.equal(refused.code, inPrefix ? 'unsupported-frontmatter-edit' : 'generated-region-edited', sourcePath)
    // Removed whole: from the front matter a front-matter edit; at the end a generated region deleted, which changes no source byte.
    const { identity } = context.note.regions
    const removed = run(context, Buffer.concat([context.publishedNoteBytes.subarray(0, identity.start), context.publishedNoteBytes.subarray(identity.end)]))
    if (inPrefix) assert.deepEqual([removed.kind, removed.code], ['refusal', 'unsupported-frontmatter-edit'], sourcePath)
    else assert.deepEqual([removed.kind, removed.unchanged, removed.generated], ['body-replacement', true, 'removed'], sourcePath)
    checked += 1
  }
  assert.ok(checked >= 7)
  // An editor that drops the byte order prefix on save: the prefix is the source's, and the body edit still applies.
  const marked = cases.get('notes/marked.md')
  const saved = replace(marked.publishedNoteBytes.subarray(3), 'A byte order prefix.', 'A byte order prefix, kept.')
  const result = run(marked, saved)
  assert.equal(result.kind, 'body-replacement', result.code)
  assert.deepEqual(result.newSourceBytes, replace(marked.baseSourceBytes, 'A byte order prefix.', 'A byte order prefix, kept.'))
})

test('the lens: a link typed in the vault to another note is structural in any spelling the app resolves; a relative source link that names no vault file is authored text', (t) => {
  const { cases } = identityWorkspace(t)
  const context = cases.get('notes/bare.md')
  const run = (edited) => applyEditLens({ manifest: context.manifest, repoId: context.repoId, nodeId: context.nodeId, publishedNoteBytes: context.publishedNoteBytes, baseSourceBytes: context.baseSourceBytes, editedNoteBytes: edited })
  const append = (text) => { const at = context.note.regions.body.end; return Buffer.concat([context.publishedNoteBytes.subarray(0, at), Buffer.from(text), context.publishedNoteBytes.subarray(at)]) }
  for (const link of ['[[tide-desk/notes/Block mapping.md]]', '[[Block mapping]]', '[[notes/Block mapping]]', '[x](Block%20mapping.md)', '[x](./Block%20mapping.md)', '[x](../notes/Line%20endings.md)', '[[tide-desk/notes/Not a note yet]]']) {
    const result = run(append(`See ${link}.\n`))
    assert.deepEqual([result.kind, result.code, result.detail?.reason], ['refusal', 'unsupported-structural-edit', 'vault-link-changed'], link)
  }
  for (const link of ['[x](../other/thing.md)', '[x](https://example.invalid/a.md)']) {
    const result = run(append(`See ${link}.\n`))
    assert.equal(result.kind, 'body-replacement', `${link}: ${result.code}`)
  }
  // A vault path typed as text, outside any link, is a vault identity: it never reaches a source.
  const result = run(append('`tide-desk/notes/Block mapping.md` in code.\n'))
  assert.deepEqual([result.code, result.detail?.reason], ['unsupported-structural-edit', 'vault-identity-in-authored-text'])
})

// ---------------------------------------------------------------------------
// Links resolve where the app resolves them
// ---------------------------------------------------------------------------

// Obsidian's link resolution, as MetadataCache.getLinkpathDest reads in the
// 1.13.7 application bundle: files are looked up by their lower-cased name; a
// target starting `./` or `../` is resolved against the linking note's
// folder; then an exact vault path wins; then files whose path ends with the
// target, those under the linking note's folder first, the shortest first.
function resolveLikeTheApp(files, linkpath, sourcePath) {
  const byName = new Map()
  for (const file of files) {
    const name = file.split('/').at(-1).toLowerCase()
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name).push(file)
  }
  const nameOf = (value) => value.split('/').at(-1)
  let target = linkpath.toLowerCase()
  let candidates = nameOf(target).includes('.') ? byName.get(nameOf(target)) : undefined
  if (!candidates) { target = `${linkpath}.md`.toLowerCase(); candidates = byName.get(nameOf(target)) }
  if (!candidates) return null
  if (nameOf(target) === target && candidates.length === 1) return candidates[0]
  const parent = (value) => (value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '')
  let folder = parent(sourcePath).toLowerCase()
  if (target.startsWith('./') || target.startsWith('../')) {
    if (target.startsWith('./../')) target = target.slice(2)
    if (target.startsWith('./')) { target = `${folder === '' ? '' : `${folder}/`}${target.slice(2)}` } else {
      while (target.startsWith('../')) { target = target.slice(3); folder = parent(folder) }
      target = `${folder === '' ? '' : `${folder}/`}${target}`
    }
    const relative = candidates.find((file) => file.toLowerCase() === target)
    if (relative) return relative
  }
  target = target.replace(/^\//, '')
  const exact = candidates.find((file) => file.toLowerCase() === target)
  if (exact) return exact
  if (linkpath.startsWith('/')) return null
  const suffixed = candidates.filter((file) => file.toLowerCase().endsWith(target)).sort((left, right) => left.length - right.length)
  const near = suffixed.filter((file) => file.toLowerCase().startsWith(parent(sourcePath).toLowerCase()))
  return [...near, ...suffixed.filter((file) => !near.includes(file))][0] ?? null
}

test('every rewritten link and relation row resolves, the way the app resolves it, to exactly the note it names', (t) => {
  // A repository called `docs` that has a `docs` folder of its own: a vault path must still mean itself.
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups) cleanup() })
  const { prepared } = prepareWorkspace({ after: (fn) => cleanups.push(fn) }, {
    repositories: ['docs', 'wiki'],
    files: {
      'docs/guide/intro.md': { text: doc('docs:intro', 'Intro', 'The [nested intro](../docs/guide/intro.md) and the [wiki](../../wiki/intro.md) and [[Intro]].', '') },
      'docs/docs/guide/intro.md': { text: doc('docs:nested-intro', 'Intro', 'Nested. Back to the [top](../../../guide/intro.md).') },
      'docs/overview.md': { text: doc('docs:overview', 'Overview', 'See [intro](guide/intro.md) and [[wiki/intro]].') },
      'wiki/intro.md': { text: doc('wiki:intro', 'Intro', 'The wiki intro, see [docs](../docs/overview.md).') },
    },
  })
  const files = prepared.files.filter((file) => file.kind !== 'settings').map((file) => file.path)
  const pathOf = new Map(prepared.manifest.notes.map((note) => [note.nodeId, note.path]))
  let resolved = 0
  for (const link of prepared.manifest.links) {
    const source = pathOf.get(link.sourceNodeId)
    const target = pathOf.get(link.targetNodeId)
    for (const inversion of link.inversions ?? []) {
      const emitted = Buffer.from(inversion.ext[EXT].emitted, 'base64url').toString('utf8')
      if (emitted.startsWith('|')) continue
      const linkpath = emitted.includes('%') ? decodeURIComponent(emitted) : emitted
      assert.equal(resolveLikeTheApp(files, linkpath, source), target, `${source}: ${emitted}`)
      resolved += 1
    }
  }
  for (const note of prepared.manifest.notes) {
    const text = prepared.files.find((file) => file.path === note.path).bytes.toString('utf8')
    for (const match of text.matchAll(/- [a-z_]+ → \[\[([^|\]]+)\|/g)) {
      assert.ok(files.includes(match[1]), match[1])
      assert.equal(resolveLikeTheApp(files, match[1], note.path), match[1])
      resolved += 1
    }
  }
  assert.ok(resolved >= 6, `${resolved} links checked`)
  // The control: the layout 1 spelling of a link, a bare name, is ambiguous here and resolves by the app's tie-break, not by identity.
  assert.equal(new Set(prepared.manifest.notes.filter((note) => note.path.toLowerCase().endsWith('/intro.md')).map((note) => note.path)).size, 3)
})

// ---------------------------------------------------------------------------
// Allocation per view, a lost registry, and sources that do not fit
// ---------------------------------------------------------------------------

const titled = (id, title) => ({ text: `---\ntitle: "${title}"\nkg:\n  id: "${id}"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# ${title}\n` })
function workspaceOf(t, files, repositories = ['r']) {
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups) cleanup() })
  return prepareWorkspace({ after: (fn) => cleanups.push(fn) }, { repositories, files }).inputs
}
const scopeOf = (scopeId, selector) => ({ schema: 'atelier-obsidian-scope/v1', scopeId, mode: 'scoped', selector })
const withheldIn = (inputs, ids) => ({ ...inputs, snapshot: { ...inputs.snapshot, graph: withEligibility(inputs.snapshot.graph, (item) => !ids.includes(item.id), () => true) } })
const pathsIn = (prepared) => Object.fromEntries(prepared.manifest.notes.map((note) => [note.nodeId, note.path]))
const diagnosticsOf = (prepared) => prepared.manifest.ext[EXT].diagnostics ?? []
const folderOf = (filePath) => filePath.slice(0, filePath.lastIndexOf('/'))

test('each view allocates among its own notes: a note of another view, or one that left the view, never causes a qualifier', (t) => {
  const files = { 'r/a/one.md': titled('r:1', 'Plan'), 'r/a/two.md': titled('r:2', 'Plan') }
  const inputs = workspaceOf(t, files)
  // One note in each view: each takes the plain name there, so one title can have the same path in two views.
  const one = prepareView({ ...inputs, scope: scopeOf('scope-one', { ids: ['r:1'] }) })
  const two = prepareView({ ...inputs, scope: scopeOf('scope-two', { ids: ['r:2'] }), persistentPathRegistry: one.persistentPathRegistry })
  assert.deepEqual([pathsIn(one), pathsIn(two)], [{ 'r:1': 'r/a/Plan.md' }, { 'r:2': 'r/a/Plan.md' }])
  // Both notes in one view: the later identity is qualified, in that view only.
  const all = scopeOf('scope-all', { repo: 'r' })
  const both = prepareView({ ...inputs, scope: all, persistentPathRegistry: two.persistentPathRegistry })
  assert.deepEqual(pathsIn(both), { 'r:1': 'r/a/Plan.md', 'r:2': 'r/a/Plan (two).md' })
  // r:1 leaves the view and r:3 of the same title arrives: r:3 takes the name r:1 released, and r:2 keeps its path.
  const later = withheldIn(workspaceOf(t, { ...files, 'r/a/three.md': titled('r:3', 'Plan') }), ['r:1'])
  const next = prepareView({ ...later, scope: all, persistentPathRegistry: both.persistentPathRegistry, priorManifest: both.manifest })
  assert.deepEqual(pathsIn(next), { 'r:2': 'r/a/Plan (two).md', 'r:3': 'r/a/Plan.md' })
  // Unless the file of the note that left is held for an edit: it stays in the vault, and the newcomer is qualified.
  const held = prepareView({ ...later, scope: all, persistentPathRegistry: both.persistentPathRegistry, priorManifest: both.manifest, heldNotePaths: ['r/a/Plan.md'] })
  assert.deepEqual(pathsIn(held), { 'r:2': 'r/a/Plan (two).md', 'r:3': 'r/a/Plan (three).md' })
  // Each view's allocation is its own section of the registry, and a view names only its own notes there.
  assert.deepEqual(Object.keys(next.persistentPathRegistry.views).sort(), ['scope-all', 'scope-one', 'scope-two'])
  assert.deepEqual(next.persistentPathRegistry.views['scope-all'].entries.map((entry) => entry.nodeId), ['r:2', 'r:3'])
})

test('an identity that leaves a view releases its path there: a renamed source takes its name back', (t) => {
  // A source without an identity of its own is identified by its path, so renaming it makes a new identity.
  const draft = workspaceOf(t, { 'r/notes/plan-draft.md': { text: '# Plan\n\nThe draft.\n' }, 'r/notes/keep.md': titled('r:keep', 'Kept note') })
  const first = prepareView(draft)
  assert.equal(pathsIn(first)['r:notes-plan-draft'], 'r/notes/Plan.md')
  const renamed = workspaceOf(t, { 'r/notes/plan-final.md': { text: '# Plan\n\nThe final text.\n' }, 'r/notes/keep.md': titled('r:keep', 'Kept note') })
  const second = prepareView({ ...renamed, persistentPathRegistry: first.persistentPathRegistry, priorManifest: first.manifest })
  assert.deepEqual(pathsIn(second), { 'r:keep': 'r/notes/Kept note.md', 'r:notes-plan-final': 'r/notes/Plan.md' })
  assert.deepEqual(second.persistentPathRegistry.views['scope-full'].entries.map((entry) => entry.nodeId), ['r:keep', 'r:notes-plan-final'], 'the old identity is released')
})

test('a lost registry costs no view its paths: every view keeps what it published, and none refuses', (t) => {
  const viewA = scopeOf('scope-a', { repo: 'r', pathPrefix: 'b/' })
  const viewB = scopeOf('scope-b', { repo: 'r', pathPrefix: 'a/' })
  // History: r:2 came first and took "Plan"; r:1, which sorts first, came later and was qualified.
  const early = workspaceOf(t, { 'r/a/two.md': titled('r:2', 'Plan'), 'r/b/other.md': titled('r:x', 'Other') })
  const a0 = prepareView({ ...early, scope: viewA })
  const b0 = prepareView({ ...early, scope: viewB, persistentPathRegistry: a0.persistentPathRegistry })
  const later = workspaceOf(t, { 'r/a/two.md': titled('r:2', 'Plan'), 'r/a/one.md': titled('r:1', 'Plan'), 'r/b/other.md': titled('r:x', 'Other') })
  const a1 = prepareView({ ...later, scope: viewA, persistentPathRegistry: b0.persistentPathRegistry, priorManifest: a0.manifest })
  const b1 = prepareView({ ...later, scope: viewB, persistentPathRegistry: a1.persistentPathRegistry, priorManifest: b0.manifest })
  assert.deepEqual(pathsIn(b1), { 'r:1': 'r/a/Plan (one).md', 'r:2': 'r/a/Plan.md' })
  // The registry is lost; the views are prepared in either order.
  for (const order of [['a', 'b'], ['b', 'a']]) {
    let registry = null
    const prepared = {}
    for (const name of order) {
      prepared[name] = prepareView({ ...later, scope: name === 'a' ? viewA : viewB, persistentPathRegistry: registry, priorManifest: name === 'a' ? a1.manifest : b1.manifest })
      registry = prepared[name].persistentPathRegistry
    }
    assert.deepEqual([pathsIn(prepared.a), pathsIn(prepared.b)], [pathsIn(a1), pathsIn(b1)], order.join(' then '))
    assert.deepEqual(prepared.b.changes.removed, [])
  }
})

test('a source folder chain too deep for the path budget keeps a readable prefix and a short stable id, and nothing is refused', (t) => {
  const chain = 'a-long-folder-name-for-depth/'.repeat(6)
  const inputs = workspaceOf(t, {
    [`r/${chain}deep.md`]: titled('r:deep', 'Deep note'),
    [`r/${chain}deeper/other.md`]: titled('r:other', 'Other note'),
    'r/shallow.md': titled('r:shallow', 'Shallow note'),
  })
  const trimmed = prepareView({ ...inputs, maxFullPathBytes: 190 })
  const paths = pathsIn(trimmed)
  assert.equal(paths['r:shallow'], 'r/Shallow note.md')
  for (const [nodeId, name] of [['r:deep', 'Deep note'], ['r:other', 'Other note']]) {
    assert.ok(bytes(paths[nodeId]) + 1 <= 190, paths[nodeId])
    assert.match(paths[nodeId], new RegExp(`^r/(?:a-long-folder-name-for-depth/)+[^/]+ \\([0-9a-f]{6}\\)/${name}\\.md$`))
  }
  // Two source folders shortened to one readable prefix stay two folders.
  assert.notEqual(folderOf(paths['r:deep']), folderOf(paths['r:other']))
  assert.deepEqual(diagnosticsOf(trimmed), [
    { code: 'folder-shortened', repoId: 'r', nodeId: 'r:deep', notePath: paths['r:deep'] },
    { code: 'folder-shortened', repoId: 'r', nodeId: 'r:other', notePath: paths['r:other'] },
  ])
  assert.deepEqual(validateObsidianContract('generation-manifest', trimmed.manifest), [])
  // Budgets are per view: a view whose vault root leaves room keeps the full folders.
  const roomy = prepareView({ ...inputs, scope: scopeOf('scope-roomy', { repo: 'r' }), persistentPathRegistry: trimmed.persistentPathRegistry })
  assert.equal(pathsIn(roomy)['r:deep'], `r/${chain}Deep note.md`)
  assert.deepEqual(diagnosticsOf(roomy), [])
  // A directory chain of almost 1,000 bytes under a 120-byte vault root: laid out, not refused.
  const reviewed = Array.from({ length: 12 }, (_, index) => `generated-reference-section-${String(index).padStart(2, '0')}-${'x'.repeat(50)}`).join('/')
  for (const [vaultRootBytes, degraded] of [[0, []], [120, [['folder-shortened', 'r:deep']]]]) {
    const result = allocateViewPaths({ nodes: [node('r', 'r:a', 'plans/a.md', 'Harbor plan'), node('r', 'r:deep', `${reviewed}/leaf.md`, 'Leaf note')], vaultRootBytes })
    assert.equal(result.pathOf('r', 'r:a'), 'r/plans/Harbor plan.md')
    assert.ok(vaultRootBytes + 1 + bytes(result.pathOf('r', 'r:deep')) <= 1024)
    assert.deepEqual(result.diagnostics.map((item) => [item.code, item.nodeId]), degraded, `vault root ${vaultRootBytes} bytes`)
  }
})

test('a source folder that meets a file of the same name is qualified with a short stable id, in either order, and nothing is refused', (t) => {
  const odd = workspaceOf(t, { 'r/docs/setup.md': titled('r:a-guide', 'Guide'), 'r/docs/Guide.md/inner.md': titled('r:b-inner', 'Inner note') })
  const prepared = prepareView(odd)
  const paths = pathsIn(prepared)
  assert.equal(paths['r:a-guide'], 'r/docs/Guide.md')
  assert.match(paths['r:b-inner'], /^r\/docs\/Guide\.md \([0-9a-f]{6}\)\/Inner note\.md$/)
  assert.deepEqual(diagnosticsOf(prepared), [{ code: 'folder-qualified', repoId: 'r', nodeId: 'r:b-inner', notePath: paths['r:b-inner'] }])
  // An extensionless wrapped file and a folder that differs from it only in case, in either order of identity.
  for (const [fileId, folderId] of [['r:a-data', 'r:b-readme'], ['r:b-data', 'r:a-readme']]) {
    const result = allocateViewPaths({ nodes: [node('r', fileId, 'a/data', 'Data', ''), node('r', folderId, 'a/Data/readme.md', 'Read me first')] })
    const readme = result.pathOf('r', folderId)
    assert.deepEqual([result.pathOf('r', fileId), result.attachmentOf('r', fileId)].map((value) => value !== null), [true, true])
    assert.ok(readme.endsWith('/Read me first.md') && collisionKey(folderOf(readme)) !== collisionKey(result.attachmentOf('r', fileId)), readme)
  }
  // An embedded asset named like a folder of a note: the file is the one qualified, beside the folder.
  const asset = allocateViewPaths({ nodes: [node('r', 'r:x', 'img/logo/readme.md', 'Read me first')], assets: [{ repo: 'r', id: 'r:asset:img/logo', path: 'img/logo' }] })
  assert.equal(asset.pathOf('r', 'r:x'), 'r/img/logo/Read me first.md')
  assert.match(asset.assetPathOf('r', 'img/logo'), /^r\/img\/logo \([0-9a-f]{6}\)$/)
})

test('files held in the vault, their folders in any spelling, never make an allocation refuse: a fuzz over odd sources, held files and vault roots', () => {
  let seed = 777
  const random = (n) => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) % n }
  const pick = (values) => values[random(values.length)]
  const pieces = ['a', 'Data', 'data', 'DATA', 'CON', 'com1', 'x'.repeat(40), 'é', 'é', '\u{1F600}', ' ', '.', '..x', 'Guide.md', 'notes', 'Notes', '語'.repeat(20), 'a:b', 'q?', '#h', 'z'.repeat(119), '-', '_']
  const segment = () => { let value = ''; for (let count = 1 + random(4); count > 0; count -= 1) value += pick(pieces); return value.replace(/\//g, '') || 'x' }
  const problems = []
  for (let round = 0; round < 1500; round += 1) {
    const vaultRootBytes = pick([0, 0, 100, 300, 600, 800, 900])
    const nodes = []
    const assets = []
    const count = 1 + random(8)
    for (let index = 0; index < count; index += 1) {
      const dirs = Array.from({ length: random(3) === 0 ? 6 + random(9) : random(4) }, segment)
      const wrapped = random(4) === 0
      const name = wrapped ? `${segment()}${pick(['', '.csv', '.pdf', '.PNG', '.tar.gz'])}` : `${segment()}.md`
      const repo = pick(['r', 'r', 'Notes', 'notes'])
      const sourcePath = [...dirs, name].join('/')
      if (nodes.some((item) => item.repo === repo && item.path === sourcePath)) continue
      nodes.push({ repo, id: `${repo}:n${index}-${round}`, path: sourcePath, title: random(2) ? segment() : '', extension: wrapped ? (name.includes('.') ? name.split('.').at(-1) : '') : 'md' })
      if (random(5) === 0) assets.push({ repo, id: `${repo}:asset:${index}`, path: [...dirs.slice(0, random(dirs.length + 1)), `${segment()}.png`].join('/') })
    }
    const occupied = [pick(['notes/Held--0123456789ab.md', 'NOTES/Held.md', 'r/Held.md', 'R/sub/Held.md', 'r/a/Data']), ...(random(2) ? ['notes/Other--abcdefabcdef.md'] : [])]
    let first
    try { first = allocateViewPaths({ nodes, assets, vaultRootBytes, occupied }) } catch (error) { problems.push(`refused ${error.code} at vault root ${vaultRootBytes}`); continue }
    const all = [...first.section.entries.flatMap((entry) => [entry.path, ...(entry.attachment ? [entry.attachment] : [])]), ...first.section.assets.map((entry) => entry.path)]
    const files = new Map(occupied.map((filePath) => [collisionKey(filePath), filePath]))
    const folders = new Map()
    for (const filePath of all) {
      if (!isReadableVaultPath(filePath)) problems.push(`unreadable ${JSON.stringify(filePath)}`)
      if (vaultRootBytes + 1 + bytes(filePath) > 1024 || filePath.split('/').some((part) => bytes(part) > 255)) problems.push(`over the limits at vault root ${vaultRootBytes}`)
      if (files.has(collisionKey(filePath))) problems.push(`collision ${JSON.stringify(filePath)} ${JSON.stringify(files.get(collisionKey(filePath)))}`)
      files.set(collisionKey(filePath), filePath)
      const parts = filePath.split('/')
      for (let index = 1; index < parts.length; index += 1) {
        const folder = parts.slice(0, index).join('/')
        if (folders.has(collisionKey(folder)) && folders.get(collisionKey(folder)) !== folder) problems.push(`two spellings ${JSON.stringify(folder)} ${JSON.stringify(folders.get(collisionKey(folder)))}`)
        folders.set(collisionKey(folder), folder)
      }
    }
    for (const filePath of all) if (folders.has(collisionKey(filePath))) problems.push(`a file is also a folder ${JSON.stringify(filePath)}`)
    const again = allocateViewPaths({ nodes: [...nodes].reverse(), assets: [...assets].reverse(), vaultRootBytes, occupied: [...occupied].reverse() })
    if (JSON.stringify(again.section) !== JSON.stringify(first.section)) problems.push('the result depends on the listing order')
    try {
      const seeded = allocateViewPaths({ published: first.section, nodes, assets, vaultRootBytes, occupied })
      if (JSON.stringify(seeded.section) !== JSON.stringify(first.section)) problems.push('a seeded allocation moved a path')
    } catch (error) { problems.push(`a seeded allocation refused ${error.code}`) }
  }
  assert.deepEqual([...new Set(problems)].slice(0, 10), [])
})

test('a repository named like a folder of layout 1 is told apart from it, since the upgrade leaves that folder in the vault; one named exactly so uses it', () => {
  const result = allocateViewPaths({ nodes: [node('Notes', 'Notes:a', 'a.md', 'Alpha'), node('notes', 'notes:b', 'b.md', 'Beta'), node('ATTACHMENTS', 'ATTACHMENTS:c', 'c.md', 'Gamma'), node('attachments', 'attachments:d', 'd.md', 'Delta')] })
  assert.match(result.pathOf('Notes', 'Notes:a'), /^Notes \([0-9a-f]{6}\)\/Alpha\.md$/)
  assert.equal(result.pathOf('notes', 'notes:b'), 'notes/Beta.md')
  assert.match(result.pathOf('ATTACHMENTS', 'ATTACHMENTS:c'), /^ATTACHMENTS \([0-9a-f]{6}\)\/Gamma\.md$/)
  assert.equal(result.pathOf('attachments', 'attachments:d'), 'attachments/Delta.md')
})

test('the registry keeps only the sections of the views still maintained, and always the view\'s own', (t) => {
  const inputs = workspaceOf(t, { 'r/a/one.md': titled('r:1', 'Plan') })
  const a = prepareView({ ...inputs, scope: scopeOf('scope-a', { repo: 'r' }) })
  const b = prepareView({ ...inputs, scope: scopeOf('scope-b', { repo: 'r' }), persistentPathRegistry: a.persistentPathRegistry })
  assert.deepEqual(Object.keys(b.persistentPathRegistry.views).sort(), ['scope-a', 'scope-b'])
  const pruned = prepareView({ ...inputs, scope: scopeOf('scope-b', { repo: 'r' }), persistentPathRegistry: b.persistentPathRegistry, viewScopeIds: ['scope-b'] })
  assert.deepEqual(Object.keys(pruned.persistentPathRegistry.views), ['scope-b'])
  const own = prepareView({ ...inputs, scope: scopeOf('scope-a', { repo: 'r' }), persistentPathRegistry: b.persistentPathRegistry, viewScopeIds: [] })
  assert.deepEqual(Object.keys(own.persistentPathRegistry.views), ['scope-a'])
  assert.throws(() => prepareView({ ...inputs, viewScopeIds: 'scope-a' }), { code: 'invalid-view-scopes' })
})

test('a file whose edit closed on this tick holds a layout 1 view once more, but takes no name in layout 2', (t) => {
  const files = { 'r/a/one.md': titled('r:1', 'Plan') }
  const first = prepareView(workspaceOf(t, files))
  assert.deepEqual(pathsIn(first), { 'r:1': 'r/a/Plan.md' })
  // r:1 leaves the view on the tick its edit closes, and r:3 of the same title arrives.
  const later = withheldIn(workspaceOf(t, { ...files, 'r/a/three.md': titled('r:3', 'Plan') }), ['r:1'])
  const closed = prepareView({ ...later, priorManifest: first.manifest, heldNotePaths: [], layoutHeldNotePaths: ['r/a/Plan.md'] })
  assert.deepEqual([closed.manifest.layoutVersion, pathsIn(closed)], [2, { 'r:3': 'r/a/Plan.md' }])
  // A file held for an open edit keeps its name taken.
  const open = prepareView({ ...later, priorManifest: first.manifest, heldNotePaths: ['r/a/Plan.md'] })
  assert.deepEqual(pathsIn(open), { 'r:3': 'r/a/Plan (three).md' })
  assert.throws(() => prepareView({ ...later, layoutHeldNotePaths: 'r/a/Plan.md' }), { code: 'invalid-held-notes' })
})

test('a file leaves a layout 2 vault under the kind its generation recorded: a repository named attachments holds notes', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const prior = (schema, extra) => ({ schema, notes: [{ path: 'attachments/notes/Plan.md', noteDigest: digest }], attachments: [{ path: 'attachments/charts/chart.pdf', digest }], ...extra })
  const kinds = (priorManifest) => Object.fromEntries(planUnits({ files: [], priorManifest, pointer: null, ledger: new Map() }).map((unit) => [unit.path, unit.kind]))
  assert.deepEqual(kinds(prior('atelier-obsidian-generation-manifest/v2', { layoutVersion: 2 })), { 'attachments/charts/chart.pdf': 'attachment', 'attachments/notes/Plan.md': 'note' })
  // Layout 1 kept every file under attachments/, and a file published by an interrupted run is known by that folder alone.
  const interrupted = planUnits({ files: [], priorManifest: prior('atelier-obsidian-generation-manifest/v1'), pointer: null, ledger: new Map([['attachments/Late--0123456789ab.png', digest]]) })
  assert.deepEqual(Object.fromEntries(interrupted.map((unit) => [unit.path, unit.kind]))['attachments/Late--0123456789ab.png'], 'attachment')
})

// ---------------------------------------------------------------------------
// Status names the note and the rule
// ---------------------------------------------------------------------------

test('status names the note and the rule: a bare word is reported on a current view, and a refused view says which note and rule, never the value', needsExchange, async (t) => {
  const keeper = (title) => `---\ntitle: "${title}"\nkg:\n  id: "east-wing:keeper"\n  type: "document"\n  status: "active"\n  audience: "team"\n  relations:\n    supports:\n      - "east-wing:lantern"\n---\n\n# ${title}\n\nBody.\n`
  const world = makeApplyWorld(t, {
    repositories: ['east-wing'],
    files: {
      'east-wing/notes/lantern.md': noteText({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns.' }),
      'east-wing/notes/keeper.md': keeper('Keeper by the harbor'),
      // Outside every view (its audience is not allowed), with an identity that is a bare word.
      'east-wing/notes/harbor.md': noteText({ id: 'harbor', title: 'Harbor', body: 'Private.', audience: 'private' }),
    },
  })
  const engine = world.engine()
  const report = await engine.tick()
  const lanternNote = 'east-wing/notes/Lantern room.md'
  const reported = [{ code: 'bare-identity-in-generated-text', rule: 'deny-list', repoId: 'east-wing', nodeId: 'east-wing:lantern', notePath: lanternNote }]
  assert.deepEqual([report.scopes[0].state, report.scopes[0].diagnostics], ['current', reported])
  assert.deepEqual(world.stateStore().readFreshness().scopes[0].diagnostics, reported)
  const status = () => scopeReport({ workspace: { workspaceRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID }, scopeId: 'scope-whole', repositoryRoots: protectedRoots(world.loadProject()), serviceState: 'healthy' })
  assert.deepEqual(status().diagnostics, reported)
  // The keeper's title now names the private note by its repository-qualified path: the view is refused, and says where.
  fs.writeFileSync(world.source('east-wing/notes/keeper.md'), keeper('Keeper of east-wing/notes/harbor.md'))
  world.advance(1000)
  const refused = await engine.tick()
  assert.deepEqual([refused.scopes[0].state, refused.scopes[0].reason], ['stale', 'redaction-failure'])
  assert.deepEqual(refused.scopes[0].diagnostics, [{ code: 'redaction-failure', rule: 'deny-list', notePath: lanternNote }])
  assert.deepEqual(status().diagnostics, refused.scopes[0].diagnostics)
  assert.equal(JSON.stringify(world.stateStore().readFreshness()).includes('notes/harbor.md'), false, 'the value is named nowhere')
})

test('a freshness entry may carry diagnostics naming notes and rules; anything else in them refuses', () => {
  const entry = { scopeId: 'scope-a', state: 'current', reason: 'published-and-verified', generationId: 'gen-a', preparedGenerationId: 'gen-a', verified: true, heldNotes: [], changeClasses: [], retainedEdits: 0, checkedAt: '2026-01-05T10:00:00.000Z' }
  const document = (scope) => ({ schema: FRESHNESS_SCHEMA, workspaceId: 'ws-a', enablement: 'enabled', maintenanceMode: 'manual', lastTickAt: '2026-01-05T10:00:00.000Z', lastFullReconciliationAt: null, scopes: [scope] })
  validateFreshness(document(entry), 'ws-a')
  validateFreshness(document({ ...entry, diagnostics: [{ code: 'folder-shortened', repoId: 'r', nodeId: 'r:a', notePath: 'r/a (1a2b3c)/A.md' }, { code: 'redaction-failure', rule: 'deny-list', notePath: 'r/B.md' }] }), 'ws-a')
  for (const diagnostics of ['x', [{}], [{ code: 'folder-shortened', value: 'withheld text' }], [{ code: 'x', notePath: '/abs.md' }], Array.from({ length: 101 }, () => ({ code: 'x' }))]) {
    assert.throws(() => validateFreshness(document({ ...entry, diagnostics }), 'ws-a'), { code: 'invalid-freshness-state' }, JSON.stringify(diagnostics).slice(0, 60))
  }
})

// ---------------------------------------------------------------------------
// Upgrade from layout 1
// ---------------------------------------------------------------------------

const UPGRADE_FILES = {
  'east-wing/notes/lantern.md': noteText({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute. See the [compass](compass.md).' }),
  'east-wing/notes/compass.md': noteText({ id: 'east-wing:compass', title: 'Compass rose', body: 'North is painted red.' }),
  'west-wing/logs/tide.md': noteText({ id: 'west-wing:tide', title: 'Tide log', body: 'High water at noon.' }),
}
const V1 = 'atelier-obsidian-generation-manifest/v1'
const V2 = 'atelier-obsidian-generation-manifest/v2'
const upgradeWorld = (t) => makeApplyWorld(t, { repositories: ['east-wing', 'west-wing'], files: UPGRADE_FILES })
// What the earlier release prepared: layout 1 paths, recorded in a layout 1 registry.
const EARLIER_RELEASE = {
  prepareView(input) {
    const prepared = prepareView({ ...input, layout: 1 })
    const entries = prepared.manifest.notes.map(({ repoId, nodeId, path: notePath }) => ({ repoId, nodeId, path: notePath }))
    return { ...prepared, persistentPathRegistry: { schema: PATH_REGISTRY_SCHEMA, workspaceId: prepared.persistentPathRegistry.workspaceId, entries } }
  },
}
const vaultFiles = (world) => treeListing(world.vault(), { skip: (name) => name.startsWith('.') })

test('upgrade: a vault the earlier release published is laid out again once, and every earlier file is retired to recovery, none deleted', needsExchange, async (t) => {
  const world = upgradeWorld(t)
  const earlier = world.engine({ seams: EARLIER_RELEASE })
  assert.equal((await earlier.tick()).scopes[0].state, 'current')
  assert.equal(world.manifest().schema, V1)
  const earlierFiles = Object.entries(vaultFiles(world)).filter(([name]) => !name.endsWith('/'))
  assert.ok(earlierFiles.length >= 3 && earlierFiles.every(([name]) => name.startsWith('notes/')), 'the earlier release laid the vault out flat')
  assert.equal(world.stateStore().readPathRegistry().layout, undefined)
  earlier.stop()

  const engine = world.engine()
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'current')
  const after = world.manifest()
  assert.deepEqual([after.schema, after.layoutVersion], [V2, 2])
  assert.deepEqual(after.notes.map((note) => note.path).sort(), ['east-wing/notes/Compass rose.md', 'east-wing/notes/Lantern room.md', 'west-wing/logs/Tide log.md'])
  assert.equal(world.stateStore().readPathRegistry().layout, 2, 'the registry is laid out again too')
  // No earlier file is left in the vault, only the folder that held them...
  const now = vaultFiles(world)
  for (const [name] of earlierFiles) assert.equal(now[name], undefined, name)
  assert.deepEqual(Object.keys(now).filter((name) => name.startsWith('notes')), ['notes/'])
  // ...and every one of them is in the recovery area, byte for byte.
  const recovered = new Set(Object.values(treeListing(world.recovery())))
  for (const [name, digest] of earlierFiles) assert.ok(recovered.has(digest), `${name} is retained in recovery`)
  // Laid out once: the next ticks change nothing.
  for (let tick = 0; tick < 2; tick += 1) { world.advance(1000); assert.equal((await engine.tick()).scopes[0].state, 'current') }
  assert.equal(world.manifest().generationId, after.generationId)
})

test('upgrade with a held edit: the view keeps layout 1 while a note is held, the edit applies from its layout 1 generation, and then the view is laid out again with nothing lost', needsExchange, async (t) => {
  const world = upgradeWorld(t)
  const earlier = world.engine({ seams: EARLIER_RELEASE })
  await earlier.tick()
  const edited = world.editNote('east-wing:lantern', 'once a minute', 'twice a minute')
  world.advance(1000)
  assert.equal((await earlier.tick()).scopes[0].state, 'held-for-your-edit')
  earlier.stop()
  const edit = world.editOf('east-wing:lantern')
  assert.match(edit.path, /^notes\/Lantern room--[0-9a-f]{12}\.md$/)

  // The new release: while the note is held nothing moves, and a source that changes is still prepared in layout 1.
  const engine = world.engine()
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'held-for-your-edit')
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nA line added at the source.\n')
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'held-for-your-edit')
  const heldManifest = world.manifest()
  assert.equal(heldManifest.schema, V1)
  assert.match(heldManifest.notes.find((note) => note.nodeId === 'west-wing:tide').path, /^notes\/Tide log--[0-9a-f]{12}\.md$/)
  assert.match(fs.readFileSync(world.noteFile('west-wing:tide'), 'utf8'), /A line added at the source/)
  assert.deepEqual(fs.readFileSync(path.join(world.vault(), edit.path)), edited, 'the held note is untouched')

  // The edit applies: the published note of its layout 1 generation is prepared again in that layout.
  const result = await world.sourceApply().apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
  assert.deepEqual([result.status, result.code], ['applied', 'applied'])
  assert.match(fs.readFileSync(world.source('east-wing/notes/lantern.md'), 'utf8'), /twice a minute/)

  // The hold lifts, and then the view is laid out again.
  for (let tick = 0; tick < 3; tick += 1) { world.advance(1000); await engine.tick() }
  const after = world.manifest()
  assert.deepEqual([after.schema, after.layoutVersion], [V2, 2])
  assert.equal(world.pendingEdits().find((item) => item.editId === edit.editId).state, 'withdrawn')
  assert.equal(after.notes.find((note) => note.nodeId === 'east-wing:lantern').path, 'east-wing/notes/Lantern room.md')
  assert.match(fs.readFileSync(world.noteFile('east-wing:lantern'), 'utf8'), /twice a minute/)
  // Nothing is lost: the person's bytes are in the object store and the note they edited is in recovery.
  assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), edit.objectRef)), edited)
  assert.ok(new Set(Object.values(treeListing(world.recovery()))).has(digestOf(edited)), 'the layout 1 note the person edited is retained')
  assert.equal(fs.existsSync(path.join(world.vault(), edit.path)), false)
})

test('upgrade with a held edit in a repository named like the layout 1 folder: the held file never stops the view, and after the edit applies it is laid out again', needsExchange, async (t) => {
  // `Notes` is one folder with `notes`, where layout 1 keeps every note, on a case-insensitive file system.
  const world = makeApplyWorld(t, {
    repositories: ['Notes'],
    files: {
      'Notes/lantern.md': noteText({ id: 'Notes:lantern', title: 'Lantern room', body: 'The lamp turns once a minute.' }),
      'Notes/compass.md': noteText({ id: 'Notes:compass', title: 'Compass rose', body: 'North is painted red.' }),
    },
  })
  const earlier = world.engine({ seams: EARLIER_RELEASE })
  await earlier.tick()
  world.editNote('Notes:lantern', 'once a minute', 'twice a minute')
  world.advance(1000)
  const heldEarlier = (await earlier.tick()).scopes[0]
  assert.equal(heldEarlier.state, 'held-for-your-edit', JSON.stringify(heldEarlier))
  earlier.stop()
  const edit = world.editOf('Notes:lantern')
  assert.match(edit.path, /^notes\/Lantern room--[0-9a-f]{12}\.md$/)

  // The held file keeps its folder, spelled `notes`; the repository's folder is told apart from it, and nothing refuses.
  const engine = world.engine()
  for (let tick = 0; tick < 2; tick += 1) {
    world.advance(1000)
    const report = await engine.tick()
    assert.deepEqual([report.scopes[0].state, world.manifest().schema], ['held-for-your-edit', V1], JSON.stringify(report.scopes[0]))
  }
  const result = await world.sourceApply().apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
  assert.deepEqual([result.status, result.code], ['applied', 'applied'])

  // The hold lifts, and the view is laid out again, the repository's folder told apart from the one layout 1 left.
  for (let tick = 0; tick < 3; tick += 1) { world.advance(1000); await engine.tick() }
  const after = world.manifest()
  assert.deepEqual([after.schema, after.layoutVersion], [V2, 2])
  const folder = after.notes[0].path.split('/')[0]
  assert.match(folder, /^Notes \([0-9a-f]{6}\)$/)
  assert.deepEqual(after.notes.map((note) => note.path).sort(), [`${folder}/Compass rose.md`, `${folder}/Lantern room.md`])
  assert.equal(world.pendingEdits().some((item) => item.closedAt === null), false, 'no edit is left queued')
  assert.match(fs.readFileSync(world.noteFile('Notes:lantern'), 'utf8'), /twice a minute/)
})

test('upgrade in a workspace with a repository named like the layout 1 folder: every note is on disk under the folder its manifest names', needsExchange, async (t) => {
  const world = makeApplyWorld(t, { repositories: ['Notes'], files: { 'Notes/lantern.md': noteText({ id: 'Notes:lantern', title: 'Lantern room', body: 'The lamp turns once a minute.' }) } })
  const earlier = world.engine({ seams: EARLIER_RELEASE })
  await earlier.tick()
  earlier.stop()
  const engine = world.engine()
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'current')
  const [lantern] = world.manifest().notes.map((note) => note.path)
  const [folder, name] = lantern.split('/')
  // The `notes` folder the upgrade leaves behind and the repository's folder are two folders, on a file system that
  // compares names case-insensitively too, so the app reports the note under exactly the path the manifest records.
  assert.match(folder, /^Notes \([0-9a-f]{6}\)$/)
  assert.ok(fs.readdirSync(world.vault()).includes(folder), JSON.stringify(fs.readdirSync(world.vault())))
  assert.deepEqual(fs.readdirSync(path.join(world.vault(), folder)), [name])
})

test('the engine hands prepareView the files of open edits as held, those of edits closed on the tick only as holding the layout, and the views it maintains', needsExchange, async (t) => {
  const world = upgradeWorld(t)
  const earlier = world.engine({ seams: EARLIER_RELEASE })
  await earlier.tick()
  earlier.stop()
  world.editNote('east-wing:lantern', 'once a minute', 'twice a minute')
  world.installPolicy({ selector: { repo: 'east-wing' } })
  world.configureMachine({ maintenanceMode: 'automatic' })
  const calls = []
  const spy = { prepareView(input) { calls.push({ heldNotePaths: input.heldNotePaths, layoutHeldNotePaths: input.layoutHeldNotePaths, viewScopeIds: input.viewScopeIds }); return prepareView(input) } }
  const engine = world.engine({ seams: spy, applyOperation: createEngineApplyOperation({ context: { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, clock: world.clock } }) })
  world.advance(1000)
  assert.deepEqual((await engine.tick()).dispatched.map((item) => item.status), ['applied'])
  const closed = world.pendingEdits().find((item) => item.identity.nodeId === 'east-wing:lantern')
  assert.notEqual(closed.closedAt, null)
  assert.deepEqual(calls.at(-1), { heldNotePaths: [], layoutHeldNotePaths: [closed.path], viewScopeIds: ['scope-whole'] })
})

test('upgrade with a withdrawn edit: the view keeps layout 1 while the note is held and on the tick its edit closes, and is laid out again once the person restores the note', needsExchange, async (t) => {
  const world = upgradeWorld(t)
  const earlier = world.engine({ seams: EARLIER_RELEASE })
  await earlier.tick()
  const published = fs.readFileSync(world.noteFile('east-wing:lantern'))
  world.editNote('east-wing:lantern', 'once a minute', 'twice a minute')
  world.advance(1000)
  assert.equal((await earlier.tick()).scopes[0].state, 'held-for-your-edit')
  earlier.stop()
  const edit = world.editOf('east-wing:lantern')

  const engine = world.engine()
  world.advance(1000)
  assert.equal((await engine.tick()).scopes[0].state, 'held-for-your-edit')
  assert.equal(world.manifest().schema, V1)
  // The person puts the note back as it was published: the edit is withdrawn and the hold lifts. The tick that closes
  // the edit still prepares layout 1, and the next one lays the view out again.
  fs.writeFileSync(path.join(world.vault(), edit.path), published)
  world.advance(1000)
  await engine.tick()
  assert.equal(world.pendingEdits().find((item) => item.editId === edit.editId).state, 'withdrawn')
  assert.equal(world.manifest().schema, V1, 'an edit closed on this tick holds the layout on this tick')
  for (let tick = 0; tick < 2; tick += 1) { world.advance(1000); await engine.tick() }
  const after = world.manifest()
  assert.deepEqual([after.schema, after.layoutVersion], [V2, 2])
  assert.equal(world.pendingEdits().find((item) => item.editId === edit.editId).state, 'withdrawn')
  assert.doesNotMatch(fs.readFileSync(world.noteFile('east-wing:lantern'), 'utf8'), /twice a minute/)
  assert.equal(fs.existsSync(path.join(world.vault(), edit.path)), false)
  assert.ok(new Set(Object.values(treeListing(world.recovery()))).has(digestOf(published)), 'the layout 1 note is retired to recovery')
})

test('upgrade in automatic mode: an edit applied on the tick that would lay the view out again keeps layout 1 until its note is published, and the edited file is then retired, never left unobserved', needsExchange, async (t) => {
  const world = upgradeWorld(t)
  const earlier = world.engine({ seams: EARLIER_RELEASE })
  await earlier.tick()
  earlier.stop()
  const edited = world.editNote('east-wing:lantern', 'once a minute', 'twice a minute')
  world.installPolicy({ selector: { repo: 'east-wing' } })
  world.configureMachine({ maintenanceMode: 'automatic' })
  const engine = world.engine({ applyOperation: createEngineApplyOperation({ context: { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, clock: world.clock } }) })

  // One tick observes the edit, applies it, and publishes the note in layout 1 from the new source: the note the
  // person edited is the published note.
  world.advance(1000)
  assert.deepEqual((await engine.tick()).dispatched.map((item) => item.status), ['applied'])
  assert.match(fs.readFileSync(world.source('east-wing/notes/lantern.md'), 'utf8'), /twice a minute/)
  const held = world.manifest()
  assert.equal(held.schema, V1)
  const lantern = held.notes.find((note) => note.nodeId === 'east-wing:lantern')
  assert.equal(lantern.noteDigest, digestOf(edited))
  // The next tick lays the view out again and retires every layout 1 file, the one the person edited included.
  world.advance(1000)
  await engine.tick()
  assert.deepEqual([world.manifest().schema, world.manifest().layoutVersion], [V2, 2])
  assert.deepEqual(Object.keys(vaultFiles(world)).filter((name) => name.startsWith('notes/') && !name.endsWith('/')), [], 'no layout 1 file is left behind')
  assert.ok(new Set(Object.values(treeListing(world.recovery()))).has(digestOf(edited)), 'the edited file is retained in recovery')
  assert.match(fs.readFileSync(world.noteFile('east-wing:lantern'), 'utf8'), /twice a minute/)
})

test('prepareView keeps layout 1 exactly while the prior generation is in layout 1 and holds a note, and lays out again otherwise', (t) => {
  const cleanups = []
  t.after(() => { for (const cleanup of cleanups) cleanup() })
  const files = Object.fromEntries(Object.entries(UPGRADE_FILES).map(([name, text]) => [name, { text }]))
  const { prepared: first, inputs } = prepareWorkspace({ after: (fn) => cleanups.push(fn) }, { repositories: ['east-wing', 'west-wing'], files }, { layout: 1 })
  assert.equal(first.manifest.schema, V1)
  const again = (extra) => prepareView({ ...inputs, priorManifest: first.manifest, ...extra })
  // Held: the generation is prepared exactly as the earlier release prepared it.
  const held = again({ heldNotePaths: [first.manifest.notes[1].path] })
  assert.deepEqual(held.manifestBytes, first.manifestBytes)
  assert.deepEqual(held.files.map((file) => [file.path, file.digest]), first.files.map((file) => [file.path, file.digest]))
  assert.equal(held.persistentPathRegistry.layout, 2, 'the persistent registry is laid out again whichever layout the view is prepared in')
  // Not held, or held only for a path the prior generation does not hold: laid out again, every layout 1 path reported removed.
  for (const heldNotePaths of [null, [], ['notes/Elsewhere--0123456789ab.md']]) {
    const relaid = again({ heldNotePaths })
    assert.deepEqual([relaid.manifest.schema, relaid.manifest.layoutVersion], [V2, 2])
    assert.deepEqual(relaid.changes.removed, first.manifest.notes.map((note) => note.path).sort())
    assert.deepEqual(relaid.changes.added, relaid.manifest.notes.map((note) => note.path))
  }
  // A layout 2 generation with a held note stays in layout 2, on its own paths.
  const second = again({})
  const stays = prepareView({ ...inputs, priorManifest: second.manifest, persistentPathRegistry: second.persistentPathRegistry, heldNotePaths: [second.manifest.notes[0].path] })
  assert.deepEqual(stays.manifestBytes, second.manifestBytes)
  // An explicit layout is what recovering a generation as it was published asks for; anything else refuses.
  assert.deepEqual(prepareView({ ...inputs, priorManifest: first.manifest, layout: 1 }).manifestBytes, first.manifestBytes)
  assert.throws(() => prepareView({ ...inputs, layout: 3 }), { code: 'invalid-layout' })
  assert.throws(() => prepareView({ ...inputs, heldNotePaths: 'notes/x.md' }), { code: 'invalid-held-notes' })
})
