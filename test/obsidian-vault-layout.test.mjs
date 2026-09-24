import assert from 'node:assert/strict'
import test from 'node:test'
import {
  fileNameParts, folderNameOf, identityLineTexts, isReadableVaultPath, joinFileName, noteNameOf, qualifierIdOf, vaultName, validateObsidianContract,
} from '../src/projection/obsidian/contracts.mjs'
import { applyEditLens } from '../src/projection/obsidian/edits/index.mjs'
import { PATH_REGISTRY_SCHEMA, allocateWorkspacePaths, collisionKey, prepareView } from '../src/projection/obsidian/materialize/index.mjs'
import { prepareWorkspace } from './support/obsidian-edits/workspace.mjs'

// Vault layout 2: file names are titles, folders mirror the repository, and
// each note names its identity in generated properties. Invented, synthetic
// content only. See "Vault layout" in docs/obsidian-contract.md.

const EXT = 'mnstry.atelier.obsidian'
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

const allocate = (nodes, registry = null, assets = []) => allocateWorkspacePaths({ registry, workspaceId: 'ws', nodes, assets })
const pathsOf = (result) => Object.fromEntries(result.registry.entries.map((entry) => [entry.nodeId, entry.path]))

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
  for (const entry of result.registry.entries) assert.doesNotMatch(entry.path, /[0-9a-f]{6}\)/, 'no hash in a name that collides with nothing')
  assert.deepEqual([result.registry.schema, result.registry.layout], [PATH_REGISTRY_SCHEMA, 2])
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
    assert.deepEqual(allocate(order).registry, first.registry)
  }
  // A newcomer that would take an allocated name is qualified; nothing allocated moves.
  const grown = allocate([...nodes, node('r', 'r:0', 'a/zero.md', 'Plan')], first.registry)
  for (const entry of first.registry.entries) assert.equal(pathsOf(grown)[entry.nodeId], entry.path)
  assert.equal(pathsOf(grown)['r:0'], 'r/a/Plan (zero).md', 'r:0 sorts first but came last: the existing Plan keeps its name')
  // A node that leaves the census and comes back keeps its path.
  const without = allocate(nodes.filter((item) => item.id !== 'r:1'), grown.registry)
  const returned = allocate(nodes, without.registry)
  assert.equal(pathsOf(returned)['r:1'], pathsOf(first)['r:1'])
  // First come, first named: the same two titles in the other order of arrival swap names, and each keeps it afterwards.
  const earlyTwo = allocate([node('r', 'r:2', 'a/two.md', 'Plan')])
  const thenOne = allocate([node('r', 'r:1', 'a/one.md', 'Plan'), node('r', 'r:2', 'a/two.md', 'Plan')], earlyTwo.registry)
  assert.deepEqual(pathsOf(thenOne), { 'r:1': 'r/a/Plan (one).md', 'r:2': 'r/a/Plan.md' })
})

test('a retitled source keeps its path; repositories whose folders would collide are told apart', () => {
  const first = allocate([node('r', 'r:1', 'a/one.md', 'Old title')])
  // (A title that is exactly the title-cased file name reads as the graph's fallback: the stem names the note.)
  assert.equal(pathsOf(allocate([node('r', 'r:2', 'a/intro.md', 'Intro')]))['r:2'], 'r/a/intro.md')
  const retitled = allocate([node('r', 'r:1', 'a/one.md', 'New title')], first.registry)
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

test('a layout 1 registry is set aside: layout 2 allocates anew, and a malformed layout 2 registry refuses', () => {
  const legacy = { schema: PATH_REGISTRY_SCHEMA, workspaceId: 'ws', entries: [{ repoId: 'r', nodeId: 'r:1', path: 'notes/One--0123456789ab.md' }] }
  assert.deepEqual(pathsOf(allocate([node('r', 'r:1', 'a/one.md', 'First one')], legacy)), { 'r:1': 'r/a/First one.md' })
  const readable = allocate([node('r', 'r:1', 'a/one.md', 'First one')]).registry
  for (const entry of [{ repoId: 'r', nodeId: 'r:2', path: 'r/a/.hidden.md' }, { repoId: 'r', nodeId: 'r:2', path: 'r/a/b#c.md' }, { repoId: 'r', nodeId: 'r:2', path: 'r/a/two.txt' }, { repoId: 'r', nodeId: 'r:2', path: 'two.md' }]) {
    assert.throws(() => allocate([], { ...readable, entries: [...readable.entries, entry] }), { code: 'invalid-path-registry' }, entry.path)
  }
  assert.throws(() => allocate([], { ...readable, entries: [...readable.entries, { repoId: 'q', nodeId: 'q:1', path: 'r/b/x.md' }] }), { code: 'invalid-path-registry' }, 'two repositories, one folder')
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
  // The author's own key of that name is left as written, beside the generated block at the end.
  assert.ok(cases.get('notes/taken.md').publishedNoteBytes.toString('utf8').startsWith('---\ntitle: "Taken key"\natelier-id: "mine"\n'))
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
