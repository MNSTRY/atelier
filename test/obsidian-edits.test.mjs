import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ALIGN_LIMITS,
  EDIT_LENS_PRIMITIVES,
  EDIT_LENS_REFUSALS,
  alignBodies,
  applyEditLens,
  createEditLensForOracleTests,
  placeUnits,
} from '../src/projection/obsidian/edits/index.mjs'
import { sha256Digest } from '../src/projection/obsidian/materialize/index.mjs'
import { EXT, prepareWorkspace } from './support/obsidian-edits/workspace.mjs'

// Invented fixtures only. Every note under test is the output of the real
// prepareView over a workspace written to a temporary directory; an edit is a
// byte-level change to such a note, and every expected source is computed here
// from the fixture's source bytes, never by the lens.

const root = fileURLToPath(new URL('..', import.meta.url))
const workspace = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/obsidian/edits/workspace.json'), 'utf8'))
const ALPHA_MD = 'Alpha%20topic--2af151f3fa6d.md'
const ALPHA_WIKI = 'Alpha topic--2af151f3fa6d'
const BETA_WIKI = 'Beta topic--8051619ff050'

const cleanups = []
let cases
before(() => {
  ({ cases } = prepareWorkspace({ after: (fn) => cleanups.push(fn) }, workspace))
})
after(() => {
  for (const cleanup of cleanups) cleanup()
})

const utf8 = (text) => Buffer.from(text, 'utf8')
const asBytes = (value) => (Buffer.isBuffer(value) ? value : utf8(value))

function replaceNth(buffer, from, to, nth = 0) {
  const needle = asBytes(from)
  let at = buffer.indexOf(needle)
  for (let seen = 0; seen < nth && at !== -1; seen += 1) at = buffer.indexOf(needle, at + 1)
  assert.notEqual(at, -1, 'the fixture no longer holds the bytes this case edits')
  return Buffer.concat([buffer.subarray(0, at), asBytes(to), buffer.subarray(at + needle.length)])
}
const applyAll = (buffer, steps, context) => steps.reduce((bytes, step) => (typeof step === 'function' ? step(bytes, context) : replaceNth(bytes, ...step)), buffer)
const insertAt = (buffer, offset, bytes) => Buffer.concat([buffer.subarray(0, offset), asBytes(bytes), buffer.subarray(offset)])
const atBodyEnd = (bytes) => (note, context) => insertAt(note, context.note.regions.body.end, bytes)
const atSourceEnd = (bytes) => (source) => Buffer.concat([source, asBytes(bytes)])
const authoredOf = (context) => context.publishedNoteBytes.subarray(0, context.note.regions.body.end)
const generatedOf = (context) => context.publishedNoteBytes.subarray(context.note.regions.body.end)

const runLens = (context, editedNoteBytes, lens = applyEditLens, overrides = {}) => lens({
  manifest: context.manifest, repoId: context.repoId, nodeId: context.nodeId, publishedNoteBytes: context.publishedNoteBytes, baseSourceBytes: context.baseSourceBytes, editedNoteBytes, ...overrides,
})

function assertExactSource(context, result, expected, label) {
  assert.equal(result.kind, 'body-replacement', `${label}: refused with ${result.code}`)
  assert.equal(result.newSourceBytes.toString('hex'), expected.toString('hex'), `${label}: new source bytes differ`)
  assert.equal(result.baseSourceDigest, sha256Digest(context.baseSourceBytes), label)
  assert.equal(result.newSourceDigest, sha256Digest(expected), label)
  assert.equal(result.unchanged, expected.equals(context.baseSourceBytes), label)
  // The changed ranges alone rebuild the new source from the base.
  const parts = []
  let cursor = 0
  for (const range of result.changedRanges) {
    assert.ok(range.start >= cursor && range.end >= range.start && range.start >= context.note.regions.body.start, `${label}: changed ranges are ordered and inside the body`)
    parts.push(context.baseSourceBytes.subarray(cursor, range.start), result.newSourceBytes.subarray(range.newStart, range.newEnd))
    cursor = range.end
  }
  parts.push(context.baseSourceBytes.subarray(cursor))
  assert.equal(Buffer.concat(parts).toString('hex'), expected.toString('hex'), `${label}: changed ranges do not rebuild the new source`)
  // Every byte outside the authored body is the source's own.
  const bodyStart = context.note.regions.body.start
  assert.equal(result.newSourceBytes.subarray(0, bodyStart).toString('hex'), context.baseSourceBytes.subarray(0, bodyStart).toString('hex'), `${label}: prefix bytes changed`)
}

function assertRefusal(result, code, label) {
  assert.equal(result.kind, 'refusal', `${label}: expected ${code}, got a body replacement`)
  assert.equal(result.code, code, label)
  assert.ok(EDIT_LENS_REFUSALS.includes(result.code), label)
}

// Broken lenses for the mutation controls. Each one is the real lens with one
// primitive replaced.
const broken = {
  keepsEmittedBytes: createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, originalOf: (unit) => unit.emitted }),
  givesSeparatorToAuthor: createEditLensForOracleTests({
    ...EDIT_LENS_PRIMITIVES,
    splitGeneratedTail: (input) => {
      const tail = EDIT_LENS_PRIMITIVES.splitGeneratedTail(input)
      return tail.generated === 'intact' ? { ...tail, authored: input.editedNoteBytes.subarray(0, tail.authored.length + 1) } : tail
    },
  }),
  acceptsAnyGeneratedTail: createEditLensForOracleTests({
    ...EDIT_LENS_PRIMITIVES,
    splitGeneratedTail: (input) => {
      try { return EDIT_LENS_PRIMITIVES.splitGeneratedTail(input) } catch { return { authored: input.editedNoteBytes, generated: 'removed' } }
    },
  }),
  keepsSeparatorOfRemovedTail: createEditLensForOracleTests({
    ...EDIT_LENS_PRIMITIVES,
    splitGeneratedTail: (input) => {
      const tail = EDIT_LENS_PRIMITIVES.splitGeneratedTail(input)
      return tail.generated === 'removed' ? { ...tail, authored: input.editedNoteBytes } : tail
    },
  }),
  ignoresFrontMatter: createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, splitPrefix: ({ noteEntry, editedAuthored }) => editedAuthored.subarray(noteEntry.regions.body.start) }),
  normalizesNewlines: createEditLensForOracleTests({
    ...EDIT_LENS_PRIMITIVES,
    splitPrefix: (input) => utf8(EDIT_LENS_PRIMITIVES.splitPrefix(input).toString('utf8').replaceAll('\r\n', '\n')),
  }),
  seesNoStructuralLinks: createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, findStructuralLinks: () => [] }),
  callsEditedRewritesDeleted: createEditLensForOracleTests({
    ...EDIT_LENS_PRIMITIVES,
    placeUnits: (input) => {
      try { return EDIT_LENS_PRIMITIVES.placeUnits(input) } catch { return input.units.map(() => ({ state: 'deleted' })) }
    },
  }),
  acceptsAnyEncoding: createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, isStrictUtf8: () => true }),
  editsWrappers: createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, isEditableSource: () => true }),
}

// ---------------------------------------------------------------------------
// Unedited notes
// ---------------------------------------------------------------------------

function unchangedOracle(lens) {
  let markdown = 0
  for (const [sourcePath, context] of cases) {
    if (context.note.ext[EXT].source.kind !== 'markdown') continue
    markdown += 1
    const result = runLens(context, context.publishedNoteBytes, lens)
    assertExactSource(context, result, context.baseSourceBytes, sourcePath)
    assert.deepEqual(result.changedRanges, [], sourcePath)
  }
  assert.ok(markdown >= 16)
}

test('lens: an unedited note inverts to the byte-identical source for every fixture', () => {
  unchangedOracle(applyEditLens)
  assert.throws(() => unchangedOracle(broken.keepsEmittedBytes), 'mutation control: a lens that leaves emitted link bytes in place')
  assert.throws(() => unchangedOracle(broken.givesSeparatorToAuthor), 'mutation control: a lens that gives a generated separator byte to the author')
})

// ---------------------------------------------------------------------------
// Table: edits that become exact source bytes
// ---------------------------------------------------------------------------

// { name, file, note: steps over the published note, source: steps over the base source }.
// A step is [from, to, nth] or a function. `source` defaults to `note`.
const BODY_EDITS = [
  { name: 'byte order prefix kept, text edited', file: 'log.md', note: [['naïve', 'naïve and more']] },
  { name: 'byte order prefix dropped by the editor is kept from the source', file: 'log.md', note: [['naïve', 'naïve and more'], (note) => note.subarray(3)], source: [['naïve', 'naïve and more']] },
  { name: 'rewritten link beside the byte order prefix stays inverted', file: 'log.md', note: [['a link to', 'one link to']] },
  { name: 'CRLF line added with CRLF', file: 'topics/alpha.md', note: [['## Part one\r\n', '## Part one\r\nAdded line\r\n']] },
  { name: 'bare LF typed into a CRLF note is not normalized', file: 'topics/alpha.md', note: [['Back to', 'Typed with a bare newline\nBack to']] },
  { name: 'mixed line endings survive an edit', file: 'topics/beta.md', note: [['Mixed line endings', 'Mixed endings']] },
  { name: 'final newline added to a note that had none', file: 'topics/beta.md', note: [atBodyEnd('\n')], source: [atSourceEnd('\n')] },
  { name: 'no front matter', file: 'bare.md', note: [['no links', 'no links yet']] },
  { name: 'derived-only metadata: generated relations, no authored link', file: 'delta.md', note: [['No authored links here at all.', 'Still no authored links.']] },
  { name: 'edit inside a closed code fence', file: 'guide.md', note: [['[fenced](topics/alpha.md)', '[fenced](topics/alpha.md) plus `more`']] },
  { name: 'a vault-looking link typed inside a code fence is code', file: 'guide.md', note: [['[[Alpha topic]]\n```', `[[${ALPHA_WIKI}]]\n\`\`\``]] },
  { name: 'edit before an unclosed fence', file: 'open-fence.md', note: [['Before the fence', 'Ahead of the fence']] },
  { name: 'edit inside an unclosed fence', file: 'open-fence.md', note: [['const answer = 42', 'const answer = 43']] },
  { name: 'text appended inside an unclosed fence, before the generated closure', file: 'open-fence.md', note: [atBodyEnd('\nmore()')], source: [atSourceEnd('\nmore()')] },
  { name: 'a person who closes the fence themselves', file: 'open-fence.md', note: [atBodyEnd('\n```')], source: [atSourceEnd('\n```')] },
  { name: 'edit inside an unclosed CRLF fence', file: 'open-fence-crlf.md', note: [['raw text', 'raw text, longer']] },
  { name: 'escaped brackets', file: 'guide.md', note: [['\\[escaped\\] text', '\\[escaped\\] words']] },
  { name: 'link in inline code edited', file: 'guide.md', note: [['`[[Alpha topic]]` in inline', '`[[Alpha topic|shown]]` in inline']] },
  { name: 'heading reference edited', file: 'guide.md', note: [['#Part one|', '#Part two|']], source: [['#Part one]]', '#Part two]]']] },
  { name: 'block reference edited', file: 'guide.md', note: [['^blk1|', '^blk2|']], source: [['^blk1]]', '^blk2]]']] },
  { name: 'wikilink embed size edited', file: 'guide.md', note: [['|200]]', '|320]]']] },
  { name: 'markdown embed label edited', file: 'guide.md', note: [['![plan](', '![floor plan](']] },
  { name: 'markdown link deleted', file: 'guide.md', note: [[`[first](${ALPHA_MD}) and `, '']], source: [['[first](topics/alpha.md) and ', '']] },
  { name: 'wikilink and its appended alias deleted', file: 'guide.md', note: [[`[[${ALPHA_WIKI}|Alpha topic]] before `, '']], source: [['[[Alpha topic]] before ', '']] },
  { name: 'embeds deleted', file: 'guide.md', note: [['Pictures: ![plan](attachments/plan--f4c650b30ceb.png) and ![[attachments/plan--f4c650b30ceb.png|200]].\n', '']], source: [['Pictures: ![plan](assets/plan.png) and ![[assets/plan.png|200]].\n', '']] },
  { name: 'text edited between two rewritten links', file: 'guide.md', note: [[' before [second]', ' well before [second]']] },
  { name: 'text inserted immediately before and after a rewritten link', file: 'guide.md', note: [['see [first](', 'see!![first]('], [`${ALPHA_MD}) and`, `${ALPHA_MD})?? and`]], source: [['see [first](', 'see!![first]('], ['(topics/alpha.md) and', '(topics/alpha.md)?? and']] },
  { name: 'link label edited', file: 'guide.md', note: [['[again](', '[once again](']] },
  { name: 'edits on both sides of several rewritten links', file: 'guide.md', note: [['Überblick', 'Überblick (kurz)'], ['Closing words.', 'Closing words, revised.'], ['Twice over', 'Two times over']] },
  { name: 'same target linked twice, the first deleted', file: 'twins.md', note: [[`[left](${ALPHA_MD}), `, '']], source: [['[left](topics/alpha.md), ', '']] },
  { name: 'same target linked twice, the second deleted', file: 'twins.md', note: [[`, [right](${ALPHA_MD})`, '']], source: [[', [right](./topics/alpha.md)', '']] },
  { name: 'same target linked twice, text edited around both', file: 'twins.md', note: [['Pair:', 'A pair:'], [' end.', ' the end.'], ['some words', 'a few words']] },
  { name: 'new external link typed', file: 'guide.md', note: [['Closing words.', 'Closing words, see [the site](https://example.invalid/notes/page.md).']] },
  { name: 'new link to something that is not a vault file', file: 'guide.md', note: [['Closing words.', 'Closing words about [[Some other page]] and [here](other/page.md).']] },
  { name: 'a vault-looking link the source already had stays', file: 'lookalike.md', note: [['More words follow.', 'More words follow here.']] },
]

function bodyEditOracle(lens, rows = BODY_EDITS) {
  for (const row of rows) {
    const context = cases.get(row.file)
    const edited = applyAll(context.publishedNoteBytes, row.note, context)
    const expected = applyAll(context.baseSourceBytes, row.source ?? row.note, context)
    assert.ok(!edited.equals(context.publishedNoteBytes), row.name)
    assertExactSource(context, runLens(context, edited, lens), expected, row.name)
  }
}

test('lens: table of body edits, each compared byte for byte with the edited source', () => {
  bodyEditOracle(applyEditLens)
  assert.throws(() => bodyEditOracle(broken.keepsEmittedBytes), 'mutation control: emitted bytes left in the source')
  assert.throws(() => bodyEditOracle(broken.normalizesNewlines), 'mutation control: CRLF rewritten as LF')
  assert.throws(() => bodyEditOracle(broken.givesSeparatorToAuthor), 'mutation control: separator attributed to the author')
})

// ---------------------------------------------------------------------------
// Final newline
// ---------------------------------------------------------------------------

function finalNewlineOracle(lens) {
  let checked = 0
  for (const count of [0, 1, 2]) {
    for (const kind of ['linked', 'alone']) {
      const context = cases.get(`endings/nl${count}-${kind}.md`)
      assert.equal(context.note.regions.generated.length > 0, kind === 'linked')
      const authored = authoredOf(context)
      const edits = [
        { name: 'text appended', authored: Buffer.concat([authored, utf8('Z')]), source: Buffer.concat([context.baseSourceBytes, utf8('Z')]) },
        { name: 'newline appended', authored: Buffer.concat([authored, utf8('\n')]), source: Buffer.concat([context.baseSourceBytes, utf8('\n')]) },
        { name: 'line appended', authored: Buffer.concat([authored, utf8('\nlast line\n')]), source: Buffer.concat([context.baseSourceBytes, utf8('\nlast line\n')]) },
        ...(count > 0 ? [{ name: 'last newline removed', authored: authored.subarray(0, authored.length - 1), source: context.baseSourceBytes.subarray(0, context.baseSourceBytes.length - 1) }] : []),
      ]
      for (const edit of edits) {
        const result = runLens(context, Buffer.concat([edit.authored, generatedOf(context)]), lens)
        assertExactSource(context, result, edit.source, `${count} final newlines, ${kind}, ${edit.name}`)
        checked += 1
      }
    }
  }
  assert.equal(checked, 22)
}

test('regions: every final-newline state of the authored body comes from the edited bytes, never from a generated separator', () => {
  finalNewlineOracle(applyEditLens)
  assert.throws(() => finalNewlineOracle(broken.givesSeparatorToAuthor), 'mutation control')
})

// ---------------------------------------------------------------------------
// Generated regions
// ---------------------------------------------------------------------------

function generatedRefusalOracle(lens) {
  const context = cases.get('guide.md')
  const authored = authoredOf(context)
  const generated = generatedOf(context)
  const lastLine = generated.lastIndexOf(utf8('- links_to'))
  const variants = {
    edited: replaceNth(context.publishedNoteBytes, '- supports →', '- supports =>'),
    'text added after': Buffer.concat([context.publishedNoteBytes, utf8('more\n')]),
    moved: Buffer.concat([authored.subarray(0, authored.length - 16), generated, authored.subarray(authored.length - 16)]),
    duplicated: Buffer.concat([authored, generated, generated]),
    'copied into the body and kept at the end': Buffer.concat([authored.subarray(0, authored.length - 16), generated.subarray(generated.indexOf(utf8('- supports'))), authored.subarray(authored.length - 16), generated]),
    'partially deleted': Buffer.concat([authored, generated.subarray(0, lastLine)]),
    'heading deleted, rows left': Buffer.concat([authored, utf8('\n'), generated.subarray(generated.indexOf(utf8('- supports')))]),
  }
  for (const [name, edited] of Object.entries(variants)) assertRefusal(runLens(context, edited, lens), 'generated-region-edited', name)
  const fence = cases.get('open-fence.md')
  assertRefusal(runLens(fence, replaceNth(fence.publishedNoteBytes, 'Relations (generated)', 'Relations'), lens), 'generated-region-edited', 'heading of a fence-closing region edited')
}

function generatedRemovedOracle(lens) {
  for (const [file, context] of cases) {
    if (context.note.ext[EXT].source.kind !== 'markdown' || context.note.regions.generated.length === 0) continue
    const authored = authoredOf(context)
    const generated = generatedOf(context)
    const closure = context.note.regions.generated[0].ext?.[EXT]?.fenceClosure?.byteLength ?? 0
    let lead = closure
    while (generated[lead] === 0x0a || generated[lead] === 0x0d) lead += 1
    // Whatever is left of the separator and the fence closure, the source is unchanged.
    for (let kept = 0; kept <= lead; kept += 1) {
      const result = runLens(context, Buffer.concat([authored, generated.subarray(0, kept)]), lens)
      assertExactSource(context, result, context.baseSourceBytes, `${file}: generated tail removed, ${kept} leading bytes left`)
      assert.equal(result.generated, 'removed')
    }
    // Removed together with an authored edit: the leading bytes left behind are still not the author's.
    const edited = replaceNth(authored, '# ', '# Revised ')
    const expected = replaceNth(context.baseSourceBytes, '# ', '# Revised ')
    assertExactSource(context, runLens(context, Buffer.concat([edited, generated.subarray(0, lead)]), lens), expected, `${file}: tail removed beside an authored edit`)
    assertExactSource(context, runLens(context, edited, lens), expected, `${file}: tail and separator removed beside an authored edit`)
  }
}

test('regions: a generated region that was edited, moved, duplicated or partially deleted refuses', () => {
  generatedRefusalOracle(applyEditLens)
  assert.throws(() => generatedRefusalOracle(broken.acceptsAnyGeneratedTail), 'mutation control')
})

test('regions: a generated region deleted entirely is not an authored edit, and its separator and fence closure are not the author\'s', () => {
  generatedRemovedOracle(applyEditLens)
  assert.throws(() => generatedRemovedOracle(broken.keepsSeparatorOfRemovedTail), 'mutation control')
})

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const REFUSED_EDITS = [
  { name: 'appended alias edited', file: 'guide.md', code: 'link-rewrite-edited', note: [['|Alpha topic]] before', '|the alpha]] before']] },
  { name: 'appended alias extended', file: 'guide.md', code: 'link-rewrite-edited', note: [['|Alpha topic]] before', '|Alpha topics]] before']] },
  { name: 'appended alias removed, link kept', file: 'guide.md', code: 'link-rewrite-edited', note: [['|Alpha topic]] before', ']] before']] },
  { name: 'rewritten wikilink target removed, alias kept', file: 'guide.md', code: 'unsupported-structural-edit', note: [[`[[${ALPHA_WIKI}|Alpha topic]] before`, '[[|Alpha topic]] before']] },
  { name: 'rewritten target partly retyped', file: 'guide.md', code: 'unsupported-structural-edit', note: [[`[first](${ALPHA_MD})`, '[first](Alpha%20topic--2af151f3fa6d.txt)']] },
  { name: 'rewritten target retargeted to another note', file: 'guide.md', code: 'unsupported-structural-edit', note: [[`[[${ALPHA_WIKI}|Alpha topic]] before`, `[[${BETA_WIKI}|Alpha topic]] before`]] },
  { name: 'text typed against a rewritten target', file: 'guide.md', code: 'unsupported-structural-edit', note: [[`[first](${ALPHA_MD})`, `[first](zz${ALPHA_MD})`]] },
  { name: 'text typed after a rewritten target', file: 'guide.md', code: 'unsupported-structural-edit', note: [[`[first](${ALPHA_MD})`, `[first](${ALPHA_MD}zz)`]] },
  { name: 'rewritten link copied elsewhere', file: 'guide.md', code: 'unsupported-structural-edit', note: [['Closing words.', `Closing words. [first](${ALPHA_MD})`]] },
  { name: 'authored lookalike link duplicated', file: 'lookalike.md', code: 'unsupported-structural-edit', note: [['More words follow.', 'More words and a second [list](notes/todo.md) follow.']] },
  { name: 'ambiguous deletion between two spellings of one target', file: 'twins.md', code: 'ambiguous-link-alignment', note: [[`${ALPHA_MD}) [two](`, '']] },
  { name: 'front matter edited', file: 'guide.md', code: 'unsupported-frontmatter-edit', note: [['title: "Field guide"', 'title: "Field guide, revised"']] },
  { name: 'text typed before the front matter', file: 'guide.md', code: 'unsupported-frontmatter-edit', note: [(note) => Buffer.concat([utf8('x'), note])] },
  { name: 'front matter added to a note without one', file: 'bare.md', code: 'unsupported-frontmatter-edit', note: [(note) => Buffer.concat([utf8('---\ntitle: "Added"\n---\n'), note])] },
  { name: 'invalid UTF-8', file: 'guide.md', code: 'invalid-utf8', note: [(note, context) => insertAt(note, context.note.regions.body.start + 4, Buffer.from([0xff]))] },
  { name: 'truncated UTF-8 sequence', file: 'log.md', code: 'invalid-utf8', note: [['naïve', Buffer.from([0x6e, 0x61, 0xc3])]] },
  { name: 'wrapper note', file: 'charts/table.pdf', code: 'unsupported-wrapper-edit', note: [['Format', 'Formats']] },
]

function refusalOracle(lens, only = null) {
  for (const row of REFUSED_EDITS) {
    if (only && !only.includes(row.code)) continue
    const context = cases.get(row.file)
    assertRefusal(runLens(context, applyAll(context.publishedNoteBytes, row.note, context), lens), row.code, row.name)
  }
}

test('lens: edits that are not a body replacement are typed refusals', () => {
  refusalOracle(applyEditLens)
  assert.throws(() => refusalOracle(broken.callsEditedRewritesDeleted, ['link-rewrite-edited']), 'mutation control: edited aliases taken for deletions')
  assert.throws(() => refusalOracle(broken.seesNoStructuralLinks, ['unsupported-structural-edit']), 'mutation control: no structural check')
  assert.throws(() => refusalOracle(broken.ignoresFrontMatter, ['unsupported-frontmatter-edit']), 'mutation control: front matter unchecked')
  assert.throws(() => refusalOracle(broken.acceptsAnyEncoding, ['invalid-utf8']), 'mutation control: encoding unchecked')
  assert.throws(() => refusalOracle(broken.editsWrappers, ['unsupported-wrapper-edit']), 'mutation control: wrappers editable')
})

function structuralOffsetsOracle(lens) {
  const context = cases.get('guide.md')
  const typed = { wikilink: `[[${BETA_WIKI}]]`, markdown: '[beta](notes/Beta%20topic--8051619ff050.md)', bare: `[b](${BETA_WIKI.replaceAll(' ', '%20')}.md)`, embed: '[[attachments/plan--f4c650b30ceb.png]]', folder: '[[notes/Anything at all]]' }
  for (const [name, text] of Object.entries(typed)) {
    const edited = replaceNth(context.publishedNoteBytes, 'Closing words.', `Closing words and ${text}.`)
    const result = runLens(context, edited, lens)
    assertRefusal(result, 'unsupported-structural-edit', name)
    assert.deepEqual(result.detail.occurrences.map((item) => edited.subarray(item.noteStart, item.noteEnd).toString('utf8')), [text], name)
  }
}

test('lens: a new vault-internal link is a structural refusal that names its byte offsets in the edited note', () => {
  structuralOffsetsOracle(applyEditLens)
  assert.throws(() => structuralOffsetsOracle(broken.seesNoStructuralLinks), 'mutation control')
})

function baseOracle(lens, staleBytes) {
  const context = cases.get('guide.md')
  const edited = replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words, revised.')
  const stale = runLens(context, edited, lens, { baseSourceBytes: staleBytes })
  assertRefusal(stale, 'stale-base', 'source changed since the note was generated')
  assert.deepEqual(stale.detail, { expected: sha256Digest(context.baseSourceBytes), actual: sha256Digest(staleBytes) })
  const other = cases.get('delta.md')
  assertRefusal(runLens(context, edited, lens, { publishedNoteBytes: other.publishedNoteBytes }), 'baseline-mismatch', 'published bytes of another note')
  assertRefusal(runLens(context, edited, lens, { publishedNoteBytes: edited }), 'baseline-mismatch', 'the edited note offered as its own baseline')
  assertRefusal(runLens(context, edited, lens, { nodeId: 'reading-room:absent' }), 'unknown-note', 'identity the manifest does not hold')
}

test('lens: the base source and the published note must be the bytes the manifest recorded', () => {
  const context = cases.get('guide.md')
  const staleBytes = replaceNth(context.baseSourceBytes, 'Closing words.', 'Closing words!')
  baseOracle(applyEditLens, staleBytes)
  const trusting = createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, digestOf: (bytes) => (bytes.equals(staleBytes) ? sha256Digest(context.baseSourceBytes) : bytes.length === context.publishedNoteBytes.length + 9 ? context.note.noteDigest : sha256Digest(bytes)) })
  assert.throws(() => baseOracle(trusting, staleBytes), 'mutation control: digests taken on trust')
})

// ---------------------------------------------------------------------------
// Determinism, property, size
// ---------------------------------------------------------------------------

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

function inversionsOf(context) {
  return [
    ...context.manifest.links.filter((link) => link.sourceNodeId === context.nodeId).flatMap((link) => link.inversions ?? []),
    ...(context.note.ext[EXT].assetEmbeds ?? []).flatMap((embed) => embed.inversions),
  ].sort((left, right) => left.note.start - right.note.start)
}

// Random edits on body lines that hold no rewrite: insertions of plain words
// and deletions of whole characters, applied to the note and, through the
// recorded offsets, to the source.
function randomEdits(context, random) {
  const note = context.publishedNoteBytes
  const { start, end } = context.note.regions.body
  const inversions = inversionsOf(context)
  const lines = []
  for (let offset = start; offset < end;) {
    const newline = note.indexOf(0x0a, offset)
    const next = newline === -1 || newline >= end ? end : newline + 1
    let contentEnd = next
    while (contentEnd > offset && (note[contentEnd - 1] === 0x0a || note[contentEnd - 1] === 0x0d)) contentEnd -= 1
    const lookalike = ['notes/', 'attachments/'].some((name) => note.subarray(offset, next).includes(name))
    if (!lookalike && !inversions.some((item) => item.note.start < next && item.note.end >= offset)) lines.push([offset, contentEnd])
    offset = next
  }
  const boundary = (offset) => { while (offset < end && (note[offset] & 0xc0) === 0x80) offset += 1; return offset }
  const toSource = (offset) => offset - inversions.filter((item) => item.note.end <= offset).reduce((total, item) => total + (item.note.end - item.note.start) - (item.source.end - item.source.start), 0)
  const edits = []
  const used = new Set()
  for (let count = 1 + Math.floor(random() * 3); count > 0; count -= 1) {
    const index = Math.floor(random() * lines.length)
    if (used.has(index)) continue
    used.add(index)
    const [from, to] = lines[index]
    const at = boundary(from + Math.floor(random() * (to - from + 1)))
    const until = random() < 0.5 ? at : Math.min(to, boundary(at + Math.floor(random() * 12)))
    const text = random() < 0.3 ? '' : ['word', ' two words ', 'x', 'é ☕', '  '][Math.floor(random() * 5)]
    if (until === at && text === '') continue
    edits.push({ at, until, text: utf8(text) })
  }
  edits.sort((left, right) => right.at - left.at)
  let edited = note
  let expected = context.baseSourceBytes
  for (const edit of edits) {
    edited = Buffer.concat([edited.subarray(0, edit.at), edit.text, edited.subarray(edit.until)])
    expected = Buffer.concat([expected.subarray(0, toSource(edit.at)), edit.text, expected.subarray(toSource(edit.until))])
  }
  return { edited, expected }
}

function propertyOracle(lens, trials) {
  const random = mulberry32(20260105)
  const files = [...cases.keys()].filter((file) => cases.get(file).note.ext[EXT].source.kind === 'markdown')
  let changed = 0
  for (let trial = 0; trial < trials; trial += 1) {
    const file = files[trial % files.length]
    const context = cases.get(file)
    const { edited, expected } = randomEdits(context, random)
    assertExactSource(context, runLens(context, edited, lens), expected, `trial ${trial} on ${file}`)
    if (!expected.equals(context.baseSourceBytes)) changed += 1
  }
  assert.ok(changed > trials / 2)
}

test('lens: property, seeded random edits away from rewrites equal the same edit applied to the source', () => {
  propertyOracle(applyEditLens, 600)
  assert.throws(() => propertyOracle(broken.keepsEmittedBytes, 60), 'mutation control')
  assert.throws(() => propertyOracle(broken.normalizesNewlines, 60), 'mutation control')
})

test('lens: applying it twice gives identical results', () => {
  const oracle = (lens) => {
    for (const row of BODY_EDITS.slice(0, 12)) {
      const context = cases.get(row.file)
      const edited = applyAll(context.publishedNoteBytes, row.note, context)
      assert.deepEqual(runLens(context, edited, lens), runLens(context, Buffer.from(edited), lens), row.name)
    }
  }
  oracle(applyEditLens)
  let calls = 0
  const unstable = createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, originalOf: (unit) => ((calls += 1) % 2 ? unit.original : unit.emitted) })
  assert.throws(() => oracle(unstable), 'mutation control')
})

function largeWorkspace(lines) {
  const body = ['# Large note', '', 'Opening with a [link](small.md) here.', ...Array.from({ length: lines }, (_, index) => `Line ${index} of an invented body that is long enough to add up, ${'pad '.repeat(8)}end.`), 'A [middle](./small.md) link.', ...Array.from({ length: lines }, (_, index) => `Second half line ${index}, ${'pad '.repeat(10)}end.`), 'Closing with a [[Small note]] link.', '']
  return {
    repositories: ['big-room'],
    files: {
      'big-room/large.md': { text: `---\ntitle: "Large note"\nkg:\n  id: "big-room:large"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n${body.join('\n')}` },
      'big-room/small.md': { text: '---\ntitle: "Small note"\nkg:\n  id: "big-room:small"\n  type: "document"\n  status: "active"\n  audience: "team"\n---\n\n# Small note\n' },
    },
  }
}

test('lens: a 5 MB body with edits at both ends and rewritten links between them is aligned in seconds', (t) => {
  const { cases: large } = prepareWorkspace(t, largeWorkspace(36000))
  const context = large.get('large.md')
  assert.ok(context.baseSourceBytes.length > 5 * 1024 * 1024)
  const steps = [['# Large note', '# Large note, revised'], ['Line 17 of', 'Line seventeen of'], ['Second half line 35990,', 'Second half line 35990 (edited),'], ['Closing with', 'Closing, finally, with']]
  const edited = applyAll(context.publishedNoteBytes, steps)
  const started = process.hrtime.bigint()
  const result = runLens(context, edited)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assertExactSource(context, result, applyAll(context.baseSourceBytes, steps), 'large body')
  t.diagnostic(`5 MB body: lens completed in ${elapsedMs.toFixed(0)} ms`)
  assert.ok(elapsedMs < 10000, `the lens took ${elapsedMs} ms`)
})

test('lens: an edit too large to align around a rewritten link refuses instead of guessing or hanging', (t) => {
  const { cases: large } = prepareWorkspace(t, largeWorkspace(2500))
  const context = large.get('large.md')
  const rewriteEveryLine = (note) => utf8(note.toString('utf8').replaceAll(' of an invented body', ' of a reworded body').replaceAll('Second half line', 'Later line'))
  const started = process.hrtime.bigint()
  // The middle link survives untouched: it is found between its neighbours, exactly once.
  const kept = rewriteEveryLine(context.publishedNoteBytes)
  assertExactSource(context, runLens(context, kept), rewriteEveryLine(context.baseSourceBytes), 'every line rewritten, links kept')
  // The middle link is retyped as well: nothing can say whether it was edited or deleted.
  const retyped = replaceNth(kept, 'A [middle](Small%20note', 'A [middle](Small%20memo')
  assertRefusal(runLens(context, retyped), 'edit-too-large-to-align', 'every line rewritten and a link retyped')
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 10000)

  // The bound is what refuses: the same small edit aligns under the shipped limits and not under tiny ones.
  const guide = cases.get('guide.md')
  const small = applyAll(guide.publishedNoteBytes, [['Überblick', 'Überblick (kurz)'], [`[again](${ALPHA_MD})`, '[again](Alpha.md)'], ['Closing words.', 'Closing words, revised.']])
  assertRefusal(runLens(guide, small), 'unsupported-structural-edit', 'shipped limits')
  const tiny = createEditLensForOracleTests({ ...EDIT_LENS_PRIMITIVES, placeUnits: (input) => placeUnits({ ...input, align: (published, editedBody, options) => alignBodies(published, editedBody, { ...options, limits: { ...ALIGN_LIMITS, maxLineEdits: 1, maxByteEdits: 1 } }) }) })
  assertRefusal(runLens(guide, small, tiny), 'edit-too-large-to-align', 'tiny limits')
})

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

const DIGEST = /^sha256:[0-9a-f]{64}$/

function assertCarriesNoText(value, allowed, label) {
  if (typeof value === 'string') assert.ok(DIGEST.test(value) || allowed.has(value), `${label}: a refusal carries the string ${JSON.stringify(value)}`)
  else if (Array.isArray(value)) value.forEach((item) => assertCarriesNoText(item, allowed, label))
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { assert.ok(/^[A-Za-z]+$/.test(key), label); assertCarriesNoText(item, allowed, label) }
  else assert.ok(value === null || typeof value === 'number' || typeof value === 'boolean', label)
}

test('lens: refusals carry codes, digests and byte offsets, never note text, titles or paths', () => {
  const allowed = new Set([...EDIT_LENS_REFUSALS, 'refusal', 'rewritten-target-edited', 'vault-link-changed'])
  let refusals = 0
  for (const row of REFUSED_EDITS) {
    const context = cases.get(row.file)
    const result = runLens(context, applyAll(context.publishedNoteBytes, row.note, context))
    assert.deepEqual(Object.keys(result).sort(), ['code', 'detail', 'kind'])
    assertCarriesNoText(result, allowed, row.name)
    refusals += 1
  }
  assert.ok(refusals >= 15)
  assert.throws(() => assertCarriesNoText({ kind: 'refusal', code: 'link-rewrite-edited', detail: { text: 'Closing words.' } }, allowed, 'control'), 'mutation control: a refusal that quotes the note')
  assert.throws(() => assertCarriesNoText({ kind: 'refusal', code: 'stale-base', detail: { file: path.join(root, 'guide.md') } }, allowed, 'control'), 'mutation control: a refusal that names a path')
})
