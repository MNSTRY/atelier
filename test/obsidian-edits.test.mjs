import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ALIGN_LIMITS,
  ARBITRATION_REASONS,
  ARBITRATION_RULES,
  EDIT_ACKNOWLEDGEMENT_SCHEMA,
  EDIT_LENS_PRIMITIVES,
  EDIT_LENS_REFUSALS,
  EDIT_LENS_VERSION,
  EDIT_OBSERVATION_STEPS,
  EditArbitrationRefusal,
  MAX_PLAIN_SEGMENT,
  OBJECTS_DIRECTORY,
  OBJECT_EVENT_SCHEMA,
  OBJECT_EVENT_TYPES,
  OBJECT_INDEX_DIRECTORY,
  OBJECT_INDEX_SCHEMA,
  OBJECT_STORE_CRASH_STEPS,
  OBJECT_STORE_LIMITS,
  OBJECT_STORE_PRIMITIVES,
  REFUSED_DISPOSITIONS,
  alignBodies,
  applyEditLens,
  arbitrateEvents,
  createEditLensForOracleTests,
  createEditObserverForOracleTests,
  createObjectStoreForOracleTests,
  decodeIdentitySegment,
  editIdempotencyKey,
  encodeIdentitySegment,
  isObjectEvent,
  observeEdit,
  openObjectStore,
  placeUnits,
} from '../src/projection/obsidian/edits/index.mjs'
import { ObsidianContractRefusal, validateObsidianContract } from '../src/projection/obsidian/contracts.mjs'
import { sha256Digest } from '../src/projection/obsidian/materialize/index.mjs'
import { PublicationRefusal, createRecoveryStore } from '../src/projection/obsidian/recovery/index.mjs'
import { observeVaultEdits } from '../src/runtime/obsidian/pending-edits.mjs'
import { createAbandonmentProof, machineDigest } from '../src/runtime/obsidian/private-lock.mjs'
import { RACE_MODES, digestOf, makeOperation, raceIdentity, raceOperation, resultOf, stormIdentity, stormOperation } from './support/obsidian-edits/operations.mjs'
import { EXT, WORKSPACE_ID, prepareWorkspace } from './support/obsidian-edits/workspace.mjs'
import {
  APPLY_POLICY_PRIMITIVES, MAX_MANUAL_BATCH_SIZE, SOURCE_APPLY_PRIMITIVES, SOURCE_APPLY_REFUSALS, SOURCE_APPLY_STEPS, applyPolicyDigest, canonicalApplyPolicy, createApplyCommandOperation, createApplyPolicyForOracleTests,
  createEngineApplyOperation, createSourceApplyContribution, decideApply, withApplyPolicyDigest,
} from '../src/projection/obsidian/edits/index.mjs'
import { resolveExchange } from '../src/projection/obsidian/publication/index.mjs'
import { createObsidianRegistry } from '../src/runtime/obsidian/extension-points.mjs'
import { createProductionSeams } from '../src/runtime/obsidian/pipeline.mjs'
import { revokeApplyPolicy } from '../src/runtime/obsidian/machine-settings.mjs'
import { APPLY_WORKSPACE_ID, GONE_HOLDER_PID, digestOf as bytesDigest, git, goneHolderProof, makeApplyWorld, noteText, treeListing } from './support/obsidian-edits/apply-world.mjs'

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
  // The rule this lens once had: only COMPLETE generated lines count as left
  // over, and when nothing else decides, the end of the note is the author's.
  guessesWhereTheAuthorStopped: createEditLensForOracleTests({
    ...EDIT_LENS_PRIMITIVES,
    splitGeneratedTail: ({ noteEntry, publishedNoteBytes, editedNoteBytes }) => {
      const bodyEnd = noteEntry.regions.body.end
      const bytes = publishedNoteBytes.subarray(bodyEnd)
      const publishedAuthored = publishedNoteBytes.subarray(0, bodyEnd)
      if (bytes.length === 0) return { authored: editedNoteBytes, generated: 'none' }
      let lead = noteEntry.regions.generated[0]?.ext?.[EXT]?.fenceClosure?.byteLength ?? 0
      while (lead < bytes.length && (bytes[lead] === 0x0a || bytes[lead] === 0x0d)) lead += 1
      const lines = bytes.subarray(lead).toString('latin1').split(/\r?\n/).filter((line) => line.length > 0).map((line) => Buffer.from(line, 'latin1'))
      const count = (haystack, needle) => { let total = 0; for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) total += 1; return total }
      const surplus = (haystack) => lines.some((line) => count(haystack, line) > count(publishedAuthored, line))
      const ends = (buffer, tail) => tail.length <= buffer.length && buffer.subarray(buffer.length - tail.length).equals(tail)
      const lineEndings = (buffer) => { let total = 0; while (total < buffer.length && (buffer[buffer.length - 1 - total] === 0x0a || buffer[buffer.length - 1 - total] === 0x0d)) total += 1; return total }
      if (ends(editedNoteBytes, bytes)) {
        const authored = editedNoteBytes.subarray(0, editedNoteBytes.length - bytes.length)
        if (surplus(authored)) throw new ObsidianContractRefusal('generated-region-edited', 'generated text inside the authored part')
        return { authored, generated: 'intact' }
      }
      if (surplus(editedNoteBytes)) throw new ObsidianContractRefusal('generated-region-edited', 'a generated line is left')
      for (let keep = lead; keep > 0; keep -= 1) {
        if (!ends(editedNoteBytes, bytes.subarray(0, keep))) continue
        const authored = editedNoteBytes.subarray(0, editedNoteBytes.length - keep)
        if (authored.equals(publishedAuthored) || lineEndings(authored) === lineEndings(publishedAuthored)) return { authored, generated: 'removed' }
      }
      return { authored: editedNoteBytes, generated: 'removed' }
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

const markdownWithTail = () => [...cases].filter(([, context]) => context.note.ext[EXT].source.kind === 'markdown' && context.note.regions.generated.length > 0)
const leadOf = (context) => {
  const generated = generatedOf(context)
  let lead = context.note.regions.generated[0].ext?.[EXT]?.fenceClosure?.byteLength ?? 0
  while (generated[lead] === 0x0a || generated[lead] === 0x0d) lead += 1
  return lead
}

// A generated tail cut in the middle of a line leaves no complete generated
// line behind. Whatever is left is still generated text: the only answers are
// a refusal or, where what is left is nothing but separator bytes, the
// unchanged source.
function generatedTruncationOracle(lens) {
  let refused = 0
  for (const [file, context] of markdownWithTail()) {
    const authored = authoredOf(context)
    const generated = generatedOf(context)
    const lead = leadOf(context)
    const settle = (edited, label, separatorOnly) => {
      const result = runLens(context, edited, lens)
      // A cut inside a multi-byte character is refused for its encoding first.
      const wellFormed = (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(edited); return true } catch { return false } })()
      if (result.kind === 'refusal') { assertRefusal(result, wellFormed ? 'generated-region-edited' : 'invalid-utf8', label); refused += 1; return }
      // Bytes that read both ways: the cut took line endings and the author's
      // own line endings complete the tail again. The note then still ends
      // with the whole tail and the author's part is shorter by line endings.
      const dropped = edited.length - generated.length >= 0 && edited.subarray(edited.length - generated.length).equals(generated) ? authored.length - (edited.length - generated.length) : null
      if (dropped !== null && dropped > 0 && authored.subarray(authored.length - dropped).every((byte) => byte === 0x0a || byte === 0x0d)) {
        assertExactSource(context, result, context.baseSourceBytes.subarray(0, context.baseSourceBytes.length - dropped), label)
        return
      }
      assert.ok(separatorOnly, `${label}: a fragment of generated text was accepted`)
      assertExactSource(context, result, context.baseSourceBytes, label)
    }
    for (let kept = lead + 1; kept < generated.length; kept += 1) settle(Buffer.concat([authored, generated.subarray(0, kept)]), `${file}: tail cut from the right, ${kept} bytes left`, false)
    for (let from = 1; from < generated.length; from += 1) {
      const left = generated.subarray(from)
      settle(Buffer.concat([authored, left]), `${file}: tail cut from the left at ${from}`, left.every((byte) => byte === 0x0a || byte === 0x0d))
    }
    // The same cuts beside an authored edit, and a fragment left inside the body.
    const revised = replaceNth(authored, '# ', '# Revised ')
    const middle = lead + Math.floor((generated.length - lead) / 2)
    for (const [name, edited] of Object.entries({
      'cut from the right beside an authored edit': Buffer.concat([revised, generated.subarray(0, middle)]),
      'cut from the left beside an authored edit': Buffer.concat([revised, generated.subarray(middle)]),
      'fragment left in the middle of the body': insertAt(authored, context.note.regions.body.start, generated.subarray(lead, Math.min(generated.length, lead + 12))),
    })) assertRefusal(runLens(context, edited, lens), 'generated-region-edited', `${file}: ${name}`)
  }
  assert.ok(refused > 500, `only ${refused} truncations were tried`)
}

test('regions: a generated tail cut in the middle of a line, from either side or beside an authored edit, never reaches the source', () => {
  // The smallest case: the person selects from the middle of the generated heading to the end of the note and deletes.
  const context = cases.get('guide.md')
  const generated = generatedOf(context)
  const cut = generated.indexOf(utf8('## Rela')) + '## Rela'.length
  assert.ok(cut > leadOf(context))
  assertRefusal(runLens(context, Buffer.concat([authoredOf(context), generated.subarray(0, cut)])), 'generated-region-edited', 'heading cut after seven bytes')
  generatedTruncationOracle(applyEditLens)
  assert.throws(() => generatedTruncationOracle(broken.guessesWhereTheAuthorStopped), /fragment of generated text was accepted|expected generated-region-edited|new source bytes differ/, 'mutation control: complete lines only, and the end of the note taken for the author\'s')
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
  { name: 'a vault file named inside a code fence, where no link is read', file: 'guide.md', code: 'unsupported-structural-edit', note: [['[[Alpha topic]]\n```', `[[${ALPHA_WIKI}]]\n\`\`\``]] },
  { name: 'a vault file named in plain prose', file: 'guide.md', code: 'unsupported-structural-edit', note: [['Closing words.', `Closing words about ${BETA_WIKI}.`]] },
  { name: 'a code fence opened before a rewritten link', file: 'open-fence.md', code: 'unsupported-structural-edit', note: [['Before the fence', '```\nBefore the fence']] },
  { name: 'a rewritten link wrapped in inline code', file: 'guide.md', code: 'unsupported-structural-edit', note: [[`[[${ALPHA_WIKI}|Alpha topic]] before`, `\`[[${ALPHA_WIKI}|Alpha topic]]\` before`]] },
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

// Fuzz: random edits anywhere in the authored body, also on lines that hold a
// rewrite, that never touch a rewrite's own bytes or sit exactly on its edge.
// Inserted text is often copied from the note itself (adversarial repeats for
// the alignment) or is a line ending, a fence or a bracket, which change what
// the canonical scanner reads as code or as a link. The same edit is applied
// to the source through the recorded offsets. The lens must return exactly
// that source or refuse; wrong bytes are the only failure.
const FUZZ_TEXTS = ['', 'x', ' words here ', '\n', '\r\n', '\n\n', '- item\n', 'é☕', '```', '```\n', '~~~\n', '`', '[', ']]', '[[', '](', '---\n']
// Found by an earlier fuzz: an alignment that pairs a blank line with an
// inserted one and calls the untouched rewrite beside it deleted.
const FUZZ_REGRESSIONS = [
  { file: 'open-fence.md', edits: [[199, 199, '\r\n'], [155, 155, 'e\n\nBefore the fen']] },
  { file: 'open-fence-crlf.md', edits: [[217, 221, '\r\n'], [156, 165, 'x']] },
  { file: 'open-fence.md', edits: [[221, 232, 'en'], [153, 153, '.\n\n```js\nconst ans']] },
]

function fuzzTrial(context, random, { wholeNote = false } = {}) {
  const note = context.publishedNoteBytes
  const { start, end } = context.note.regions.body
  // With `wholeNote` an edit may begin or end anywhere up to the last byte of
  // the note, so it can fall on the boundary and inside the generated tail,
  // and one edit in five deletes everything from where it begins.
  const limit = wholeNote ? note.length : end
  const inversions = inversionsOf(context)
  const boundary = (offset, stop = end) => { while (offset < stop && (note[offset] & 0xc0) === 0x80) offset += 1; return offset }
  const touches = (from, to) => inversions.some((item) => from <= item.note.end && to >= item.note.start)
  const edits = []
  for (let count = 1 + Math.floor(random() * 4); count > 0; count -= 1) {
    const at = boundary(start + Math.floor(random() * (limit - start)), limit)
    const until = wholeNote && random() < 0.2 ? note.length : random() < 0.5 ? at : Math.min(limit, boundary(at + Math.floor(random() * 20), limit))
    if (touches(at, until)) continue
    let text
    if (random() < 0.5) {
      const from = boundary(start + Math.floor(random() * (end - start)))
      const to = Math.min(end, boundary(from + Math.floor(random() * 25)))
      text = touches(from, to) ? utf8('plain') : note.subarray(from, to)
    } else text = utf8(FUZZ_TEXTS[Math.floor(random() * FUZZ_TEXTS.length)])
    if ((until === at && text.length === 0) || edits.some((edit) => !(until < edit.at || at > edit.until))) continue
    edits.push({ at, until, text })
  }
  return edits
}

const countOf = (haystack, needle) => { let total = 0; for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) total += 1; return total }
const GENERATED_RUN = 8

// Every run of GENERATED_RUN bytes of the generated tail that reaches past its
// separator. None may occur in a new source more often than the base source
// and the text typed in this trial account for.
function generatedRunsLeaked(context, newSourceBytes, edits) {
  if (context.note.regions.generated.length === 0) return false
  const generated = generatedOf(context)
  const runs = new Set()
  for (let at = Math.max(0, leadOf(context) - GENERATED_RUN + 1); at + GENERATED_RUN <= generated.length; at += 1) runs.add(generated.toString('latin1', at, at + GENERATED_RUN))
  return [...runs].some((run) => {
    const needle = Buffer.from(run, 'latin1')
    return countOf(newSourceBytes, needle) > countOf(context.baseSourceBytes, needle) + edits.reduce((total, edit) => total + countOf(edit.text, needle), 0)
  })
}

function fuzzOracle(lens, { seed, trials, wholeNote = false }) {
  const random = mulberry32(seed)
  const files = [...cases.keys()].filter((file) => cases.get(file).note.ext[EXT].source.kind === 'markdown' && cases.get(file).note.regions.body.end - cases.get(file).note.regions.body.start >= 2)
  const tally = { exact: 0, refused: {}, wrong: [], inTail: { exact: 0, refused: 0 } }
  const planned = [
    ...FUZZ_REGRESSIONS.map((item) => ({ file: item.file, edits: item.edits.map(([at, until, text]) => ({ at, until, text: utf8(text) })) })),
    ...Array.from({ length: trials }, (_, trial) => ({ file: files[trial % files.length], edits: fuzzTrial(cases.get(files[trial % files.length]), random, { wholeNote }) })),
  ]
  for (const { file, edits } of planned) {
    if (edits.length === 0) continue
    const context = cases.get(file)
    const bodyEnd = context.note.regions.body.end
    const inversions = inversionsOf(context)
    const toSource = (offset) => offset - inversions.filter((item) => item.note.end <= offset).reduce((total, item) => total + (item.note.end - item.note.start) - (item.source.end - item.source.start), 0)
    const inTail = edits.some((edit) => edit.until > bodyEnd)
    let edited = context.publishedNoteBytes
    let expected = context.baseSourceBytes
    for (const edit of [...edits].sort((left, right) => right.at - left.at)) {
      edited = Buffer.concat([edited.subarray(0, edit.at), edit.text, edited.subarray(edit.until)])
      // No byte of the tail is the author's to change: what an edit does
      // beyond the body is never part of an expected source, so a success
      // for such a trial is exact only where the tail was removed whole.
      if (edit.until <= bodyEnd) expected = Buffer.concat([expected.subarray(0, toSource(edit.at)), edit.text, expected.subarray(toSource(edit.until))])
    }
    const result = runLens(context, edited, lens)
    if (result.kind === 'refusal') {
      tally.refused[result.code] = (tally.refused[result.code] ?? 0) + 1
      if (inTail) tally.inTail.refused += 1
      continue
    }
    // Second oracle, independent of the expected bytes: no emitted target
    // reaches the source unless the base or the inserted text held it, no run
    // of generated bytes does either, and nothing outside the body moved.
    const bodyStart = context.note.regions.body.start
    const leaked = inversions.some((item) => {
      const emitted = Buffer.from(item.ext[EXT].emitted, 'base64url')
      if (item.source.start === item.source.end) return false
      return countOf(result.newSourceBytes, emitted) > countOf(context.baseSourceBytes, emitted) + edits.reduce((total, edit) => total + countOf(edit.text, emitted), 0)
    })
    // Asked of every trial that touched the tail: text the author moves about
    // inside the body may well share eight bytes with a generated row (the
    // title of a related note), and that text is theirs.
    const generatedLeaked = inTail && generatedRunsLeaked(context, result.newSourceBytes, edits)
    const prefixKept = result.newSourceBytes.subarray(0, bodyStart).equals(context.baseSourceBytes.subarray(0, bodyStart))
    if (result.newSourceBytes.equals(expected) && !leaked && !generatedLeaked && prefixKept) { tally.exact += 1; if (inTail) tally.inTail.exact += 1 }
    else tally.wrong.push({ file, leaked, generatedLeaked, prefixKept, edits: edits.map((edit) => [edit.at, edit.until, edit.text.toString('utf8')]) })
  }
  assert.deepEqual(tally.wrong.slice(0, 3), [], `${tally.wrong.length} wrong results`)
  return tally
}

test('lens: fuzz, exact or refused, never wrong', (t) => {
  const tally = fuzzOracle(applyEditLens, { seed: Number(process.env.ATELIER_EDIT_FUZZ_SEED ?? 20260105), trials: Number(process.env.ATELIER_EDIT_FUZZ_TRIALS ?? 4000) })
  const refused = Object.values(tally.refused).reduce((total, value) => total + value, 0)
  t.diagnostic(`fuzz: ${JSON.stringify({ exact: tally.exact, refused: tally.refused, wrong: 0 })}`)
  // A lens that refuses everything is never wrong either.
  assert.ok(tally.exact > 4 * refused, `only ${tally.exact} exact results beside ${refused} refusals`)
  const passesUnplacedRewritesThrough = createEditLensForOracleTests({
    ...EDIT_LENS_PRIMITIVES,
    placeUnits: (input) => placeUnits({ ...input, wideSearch: false }),
    assertRewritesAccounted: () => [],
  })
  assert.throws(() => fuzzOracle(passesUnplacedRewritesThrough, { seed: 20260105, trials: 0 }), /wrong results/, 'mutation control: unplaced rewrites written to the source')
  assert.throws(() => fuzzOracle(broken.keepsEmittedBytes, { seed: 20260105, trials: 200 }), /wrong results/, 'mutation control')
  assert.throws(() => fuzzOracle(broken.normalizesNewlines, { seed: 20260105, trials: 200 }), /wrong results/, 'mutation control')
})

test('lens: fuzz over the whole note, the boundary and the generated tail included: exact or refused, and no run of generated bytes in a source', (t) => {
  const options = { seed: Number(process.env.ATELIER_EDIT_FUZZ_SEED ?? 20260105), trials: Number(process.env.ATELIER_EDIT_FUZZ_TRIALS ?? 4000), wholeNote: true }
  const tally = fuzzOracle(applyEditLens, options)
  t.diagnostic(`fuzz, whole note: ${JSON.stringify({ exact: tally.exact, refused: tally.refused, inTail: tally.inTail, wrong: 0 })}`)
  assert.ok(tally.inTail.refused > options.trials / 10, 'the generated tail was edited often enough to matter')
  assert.ok(tally.exact > tally.inTail.refused / 4, 'edits that stay in the body still succeed')
  assert.throws(() => fuzzOracle(broken.guessesWhereTheAuthorStopped, { ...options, seed: 20260105, trials: 1500 }), /wrong results/, 'mutation control: the end of the note taken for the author\'s')
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
  const allowed = new Set([...EDIT_LENS_REFUSALS, 'refusal', 'rewritten-target-edited', 'vault-link-changed', 'vault-identity-in-authored-text', 'rewrite-unaccounted'])
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

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

// A pending edit exactly as the maintenance engine queues it: the edited note
// is written into a temporary vault, and the engine's own observation keeps
// its bytes in the recovery object store before it records anything.
function queueEdit(t, context, editedNoteBytes, { scopeId = 'scope-full', manifest = context.manifest } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-edit-observation-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const store = createRecoveryStore({ workspaceRoot: path.join(dir, 'workspace-state'), workspaceId: WORKSPACE_ID, scopeId, repositoryRoots: [] })
  const notePath = path.join(store.vaultRoot, ...context.note.path.split('/'))
  fs.mkdirSync(path.dirname(notePath), { recursive: true })
  fs.writeFileSync(notePath, editedNoteBytes)
  const { edits } = observeVaultEdits({
    store, workspaceId: WORKSPACE_ID, scopeId, manifest,
    bases: new Map([[context.note.path, { digest: context.note.noteDigest, repoId: context.repoId, nodeId: context.nodeId }]]),
    digestOf: () => sha256Digest(fs.readFileSync(notePath)), edits: [], now: '2026-01-05T10:05:00.000Z',
  })
  assert.equal(edits.length, 1)
  return { store, edit: edits[0], notePath }
}

const observe = (queued, context, extra = {}, observer = observeEdit) => observer({
  edit: queued.edit, store: queued.store, manifest: context.manifest, publishedNoteBytes: context.publishedNoteBytes, baseSourceBytes: context.baseSourceBytes, ...extra,
})

test('observation: a preserved body edit becomes a pending body-replacement operation bound to identity, origin and digests', (t) => {
  const context = cases.get('guide.md')
  const edited = replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words, revised.')
  const expected = replaceNth(context.baseSourceBytes, 'Closing words.', 'Closing words, revised.')
  const queued = queueEdit(t, context, edited)
  const sourceBefore = Buffer.from(context.baseSourceBytes)
  const { operation, outcome } = observe(queued, context)
  assert.deepEqual(validateObsidianContract('edit-operation', operation), [])
  assertExactSource(context, outcome, expected, 'observed edit')
  const at = context.baseSourceBytes.indexOf(utf8('.'), context.baseSourceBytes.indexOf(utf8('Closing words')))
  assert.deepEqual(operation, {
    schema: 'atelier-obsidian-edit-operation/v1',
    contractVersion: '1.0.0',
    editId: queued.edit.editId,
    workspaceId: WORKSPACE_ID,
    repoId: 'reading-room',
    nodeId: 'reading-room:guide',
    origin: { scopeId: 'scope-full', generationId: context.manifest.generationId, ext: { [EXT]: { notePath: context.note.path, baseNoteDigest: context.note.noteDigest, publishedNoteDigest: context.note.noteDigest } } },
    kind: 'body-replacement',
    baseSourceDigest: sha256Digest(context.baseSourceBytes),
    observed: { digest: sha256Digest(edited), byteLength: edited.length, recoveryRef: queued.edit.objectRef },
    idempotencyKey: editIdempotencyKey({ workspaceId: WORKSPACE_ID, repoId: 'reading-room', nodeId: 'reading-room:guide', baseSourceDigest: sha256Digest(context.baseSourceBytes), observedDigest: sha256Digest(edited) }),
    state: 'pending',
    observedAt: '2026-01-05T10:05:00.000Z',
    ext: {
      [EXT]: {
        lensVersion: EDIT_LENS_VERSION,
        publishedNoteRef: `recovery/objects/${context.note.noteDigest.slice(7)}.bin`,
        baseSourceRef: `recovery/objects/${sha256Digest(context.baseSourceBytes).slice(7)}.bin`,
        currentSourceDigest: sha256Digest(context.baseSourceBytes),
        result: { newSourceDigest: sha256Digest(expected), newByteLength: expected.length, changedRanges: [{ start: at, end: at, newStart: at, newEnd: at + ', revised'.length }], unchanged: false, generated: 'intact' },
      },
    },
  })
  // Everything the operation refers to is retained, immutable, under its digest.
  for (const bytes of [edited, context.publishedNoteBytes, context.baseSourceBytes]) assert.ok(queued.store.readObject(sha256Digest(bytes)).equals(bytes))
  // Nothing was written to the source or to the vault.
  assert.ok(context.baseSourceBytes.equals(sourceBefore))
  assert.ok(fs.readFileSync(queued.notePath).equals(edited))
})

test('observation: identical edits over identical bases coalesce under one idempotency key and nothing else does', (t) => {
  const context = cases.get('guide.md')
  const edited = replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words, revised.')
  const first = observe(queueEdit(t, context, edited), context).operation
  // The same bytes seen from another view and generation of the same workspace.
  const elsewhere = { ...context.manifest, scopeId: 'scope-other', generationId: 'gen-other-0001' }
  const second = observe(queueEdit(t, context, edited, { scopeId: 'scope-other', manifest: elsewhere }), { ...context, manifest: elsewhere }).operation
  assert.notEqual(first.editId, second.editId)
  assert.equal(first.idempotencyKey, second.idempotencyKey)
  assert.match(first.idempotencyKey, /^op-[0-9a-f]{64}$/)
  const other = observe(queueEdit(t, context, replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words!')), context).operation
  assert.notEqual(first.idempotencyKey, other.idempotencyKey)
  const key = (change) => editIdempotencyKey({ workspaceId: WORKSPACE_ID, repoId: 'reading-room', nodeId: 'reading-room:guide', baseSourceDigest: first.baseSourceDigest, observedDigest: first.observed.digest, ...change })
  assert.equal(key({}), first.idempotencyKey)
  for (const change of [{ workspaceId: 'ws-other' }, { repoId: 'other-room' }, { nodeId: 'reading-room:alpha' }, { baseSourceDigest: sha256Digest(utf8('another base')) }, { observedDigest: sha256Digest(utf8('another edit')) }]) {
    assert.notEqual(key(change), first.idempotencyKey)
  }
})

test('observation: what the lens refuses is classified, never applied: proposals, conflicts and refusals', (t) => {
  const guide = cases.get('guide.md')
  const rows = [
    { name: 'new vault link', context: guide, edited: replaceNth(guide.publishedNoteBytes, 'Closing words.', `Closing words and [[${BETA_WIKI}]].`), code: 'unsupported-structural-edit', kind: 'semantic-proposal', state: 'proposed' },
    { name: 'front matter', context: guide, edited: replaceNth(guide.publishedNoteBytes, 'title: "Field guide"', 'title: "Field manual"'), code: 'unsupported-frontmatter-edit', kind: 'semantic-proposal', state: 'proposed' },
    { name: 'generated region', context: guide, edited: replaceNth(guide.publishedNoteBytes, '- supports →', '- supports =>'), code: 'generated-region-edited', kind: 'body-replacement', state: 'refused' },
    { name: 'alias', context: guide, edited: replaceNth(guide.publishedNoteBytes, '|Alpha topic]] before', '|the alpha]] before'), code: 'link-rewrite-edited', kind: 'body-replacement', state: 'refused' },
    { name: 'wrapper', context: cases.get('charts/table.pdf'), edited: replaceNth(cases.get('charts/table.pdf').publishedNoteBytes, 'Format', 'Formats'), code: 'unsupported-wrapper-edit', kind: 'body-replacement', state: 'refused' },
    { name: 'stale base', context: guide, edited: replaceNth(guide.publishedNoteBytes, 'Closing words.', 'Closing words, revised.'), extra: { baseSourceBytes: replaceNth(guide.baseSourceBytes, 'Closing words.', 'Closing words!') }, code: 'stale-base', kind: 'body-replacement', state: 'conflicted' },
    { name: 'baseline mismatch', context: guide, edited: replaceNth(guide.publishedNoteBytes, 'Closing words.', 'Closing words, revised.'), extra: { publishedNoteBytes: cases.get('delta.md').publishedNoteBytes }, code: 'baseline-mismatch', kind: 'body-replacement', state: 'refused' },
  ]
  for (const row of rows) {
    const { operation, outcome } = observe(queueEdit(t, row.context, row.edited), row.context, row.extra)
    assert.deepEqual(validateObsidianContract('edit-operation', operation), [], row.name)
    assert.deepEqual([outcome.kind, outcome.code, operation.kind, operation.state, operation.ext[EXT].refusal.code], ['refusal', row.code, row.kind, row.state, row.code], row.name)
    assert.equal(operation.ext[EXT].result, undefined, row.name)
    // The base an operation is keyed on is the one the note was generated from.
    assert.equal(operation.baseSourceDigest, row.context.note.ext[EXT].source.rawDigest, row.name)
  }
  const stale = observe(queueEdit(t, guide, rows[5].edited), guide, rows[5].extra).operation
  assert.equal(stale.ext[EXT].currentSourceDigest, sha256Digest(rows[5].extra.baseSourceBytes))
  // A record of another generation is not judged against this manifest.
  const queued = queueEdit(t, guide, rows[5].edited)
  const foreign = observe({ ...queued, edit: { ...queued.edit, generationId: 'gen-other-0001' } }, guide)
  assert.deepEqual([foreign.outcome.code, foreign.operation.state], ['unknown-note', 'refused'])
})

function missingBytesOracle(t, observer) {
  const context = cases.get('guide.md')
  const edited = replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words, revised.')
  const queued = queueEdit(t, context, edited)
  fs.rmSync(queued.store.resolve(queued.edit.objectRef), { force: true })
  // The live note still holds the very same bytes. It is not a substitute.
  assert.ok(fs.readFileSync(queued.notePath).equals(edited))
  const { operation, outcome } = observe(queued, context, {}, observer(queued))
  assert.deepEqual([outcome.kind, outcome.code, operation.state, operation.observed.byteLength], ['refusal', 'edit-bytes-missing', 'refused', 0])
  assert.deepEqual(validateObsidianContract('edit-operation', operation), [])
  // Retained bytes that no longer match their name are missing too.
  const corrupt = queueEdit(t, context, edited)
  const file = corrupt.store.resolve(corrupt.edit.objectRef)
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  fs.writeFileSync(file, utf8('not the edit'))
  assert.equal(observe(corrupt, context, {}, observer(corrupt)).outcome.code, 'edit-bytes-missing')
}

test('observation: preserved bytes that are absent refuse edit-bytes-missing; the live vault note is never read instead', (t) => {
  missingBytesOracle(t, () => observeEdit)
  const rereadsVault = (queued) => createEditObserverForOracleTests({
    ...EDIT_OBSERVATION_STEPS,
    preserve: (input) => {
      const live = fs.readFileSync(queued.notePath)
      return { edited: live, publishedRef: input.store.retainObject(input.publishedNoteBytes).ref, baseRef: input.store.retainObject(input.baseSourceBytes).ref }
    },
  })
  assert.throws(() => missingBytesOracle(t, rereadsVault), 'mutation control: an observer that re-reads the live note')
})

function orderOracle(t, steps) {
  const context = cases.get('guide.md')
  const edited = replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words, revised.')
  const queued = queueEdit(t, context, edited)
  let classified = 0
  const observer = createEditObserverForOracleTests(steps({ onClassify: () => { classified += 1 } }))
  const crash = new Error('crash seam')
  assert.throws(() => observe(queued, context, { afterPreserved: () => { throw crash } }, observer), (error) => error === crash)
  // At the seam every immutable byte is retained and nothing has been classified.
  assert.equal(classified, 0, 'classification ran before the bytes were recorded')
  for (const bytes of [edited, context.publishedNoteBytes, context.baseSourceBytes]) assert.ok(queued.store.readObject(sha256Digest(bytes)).equals(bytes))
  // After the crash the same record observes to the same operation.
  const again = observe(queued, context, {}, observer)
  assert.equal(classified, 1)
  assert.deepEqual(again.operation, observe(queued, context).operation)
}

test('observation: the immutable edit bytes are recorded before classification, across a crash seam', (t) => {
  const counting = ({ onClassify }) => ({ ...EDIT_OBSERVATION_STEPS, classify: (input) => { onClassify(); return EDIT_OBSERVATION_STEPS.classify(input) } })
  orderOracle(t, counting)
  const classifiesFirst = ({ onClassify }) => ({
    ...counting({ onClassify }),
    preserve: (input) => {
      const edited = input.store.readObject(input.edit.observedDigest)
      counting({ onClassify }).classify({ manifest: cases.get('guide.md').manifest, repoId: 'reading-room', nodeId: 'reading-room:guide', publishedNoteBytes: input.publishedNoteBytes, editedNoteBytes: edited, baseSourceBytes: input.baseSourceBytes })
      return EDIT_OBSERVATION_STEPS.preserve(input)
    },
  })
  assert.throws(() => orderOracle(t, classifiesFirst), 'mutation control: an observer that classifies before it records')
})

function assertOperationCarriesNoText(operation, label) {
  const identities = new Set([operation.editId, operation.workspaceId, operation.repoId, operation.nodeId, operation.origin.scopeId, operation.origin.generationId, operation.idempotencyKey, operation.observedAt])
  const vocabulary = new Set([...EDIT_LENS_REFUSALS, 'edit-bytes-missing', 'atelier-obsidian-edit-operation/v1', '1.0.0', EDIT_LENS_VERSION, 'body-replacement', 'semantic-proposal', 'pending', 'proposed', 'refused', 'conflicted', 'intact', 'removed', 'none', 'rewritten-target-edited', 'vault-link-changed', 'vault-identity-in-authored-text', 'rewrite-unaccounted'])
  const visit = (value, pointer) => {
    if (typeof value === 'string') {
      // The vault-relative note path is the one readable string: it names the note the edit was made in.
      if (pointer === `/origin/ext/${EXT}/notePath`) return assert.equal(value, operation.origin.ext[EXT].notePath)
      assert.ok(DIGEST.test(value) || /^recovery\/objects\/[0-9a-f]{64}\.bin$/.test(value) || identities.has(value) || vocabulary.has(value), `${label}: ${pointer} carries ${JSON.stringify(value)}`)
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${pointer}/${index}`))
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, `${pointer}/${key}`)
    else assert.ok(value === null || typeof value === 'number' || typeof value === 'boolean', `${label}: ${pointer}`)
  }
  visit(operation, '')
}

test('observation: operation documents hold identities, digests, offsets, codes and store references only', (t) => {
  const guide = cases.get('guide.md')
  const edits = [
    replaceNth(guide.publishedNoteBytes, 'Closing words.', 'Closing words, revised.'),
    replaceNth(guide.publishedNoteBytes, 'Closing words.', `Closing words and [[${BETA_WIKI}]].`),
    replaceNth(guide.publishedNoteBytes, 'title: "Field guide"', 'title: "Field manual"'),
    replaceNth(guide.publishedNoteBytes, '|Alpha topic]] before', '|the alpha]] before'),
    authoredOf(guide),
  ]
  for (const [index, edited] of edits.entries()) {
    const queued = queueEdit(t, guide, edited)
    const { operation } = observe(queued, guide)
    assertOperationCarriesNoText(operation, `edit ${index}`)
    // A raw path never appears, however it is escaped in JSON.
    const serialized = JSON.stringify(operation)
    for (const machinePath of [queued.store.workspaceRoot, queued.store.vaultRoot, os.tmpdir()]) assert.ok(!serialized.includes(JSON.stringify(machinePath).slice(1, -1)), `edit ${index}`)
  }
  const { operation } = observe(queueEdit(t, guide, edits[0]), guide)
  assert.throws(() => assertOperationCarriesNoText({ ...operation, ext: { [EXT]: { ...operation.ext[EXT], excerpt: 'Closing words, revised.' } } }, 'control'), 'mutation control: an operation that quotes the note')
  assert.throws(() => assertOperationCarriesNoText({ ...operation, ext: { [EXT]: { ...operation.ext[EXT], file: path.join(os.tmpdir(), 'guide.md') } } }, 'control'), 'mutation control: an operation that names a machine path')
})

// ---------------------------------------------------------------------------
// Arbitration across views and processes
// ---------------------------------------------------------------------------

const ARBITRATION_WS = 'ws-arbitration'
const GUIDE = { repoId: 'reading-room', nodeId: 'reading-room:guide' }
const ARBITRATION_START = Date.parse('2026-01-05T11:00:00.000Z')
const RACE_CHILD = fileURLToPath(new URL('./support/obsidian-edits/race-child.mjs', import.meta.url))
const guideNode = (name) => ({ repoId: 'reading-room', nodeId: `reading-room:${name}` })

function arbitrationWorld(t, { primitives = OBJECT_STORE_PRIMITIVES, workspaceId = ARBITRATION_WS } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-edit-arbitration-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const time = { now: ARBITRATION_START }
  const open = ({ crash, primitives: own = primitives } = {}) => createObjectStoreForOracleTests(own)({ stateRoot: dir, workspaceId, repositoryRoots: [], clock: () => new Date(time.now), crash })
  return { dir, time, open, store: open() }
}

const objectDirectory = (dir, identity) => path.join(dir, OBJECTS_DIRECTORY, encodeIdentitySegment(identity.repoId), encodeIdentitySegment(identity.nodeId))
const eventFile = (sequence) => `${String(sequence).padStart(12, '0')}.json`

// The log as the files say it, read without the store: names in sequence, each
// event valid and chained to the bytes of the one before it.
function readEventFiles(dir, identity) {
  const directory = objectDirectory(dir, identity)
  let previous = null
  return fs.readdirSync(directory).filter((name) => !name.startsWith('.atelier-write-')).sort().map((name, index) => {
    assert.equal(name, eventFile(index + 1), 'event names are the sequence, without a gap')
    const bytes = fs.readFileSync(path.join(directory, name))
    const event = JSON.parse(bytes.toString('utf8'))
    assert.ok(isObjectEvent(event), `${name} is a valid event`)
    assert.deepEqual([event.sequence, event.previous, event.repoId, event.nodeId], [index + 1, previous, identity.repoId, identity.nodeId], `${name} follows the event before it`)
    previous = sha256Digest(bytes)
    return event
  })
}

// At most one holder at every point of the log, and nothing recorded under a lease by anybody else.
function assertLeaseSerial(events, label, { takeovers = false } = {}) {
  let holder = null
  for (const event of events) {
    if (event.type === 'lease-acquired') {
      if (holder !== null) assert.ok(takeovers && event.body.takeover?.nonce === holder, `${label}: event ${event.sequence} acquires a lease that is held`)
      else assert.equal(event.body.takeover, null, `${label}: event ${event.sequence} takes over nothing`)
      holder = event.body.lease.nonce
    } else if (event.type === 'lease-released') {
      assert.equal(event.body.nonce, holder, `${label}: event ${event.sequence} releases a lease it does not hold`)
      holder = null
    } else if (['apply-intent', 'applied', 'apply-refused'].includes(event.type)) {
      assert.equal(event.body.nonce, holder, `${label}: event ${event.sequence} is recorded without the lease`)
    }
  }
  assert.deepEqual(arbitrateEvents(events).violations, [], `${label}: the log is a history the rules allow`)
  return holder
}

const stateOfOperation = (object, operation) => object.operations.find((entry) => entry.idempotencyKey === operation.idempotencyKey)
const originsOf = (entry) => entry.origins.map((origin) => [origin.scopeId, origin.generationId, origin.editId, origin.recoveryRef])
const applyRecord = (operation, actor = 'person-1') => ({ idempotencyKey: operation.idempotencyKey, actor, policy: { mode: 'manual' } })
const intentOf = (operation, actor) => ({ ...applyRecord(operation, actor), expectedSourceDigest: operation.baseSourceDigest, newSourceDigest: operation.ext[EXT].result.newSourceDigest })
const appliedOf = (operation, actor) => ({ ...applyRecord(operation, actor), oldSourceDigest: operation.baseSourceDigest, newSourceDigest: operation.ext[EXT].result.newSourceDigest })

async function applyThrough(store, operation) {
  const attempt = await store.acquireLease(operation)
  assert.equal(attempt.acquired, true)
  store.recordIntent(attempt.lease, intentOf(operation))
  const applied = store.recordApplied(attempt.lease, appliedOf(operation))
  assert.equal(store.releaseLease(attempt.lease), true)
  return applied.state
}

const refusalCode = (code) => (error) => error instanceof EditArbitrationRefusal && error.code === code

test('multi-vault arbitration: the same edit made in two vaults is one operation with both origins; a different edit conflicts and keeps both recovery references', (t) => {
  const context = cases.get('guide.md')
  const elsewhere = { ...context.manifest, scopeId: 'scope-other', generationId: 'gen-other-0001' }
  const inOther = (bytes) => observe(queueEdit(t, context, bytes, { scopeId: 'scope-other', manifest: elsewhere }), { ...context, manifest: elsewhere }).operation
  const edited = replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words, revised.')
  const first = observe(queueEdit(t, context, edited), context).operation
  const second = inOther(edited)
  const world = arbitrationWorld(t, { workspaceId: WORKSPACE_ID })
  const one = world.store.observe(first)
  const two = world.store.observe(second)
  assert.deepEqual([one.appended, two.appended, two.object.state, two.object.operations.length], [true, true, 'pending', 1])
  assert.deepEqual(originsOf(two.operation), [['scope-full', context.manifest.generationId, first.editId, first.observed.recoveryRef], ['scope-other', 'gen-other-0001', second.editId, second.observed.recoveryRef]])
  assert.deepEqual(readEventFiles(world.dir, first).map((event) => event.type), ['observed', 'coalesced'])
  assert.equal(two.object.sourceDigest, sha256Digest(context.baseSourceBytes))

  // The same note edited differently in the other vault: before any source
  // write is possible the object is conflicted, and both edits are retained.
  const third = inOther(replaceNth(context.publishedNoteBytes, 'Closing words.', 'Closing words!'))
  const three = world.store.observe(third)
  assert.equal(three.object.state, 'conflicted')
  assert.deepEqual(three.object.operations.map((entry) => [entry.idempotencyKey, entry.state, entry.reason]), [[first.idempotencyKey, 'conflicted', 'divergent-edits'], [third.idempotencyKey, 'conflicted', 'divergent-edits']])
  assert.deepEqual(three.object.operations.flatMap((entry) => entry.origins.map((origin) => origin.recoveryRef)), [first.observed.recoveryRef, second.observed.recoveryRef, third.observed.recoveryRef])
  const events = readEventFiles(world.dir, first)
  assert.deepEqual(events.map((event) => event.type), ['observed', 'coalesced', 'observed', 'conflict-declared'])
  // The readable note path of the operation document is not recorded.
  assert.ok(events.every((event) => !JSON.stringify(event).includes('notePath')))
})

// The rules, each against a fresh object of one store. Returns what it saw so
// that a broken arbiter can be shown to fail it.
async function arbitrationTableOracle(t, primitives) {
  const { store, dir } = arbitrationWorld(t, { primitives })
  const at = (name, fields) => makeOperation({ ...guideNode(name), ...fields })

  // Same base, different edited bytes, from two vaults, in either order.
  for (const [name, order] of [['same-base-ab', ['a', 'b']], ['same-base-ba', ['b', 'a']]]) {
    const operations = { a: at(name, { edited: 'edit a' }), b: at(name, { scopeId: 'scope-other', edited: 'edit b' }) }
    for (const which of order) store.observe(operations[which])
    const object = store.stateOf(guideNode(name))
    assert.equal(object.state, 'conflicted', name)
    for (const which of ['a', 'b']) {
      const entry = stateOfOperation(object, operations[which])
      assert.ok(entry, `${name}: operation ${which} was dropped`)
      assert.deepEqual([entry.state, entry.reason, entry.origins.map((origin) => origin.recoveryRef)], ['conflicted', 'divergent-edits', [operations[which].observed.recoveryRef]], `${name}: operation ${which}`)
    }
    assert.deepEqual(readEventFiles(dir, guideNode(name)).at(-1).body.operations.map((item) => item.idempotencyKey), [operations.a.idempotencyKey, operations.b.idempotencyKey].sort(), `${name}: the conflict is declared with both`)
    // No source write is possible: the write-ahead intent refuses for either.
    const attempt = await store.acquireLease(guideNode(name))
    for (const which of ['a', 'b']) assert.throws(() => store.recordIntent(attempt.lease, intentOf(operations[which])), refusalCode('object-conflicted'), name)
    store.releaseLease(attempt.lease)
  }

  // Different bases. With a known present digest the stale one is the conflict; with none, both are.
  const current = at('bases-known', { edited: 'edit a' })
  const stale = at('bases-known', { scopeId: 'scope-other', base: 'base-older', current: 'base-0', edited: 'edit b' })
  store.observe(current)
  const known = store.observe(stale).object
  assert.deepEqual([known.state, stateOfOperation(known, current).state, stateOfOperation(known, stale).state, stateOfOperation(known, stale).reason], ['conflicted', 'pending', 'conflicted', 'stale-base'])
  const lease = await store.acquireLease(guideNode('bases-known'))
  assert.throws(() => store.recordIntent(lease.lease, intentOf(current)), refusalCode('object-conflicted'), 'a conflicted object takes no intent, even for its current operation')
  store.releaseLease(lease.lease)
  const blindA = at('bases-unknown', { edited: 'edit a' })
  const blindB = at('bases-unknown', { scopeId: 'scope-other', base: 'base-older', edited: 'edit b' })
  store.observe(blindA, { presentSourceDigest: null })
  const unknown = store.observe(blindB, { presentSourceDigest: null }).object
  assert.deepEqual(unknown.operations.map((entry) => [entry.state, entry.reason]), [['conflicted', 'divergent-bases'], ['conflicted', 'divergent-bases']])

  // A late edit against the old generation, after a successful apply.
  const winner = at('late', { edited: 'edit a' })
  store.observe(winner)
  const afterApply = await applyThrough(store, winner)
  assert.deepEqual([afterApply.state, afterApply.sourceDigest, afterApply.sourceDigestProven], ['settled', digestOf(resultOf('edit a')), true])
  const late = at('late', { scopeId: 'scope-other', edited: 'edit late' })
  const lateSeen = store.observe(late)
  assert.deepEqual([lateSeen.operation.state, lateSeen.operation.reason, lateSeen.object.state, stateOfOperation(lateSeen.object, winner).state], ['conflicted', 'stale-base', 'conflicted', 'applied'])
  assert.equal(lateSeen.object.sourceDigest, digestOf(resultOf('edit a')), 'the applied source stands')

  // Old base, but the edit already is the applied result: nothing is left to apply.
  const applied = at('equal', { edited: 'edit a' })
  const twin = at('equal', { scopeId: 'scope-other', edited: 'edit a, other generated tail', result: resultOf('edit a') })
  store.observe(applied)
  store.observe(twin)
  const both = await applyThrough(store, applied)
  assert.deepEqual([both.state, stateOfOperation(both, twin).state, stateOfOperation(both, twin).reason, stateOfOperation(both, twin).by], ['settled', 'superseded', 'already-applied', applied.idempotencyKey])
  const afterwards = store.observe(at('equal', { scopeId: 'scope-third', edited: 'edit a, third tail', result: resultOf('edit a') }))
  assert.deepEqual([afterwards.operation.state, afterwards.operation.reason, afterwards.object.state], ['superseded', 'already-applied', 'settled'])
  assert.deepEqual(readEventFiles(dir, guideNode('equal')).filter((event) => event.type === 'superseded').map((event) => event.body.operations.map((item) => item.reason)), [['already-applied'], ['already-applied']])

  // Resolution: a new operation against the present digest that names what it resolves.
  const left = at('resolve', { edited: 'edit a' })
  const right = at('resolve', { scopeId: 'scope-other', edited: 'edit b' })
  store.observe(left)
  store.observe(right)
  const partial = at('resolve', { scopeId: 'scope-third', edited: 'edit partial' })
  const partly = store.observe(partial, { resolves: [left.idempotencyKey] })
  assert.deepEqual([partly.operation.state, partly.operation.reason, partly.object.state], ['conflicted', 'resolution-incomplete', 'conflicted'])
  const unnamed = store.observe(at('resolve', { scopeId: 'scope-third', edited: 'edit unnamed' }))
  assert.deepEqual([unnamed.operation.state, unnamed.operation.reason], ['conflicted', 'object-conflicted'], 'a conflicted object stays conflicted')
  const candidate = at('resolve', { scopeId: 'scope-third', edited: 'edit merged' })
  const resolved = store.observe(candidate, { resolves: [left, right, partial, unnamed.operation].map((item) => item.idempotencyKey) })
  assert.deepEqual([resolved.object.state, resolved.operation.state], ['pending', 'pending'])
  assert.deepEqual(resolved.object.operations.filter((entry) => entry !== resolved.operation).map((entry) => [entry.state, entry.reason, entry.by, entry.origins.length]), Array.from({ length: 4 }, () => ['superseded', 'resolved', candidate.idempotencyKey, 1]), 'what was resolved is retained')
  const merged = await applyThrough(store, candidate)
  assert.deepEqual([merged.state, merged.sourceDigest], ['settled', digestOf(resultOf('edit merged'))])
  // A resolution never overrides the stale-source check.
  const staleCandidate = store.observe(at('late', { scopeId: 'scope-third', edited: 'edit resolving late' }), { resolves: [late.idempotencyKey] })
  assert.deepEqual([staleCandidate.operation.state, staleCandidate.operation.reason, stateOfOperation(staleCandidate.object, late).state], ['conflicted', 'stale-base', 'conflicted'])
  const freshCandidate = store.observe(at('late', { scopeId: 'scope-third', base: resultOf('edit a'), edited: 'edit rebased' }), { resolves: [late.idempotencyKey, staleCandidate.operation.idempotencyKey] })
  assert.deepEqual([freshCandidate.operation.state, freshCandidate.object.state, stateOfOperation(freshCandidate.object, late).state], ['pending', 'pending', 'superseded'])

  for (const name of ['same-base-ab', 'same-base-ba', 'bases-known', 'bases-unknown', 'late', 'equal', 'resolve']) assert.equal(assertLeaseSerial(readEventFiles(dir, guideNode(name)), name), null)
}

test('arbitration: different edits or bases conflict with everything retained, a late edit is stale, an edit equal to the applied result is superseded, and only a named resolution against the present digest resolves', async (t) => {
  await arbitrationTableOracle(t, OBJECT_STORE_PRIMITIVES)
  const lastWriterWins = {
    divergent: ({ incoming, open }) => [{ entry: incoming, state: 'pending' }, ...open.map((entry) => ({ entry, state: 'superseded', reason: 'resolved', by: incoming.idempotencyKey }))],
    stale: ({ incoming }) => [{ entry: incoming, state: 'pending' }],
  }
  const dropsTheLoser = { ...ARBITRATION_RULES, divergent: ({ incoming }) => [{ entry: incoming, drop: true }] }
  const ignoresStaleness = { ...ARBITRATION_RULES, stale: ({ incoming }) => [{ entry: incoming, state: 'pending' }] }
  for (const [name, rules] of Object.entries({ lastWriterWins, dropsTheLoser, ignoresStaleness })) {
    await assert.rejects(() => arbitrationTableOracle(t, { ...OBJECT_STORE_PRIMITIVES, rules }), (error) => error.name === 'AssertionError', `mutation control: an arbiter that ${name}`)
  }
})

test('arbitration: proposals, refusals and lens conflicts are recorded and are never applicable', async (t) => {
  const { store } = arbitrationWorld(t)
  const proposal = makeOperation({ ...guideNode('proposal'), edited: 'edit structure', state: 'proposed', kind: 'semantic-proposal', refusalCode: 'unsupported-structural-edit' })
  const refused = makeOperation({ ...guideNode('refused'), edited: 'edit refused', state: 'refused', refusalCode: 'generated-region-edited' })
  const lensConflict = makeOperation({ ...guideNode('lens-conflict'), edited: 'edit on moved base', state: 'conflicted' })
  for (const [operation, expected] of [[proposal, ['proposed', null, 'settled']], [refused, ['refused', 'generated-region-edited', 'settled']], [lensConflict, ['conflicted', 'stale-base', 'conflicted']]]) {
    const seen = store.observe(operation)
    assert.deepEqual([seen.operation.state, seen.operation.reason, seen.object.state], expected)
    const attempt = await store.acquireLease(operation)
    const anIntent = { ...applyRecord(operation), expectedSourceDigest: operation.baseSourceDigest, newSourceDigest: digestOf('anything') }
    assert.throws(() => store.recordIntent(attempt.lease, anIntent), (error) => error instanceof EditArbitrationRefusal && ['operation-not-applicable', 'object-conflicted'].includes(error.code))
    store.releaseLease(attempt.lease)
  }
  // A body edit beside a proposal of the same object is not disturbed by it.
  const body = makeOperation({ ...guideNode('proposal'), scopeId: 'scope-other', edited: 'edit body' })
  assert.deepEqual([store.observe(body).object.state, (await applyThrough(store, body)).state], ['pending', 'settled'])
  // What a caller may not offer: a state only this store gives, a key that is not the key of the document, another workspace.
  assert.throws(() => store.observe({ ...body, state: 'applied' }), refusalCode('invalid-operation'))
  assert.throws(() => store.observe({ ...body, idempotencyKey: proposal.idempotencyKey }), refusalCode('invalid-operation'))
  assert.throws(() => store.observe(makeOperation({ ...guideNode('proposal'), workspaceId: 'ws-elsewhere', edited: 'edit body' })), refusalCode('foreign-workspace'))
  assert.throws(() => store.observe({ ...body, excerpt: 'text' }), refusalCode('invalid-operation'))
})

// ---- two real processes ---------------------------------------------------

function runRaceChild(t, survivors, options) {
  const child = childProcess.spawn(process.execPath, [RACE_CHILD, JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const entry = { child, role: options.role, exited: false }
  survivors.push(entry)
  return new Promise((resolve, reject) => {
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${t.name}: race child ${options.role} did not finish`)) }, 120000)
    child.once('error', reject)
    child.once('exit', (code) => {
      entry.exited = true
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`${t.name}: race child ${options.role} exited with ${code}: ${err.slice(-2000)}`))
      try { return resolve(JSON.parse(out)) } catch (error) { return reject(error) }
    })
  })
}

test('multi-vault arbitration: two real processes race to observe and to take the lease of one object; never two holders, never a lost operation, never a last writer', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-edit-race-')))
  const survivors = []
  t.after(async () => {
    for (const entry of survivors.filter((item) => !item.exited)) {
      const gone = new Promise((resolve) => { entry.child.once('exit', resolve) })
      entry.child.kill('SIGKILL')
      await gone
      t.diagnostic(`${t.name}: killed surviving race child ${entry.role} (pid ${entry.child.pid})`)
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const stateRoot = path.join(dir, 'workspace-state')
  const holdRoot = path.join(dir, 'holds')
  fs.mkdirSync(holdRoot)
  const roundsPerBatch = Number(process.env.ATELIER_EDIT_RACE_ROUNDS ?? 24)
  const stormSize = 30
  const tally = { rounds: 0, stormsInterleaved: 0, first: { a: 0, b: 0 }, acquired: { a: 0, b: 0 }, refused: { a: 0, b: 0 }, applied: { a: 0, b: 0 }, modes: {}, leaseReasons: {} }
  const bothSides = () => tally.stormsInterleaved > 0 && ['first', 'acquired', 'refused'].every((what) => tally[what].a > 0 && tally[what].b > 0)

  // A run in which one process always wins proves nothing, so batches repeat
  // (at most four) until each process has been first, has taken a lease and
  // has been refused one.
  for (let batch = 0; batch < 4 && !bothSides(); batch += 1) {
    const shared = { stateRoot, holdRoot, rounds: roundsPerBatch, firstRound: batch * roundsPerBatch, startAt: Date.now() + 2500, periodMs: 150, holdMs: 25, storm: stormSize }
    const reports = await Promise.all(['a', 'b'].map((role) => runRaceChild(t, survivors, { ...shared, role })))
    const store = openObjectStore({ stateRoot, workspaceId: 'ws-race', repositoryRoots: [], clock: () => new Date(ARBITRATION_START) })
    for (let index = 0; index < roundsPerBatch; index += 1) {
      const round = shared.firstRound + index
      const mode = RACE_MODES[round % RACE_MODES.length]
      const label = `round ${round} (${mode})`
      const identity = raceIdentity(round)
      const events = readEventFiles(stateRoot, identity)
      assert.equal(assertLeaseSerial(events, label), null, `${label}: a lease is still held`)
      assert.equal(events.filter((event) => event.type === 'lease-acquired' && event.body.takeover !== null).length, 0, `${label}: nothing was taken over from a live process`)
      const object = store.recoverObject(identity)
      tally.rounds += 1
      tally.modes[mode] = (tally.modes[mode] ?? 0) + 1
      for (const { role, pid, report } of reports) {
        const seen = report[index]
        const operation = raceOperation({ round, role, mode })
        assert.deepEqual([seen.round, seen.doubleHolder], [round, false], `${label}: ${role} held the lease beside another holder`)
        // The acknowledged operation is in the log, under the event that was acknowledged, with this origin.
        const recorded = events[seen.acknowledgement.sequence - 1]
        assert.deepEqual([recorded.body.operation.idempotencyKey, recorded.body.operation.editId, recorded.body.operation.origin.scopeId], [operation.idempotencyKey, operation.editId, `scope-${role}`], `${label}: the operation of ${role} was lost`)
        assert.ok(stateOfOperation(object, operation).origins.some((origin) => origin.scopeId === `scope-${role}`), `${label}: the origin of ${role} was lost`)
        if (seen.first) tally.first[role] += 1
        if (seen.lease === 'acquired') {
          tally.acquired[role] += 1
          assert.equal(seen.released, true, label)
          assert.ok(events.some((event) => event.type === 'lease-acquired' && event.body.lease.pid === pid), label)
        } else {
          tally.refused[role] += 1
          tally.leaseReasons[seen.lease] = (tally.leaseReasons[seen.lease] ?? 0) + 1
          assert.equal(seen.lease, 'live-process-unproven', `${label}: a held lease refuses, whoever holds it`)
        }
        if (seen.applied) tally.applied[role] += 1
      }
      // No last writer: the outcome depends on what was offered, not on who came second.
      if (mode === 'same-edit') {
        assert.deepEqual([object.operations.length, object.operations[0].origins.map((origin) => origin.scopeId).sort(), object.operations[0].state, object.state], [1, ['scope-a', 'scope-b'], 'applied', 'settled'], label)
        assert.equal(events.filter((event) => event.type === 'applied').length, 1, `${label}: applied once`)
      } else {
        assert.deepEqual([object.state, object.operations.map((entry) => entry.state)], ['conflicted', ['conflicted', 'conflicted']], label)
        assert.equal(events.filter((event) => ['apply-intent', 'applied'].includes(event.type)).length, 0, label)
      }
    }
    // Both processes appending to one object at once: every offer has its own event, in one sequence.
    const storm = readEventFiles(stateRoot, stormIdentity(shared.firstRound))
    assert.deepEqual(storm.map((event) => event.type), ['observed', ...Array.from({ length: 2 * stormSize - 1 }, () => 'coalesced')])
    assert.deepEqual(reports.flatMap((item) => item.stormSequences).sort((left, right) => left - right), storm.map((event) => event.sequence), 'every acknowledged offer is its own event')
    for (const { role, stormSequences } of reports) {
      for (const [index, sequence] of stormSequences.entries()) assert.equal(storm[sequence - 1].body.operation.editId, stormOperation({ batch: shared.firstRound, role, index }).editId)
    }
    const stormed = store.recoverObject(stormIdentity(shared.firstRound))
    assert.deepEqual([stormed.state, stormed.operations.length, stormed.operations[0].origins.length], ['pending', 1, 2 * stormSize])
    const [stormA, stormB] = reports.map((item) => item.stormSequences)
    if (Math.min(...stormA) < Math.max(...stormB) && Math.min(...stormB) < Math.max(...stormA)) tally.stormsInterleaved += 1
  }
  t.diagnostic(`race tallies: ${JSON.stringify(tally)}`)
  assert.ok(bothSides(), `both sides of every race must occur: ${JSON.stringify(tally)}`)
  assert.deepEqual(survivors.filter((entry) => !entry.exited).map((entry) => entry.role), [], 'a race child is still running')
  // Mutation control for the log oracle: a second holder, or a record made without the lease, is caught.
  const events = readEventFiles(stateRoot, raceIdentity(0))
  const acquired = events.find((event) => event.type === 'lease-acquired')
  const intruder = { ...acquired, sequence: acquired.sequence + 1, body: { ...acquired.body, lease: { ...acquired.body.lease, nonce: 'f'.repeat(32) } } }
  assert.throws(() => assertLeaseSerial([...events.slice(0, acquired.sequence), intruder], 'control'), 'mutation control: two holders')
  assert.throws(() => assertLeaseSerial(events.filter((event) => event.type !== 'lease-acquired'), 'control'), 'mutation control: records without a lease')
})

// ---- replay and crash safety ------------------------------------------------

const CRASH = new Error('crash seam')
const crashAt = (step, type = null) => (seen, context) => { if (seen === step && (type === null || context.type === type)) throw CRASH }

// `offerAgain` is how the operation is offered after the crash.
function lostAcknowledgementOracle(t, offerAgain = (operation) => operation) {
  const operation = makeOperation({ ...GUIDE, edited: 'edit a' })
  const control = arbitrationWorld(t).store.observe(operation).acknowledgement
  assert.deepEqual(Object.keys(control).sort(), ['editId', 'eventDigest', 'idempotencyKey', 'nodeId', 'repoId', 'schema', 'sequence', 'workspaceId'])
  assert.deepEqual([control.schema, control.sequence, control.idempotencyKey], [EDIT_ACKNOWLEDGEMENT_SCHEMA, 1, operation.idempotencyKey])
  for (const step of OBJECT_STORE_CRASH_STEPS) {
    const world = arbitrationWorld(t)
    assert.throws(() => world.open({ crash: crashAt(step) }).observe(operation), (error) => error === CRASH, step)
    assert.equal(readEventFiles(world.dir, GUIDE).length, 1, `${step}: the event was written before the acknowledgement was lost`)
    const restarted = world.open()
    const again = restarted.observe(offerAgain(operation))
    const third = world.open().observe(offerAgain(operation))
    assert.deepEqual([again.appended, third.appended], [false, false], `${step}: offering again appends nothing`)
    assert.deepEqual([again.acknowledgement, third.acknowledgement], [control, control], `${step}: the same acknowledgement as the one that was lost`)
    assert.deepEqual([readEventFiles(world.dir, GUIDE).length, again.object.operations.length, again.operation.origins.length], [1, 1, 1], `${step}: one operation, recorded once`)
  }
}

test('replay: an acknowledgement lost to a crash after the write is answered again with the same acknowledgement, and nothing is recorded twice', (t) => {
  lostAcknowledgementOracle(t)
  let retry = 0
  const mintsAnIdentityPerRetry = (operation) => { retry += 1; return { ...operation, editId: `${operation.editId}-r${retry}` } }
  assert.throws(() => lostAcknowledgementOracle(t, mintsAnIdentityPerRetry), (error) => error.name === 'AssertionError', 'mutation control: a replay that is recorded as something new')
})

function snapshotTree(directory) {
  const files = {}
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else files[path.relative(directory, absolute).split(path.sep).join('/')] = fs.readFileSync(absolute).toString('hex')
    }
  }
  walk(directory)
  return files
}

async function indexOracle(t, primitives) {
  const world = arbitrationWorld(t, { primitives })
  const { store, dir } = world
  const indexRoot = path.join(dir, OBJECT_INDEX_DIRECTORY)
  const first = makeOperation({ ...guideNode('indexed'), edited: 'edit a' })
  store.observe(first)
  const indexPath = path.join(indexRoot, encodeIdentitySegment('reading-room'), `${encodeIdentitySegment('reading-room:indexed')}.json`)
  const early = fs.readFileSync(indexPath)
  assert.deepEqual(store.list({ state: 'pending' }).objects.map((item) => item.nodeId), ['reading-room:indexed'])
  store.observe(makeOperation({ ...guideNode('indexed'), scopeId: 'scope-other', edited: 'edit b' }))
  const applied = makeOperation({ ...guideNode('applied'), edited: 'edit a' })
  store.observe(applied)
  await applyThrough(store, applied)
  store.observe(makeOperation({ repoId: 'other-room', nodeId: 'reading-room:indexed', scopeId: 'scope-other', edited: 'edit a' }))

  // Deleted and rebuilt: the same bytes, from this store and from one that never saw the appends.
  const incremental = snapshotTree(indexRoot)
  assert.equal(Object.keys(incremental).length, 3)
  assert.deepEqual(JSON.parse(Buffer.from(Object.values(incremental)[0], 'hex').toString('utf8')).schema, OBJECT_INDEX_SCHEMA)
  fs.rmSync(indexRoot, { recursive: true, force: true })
  assert.deepEqual(store.rebuildIndexes(), { rebuilt: 3, unreadable: [], foreign: 0 })
  assert.deepEqual(snapshotTree(indexRoot), incremental, 'rebuilt indexes are byte-identical')
  fs.rmSync(indexRoot, { recursive: true, force: true })
  world.open().rebuildIndexes()
  assert.deepEqual(snapshotTree(indexRoot), incremental, 'rebuilt by another store: byte-identical')
  const listed = store.list()
  fs.rmSync(indexRoot, { recursive: true, force: true })
  assert.deepEqual(world.open().list(), listed, 'a listing without any index is the same listing')
  assert.deepEqual(snapshotTree(indexRoot), incremental, 'and leaves the same indexes behind')

  // An index that fell behind the events (a writer that crashed before updating it) is not believed.
  fs.writeFileSync(indexPath, early)
  assert.deepEqual(store.list({ state: 'conflicted' }).objects.map((item) => [item.repoId, item.nodeId]), [['reading-room', 'reading-room:indexed']], 'the listing follows the events, not the index')
  assert.deepEqual(store.list({ state: 'pending' }).objects.map((item) => item.repoId), ['other-room'])
  assert.deepEqual(store.list({ scopeId: 'scope-full' }).objects.map((item) => item.nodeId).sort(), ['reading-room:applied', 'reading-room:indexed'])
  assert.deepEqual(snapshotTree(indexRoot), incremental, 'the stale index was derived again')
  fs.writeFileSync(indexPath, '{"schema":')
  assert.equal(store.list({ state: 'conflicted' }).objects.length, 1, 'an unreadable index is only a missing cache')
  assert.equal(store.stateOf(guideNode('indexed')).state, 'conflicted')
}

test('replay: every index is a cache, rebuilt byte-identical from the events and never believed over them', async (t) => {
  await indexOracle(t, OBJECT_STORE_PRIMITIVES)
  await assert.rejects(() => indexOracle(t, { ...OBJECT_STORE_PRIMITIVES, indexIsCurrent: () => true }), (error) => error.name === 'AssertionError', 'mutation control: an index that is authoritative')
})

const exitedPid = () => childProcess.spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid
// An abandoned lease is held under GONE_HOLDER_PID, whose absence is injected (apply-world.mjs says why). The PID of a
// real child that exited is used by one test only, which expects that PID to be somebody else's by then and tries again.
const WHERE_THE_HOLDER_IS_GONE = { ...OBJECT_STORE_PRIMITIVES, proveAbandoned: goneHolderProof() }

// One object taken through observe (three views), lease, intent, the source
// write (simulated: `source.digest`), applied and release, with a crash at the
// `crashIndex`-th durable step; then a restart that recovers and finishes.
// `decide` is how the restart settles an intent whose outcome is unknown.
async function crashCycle(t, { crashIndex, holderPid, decide }) {
  const world = arbitrationWorld(t, { primitives: WHERE_THE_HOLDER_IS_GONE })
  const operations = [
    makeOperation({ ...GUIDE, edited: 'edit a' }),
    makeOperation({ ...GUIDE, scopeId: 'scope-other', edited: 'edit a' }),
    makeOperation({ ...GUIDE, scopeId: 'scope-third', edited: 'edit a, third tail', result: resultOf('edit a') }),
  ]
  const [main] = operations
  const source = { digest: main.baseSourceDigest }
  const steps = []
  const crash = (step, context) => { steps.push(`${step}:${context.type ?? ''}`); if (steps.length - 1 === crashIndex) throw CRASH }
  const run = async (store, holder) => {
    for (const operation of operations) store.observe(operation)
    let object = store.stateOf(GUIDE)
    if (stateOfOperation(object, main).state !== 'applied' || object.lease !== null) {
      const attempt = await store.acquireLease(GUIDE, holder)
      assert.equal(attempt.acquired, true)
      object = attempt.object
      if (object.intent !== null) decide({ store, lease: attempt.lease, intent: object.intent, source, main })
      if (stateOfOperation(store.stateOf(GUIDE), main).state === 'pending') {
        store.recordIntent(attempt.lease, intentOf(main))
        source.digest = main.ext[EXT].result.newSourceDigest
        crash('source-written', { type: 'source' })
        store.recordApplied(attempt.lease, appliedOf(main))
      }
      store.releaseLease(attempt.lease)
    }
  }
  let crashed = null
  try { await run(world.open({ crash }), { pid: holderPid }) } catch (error) { if (error !== CRASH) throw error; crashed = steps.at(-1) }
  const recovered = crashed === null ? null : world.open().recoverObject(GUIDE)
  if (crashed !== null) {
    assert.deepEqual(recovered.undeclared, { siblingsStale: null, superseded: [], conflicted: [] }, `${crashed}: recovery writes down what the crash left unwritten`)
    assert.deepEqual(world.open().recoverObject(GUIDE), recovered, `${crashed}: recovery is deterministic and changes nothing the second time`)
    await run(world.open(), {})
  }
  const events = readEventFiles(world.dir, GUIDE)
  assertLeaseSerial(events, crashed ?? 'no crash', { takeovers: true })
  const object = world.open().stateOf(GUIDE)
  const summary = {
    state: object.state, sourceDigest: object.sourceDigest, lease: object.lease, intent: object.intent,
    operations: object.operations.map((entry) => [entry.idempotencyKey, entry.state, entry.reason, entry.by, entry.origins.map((origin) => [origin.scopeId, origin.editId])]),
    siblingsStale: object.siblingsStale.map((item) => [item.newSourceDigest, item.views, item.declared]),
    declarations: events.filter((event) => ['superseded', 'siblings-stale'].includes(event.type)).map((event) => event.type).sort(),
  }
  assert.equal(object.sourceDigest, source.digest, `${crashed}: the log and the source disagree about what was written`)
  return { steps, crashed, recovered, summary }
}

// Reads the source again and decides from its digest.
function decideFromDigests({ store, lease, intent, source }) {
  if (source.digest === intent.newSourceDigest) store.recordApplied(lease, { idempotencyKey: intent.idempotencyKey, oldSourceDigest: intent.expectedSourceDigest, newSourceDigest: intent.newSourceDigest, actor: intent.actor, policy: intent.policy })
  else store.recordRefused(lease, { idempotencyKey: intent.idempotencyKey, code: 'apply-interrupted', presentSourceDigest: source.digest, disposition: 'retained' })
}

async function crashOracle(t, decide) {
  const holderPid = GONE_HOLDER_PID
  const clean = await crashCycle(t, { crashIndex: -1, holderPid, decide })
  assert.equal(clean.crashed, null)
  assert.deepEqual(clean.summary.operations.map((entry) => [entry[1], entry[4].length]), [['applied', 2], ['superseded', 1]])
  assert.deepEqual([clean.summary.state, clean.summary.lease, clean.summary.intent, clean.summary.declarations], ['settled', null, null, ['siblings-stale', 'superseded']])
  assert.deepEqual(clean.summary.siblingsStale, [[digestOf(resultOf('edit a')), [{ scopeId: 'scope-full', generationId: 'gen-scope-full-0001', role: 'origin' }, { scopeId: 'scope-other', generationId: 'gen-scope-other-0001', role: 'origin' }, { scopeId: 'scope-third', generationId: 'gen-scope-third-0001', role: 'sibling' }], true]])
  const seen = { crashes: 0, unknownBeforeWrite: 0, unknownAfterWrite: 0, points: new Set() }
  for (let crashIndex = 0; crashIndex < clean.steps.length; crashIndex += 1) {
    const result = await crashCycle(t, { crashIndex, holderPid, decide })
    assert.equal(result.crashed, clean.steps[crashIndex])
    assert.deepEqual(result.summary, clean.summary, `${result.crashed}: the restart reaches the state of a run that never crashed`)
    seen.crashes += 1
    seen.points.add(result.crashed)
    if (result.recovered.intent !== null) {
      // Never assumed applied, never assumed not applied.
      assert.equal(result.recovered.intent.status, 'outcome-unknown', result.crashed)
      assert.equal(stateOfOperation(result.recovered, makeOperation({ ...GUIDE, edited: 'edit a' })).state, 'pending', `${result.crashed}: an intent is not an outcome`)
      assert.equal(result.recovered.sourceDigest, digestOf('base-0'), result.crashed)
      seen[clean.steps.indexOf(result.crashed) < clean.steps.indexOf('source-written:source') ? 'unknownBeforeWrite' : 'unknownAfterWrite'] += 1
    }
  }
  // Every durable step named by the brief was a crash point.
  for (const point of ['event-linked:observed', 'event-published:observed', 'index-updated:', 'event-published:lease-acquired', 'event-published:apply-intent', 'source-written:source', 'event-linked:applied', 'event-published:applied', 'event-published:siblings-stale', 'event-published:superseded', 'event-published:lease-released']) {
    assert.ok(seen.points.has(point), `no crash was placed at ${point}`)
  }
  assert.ok(seen.unknownBeforeWrite > 0 && seen.unknownAfterWrite > 0, `an unknown outcome must be met on both sides of the source write: ${JSON.stringify({ ...seen, points: undefined })}`)
  return seen
}

test('replay: a crash at every durable step leaves a state that recovery reconstructs; an intent without an outcome is reported as unknown and settled from digests', async (t) => {
  const seen = await crashOracle(t, decideFromDigests)
  t.diagnostic(`crash points: ${seen.crashes}; unknown outcome met before the source write ${seen.unknownBeforeWrite} times, after it ${seen.unknownAfterWrite} times`)
  const assumesApplied = ({ store, lease, intent }) => store.recordApplied(lease, { idempotencyKey: intent.idempotencyKey, oldSourceDigest: intent.expectedSourceDigest, newSourceDigest: intent.newSourceDigest, actor: intent.actor, policy: intent.policy })
  await assert.rejects(() => crashOracle(t, assumesApplied), (error) => error.name === 'AssertionError', 'mutation control: a restart that takes an intent for an outcome')
})

// ---- identity ----------------------------------------------------------------

const RESERVED_NAMES = ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'nul.txt', 'a.', 'A', 'a', 'Guide', 'guide', 'GUIDE', 'a:b', 'a_b', 'a-b', 'a.b', 'a3a', 'a:', 'k-a', 'h-a']

// No two identifiers may share a directory on any filesystem, and no name may be one a platform reserves.
function identityEncodingOracle(encode) {
  const long = (tail) => `${'Long-Identifier.Part:'.repeat(6)}${tail}`.slice(0, 128)
  const identifiers = [...RESERVED_NAMES, long('x'), long('y'), long('X'), 'z'.repeat(128), 'Z'.repeat(128), `${'z'.repeat(127)}Z`]
  const seen = new Map()
  for (const identifier of identifiers) {
    const segment = encode(identifier)
    assert.match(segment, /^[a-z0-9_~-]+$/, `${identifier}: lower case and portable characters only`)
    assert.ok(segment.length <= MAX_PLAIN_SEGMENT + 2 && segment.length <= 96, `${identifier}: bounded length`)
    assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(segment) && !/[. ]$/.test(segment), `${identifier}: not a reserved name`)
    const folded = segment.toLowerCase()
    assert.ok(!seen.has(folded), `${identifier} and ${seen.get(folded)} meet in one directory`)
    seen.set(folded, identifier)
  }
  return identifiers
}

test('arbitration: identities become directory names that are reversible, never reserved, bounded, and distinct under case folding; equal node ids of two repositories stay apart', async (t) => {
  const identifiers = identityEncodingOracle(encodeIdentitySegment)
  for (const identifier of identifiers) {
    const segment = encodeIdentitySegment(identifier)
    assert.equal(decodeIdentitySegment(segment), segment.startsWith('k-') ? identifier : null, identifier)
  }
  assert.equal(encodeIdentitySegment('reading-room:Guide.v2'), 'k-reading-room~3a~guide~2ev2')
  assert.ok(identifiers.some((identifier) => encodeIdentitySegment(identifier).startsWith('h-')), 'a long identifier is hashed')
  for (const bad of ['', '.a', 'a/b', 'a b', 'a\\b', '../x', 'x'.repeat(129), null]) assert.throws(() => encodeIdentitySegment(bad), TypeError)
  for (const foreign of ['k-~3g', 'k-~3', 'k-~', 'k-~2f', 'k-', 'x-a', 'k-A', 'K-a', 'k-a/b']) assert.equal(decodeIdentitySegment(foreign), null)
  assert.throws(() => identityEncodingOracle((identifier) => identifier.replaceAll(':', '_').replaceAll('.', '_')), 'mutation control: an encoding that only replaces what is illegal')
  assert.throws(() => identityEncodingOracle((identifier) => `k-${identifier.toLowerCase().replaceAll(':', '~3a').replaceAll('.', '~2e')}`), 'mutation control: an encoding that folds case')

  // The same node id in two repositories, case twins, a reserved name and hashed names, through the store.
  const { store, dir, open } = arbitrationWorld(t)
  const long = `${'Long-Identifier.Part:'.repeat(6)}`.slice(0, 120)
  const places = [['reading-room', 'shared:node'], ['other-room', 'shared:node'], ['reading-room', 'Guide'], ['reading-room', 'guide'], ['CON', 'NUL'], ['reading-room', `${long}x`], ['reading-room', `${long}y`], [`${long}r`, `${long}x`]]
  for (const [index, [repoId, nodeId]] of places.entries()) store.observe(makeOperation({ repoId, nodeId, edited: `edit ${index}` }))
  // A conflict in one repository is not a conflict of the equal node id in the other.
  store.observe(makeOperation({ repoId: 'reading-room', nodeId: 'shared:node', scopeId: 'scope-other', edited: 'edit elsewhere' }))
  assert.deepEqual([store.stateOf({ repoId: 'reading-room', nodeId: 'shared:node' }).state, store.stateOf({ repoId: 'other-room', nodeId: 'shared:node' }).state], ['conflicted', 'pending'])
  assert.equal((await applyThrough(store, makeOperation({ repoId: 'other-room', nodeId: 'shared:node', edited: 'edit 1' }))).state, 'settled')
  assert.equal(store.stateOf({ repoId: 'reading-room', nodeId: 'shared:node' }).sourceDigestProven, false)
  const listed = open().list()
  assert.equal(listed.foreign, 0)
  assert.deepEqual(listed.objects.map((item) => [item.repoId, item.nodeId]).sort(), places.map((place) => [...place]).sort(), 'every identity is read back, hashed names from their events')
  for (const [repoId, nodeId] of places) assert.equal(readEventFiles(dir, { repoId, nodeId })[0].body.operation.nodeId, nodeId)
  assert.equal(fs.readdirSync(path.join(dir, OBJECTS_DIRECTORY, encodeIdentitySegment('reading-room'))).length, 5)
  assert.throws(() => store.stateOf({ repoId: '../escape', nodeId: 'a' }), refusalCode('invalid-identity'))
  if (process.platform !== 'win32') {
    for (const target of [objectDirectory(dir, { repoId: 'CON', nodeId: 'NUL' }), path.join(objectDirectory(dir, { repoId: 'CON', nodeId: 'NUL' }), eventFile(1))]) assert.equal(fs.statSync(target).mode & 0o077, 0, 'owner-only')
  }
})

// ---- the lease ---------------------------------------------------------------

function idleProcess(t) {
  const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const exited = new Promise((resolve) => { child.once('exit', resolve) })
  t.after(async () => { child.kill('SIGKILL'); await exited })
  return child
}

async function leaseOracle(t, primitives) {
  const world = arbitrationWorld(t, { primitives })
  const { store } = world
  const operation = makeOperation({ ...GUIDE, edited: 'edit a' })
  store.observe(operation)
  const live = idleProcess(t)

  // Held by a live process: refused, however long it has been held.
  const held = await store.acquireLease(GUIDE, { pid: live.pid, runtimeId: 'rt-holder' })
  assert.equal(held.acquired, true)
  for (const elapsed of [0, 60 * 1000, 365 * 24 * 3600 * 1000]) {
    world.time.now = ARBITRATION_START + elapsed
    const refused = await world.open().acquireLease(GUIDE)
    assert.deepEqual(refused, { acquired: false, code: 'lease-held', reason: 'live-process-unproven', needsPerson: false, holder: { pid: live.pid, runtimeId: 'rt-holder', acquiredAt: new Date(ARBITRATION_START).toISOString(), sequence: held.lease.sequence } }, `after ${elapsed} ms: a timeout is never proof`)
  }
  assert.deepEqual((await store.acquireLease(GUIDE)).reason, 'live-process-unproven')
  const mine = await store.acquireLease(guideNode('mine'))
  assert.deepEqual([(await world.open().acquireLease(guideNode('mine'))).reason, store.releaseLease(mine.lease)], ['held-by-this-process', true])

  // Release is an event; then the next acquirer simply acquires.
  assert.deepEqual([store.releaseLease(held.lease), store.releaseLease(held.lease)], [true, false])
  const next = await world.open().acquireLease(GUIDE)
  assert.deepEqual([next.acquired, next.takeover], [true, null])
  assert.equal(store.releaseLease(next.lease), true)

  // Recorded under the lease or not at all.
  assert.throws(() => store.recordIntent(null, intentOf(operation)), refusalCode('lease-required'))
  assert.throws(() => store.recordIntent(held.lease, intentOf(operation)), refusalCode('lease-not-held'), 'a released lease')
  assert.throws(() => store.recordIntent({ ...GUIDE, nonce: 'a'.repeat(32) }, intentOf(operation)), refusalCode('lease-not-held'), 'an invented lease')
  assert.throws(() => store.recordApplied({ ...GUIDE, nonce: 'a'.repeat(32) }, appliedOf(operation)), refusalCode('lease-not-held'))
  assert.throws(() => store.recordRefused({ ...GUIDE, nonce: 'a'.repeat(32) }, { idempotencyKey: operation.idempotencyKey, code: 'policy-revoked' }), refusalCode('lease-not-held'))

  // A holder whose process is gone on this machine: taken over, with the proof recorded. The rule under test decides
  // every other holder; only the absence of this one PID is injected.
  const gone = await store.acquireLease(GUIDE, { pid: GONE_HOLDER_PID })
  store.recordIntent(gone.lease, intentOf(operation))
  const goneProof = goneHolderProof()
  const takeover = await world.open({ primitives: { ...primitives, proveAbandoned: (ticket, options) => (ticket.pid === GONE_HOLDER_PID ? goneProof(ticket, options) : primitives.proveAbandoned(ticket, options)) } }).acquireLease(GUIDE)
  assert.deepEqual([takeover.acquired, takeover.takeover], [true, { nonce: gone.lease.nonce, reason: 'holder-process-gone' }])
  assert.equal(takeover.object.intent.status, 'outcome-unknown', 'what the gone holder left is handed to the new one')
  // The holder that was thought gone can do nothing more.
  assert.throws(() => store.recordApplied(gone.lease, appliedOf(operation)), refusalCode('lease-not-held'))
  assert.equal(store.releaseLease(gone.lease), false)
  // The write-ahead order is kept: no outcome without an intent, no intent beside an unsettled one, digests must be the operation's.
  assert.throws(() => store.recordIntent(takeover.lease, intentOf(operation)), refusalCode('intent-unresolved'))
  store.recordRefused(takeover.lease, { idempotencyKey: operation.idempotencyKey, code: 'apply-interrupted', presentSourceDigest: operation.baseSourceDigest })
  assert.throws(() => store.recordApplied(takeover.lease, appliedOf(operation)), refusalCode('intent-missing'))
  assert.throws(() => store.recordIntent(takeover.lease, { ...intentOf(operation), newSourceDigest: digestOf('something else') }), refusalCode('digest-mismatch'))
  assert.throws(() => store.recordIntent(takeover.lease, { ...intentOf(operation), idempotencyKey: `op-${'0'.repeat(64)}` }), refusalCode('unknown-operation'))
  store.recordIntent(takeover.lease, intentOf(operation))
  assert.equal(store.recordApplied(takeover.lease, appliedOf(operation)).state.state, 'settled')
  assert.equal(store.releaseLease(takeover.lease), true)
  assertLeaseSerial(readEventFiles(world.dir, GUIDE), 'lease', { takeovers: true })

  // A refusal that read a moved source makes the operation stale, not retried.
  const moved = makeOperation({ ...guideNode('moved'), edited: 'edit a' })
  store.observe(moved)
  const onMoved = await store.acquireLease(moved)
  const refusedState = store.recordRefused(onMoved.lease, { idempotencyKey: moved.idempotencyKey, code: 'stale-source', presentSourceDigest: digestOf('written by somebody else') }).state
  assert.deepEqual([refusedState.state, stateOfOperation(refusedState, moved).state, stateOfOperation(refusedState, moved).reason, refusedState.sourceDigest], ['conflicted', 'conflicted', 'stale-base', digestOf('written by somebody else')])
  assert.deepEqual(REFUSED_DISPOSITIONS, ['retained', 'conflicted', 'refused'])
  assert.throws(() => store.recordRefused(onMoved.lease, { idempotencyKey: moved.idempotencyKey, code: 'stale-source', disposition: 'dropped' }), refusalCode('invalid-event'))
  store.releaseLease(onMoved.lease)
}

test('arbitration: a lease left by a real process that exited is taken over under the production proof, and a PID the system has already given to somebody else is, correctly, not', async (t) => {
  // The one test that asks the operating system about a real exited child. Its PID can be reused at once, and the
  // lease is then rightly kept (`live-process-unproven`): that round releases with the nonce it holds and tries again.
  const world = arbitrationWorld(t)
  const reasons = []
  for (let round = 0; round < 8 && !reasons.includes('holder-process-gone'); round += 1) {
    const identity = guideNode(`left-behind-${round}`)
    const left = await world.store.acquireLease(identity, { pid: exitedPid() })
    assert.equal(left.acquired, true)
    const attempt = await world.open().acquireLease(identity)
    if (attempt.acquired) {
      assert.deepEqual(attempt.takeover, { nonce: left.lease.nonce, reason: 'holder-process-gone' })
      assert.equal(world.open().releaseLease(attempt.lease), true)
      reasons.push('holder-process-gone')
    } else {
      assert.deepEqual([attempt.code, attempt.reason], ['lease-held', 'live-process-unproven'], 'the only other answer: that PID is a live process again')
      assert.equal(world.store.releaseLease(left.lease), true)
      reasons.push(attempt.reason)
    }
  }
  t.diagnostic(`real exited holders: ${reasons.join(', ')}`)
  assert.ok(reasons.includes('holder-process-gone'), `eight PIDs of exited children were all live again: ${reasons.join(', ')}`)
})

test('arbitration: the object lease has one holder, refuses while held, is released by an event, is taken over only from a process that is gone, never on a timeout, and guards every apply record', async (t) => {
  await leaseOracle(t, OBJECT_STORE_PRIMITIVES)
  const onTimeout = { ...OBJECT_STORE_PRIMITIVES, proveAbandoned: createAbandonmentProof({ maxAgeMs: 30 * 60 * 1000 }) }
  await assert.rejects(() => leaseOracle(t, onTimeout), (error) => error.name === 'AssertionError', 'mutation control: a lease that is taken over on a timeout')

  // A ticket written on another machine is never judged from here: it needs a person.
  const world = arbitrationWorld(t)
  const held = await world.store.acquireLease(GUIDE, { pid: GONE_HOLDER_PID })
  const elsewhere = world.open({ primitives: { ...OBJECT_STORE_PRIMITIVES, proveAbandoned: createAbandonmentProof({ machine: 'e'.repeat(64) }) } })
  world.time.now += 24 * 3600 * 1000
  const foreign = await elsewhere.acquireLease(GUIDE)
  assert.deepEqual([foreign.acquired, foreign.code, foreign.reason, foreign.needsPerson], [false, 'lease-held', 'held-on-another-machine', true])
  assert.equal(readEventFiles(world.dir, GUIDE).at(-1).body.lease.machine, machineDigest())
  assert.equal(world.store.releaseLease(held.lease), true)
})

// ---- hygiene -----------------------------------------------------------------

const canonicalEvent = (event) => {
  const sort = (value) => (Array.isArray(value) ? value.map(sort) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value)
  return `${JSON.stringify(sort(event), null, 2)}\n`
}

test('arbitration: a malformed, foreign, oversized, reordered or missing event file refuses everything for that object, names no content, and hides no other object', async (t) => {
  const NOTE_TEXT = 'Sentence-from-a-note'
  const damage = {
    'foreign-object-file': ({ directory }) => fs.writeFileSync(path.join(directory, `${NOTE_TEXT}.txt`), NOTE_TEXT),
    'object-event-malformed': ({ directory }) => fs.writeFileSync(path.join(directory, eventFile(3)), `{"excerpt": "${NOTE_TEXT}"`),
    'object-event-malformed (not canonical)': ({ directory, events }) => fs.writeFileSync(path.join(directory, eventFile(3)), JSON.stringify({ ...events[1], sequence: 3 })),
    'object-event-malformed (unknown member)': ({ directory, events, digests }) => fs.writeFileSync(path.join(directory, eventFile(3)), canonicalEvent({ ...events[1], sequence: 3, previous: digests[1], excerpt: NOTE_TEXT })),
    'object-event-foreign': ({ directory, events, digests }) => fs.writeFileSync(path.join(directory, eventFile(3)), canonicalEvent({ ...events[1], sequence: 3, previous: digests[1], nodeId: 'reading-room:another', body: { ...events[1].body, operation: { ...events[1].body.operation, nodeId: 'reading-room:another' } } })),
    'object-log-chain-broken': ({ directory, events }) => fs.writeFileSync(path.join(directory, eventFile(3)), canonicalEvent({ ...events[1], sequence: 3, previous: digestOf('not the event before') })),
    'object-log-gap': ({ directory, events, digests }) => fs.writeFileSync(path.join(directory, eventFile(4)), canonicalEvent({ ...events[1], sequence: 4, previous: digests[1] })),
    'object-event-too-large': ({ directory }) => fs.writeFileSync(path.join(directory, eventFile(3)), Buffer.alloc(OBJECT_STORE_LIMITS.maxEventBytes + 1, 0x20)),
    'object-log-inconsistent': ({ directory, events, digests }) => fs.writeFileSync(path.join(directory, eventFile(3)), canonicalEvent({ ...events[0], sequence: 3, previous: digests[1] })),
  }
  for (const [label, harm] of Object.entries(damage)) {
    const code = label.split(' ')[0]
    const world = arbitrationWorld(t)
    const operation = makeOperation({ ...GUIDE, edited: 'edit a' })
    world.store.observe(operation)
    world.store.observe(makeOperation({ ...GUIDE, scopeId: 'scope-other', edited: 'edit a' }))
    world.store.observe(makeOperation({ ...guideNode('healthy'), edited: 'edit a' }))
    const directory = objectDirectory(world.dir, GUIDE)
    const before = snapshotTree(directory)
    const digests = Object.values(before).map((hex) => sha256Digest(Buffer.from(hex, 'hex')))
    harm({ directory, events: readEventFiles(world.dir, GUIDE), digests })
    const damaged = snapshotTree(directory)
    for (const store of [world.store, world.open()]) {
      const attempts = {
        observe: () => store.observe(makeOperation({ ...GUIDE, scopeId: 'scope-third', edited: 'edit c' })),
        replay: () => store.observe(operation),
        stateOf: () => store.stateOf(GUIDE),
        recoverObject: () => store.recoverObject(GUIDE),
        recordIntent: () => store.recordIntent({ ...GUIDE, nonce: 'a'.repeat(32) }, intentOf(operation)),
      }
      for (const [name, attempt] of Object.entries(attempts)) {
        assert.throws(attempt, (error) => {
          assert.ok(error instanceof EditArbitrationRefusal, `${label}: ${name} threw ${error}`)
          assert.equal(error.code, code, `${label}: ${name}`)
          assert.ok(!JSON.stringify([error.message, error.detail]).includes(NOTE_TEXT), `${label}: ${name} names content`)
          return true
        })
      }
      await assert.rejects(() => store.acquireLease(GUIDE), refusalCode(code), label)
      const listed = store.list()
      assert.deepEqual(listed.objects.map((item) => [item.nodeId, item.state, item.code ?? null]), [['reading-room:guide', 'unreadable', code], ['reading-room:healthy', 'pending', null]], `${label}: listed as unreadable beside the healthy object`)
      assert.deepEqual(store.rebuildIndexes().unreadable, [{ ...GUIDE, code }], label)
    }
    assert.deepEqual(snapshotTree(directory), damaged, `${label}: nothing is repaired, removed or appended`)
  }
  // A staging file that a crashed writer left is not an event and not a stranger.
  const world = arbitrationWorld(t)
  world.store.observe(makeOperation({ ...GUIDE, edited: 'edit a' }))
  fs.writeFileSync(path.join(objectDirectory(world.dir, GUIDE), '.atelier-write-00000000-0000-4000-8000-000000000000.tmp'), '{"half":')
  assert.equal(world.open().observe(makeOperation({ ...GUIDE, scopeId: 'scope-other', edited: 'edit a' })).object.operations[0].origins.length, 2)
  // Strangers beside the object directories are counted, never opened, never in the way.
  fs.writeFileSync(path.join(world.dir, OBJECTS_DIRECTORY, 'stranger.txt'), NOTE_TEXT)
  fs.mkdirSync(path.join(world.dir, OBJECTS_DIRECTORY, encodeIdentitySegment('reading-room'), 'Stranger'))
  assert.deepEqual([world.store.list().foreign, world.store.list().objects.length], [2, 1])
})

async function logFullOracle(t, limits) {
  const world = arbitrationWorld(t, { primitives: { ...OBJECT_STORE_PRIMITIVES, limits } })
  const { store } = world
  const operation = makeOperation({ ...GUIDE, edited: 'edit a' })
  store.observe(operation)
  const attempt = await store.acquireLease(GUIDE)
  let offered = 0
  const offer = () => { offered += 1; return store.observe(makeOperation({ ...GUIDE, scopeId: `scope-${offered}`, edited: 'edit a' })) }
  while (readEventFiles(world.dir, GUIDE).length < limits.maxEventsPerObject - limits.reservedForSettlement) offer()
  const full = readEventFiles(world.dir, GUIDE)
  assert.throws(offer, (error) => error instanceof EditArbitrationRefusal && error.code === 'object-log-full' && error.detail.events === full.length && error.detail.limit === limits.maxEventsPerObject)
  // Refused, not rotated: every event is still there, and an offer already recorded is still acknowledged.
  assert.deepEqual(readEventFiles(world.dir, GUIDE), full)
  assert.deepEqual([store.observe(operation).appended, store.stateOf(GUIDE).operations[0].origins.length], [false, offered])
  // What was in flight is settled out of the reserve.
  store.recordIntent(attempt.lease, intentOf(operation))
  assert.equal(store.recordApplied(attempt.lease, appliedOf(operation)).state.state, 'settled')
  assert.equal(store.releaseLease(attempt.lease), true)
  assert.deepEqual(readEventFiles(world.dir, GUIDE).slice(full.length).map((event) => event.type), ['apply-intent', 'applied', 'siblings-stale', 'lease-released'])
  assert.throws(offer, refusalCode('object-log-full'))
  await assert.rejects(() => world.open().acquireLease(GUIDE), refusalCode('object-log-full'))
  // An event larger than an event may be is refused before it is written.
  const wide = makeOperation({ ...guideNode('wide'), edited: 'edit a' })
  assert.throws(() => store.observe(wide, { resolves: Array.from({ length: 250 }, (_, index) => `op-${String(index).padStart(64, '0')}`) }), refusalCode('object-event-too-large'))
  assert.equal(fs.existsSync(path.join(objectDirectory(world.dir, guideNode('wide')), eventFile(1))), false)
}

test('arbitration: a full object log and an oversized event refuse; nothing is rotated, compacted or dropped, and what is in flight can still be settled', async (t) => {
  assert.deepEqual(OBJECT_STORE_LIMITS, { maxEventBytes: 16384, maxEventsPerObject: 4096, reservedForSettlement: 64, maxAppendAttempts: 256 })
  await logFullOracle(t, { ...OBJECT_STORE_LIMITS, maxEventsPerObject: 20, reservedForSettlement: 8 })
  await assert.rejects(() => logFullOracle(t, { ...OBJECT_STORE_LIMITS, maxEventsPerObject: 20, reservedForSettlement: 0 }), 'mutation control: a store that keeps no reserve cannot settle')
})

// Every string a store writes or throws is an identifier it was given, a
// digest, a store reference, a nonce, a timestamp or a word of a closed list.
function assertArbitrationCarriesNoText(value, label, identifiers) {
  const vocabulary = new Set([...OBJECT_EVENT_TYPES, ...ARBITRATION_REASONS, ...REFUSED_DISPOSITIONS, OBJECT_EVENT_SCHEMA, OBJECT_INDEX_SCHEMA, EDIT_ACKNOWLEDGEMENT_SCHEMA, 'atelier-obsidian-edit-operation/v1', '1.0.0', EDIT_LENS_VERSION,
    'body-replacement', 'semantic-proposal', 'pending', 'proposed', 'refused', 'conflicted', 'applied', 'settled', 'empty', 'unreadable', 'outcome-unknown', 'origin', 'sibling', 'manual', 'automatic', 'lease-held', 'live-process-unproven', 'held-by-this-process', 'holder-process-gone',
    'apply-interrupted', 'stale-source', 'unsupported-structural-edit', 'object-conflicted', 'lease-not-held', 'object-log-full', 'foreign-object-file', 'invalid-operation', 'EditArbitrationRefusal'])
  const visit = (item, pointer) => {
    if (typeof item === 'string') {
      const fine = DIGEST.test(item) || /^recovery\/objects\/[0-9a-f]{64}\.bin$/.test(item) || /^op-[0-9a-f]{64}$/.test(item) || /^[0-9a-f]{32}$/.test(item) || /^[0-9a-f]{64}$/.test(item) || /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(item) || identifiers.has(item) || vocabulary.has(item)
      assert.ok(fine, `${label}: ${pointer} carries ${JSON.stringify(item)}`)
    } else if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `${pointer}/${index}`))
    else if (item && typeof item === 'object') for (const [key, entry] of Object.entries(item)) visit(entry, `${pointer}/${key}`)
    else assert.ok(item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean', `${label}: ${pointer}`)
  }
  visit(value, '')
}

test('arbitration: events, indexes, acknowledgements, listings and refusals hold identifiers, digests, references, codes, numbers and timestamps only', async (t) => {
  // Real operations of a real note, so that there is text that could leak.
  const context = cases.get('guide.md')
  const elsewhere = { ...context.manifest, scopeId: 'scope-other', generationId: 'gen-other-0001' }
  const edits = ['Closing words, revised.', `Closing words and [[${BETA_WIKI}]].`, 'Closing words!'].map((text) => replaceNth(context.publishedNoteBytes, 'Closing words.', text))
  const real = [observe(queueEdit(t, context, edits[0]), context).operation, observe(queueEdit(t, context, edits[1]), context).operation, observe(queueEdit(t, context, edits[2], { scopeId: 'scope-other', manifest: elsewhere }), { ...context, manifest: elsewhere }).operation]
  const world = arbitrationWorld(t, { workspaceId: WORKSPACE_ID })
  const { store } = world
  const outputs = []
  const errors = []
  const attempt = async (action) => { try { outputs.push(await action()) } catch (error) { assert.ok(error instanceof EditArbitrationRefusal, String(error)); errors.push(error) } }
  await attempt(() => store.observe(real[0]))
  await attempt(() => store.observe(real[1]))
  const first = await store.acquireLease(real[0], { runtimeId: 'rt-disclosure' })
  outputs.push(first, await store.acquireLease(real[0]))
  await attempt(() => store.recordIntent(first.lease, { ...intentOf(real[0], 'agent-1'), policy: { mode: 'automatic', policyDigest: digestOf('policy') } }))
  await attempt(() => store.recordApplied(first.lease, { ...appliedOf(real[0], 'agent-1'), policy: { mode: 'automatic', policyDigest: digestOf('policy') } }))
  await attempt(() => store.observe(real[2]))
  await attempt(() => store.recordIntent(first.lease, intentOf(real[2])))
  await attempt(() => store.recordRefused(first.lease, { idempotencyKey: real[2].idempotencyKey, code: 'stale-source', presentSourceDigest: digestOf('moved') }))
  outputs.push(store.releaseLease(first.lease))
  await attempt(() => store.recordIntent(first.lease, intentOf(real[2])))
  await attempt(() => store.observe({ ...real[2], ext: { [EXT]: { ...real[2].ext[EXT], excerpt: 'Closing words!' } }, state: 'superseded' }))
  fs.writeFileSync(objectDirectory(world.dir, guideNode('strange')), '') // a file where an object directory would be
  await attempt(() => store.stateOf(guideNode('strange')))
  outputs.push(store.list(), store.stateOf(real[0]), store.recoverObject(real[0]), store.rebuildIndexes())
  assert.ok(errors.length >= 3 && outputs.length >= 10)

  const identifiers = new Set([WORKSPACE_ID, 'reading-room', 'reading-room:guide', 'reading-room:strange', 'scope-full', 'scope-other', context.manifest.generationId, 'gen-other-0001', 'rt-disclosure', 'agent-1', 'person-1', ...real.map((operation) => operation.editId)])
  const written = [...Object.values(snapshotTree(path.join(world.dir, OBJECTS_DIRECTORY, encodeIdentitySegment('reading-room'), encodeIdentitySegment('reading-room:guide')))), ...Object.values(snapshotTree(path.join(world.dir, OBJECT_INDEX_DIRECTORY)))].map((hex) => JSON.parse(Buffer.from(hex, 'hex').toString('utf8')))
  assert.ok(written.length >= 10)
  assertArbitrationCarriesNoText(written, 'files', identifiers)
  assertArbitrationCarriesNoText(outputs, 'results', identifiers)
  for (const error of errors) {
    assertArbitrationCarriesNoText({ name: error.name, code: error.code, detail: error.detail }, `refusal ${error.code}`, new Set([...identifiers, error.code]))
    // The message is the code and a fixed sentence.
    assert.match(error.message, new RegExp(`^${error.code}: [a-z ,;'-]+$`), error.code)
  }
  const everything = JSON.stringify([written, outputs, errors.map((error) => [error.message, error.detail])])
  for (const text of ['Closing words', 'Field guide', context.note.path, ALPHA_WIKI]) assert.ok(!everything.includes(text), `note text or a title leaked: ${text}`)
  for (const machinePath of [world.dir, os.tmpdir()]) assert.ok(!everything.includes(JSON.stringify(machinePath).slice(1, -1)), 'a machine path leaked')
  assert.throws(() => assertArbitrationCarriesNoText([{ ...written[0], excerpt: 'Closing words, revised.' }], 'control', identifiers), 'mutation control: an event that quotes the note')
  assert.throws(() => assertArbitrationCarriesNoText([{ ...written[0], file: path.join(world.dir, 'guide.md') }], 'control', identifiers), 'mutation control: an event that names a machine path')
})

// ---------------------------------------------------------------------------
// Source apply: one policy-aware operation, manual and automatic
// ---------------------------------------------------------------------------
//
// Every source file written below lives in a temporary directory made by the
// test: invented repositories, initialised with a real git so that the index,
// the history and `git status` can be compared before and after.

const EXCHANGE_HERE = (() => { try { resolveExchange({}); return true } catch { return false } })()
const needsExchange = EXCHANGE_HERE ? {} : { skip: 'no atomic exchange on this platform: source apply refuses exchange-unavailable, which its own test asserts' }

const LANTERN = 'east-wing/notes/lantern.md'
const APPLY_FILES = Object.freeze({
  [LANTERN]: noteText({ id: 'east-wing:lantern', title: 'Lantern room', body: 'The lamp turns once a minute. See the [compass](compass.md).\n\nA second paragraph that nobody edits.' }),
  'east-wing/notes/compass.md': noteText({ id: 'east-wing:compass', title: 'Compass rose', body: 'North is painted red.' }),
  'east-wing/notes/ledger.md': noteText({ id: 'east-wing:ledger', title: 'Ledger', body: 'Kept for the keeper only.', audience: 'private' }),
  'west-wing/logs/tide.md': noteText({ id: 'west-wing:tide', title: 'Tide log', body: 'High water at noon.' }),
})
const WHOLE = { scopeId: 'scope-whole', mode: 'full', selector: { all: true } }
const EAST = { scopeId: 'scope-east', mode: 'scoped', selector: { repo: 'east-wing' } }
const applyWorld = (t, options = {}) => makeApplyWorld(t, { repositories: ['east-wing', 'west-wing'], files: APPLY_FILES, scopes: [WHOLE, EAST], ...options })

// The whole project tree (git directories included), and what git says about each repository.
const projectState = (world) => ({
  tree: treeListing(world.projectDir),
  status: Object.fromEntries(['east-wing', 'west-wing'].filter((name) => fs.existsSync(world.repo(name))).map((name) => [name, git(world.repo(name), ['status', '--porcelain'])])),
})
const assertNothingWritten = (world, before, label) => assert.deepEqual(projectState(world), before, `${label}: a refusal writes nothing, anywhere in the project, and leaves the git index alone`)

test('manual apply, end to end: the person\'s edit becomes exactly the expected source bytes, the old source is retained, a second run is a no-op, and the next ticks republish, lift the hold and refresh the sibling view', needsExchange, async (t) => {
  const world = applyWorld(t)
  const engine = world.engine()
  assert.deepEqual((await engine.tick()).scopes.map((scope) => scope.state), ['current', 'current'])
  const baseSource = fs.readFileSync(world.source(LANTERN))
  const expected = replaceNth(baseSource, 'once a minute', 'twice a minute')
  const editedNote = world.editNote('east-wing:lantern', 'once a minute', 'twice a minute')
  world.advance(1000)
  const held = await engine.tick()
  assert.equal(held.scopes.find((scope) => scope.scopeId === 'scope-whole').state, 'held-for-your-edit')
  const edit = world.editOf('east-wing:lantern')
  const before = projectState(world)

  const sourceApply = world.sourceApply()
  const listed = await sourceApply.list()
  assert.deepEqual(listed.map((item) => [item.editId, item.repoId, item.nodeId, item.state]), [[edit.editId, 'east-wing', 'east-wing:lantern', 'queued']])
  // The live note is never what gets applied: it is scribbled over before the apply and the preserved bytes win.
  fs.writeFileSync(world.noteFile('east-wing:lantern'), Buffer.concat([editedNote, utf8('\nscribbled after the edit was preserved\n')]))
  const result = await sourceApply.apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
  fs.writeFileSync(world.noteFile('east-wing:lantern'), editedNote)
  assert.deepEqual([result.status, result.code, result.replayed, result.actor, result.policy], ['applied', 'applied', false, 'person-synthetic', { mode: 'manual' }])
  assert.deepEqual([result.oldSourceDigest, result.newSourceDigest], [sha256Digest(baseSource), sha256Digest(expected)])

  const after = projectState(world)
  assert.equal(fs.readFileSync(world.source(LANTERN)).toString('hex'), expected.toString('hex'), 'the source is exactly the expected edit')
  const changed = Object.keys(after.tree).filter((key) => after.tree[key] !== before.tree[key])
  assert.deepEqual([changed, Object.keys(before.tree).filter((key) => !(key in after.tree)), Object.keys(after.tree).filter((key) => !(key in before.tree))], [[LANTERN], [], []], 'one file changed; no file appeared or went; the git directory is byte for byte what it was')
  assert.deepEqual(after.status, { 'east-wing': ' M notes/lantern.md\n', 'west-wing': '' }, 'nothing is staged or committed')
  assert.equal(fs.lstatSync(world.source(LANTERN)).mode & 0o777, 0o644)
  assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), result.backupRef)), baseSource, 'the old source is retained as the backup')

  const shown = await sourceApply.show(edit.editId)
  assert.deepEqual([shown.operation.state, shown.object.outcomeUnknown, shown.outcomes.map((outcome) => [outcome.status, outcome.actor, outcome.oldSourceDigest, outcome.newSourceDigest])],
    ['applied', false, [['applied', 'person-synthetic', sha256Digest(baseSource), sha256Digest(expected)]]])
  const again = await sourceApply.apply({ editId: edit.editId, mode: 'manual', actor: 'someone-else' })
  assert.deepEqual([again.status, again.code, again.replayed, again.actor, again.applyId], ['applied', 'already-applied', true, 'person-synthetic', result.applyId], 'a repeated request is answered from the record')
  assert.deepEqual(projectState(world), after, 'the second run wrote nothing')

  world.advance(1000)
  await engine.tick()
  world.advance(1000)
  const settled = await engine.tick()
  assert.deepEqual(settled.scopes.map((scope) => [scope.scopeId, scope.state, scope.heldNotes]), [['scope-east', 'current', []], ['scope-whole', 'current', []]], 'the hold is lifted and both views are current')
  assert.deepEqual(settled.pendingEdits, [])
  assert.deepEqual(fs.readFileSync(world.noteFile('east-wing:lantern')), editedNote, 'the note the person edited is the newly prepared note, never rewritten')
  assert.match(fs.readFileSync(world.noteFile('east-wing:lantern', 'scope-east'), 'utf8'), /twice a minute/, 'the sibling view was refreshed from the new source')
  const closed = world.pendingEdits().find((item) => item.editId === edit.editId)
  assert.equal(closed.state, 'withdrawn')
  assert.deepEqual((await sourceApply.apply({ editId: edit.editId, mode: 'manual' })).code, 'already-applied', 'the record answers even after the pending edit closed')
})

test('automatic apply: an installed, in-scope, active policy applies with no confirmation through the engine, and manual mode never touches a source however many ticks pass', needsExchange, async (t) => {
  const world = applyWorld(t)
  const context = { loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, clock: world.clock }
  const engine = world.engine({ applyOperation: createEngineApplyOperation({ context }) })
  await engine.tick()
  const baseSource = fs.readFileSync(world.source(LANTERN))
  world.editNote('east-wing:lantern', 'once a minute', 'three times a minute')
  const before = projectState(world)
  for (let tick = 0; tick < 12; tick += 1) {
    world.advance(5 * 60 * 1000)
    assert.deepEqual((await engine.tick()).dispatched, [])
  }
  assertNothingWritten(world, before, 'twelve ticks in manual mode, with the apply operation registered')
  // A policy alone is not a mode: still nothing.
  const policy = world.installPolicy({ selector: { repo: 'east-wing' } })
  world.advance(5 * 60 * 1000)
  await engine.tick()
  assertNothingWritten(world, before, 'a policy installed while the mode is manual')

  world.configureMachine({ maintenanceMode: 'automatic' })
  world.advance(5 * 60 * 1000)
  const report = await engine.tick()
  assert.deepEqual(report.dispatched.map((item) => [item.status, item.code, item.state]), [['applied', 'applied', 'applied']])
  assert.deepEqual(fs.readFileSync(world.source(LANTERN)), replaceNth(baseSource, 'once a minute', 'three times a minute'))
  assert.deepEqual(projectState(world).status, { 'east-wing': ' M notes/lantern.md\n', 'west-wing': '' })
  const [outcome] = (await world.sourceApply().show(report.dispatched[0].editId)).outcomes
  assert.deepEqual([outcome.actor, outcome.policy], ['agent-synthetic', { mode: 'automatic', policyDigest: policy.digest, policyId: 'policy-synthetic' }], 'the actor and the policy are the installed ones')
  world.advance(1000)
  const next = await engine.tick()
  assert.deepEqual(next.scopes.map((scope) => scope.state), ['current', 'current'])
  assert.deepEqual([next.dispatched.length, next.pendingEdits], [0, []])
})

test('mutation control: an apply whose policy decision always allows fails the manual-mode source oracle', needsExchange, async (t) => {
  const world = applyWorld(t)
  await world.engine().tick()
  world.editNote('east-wing:lantern', 'once a minute', 'never')
  world.queueDirectly()
  const before = projectState(world)
  const lax = world.sourceApply({}, { decide: () => ({ allowed: true, actor: 'anyone', policy: { mode: 'manual' }, retryBudget: null }) })
  await lax.apply({ editId: world.editOf('east-wing:lantern').editId, mode: 'automatic' })
  assert.throws(() => assertNothingWritten(world, before, 'no policy installed'), assert.AssertionError)
})

test('policy: the canonical digest excludes the digest member and ignores key order, and one decision function serves manual and automatic requests', () => {
  const content = { schema: 'atelier-obsidian-apply-policy/v1', policyId: 'policy-a', workspaceId: APPLY_WORKSPACE_ID, mode: 'automatic', status: 'active', actor: { kind: 'agent', id: 'agent-a' }, version: 1,
    allowedEditClasses: ['body-replacement'], selector: { ids: ['room:a'] }, maxBatchSize: 2, retryBudget: 1, conflictDisposition: 'hold' }
  const policy = withApplyPolicyDigest({ ...content, digest: bytesDigest('anything') })
  assert.equal(policy.digest, bytesDigest(canonicalApplyPolicy(policy)))
  assert.equal(applyPolicyDigest(Object.fromEntries(Object.entries(policy).reverse())), policy.digest)
  assert.equal(canonicalApplyPolicy(policy).includes('"digest"'), false)
  assert.notEqual(applyPolicyDigest({ ...policy, maxBatchSize: 3 }), policy.digest)

  const node = (id, extra = {}) => ({ id, repo: 'room', path: `${id.slice(5)}.md`, eligible: true, audience: 'team', ...extra })
  const graph = { nodes: [node('room:a'), node('room:b'), node('room:c', { audience: 'private' }), node('room:d', { eligible: false })], edges: [] }
  const profile = { schema: 'atelier-obsidian-corpus-profile/v1', workspaceId: APPLY_WORKSPACE_ID, repositories: [{ repoId: 'room', root: 'room', enrollment: 'enrolled' }], audience: { allow: ['team'] } }
  const decideWith = (installed, primitives = {}) => createApplyPolicyForOracleTests({ authorize: () => (installed.authorized === false ? installed : { authorized: true, reason: 'apply-policy-active', policy: installed }), ...primitives })
  const ask = (decide, nodeId, request, extra = {}) => decide({ request: { editId: 'edit-x', ...request }, workspace: {}, graph, profile, object: { repoId: 'room', nodeId }, editClass: 'body-replacement', attempts: [], ...extra })
  const decide = decideWith(policy)
  assert.deepEqual(ask(decide, 'room:a', { mode: 'manual', actor: 'person-a' }), { allowed: true, actor: 'person-a', policy: { mode: 'manual' }, retryBudget: null })
  assert.deepEqual(ask(decide, 'room:a', { mode: 'automatic' }), { allowed: true, actor: 'agent-a', policy: { mode: 'automatic', policyDigest: policy.digest, policyId: 'policy-a' }, retryBudget: 1 })
  const codeOf = (decision) => [decision.allowed, decision.code]
  for (const mode of ['manual', 'automatic']) {
    assert.deepEqual(codeOf(ask(decide, 'room:c', { mode })), [false, 'object-not-visible'], `${mode}: a withheld audience`)
    assert.deepEqual(codeOf(ask(decide, 'room:d', { mode })), [false, 'object-not-visible'], `${mode}: an ineligible object`)
    assert.deepEqual(codeOf(ask(decide, 'room:zz', { mode })), [false, 'object-not-visible'], `${mode}: an absent object answers exactly as a withheld one`)
    assert.deepEqual(codeOf(ask(decide, 'room:a', { mode }, { editClass: 'semantic-proposal' })), [false, 'edit-class-not-allowed'], `${mode}: a class no apply exists for`)
  }
  assert.deepEqual(codeOf(ask(decide, 'room:b', { mode: 'automatic' })), [false, 'outside-policy-selection'])
  assert.deepEqual(codeOf(ask(decide, 'room:a', { mode: 'automatic', policyDigest: bytesDigest('older revision') })), [false, 'policy-changed-since-dispatch'])
  assert.deepEqual(codeOf(ask(decide, 'room:a', { mode: 'automatic' }, { attempts: [{ policyDigest: policy.digest }, { policyDigest: policy.digest }] })), [false, 'retry-budget-exhausted'])
  assert.equal(ask(decide, 'room:a', { mode: 'automatic' }, { attempts: [{ policyDigest: policy.digest }, { policyDigest: bytesDigest('another revision') }] }).allowed, true, 'a new revision starts a new budget')
  assert.deepEqual(codeOf(ask(decideWith({ ...policy, maxBatchSize: 9 }), 'room:a', { mode: 'automatic' })), [false, 'policy-digest-mismatch'])
  assert.deepEqual(codeOf(ask(decideWith(withApplyPolicyDigest({ ...policy, allowedEditClasses: [] })), 'room:a', { mode: 'automatic' })), [false, 'apply-policy-invalid'], 'an automatic policy that allows no class is not a policy')
  assert.deepEqual(codeOf(ask(decideWith(withApplyPolicyDigest({ ...policy, allowedEditClasses: ['rename'] })), 'room:a', { mode: 'automatic' })), [false, 'apply-policy-invalid'], 'an unknown class refuses')
  assert.deepEqual(codeOf(ask(decideWith(withApplyPolicyDigest({ ...policy, selector: { repo: 'unknown-room' } })), 'room:a', { mode: 'automatic' })), [false, 'policy-selector-invalid'])
  assert.deepEqual(codeOf(ask(decideWith({ authorized: false, reason: 'no-apply-policy-installed', policy: null }), 'room:a', { mode: 'automatic' })), [false, 'no-apply-policy-installed'], 'there is no ambient agent mode')
  assert.deepEqual(codeOf(ask(decide, 'room:a', { mode: 'agent' })), [false, 'invalid-apply-request'])
  assert.deepEqual(codeOf(ask(decide, 'room:a', { mode: 'manual', actor: 'not an identifier' })), [false, 'invalid-apply-request'])
  assert.deepEqual(codeOf(decideApply({ request: { mode: 'automatic', editId: 'edit-x' }, workspace: { workspaceRoot: path.join(os.tmpdir(), 'atelier-no-such-workspace'), workspaceId: APPLY_WORKSPACE_ID }, graph, profile, object: { repoId: 'room', nodeId: 'room:a' }, editClass: 'body-replacement' })), [false, 'machine-settings-absent'], 'production reads the installed policy from disk')
  assert.deepEqual(Object.keys(APPLY_POLICY_PRIMITIVES).sort(), ['authorize', 'digestOf', 'select'])
  // Mutation control: a decision that trusts the digest a policy carries accepts a tampered policy.
  assert.equal(ask(decideWith({ ...policy, maxBatchSize: 9 }, { digestOf: (installed) => installed.digest }), 'room:a', { mode: 'automatic' }).allowed, true)
})

// One world, one note per case. No publisher is needed to refuse, so the view is written directly and this table
// runs on every platform.
const REFUSAL_CASES = Object.freeze(['disabled', 'stale', 'renamed', 'deleted', 'symlinked', 'symlinked-directory', 'hard-linked', 'ignored', 'ignore-unknown', 'managed-root', 'not-visible', 'lens', 'conflicted',
  'exchange', 'volume', 'unknown-scope', 'no-policy', 'manual-mode', 'revoked', 'revoked-by-command', 'paused', 'outside-selection', 'digest-mismatch', 'changed-since-dispatch', 'budget', 'batch-a', 'batch-b', 'revoked-late', 'no-change', 'withheld-renamed', 'withheld-deleted'])
const caseFile = (name) => `east-wing/cases/${name === 'symlinked-directory' ? 'linked/' : ''}${name}.md`
const caseNode = (name) => `east-wing:case-${name}`
function refusalWorld(t) {
  const files = { ...APPLY_FILES, 'east-wing/charts/table.pdf': Buffer.from('255044462d312e340a73796e7468657469630a', 'hex'),
    'east-wing/charts/table.pdf.kg.json': `${JSON.stringify({ schema: 'mnstry.source-sidecar@v1', asset: 'table.pdf', title: 'Reference table', summary: 'Invented figures.', tags: ['chart'], kg: { id: 'east-wing:table', type: 'evidence', domain: 'sample', lifecycle: 'source', status: 'active', audience: 'team', relations: { evidences: ['east-wing:lantern'] } } }, null, 2)}\n` }
  for (const name of REFUSAL_CASES) files[caseFile(name)] = noteText({ id: caseNode(name), title: `Case ${name}`, body: 'Original sentence.', audience: name === 'not-visible' || name.startsWith('withheld-') ? 'private' : 'team' })
  files[caseFile('no-change')] = files[caseFile('no-change')].replace('  audience: "team"\n', '  audience: "team"\n  relations:\n    supports:\n      - "east-wing:compass"\n')
  const world = applyWorld(t, { files, audienceAllow: ['team', 'private'] })
  for (const scope of [WHOLE, EAST]) world.publishDirectly(scope.scopeId)
  for (const name of REFUSAL_CASES) world.editNote(caseNode(name), 'Original sentence.', name === 'no-change' ? 'Original sentence.' : 'Edited sentence.')
  // A generated region removed and nothing authored changed: a body replacement that changes no source byte.
  const noChange = world.noteFile(caseNode('no-change'))
  const entry = world.manifest().notes.find((note) => note.nodeId === caseNode('no-change'))
  assert.ok(entry.regions.generated.length > 0, 'the fixture note has a generated region to remove')
  fs.writeFileSync(noChange, fs.readFileSync(noChange).subarray(0, entry.regions.body.end))
  world.editNote(caseNode('lens'), '# Case lens', `# Case lens\n\nA new link to [[${path.basename(world.manifest().notes.find((note) => note.nodeId === 'east-wing:compass').path, '.md')}]].`)
  world.editNote(caseNode('conflicted'), 'Original sentence.', 'Another sentence entirely.', 'scope-east')
  fs.appendFileSync(world.noteFile('east-wing:table'), '\nTyped into a note that stands for a file.\n')
  for (const scope of [WHOLE, EAST]) world.queueDirectly(scope.scopeId)
  return world
}

test('apply refusals, manual and automatic: every refusal is typed, keeps the edit and writes nothing anywhere in the project', async (t) => {
  const world = refusalWorld(t)
  const objects = () => openObjectStore({ stateRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID, repositoryRoots: [world.projectDir], clock: world.clock })
  const automatic = (overrides) => { world.configureMachine({ maintenanceMode: 'automatic' }); return world.installPolicy(overrides) }
  const seen = new Set()
  async function refuses(name, expected, { mode = 'manual', setup = () => {}, options = {}, primitives, request = {}, nodeId = caseNode(name), scopeId } = {}) {
    const edit = world.editOf(nodeId, scopeId)
    assert.ok(edit, `${name}: the fixture queued no edit`)
    const undo = setup()
    let before = projectState(world)
    // A case that changes the project in the middle of the apply compares with the project as it was just after.
    const rebase = () => { before = projectState(world) }
    const result = await world.sourceApply(typeof options === 'function' ? options(rebase) : options, primitives).apply({ editId: edit.editId, mode, ...request })
    assert.deepEqual([result.status, result.code], expected, `${name}: ${JSON.stringify(result)}`)
    assert.ok(SOURCE_APPLY_REFUSALS.includes(result.code) || /^(apply-policy|maintenance-mode|no-apply-policy|policy-|outside-policy|retry-budget|object-not-visible)/.test(result.code), `${name}: ${result.code} is a declared code`)
    assertNothingWritten(world, before, name)
    assert.ok(world.pendingEdits().some((item) => item.editId === edit.editId && item.closedAt === null), `${name}: the pending edit stays`)
    assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), edit.objectRef)).length > 0, true, `${name}: the preserved bytes stay`)
    seen.add(result.code)
    undo?.()
    return result
  }
  const source = (name) => world.source(caseFile(name))
  const swap = (name, replace) => () => { const bytes = fs.readFileSync(source(name)); replace(); return () => { fs.rmSync(source(name), { force: true }); fs.writeFileSync(source(name), bytes) } }

  await refuses('disabled', ['refused', 'integration-disabled'], { setup: () => { world.setEnabled(false); return () => world.setEnabled(true) } })
  await refuses('unknown-edit', ['refused', 'unknown-edit'], { nodeId: caseNode('stale'), request: { editId: `edit-${'0'.repeat(32)}` } })
  await refuses('renamed', ['refused', 'source-moved'], { setup: () => { fs.renameSync(source('renamed'), `${source('renamed')}.moved.md`); return () => fs.renameSync(`${source('renamed')}.moved.md`, source('renamed')) } })
  // A source that is gone from the corpus is an object this machine cannot see: the answer a withheld object gets.
  await refuses('deleted', ['refused', 'object-not-visible'], { setup: swap('deleted', () => fs.rmSync(source('deleted'))) })
  // The check of the graph stands behind the decision: a decision that allowed everything would still not find it.
  await refuses('deleted', ['refused', 'source-not-in-graph'], { setup: swap('deleted', () => fs.rmSync(source('deleted'))), primitives: { decide: () => ({ allowed: true, actor: 'person-synthetic', policy: { mode: 'manual' }, retryBudget: null }) } })
  if (process.platform !== 'win32') {
    const elsewhere = path.join(world.dir, 'elsewhere.md')
    fs.writeFileSync(elsewhere, fs.readFileSync(source('symlinked')))
    // A census never follows a link, so a source that became one is no longer in the graph at all.
    const toLink = () => { fs.rmSync(source('symlinked')); fs.symlinkSync(elsewhere, source('symlinked')) }
    await refuses('symlinked', ['refused', 'object-not-visible'], { setup: swap('symlinked', toLink) })
    // The path check does not rely on that: a link that appears after the graph was read refuses too.
    const production = createProductionSeams()
    const afterGraph = (change) => (rebase) => ({ seams: { buildGraph: (input) => { const graph = production.buildGraph(input); change(); rebase(); return graph } } })
    await refuses('symlinked', ['refused', 'source-symlink'], { options: afterGraph(toLink), setup: swap('symlinked', () => {}) })
    const linked = path.dirname(source('symlinked-directory'))
    const away = path.join(world.dir, 'linked-away')
    await refuses('symlinked-directory', ['refused', 'source-symlink'], { options: afterGraph(() => { fs.renameSync(linked, away); fs.symlinkSync(away, linked) }), setup: () => () => { fs.rmSync(linked); fs.renameSync(away, linked) } })
  }
  await refuses('hard-linked', ['refused', 'source-hard-linked'], { setup: () => { const twin = path.join(world.dir, 'twin.md'); fs.linkSync(source('hard-linked'), twin); return () => fs.rmSync(twin) } })
  await refuses('ignored', ['refused', 'source-git-ignored'], { primitives: { isGitIgnored: () => true } })
  await refuses('ignore-unknown', ['refused', 'source-ignore-state-unknown'], { primitives: { isGitIgnored: () => null } })
  await refuses('managed-root', ['refused', 'source-inside-managed-root'], { options: { extraManagedRoots: [world.repo('east-wing')] } })
  await refuses('not-visible', ['refused', 'object-not-visible'], { setup: () => { world.configureMachine({ audienceAllow: ['team'] }); return () => world.configureMachine({ audienceAllow: ['team', 'private'] }) } })
  const lens = await refuses('lens', ['refused', 'edit-not-applicable'])
  assert.equal(lens.detail.cause, 'unsupported-structural-edit')
  const wrapper = await refuses('wrapper', ['refused', 'edit-not-applicable'], { nodeId: 'east-wing:table' })
  assert.equal(wrapper.detail.cause, 'unsupported-wrapper-edit')
  await refuses('no-change', ['refused', 'no-source-change'])
  await refuses('conflicted', ['conflict', 'object-conflicted'])
  await refuses('conflicted', ['conflict', 'object-conflicted'], { scopeId: 'scope-east' })
  assert.deepEqual(objects().stateOf({ repoId: 'east-wing', nodeId: caseNode('conflicted') }).operations.map((entry) => [entry.state, entry.reason, entry.origins.length]), [['conflicted', 'divergent-edits', 1], ['conflicted', 'divergent-edits', 1]], 'both edits are retained, neither wins')
  await refuses('exchange', ['refused', 'exchange-unavailable'], { options: { exchangeOptions: { platform: 'win32' } } })
  await refuses('stale', ['conflict', 'stale-source'], { setup: swap('stale', () => fs.appendFileSync(source('stale'), '\nSaved by somebody else first.\n')) })
  assert.deepEqual(objects().stateOf({ repoId: 'east-wing', nodeId: caseNode('stale') }).operations.map((entry) => entry.state), ['conflicted'], 'a stale source makes the operation a conflict, with its bytes kept')

  // Automatic: the installed policy, read from disk, decides.
  await refuses('no-policy', ['refused', 'maintenance-mode-manual'], { mode: 'automatic' })
  await refuses('no-policy', ['refused', 'no-apply-policy-installed'], { mode: 'automatic', setup: () => { world.configureMachine({ maintenanceMode: 'automatic' }) } })
  await refuses('manual-mode', ['refused', 'maintenance-mode-manual'], { mode: 'automatic', setup: () => { world.installPolicy(); world.configureMachine({ maintenanceMode: 'manual' }) } })
  await refuses('revoked', ['refused', 'apply-policy-revoked'], { mode: 'automatic', setup: () => { automatic({ status: 'revoked' }) } })
  await refuses('paused', ['refused', 'apply-policy-paused'], { mode: 'automatic', setup: () => { automatic({ status: 'paused' }) } })
  await refuses('revoked-by-command', ['refused', 'maintenance-mode-manual'], { mode: 'automatic', setup: () => { automatic(); revokeApplyPolicy({ workspaceRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID, repositoryRoots: [world.projectDir], updatedAt: world.clock().toISOString() }) } })
  await refuses('outside-selection', ['refused', 'outside-policy-selection'], { mode: 'automatic', setup: () => { automatic({ selector: { repo: 'west-wing' } }) } })
  await refuses('outside-selection', ['refused', 'outside-policy-selection'], { mode: 'automatic', setup: () => { automatic({ selector: { ids: [caseNode('budget')] } }) } })
  await refuses('not-visible', ['refused', 'object-not-visible'], { mode: 'automatic', setup: () => { automatic(); world.configureMachine({ audienceAllow: ['team'] }); return () => world.configureMachine({ audienceAllow: ['team', 'private'] }) } })
  await refuses('digest-mismatch', ['refused', 'policy-digest-mismatch'], { mode: 'automatic', setup: () => { automatic({ digest: bytesDigest('not the digest of this policy') }) } })
  const installed = automatic()
  await refuses('changed-since-dispatch', ['refused', 'policy-changed-since-dispatch'], { mode: 'automatic', request: { policyDigest: bytesDigest('the revision it was queued under') } })
  await refuses('conflicted', ['conflict', 'object-conflicted'], { mode: 'automatic' })
  await refuses('lens', ['refused', 'edit-not-applicable'], { mode: 'automatic' })
  await refuses('stale', ['conflict', 'object-conflicted'], { mode: 'automatic' })

  // The retry budget is counted in the events of the object, so it survives a restart, and once it is spent a further
  // attempt appends nothing.
  automatic({ retryBudget: 1 })
  const unavailable = { mode: 'automatic', options: { exchangeOptions: { platform: 'win32' } } }
  await refuses('budget', ['refused', 'exchange-unavailable'], unavailable)
  await refuses('budget', ['refused', 'exchange-unavailable'], unavailable)
  const sequence = objects().stateOf({ repoId: 'east-wing', nodeId: caseNode('budget') }).sequence
  await refuses('budget', ['refused', 'retry-budget-exhausted'], unavailable)
  await refuses('budget', ['refused', 'retry-budget-exhausted'], { mode: 'automatic' })
  assert.equal(objects().stateOf({ repoId: 'east-wing', nodeId: caseNode('budget') }).sequence, sequence, 'a spent budget appends nothing')
  assert.deepEqual(objects().stateOf({ repoId: 'east-wing', nodeId: caseNode('budget') }).operations.map((entry) => entry.state), ['pending'], 'the edit stays pending, never dropped')
  // A manual request that would only repeat the last refusal records it once.
  const manualSequence = () => objects().stateOf({ repoId: 'east-wing', nodeId: caseNode('exchange') }).sequence
  const once = manualSequence()
  await refuses('exchange', ['refused', 'exchange-unavailable'], { options: { exchangeOptions: { platform: 'win32' } } })
  assert.equal(manualSequence() - once, 2, 'a lease taken and released, and no second copy of the same refusal')

  // The batch bound of the installed policy.
  automatic({ maxBatchSize: 1 })
  const batchBefore = projectState(world)
  const batch = await world.sourceApply({ exchangeOptions: { platform: 'win32' } }).applyBatch({ mode: 'automatic', editIds: ['batch-a', 'batch-b'].map((name) => world.editOf(caseNode(name)).editId) })
  assert.deepEqual(batch.map((result) => result.code), ['exchange-unavailable', 'batch-bound-reached'])
  assertNothingWritten(world, batchBefore, 'batch')
  // A batch a person names is bounded as well: by the largest bound a policy can carry, or by what the caller sets.
  assert.equal(MAX_MANUAL_BATCH_SIZE, 1000)
  const manualBatch = await world.sourceApply({ exchangeOptions: { platform: 'win32' }, manualBatchBound: 1 }).applyBatch({ mode: 'manual', editIds: ['batch-a', 'batch-b'].map((name) => world.editOf(caseNode(name)).editId) })
  assert.deepEqual(manualBatch.map((result) => result.code), ['exchange-unavailable', 'batch-bound-reached'])
  assertNothingWritten(world, batchBefore, 'manual batch')

  // Absent and withheld are one answer through the whole apply, not only in the decision: a withheld object whose
  // source was renamed, one whose source was deleted, one that never existed and one that is simply withheld answer
  // with the same document, and none of them leaves an event behind.
  {
    const withhold = () => { world.configureMachine({ audienceAllow: ['team'] }); return () => world.configureMachine({ audienceAllow: ['team', 'private'] }) }
    const pendingStore = world.stateStore()
    const pending = pendingStore.readPendingEdits()
    const never = { ...world.editOf(caseNode('not-visible')), editId: `edit-${'e'.repeat(32)}`, identity: { ...world.editOf(caseNode('not-visible')).identity, nodeId: caseNode('never-existed') } }
    pendingStore.writePendingEdits({ ...pending, edits: [...pending.edits, never] })
    const both = (first, second) => () => { const undoFirst = first(); const undoSecond = second(); return () => { undoSecond(); undoFirst() } }
    const answers = []
    for (const [name, setup] of [
      ['not-visible', withhold],
      ['withheld-renamed', both(withhold, () => { fs.renameSync(source('withheld-renamed'), `${source('withheld-renamed')}.moved.md`); return () => fs.renameSync(`${source('withheld-renamed')}.moved.md`, source('withheld-renamed')) })],
      ['withheld-deleted', both(withhold, swap('withheld-deleted', () => fs.rmSync(source('withheld-deleted'))))],
      ['never-existed', withhold],
    ]) {
      for (const mode of ['manual', 'automatic']) {
        const result = await refuses(name, ['refused', 'object-not-visible'], { mode, setup: mode === 'automatic' ? both(() => { automatic(); return () => world.configureMachine({ maintenanceMode: 'manual' }) }, setup) : setup })
        answers.push(JSON.stringify({ ...result, editId: 'EDIT', nodeId: 'NODE' }))
        assert.equal(objects().stateOf({ repoId: 'east-wing', nodeId: caseNode(name) }).sequence, 0, `${name}, ${mode}: nothing is recorded for an object this machine may not see`)
      }
    }
    assert.deepEqual([...new Set(answers)], [answers[0]], 'one answer, whatever became of the withheld source')
    // The same sources, visible: the answers that a withheld object must never give.
    await refuses('withheld-renamed', ['refused', 'source-moved'], { setup: () => { fs.renameSync(source('withheld-renamed'), `${source('withheld-renamed')}.moved.md`); return () => fs.renameSync(`${source('withheld-renamed')}.moved.md`, source('withheld-renamed')) } })
  }
  assert.equal(installed.digest, applyPolicyDigest(installed))
  for (const code of ['integration-disabled', 'source-moved', 'source-not-in-graph', 'source-hard-linked', 'source-git-ignored', 'source-inside-managed-root', 'object-not-visible', 'edit-not-applicable', 'object-conflicted', 'exchange-unavailable', 'stale-source', 'apply-policy-revoked', 'apply-policy-paused', 'outside-policy-selection', 'policy-digest-mismatch', 'retry-budget-exhausted']) assert.ok(seen.has(code), code)
})

// ---------------------------------------------------------------------------
// Concurrent source writers: a real second process
// ---------------------------------------------------------------------------

const WRITER_CHILD = path.join(root, 'test/support/obsidian-edits/writer-child.mjs')
const WRITER_STYLES = Object.freeze(['rename', 'inplace', 'append'])
const WRITER_TIMINGS = Object.freeze(['before', 'between', 'after', 'free'])
const RACE_ROUNDS = Math.max(20, Number(process.env.ATELIER_APPLY_RACE_ROUNDS ?? 24))
const RACE_EXTRA_FREE_ROUNDS = 36

// One writer process: tracked by handle, spoken to by line, and awaited when told to exit.
function startWriter(t, survivors, file, style, label) {
  const child = childProcess.spawn(process.execPath, [WRITER_CHILD, file, style], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const entry = { label, child, exited: false, stderr: '' }
  survivors.push(entry)
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => { entry.exited = true; resolve({ code, signal }) }))
  child.stderr.on('data', (chunk) => { entry.stderr += chunk })
  const waiting = []
  const lines = []
  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += chunk
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      const next = waiting.shift()
      if (next) next(line); else lines.push(line)
    }
  })
  const nextLine = () => (lines.length > 0 ? Promise.resolve(lines.shift()) : Promise.race([new Promise((resolve) => waiting.push(resolve)), exit.then(() => { throw new Error(`${label}: the writer exited early: ${entry.stderr.slice(0, 200)}`) })]))
  const writes = []
  const take = (line) => { const [, tag, payloadHex, holds] = line.split(' '); writes.push({ tag, payload: Buffer.from(payloadHex, 'hex'), holds }) }
  return {
    writes,
    ready: async () => assert.equal(await nextLine(), 'ready'),
    async write(tag) { child.stdin.write(`write ${tag}\n`); take(await nextLine()) },
    async free(count, maxDelayMs, tag) {
      child.stdin.write(`free ${count} ${maxDelayMs} ${tag}\n`)
      for (let line = await nextLine(); line !== 'freedone'; line = await nextLine()) take(line)
    },
    async stop() { child.stdin.write('exit\n'); const { code } = await exit; assert.equal(code, 0, `${label}: ${entry.stderr.slice(0, 200)}`) },
  }
}

function filesUnder(directory) {
  const found = []
  const walk = (current) => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const absolute = path.join(current, entry.name); if (entry.isDirectory()) walk(absolute); else if (entry.isFile()) found.push(absolute) } }
  walk(directory)
  return found
}

// The oracle of one round. Every byte a writer wrote is in the source file or retained under recovery; the source is
// one whole version (the base, the candidate, or what a writer's file held after one of its writes), never a mixture;
// a round that did not apply never leaves the candidate at the source path; an applied round retained the base.
function assertRoundKeptEveryByte({ world, label, style, sourceFile, base, candidate, writes, result }) {
  const source = fs.readFileSync(sourceFile)
  const retained = filesUnder(world.recovery()).map((file) => fs.readFileSync(file))
  // A program that saves the whole file replaces its own earlier save; only an appending one adds to it.
  for (const write of style === 'append' ? writes : writes.slice(-1)) {
    assert.ok(source.includes(write.payload) || retained.some((bytes) => bytes.includes(write.payload)), `${label}: the bytes of write ${write.tag} are neither in the source nor retained in recovery (${result.status}/${result.code})`)
  }
  const whole = new Set([sha256Digest(base), sha256Digest(candidate), ...writes.map((write) => write.holds)])
  assert.ok(whole.has(sha256Digest(source)), `${label}: the source is a mixture of versions (${result.status}/${result.code})`)
  if (result.status !== 'applied') assert.notEqual(sha256Digest(source), sha256Digest(candidate), `${label}: refused, and yet the source holds the candidate`)
  else assert.ok(retained.some((bytes) => bytes.equals(base)), `${label}: applied without retaining the old source`)
}

function raceWorld(t, count) {
  const files = { 'race-room/about.md': noteText({ id: 'race-room:about', title: 'About the races', body: 'Nothing here is edited.' }) }
  for (let index = 0; index < count; index += 1) files[`race-room/rounds/round-${index}.md`] = noteText({ id: `race-room:round-${index}`, title: `Round ${index}`, body: `Original sentence ${index}.\n\nA paragraph nobody edits.` })
  const world = makeApplyWorld(t, { repositories: ['race-room'], files, scopes: [WHOLE] })
  world.publishDirectly()
  for (let index = 0; index < count; index += 1) world.editNote(`race-room:round-${index}`, `Original sentence ${index}.`, `Edited sentence ${index}.`)
  world.queueDirectly()
  return world
}

async function raceRound({ t, world, survivors, index, mode, style, timing, primitives, tally, timings }) {
  const label = `${mode}/${style}/${timing}/round-${index}`
  const sourceFile = world.source(`race-room/rounds/round-${index}.md`)
  const base = fs.readFileSync(sourceFile)
  const candidate = replaceNth(base, `Original sentence ${index}.`, `Edited sentence ${index}.`)
  const writer = startWriter(t, survivors, sourceFile, style, label)
  await writer.ready()
  if (timing === 'before') await writer.write('before')
  // A free-running writer saves at a moment of its own choosing, anywhere from before the apply begins to after it ends.
  const racing = timing === 'free' ? writer.free(1, Math.ceil(timings.average() * 2) + 20, 'free') : null
  const startedAt = performance.now()
  const sourceApply = world.sourceApply({ beforeExchange: async () => { if (timing === 'between') await writer.write('between') } }, primitives)
  const result = await sourceApply.apply({ editId: world.editOf(`race-room:round-${index}`).editId, mode })
  if (timing !== 'free' && timing !== 'between') timings.add(performance.now() - startedAt)
  if (timing === 'after') await writer.write('after')
  await racing
  await writer.stop()
  const late = await sourceApply.recheck()
  assertRoundKeptEveryByte({ world, label, style, sourceFile, base, candidate, writes: writer.writes, result })
  const kind = result.status === 'applied' ? 'applied' : result.code
  const key = `${style}/${timing}`
  tally[key] ??= {}
  tally[key][kind] = (tally[key][kind] ?? 0) + 1
  if (late.some((finding) => finding.editId === result.editId)) tally[key]['source-changed-after-apply'] = (tally[key]['source-changed-after-apply'] ?? 0) + 1
  return { result, late }
}

async function runRaces(t, mode, { primitives, rounds = RACE_ROUNDS, extra = RACE_EXTRA_FREE_ROUNDS } = {}) {
  const survivors = []
  t.after(async () => { for (const entry of survivors.filter((item) => !item.exited)) { entry.child.kill('SIGKILL'); await new Promise((resolve) => entry.child.once('exit', resolve)) } })
  const world = raceWorld(t, rounds + extra)
  if (mode === 'automatic') { world.configureMachine({ maintenanceMode: 'automatic' }); world.installPolicy({ selector: { repo: 'race-room' } }) }
  const tally = {}
  const measured = []
  const timings = { add: (ms) => measured.push(ms), average: () => (measured.length === 0 ? 150 : measured.reduce((sum, ms) => sum + ms, 0) / measured.length) }
  const combos = WRITER_STYLES.flatMap((style) => WRITER_TIMINGS.map((timing) => ({ style, timing })))
  let index = 0
  for (; index < rounds; index += 1) await raceRound({ t, world, survivors, index, mode, ...combos[index % combos.length], primitives, tally, timings })
  // The free-running race proves something only when both sides of it happened.
  const sides = () => { const free = Object.entries(tally).filter(([key]) => key.endsWith('/free')).flatMap(([, counts]) => Object.entries(counts)); return { applied: free.some(([kind]) => kind === 'applied'), refused: free.some(([kind]) => ['stale-source', 'concurrent-source-writer'].includes(kind)) } }
  for (; index < rounds + extra && !(sides().applied && sides().refused); index += 1) await raceRound({ t, world, survivors, index, mode, style: WRITER_STYLES[index % WRITER_STYLES.length], timing: 'free', primitives, tally, timings })
  assert.deepEqual(survivors.filter((entry) => !entry.exited).map((entry) => entry.label), [], 'a writer child is still running')
  return { tally, rounds: index, sides: sides() }
}

function assertBothSides(mode, { tally, rounds, sides }) {
  console.log(`source apply races, ${mode}: ${rounds} rounds ${JSON.stringify(tally)}`)
  const total = (kind) => Object.values(tally).reduce((sum, counts) => sum + (counts[kind] ?? 0), 0)
  assert.ok(total('applied') > 0, 'no round applied')
  assert.ok(total('concurrent-source-writer') > 0, 'no round met a writer between the read and the exchange')
  assert.ok(total('stale-source') > 0, 'no round met a writer before the read')
  assert.ok(total('source-changed-after-apply') > 0, 'no round met a writer that still held the old file')
  for (const style of WRITER_STYLES) {
    assert.ok((tally[`${style}/between`]?.['concurrent-source-writer'] ?? 0) > 0, `${style}: a write between the read and the exchange is refused and kept`)
    assert.ok((tally[`${style}/before`]?.['stale-source'] ?? 0) > 0, `${style}: a write before the read is a stale source`)
    assert.ok((tally[`${style}/after`]?.applied ?? 0) > 0, `${style}: a write after the exchange does not undo the apply`)
  }
  assert.deepEqual(sides, { applied: true, refused: true }, 'the free-running race was one-sided')
}

test('manual apply against concurrent source writers, a real second process in three styles and four timings: no byte of any writer is lost, the source is never a mixture, and both outcomes occur', needsExchange, async (t) => {
  assertBothSides('manual', await runRaces(t, 'manual'))
})

test('automatic apply against concurrent source writers, a real second process in three styles and four timings: no byte of any writer is lost, the source is never a mixture, and both outcomes occur', needsExchange, async (t) => {
  assertBothSides('automatic', await runRaces(t, 'automatic'))
})

async function oneRaceRound(t, { style, timing, primitives }) {
  const survivors = []
  t.after(async () => { for (const entry of survivors.filter((item) => !item.exited)) { entry.child.kill('SIGKILL'); await new Promise((resolve) => entry.child.once('exit', resolve)) } })
  const world = raceWorld(t, 1)
  try { return await raceRound({ t, world, survivors, index: 0, mode: 'manual', style, timing, primitives, tally: {}, timings: { add() {}, average: () => 100 } }) } finally {
    assert.deepEqual(survivors.filter((entry) => !entry.exited).map((entry) => entry.label), [], 'a writer child is still running')
  }
}

test('mutation control: an apply that checks and then renames loses the concurrent writer and fails the byte oracle', needsExchange, async (t) => {
  assert.equal((await oneRaceRound(t, { style: 'rename', timing: 'between' })).result.code, 'concurrent-source-writer', 'the same round passes in production')
  await assert.rejects(oneRaceRound(t, { style: 'rename', timing: 'between', primitives: { commit: ({ candidatePath, sourcePath }) => fs.renameSync(candidatePath, sourcePath) } }), assert.AssertionError)
})

test('mutation control: an apply that does not exchange back leaves its candidate over the writer and fails the oracle', needsExchange, async (t) => {
  await assert.rejects(oneRaceRound(t, { style: 'inplace', timing: 'between', primitives: { exchangeBack: () => {} } }), /refused, and yet the source holds the candidate/)
})

test('mutation control: an apply that deletes the displaced file loses a late writer and fails the byte oracle', needsExchange, async (t) => {
  const production = await oneRaceRound(t, { style: 'inplace', timing: 'after' })
  assert.deepEqual([production.result.status, production.late.map((finding) => finding.code)], ['applied', ['source-changed-after-apply']], 'in production the late write is captured, with both byte sets retained')
  const copyThenDelete = ({ from, to }) => { fs.writeFileSync(to, fs.readFileSync(from)); fs.rmSync(from) }
  await assert.rejects(oneRaceRound(t, { style: 'inplace', timing: 'after', primitives: { keepDisplaced: copyThenDelete } }), /neither in the source nor retained/)
})

test('policy is read again immediately before the write: a policy revoked between the decision and the exchange refuses and writes nothing, and the mutation control that skips the reread writes', needsExchange, async (t) => {
  async function revokedLate(primitives) {
    const world = raceWorld(t, 1)
    world.configureMachine({ maintenanceMode: 'automatic' })
    world.installPolicy()
    const before = projectState(world)
    const revoke = async () => { revokeApplyPolicy({ workspaceRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID, repositoryRoots: [world.projectDir], updatedAt: world.clock().toISOString() }) }
    const result = await world.sourceApply({ beforeExchange: revoke }, primitives).apply({ editId: world.editOf('race-room:round-0').editId, mode: 'automatic' })
    return { world, before, result }
  }
  const { world, before, result } = await revokedLate()
  assert.deepEqual([result.status, result.code], ['refused', 'maintenance-mode-manual'], 'revocation also returns the machine to manual mode, which is what the reread meets first')
  assertNothingWritten({ ...world, repo: (name) => path.join(world.projectDir, name) }, before, 'revoked late')
  assert.deepEqual(filesUnder(world.recovery()).filter((file) => file.endsWith('.candidate')), [], 'the candidate was retired')
  const state = openObjectStore({ stateRoot: world.workspaceRoot(), workspaceId: APPLY_WORKSPACE_ID, repositoryRoots: [world.projectDir], clock: world.clock }).stateOf({ repoId: 'race-room', nodeId: 'race-room:round-0' })
  assert.deepEqual([state.intent, state.operations.map((entry) => entry.state)], [null, ['pending']], 'the intent is settled as refused and the edit stays pending')
  const careless = await revokedLate({ decideAgain: false })
  assert.equal(careless.result.status, 'applied')
  assert.throws(() => assertNothingWritten({ ...careless.world, repo: (name) => path.join(careless.world.projectDir, name) }, careless.before, 'revoked late'), assert.AssertionError)
})

test('mutation control: an apply that trusts the live note instead of the preserved bytes fails the expected-source oracle', needsExchange, async (t) => {
  async function applied(primitives) {
    const world = raceWorld(t, 1)
    const expected = replaceNth(fs.readFileSync(world.source('race-room/rounds/round-0.md')), 'Original sentence 0.', 'Edited sentence 0.')
    const edit = world.editOf('race-room:round-0')
    fs.writeFileSync(world.noteFile('race-room:round-0'), replaceNth(fs.readFileSync(world.noteFile('race-room:round-0')), 'Edited sentence 0.', 'Typed after the edit was preserved.'))
    const result = await world.sourceApply({}, primitives).apply({ editId: edit.editId, mode: 'manual' })
    assert.equal(result.status, 'applied')
    assert.deepEqual(fs.readFileSync(world.source('race-room/rounds/round-0.md')), expected)
  }
  await applied()
  await assert.rejects(applied({ editedBytes: ({ workspace, edit }) => fs.readFileSync(path.join(workspace.storeOf(edit.scopeId).vaultRoot, edit.path)) }), assert.AssertionError)
})

// ---------------------------------------------------------------------------
// Crash at every durable step of source apply
// ---------------------------------------------------------------------------

const CRASH_TABLE = Object.freeze([
  { step: 'apply-record-written', unknown: false, recovered: ['refused', 'interrupted-before-exchange'], source: 'base', operation: 'pending', retry: 'applied' },
  { step: 'candidate-written', unknown: false, recovered: ['refused', 'interrupted-before-exchange'], source: 'base', operation: 'pending', retry: 'applied' },
  { step: 'intent-recorded', unknown: true, recovered: ['refused', 'interrupted-before-exchange'], source: 'base', operation: 'pending', retry: 'applied' },
  { step: 'exchanged', unknown: true, recovered: ['applied', 'applied-after-restart'], source: 'candidate', operation: 'applied', retry: 'already-applied' },
  { step: 'exchanged', retryInsteadOfRecover: true, unknown: true, recovered: null, source: 'candidate', operation: 'applied', retry: 'already-applied' },
  { step: 'backup-recorded', unknown: true, recovered: ['applied', 'applied-after-restart'], source: 'candidate', operation: 'applied', retry: 'already-applied' },
  { step: 'applied-recorded', unknown: false, recovered: ['applied', 'applied'], source: 'candidate', operation: 'applied', retry: 'already-applied' },
  { step: 'settled', unknown: false, recovered: null, source: 'candidate', operation: 'applied', retry: 'already-applied' },
  { step: 'exchanged', writer: true, unknown: true, recovered: ['conflict', 'apply-interrupted-needs-person'], source: 'candidate', operation: 'superseded', retry: 'already-applied-or-conflict' },
  { step: 'exchanged-back', writer: true, unknown: true, recovered: ['refused', 'interrupted-before-exchange'], source: 'writer', operation: 'conflicted', retry: 'stale-source' },
])

test('apply crash recovery: a crash at every durable step, with and without a concurrent writer, is settled from digests on disk; no byte is lost and an unknown outcome is never guessed', needsExchange, async (t) => {
  assert.deepEqual([...new Set(CRASH_TABLE.map((row) => row.step))].sort(), [...SOURCE_APPLY_STEPS].sort(), 'every durable step is crashed at')
  const world = raceWorld(t, CRASH_TABLE.length)
  const report = []
  for (const [index, row] of CRASH_TABLE.entries()) {
    const label = `${row.step}${row.writer ? '+writer' : ''}${row.retryInsteadOfRecover ? '+retry' : ''}`
    const nodeId = `race-room:round-${index}`
    const sourceFile = world.source(`race-room/rounds/round-${index}.md`)
    const base = fs.readFileSync(sourceFile)
    const candidate = replaceNth(base, `Original sentence ${index}.`, `Edited sentence ${index}.`)
    const written = Buffer.concat([base, utf8(`\nsaved by another program during round ${index}\n`)])
    const edit = world.editOf(nodeId)
    const crashing = world.sourceApply({
      leasePid: GONE_HOLDER_PID,
      crash: (step) => { if (step === row.step) throw new Error(`crash at ${step}`) },
      beforeExchange: async () => { if (row.writer) { fs.writeFileSync(`${sourceFile}.tmp`, written); fs.renameSync(`${sourceFile}.tmp`, sourceFile) } },
    })
    await assert.rejects(crashing.apply({ editId: edit.editId, mode: 'manual' }), /crash at/, label)

    const fresh = world.sourceApply()
    assert.equal((await fresh.show(edit.editId)).object.outcomeUnknown, row.unknown, `${label}: an intent without an outcome is reported as unknown, not guessed`)
    if (row.retryInsteadOfRecover) {
      const retried = await fresh.apply({ editId: edit.editId, mode: 'manual' })
      assert.deepEqual([retried.status, retried.code, retried.replayed], ['applied', 'already-applied', true], `${label}: a retry after a lost reply settles from the files and does not apply twice`)
    } else {
      const mine = (await fresh.recover()).recovered.filter((item) => item.editId === edit.editId)
      assert.deepEqual(mine.map((item) => [item.status, item.code]), row.recovered === null ? [] : [row.recovered], label)
    }
    assert.deepEqual((await fresh.recover()).recovered.filter((item) => item.editId === edit.editId), [], `${label}: recovery run again finds nothing to do`)

    const source = fs.readFileSync(sourceFile)
    assert.deepEqual(source, { base, candidate, writer: written }[row.source], `${label}: the source is ${row.source}`)
    const retained = filesUnder(world.recovery()).map((file) => fs.readFileSync(file))
    for (const [name, bytes] of [['base', base], ...(row.writer ? [['writer', written]] : [])]) assert.ok(source.equals(bytes) || retained.some((kept) => kept.equals(bytes)), `${label}: the ${name} bytes are in the source or retained`)
    assert.deepEqual(filesUnder(world.recovery()).filter((file) => /\.candidate$|retiring\.bin$/.test(file)).filter((file) => fs.readFileSync(file).equals(candidate)), [], `${label}: no candidate of ours is left behind`)
    const shown = await fresh.show(edit.editId)
    assert.deepEqual([shown.object.outcomeUnknown, shown.operation?.state ?? 'pending'], [false, row.operation], label)
    const retry = await fresh.apply({ editId: edit.editId, mode: 'manual' })
    if (row.retry === 'already-applied-or-conflict') assert.ok(['already-applied', 'already-applied-by-equal-edit', 'edit-not-applicable', 'object-conflicted', 'stale-source'].includes(retry.code), `${label}: ${retry.code}`)
    else assert.equal(retry.status === 'applied' && !retry.replayed ? 'applied' : retry.code, row.retry, label)
    if (row.retry === 'applied') assert.deepEqual(fs.readFileSync(sourceFile), candidate)
    report.push(`${label} -> ${row.recovered === null ? (row.retryInsteadOfRecover ? 'retry' : 'nothing to recover') : row.recovered.join('/')}; source ${row.source}; then ${retry.code}`)
  }
  console.log(`source apply crash table:\n  ${report.join('\n  ')}`)
})

// ---------------------------------------------------------------------------
// Where no atomic exchange exists; the command; disclosure
// ---------------------------------------------------------------------------

test('apply without an atomic exchange (Windows today) refuses exchange-unavailable, in both modes, and writes nothing', async (t) => {
  const world = raceWorld(t, 2)
  world.configureMachine({ maintenanceMode: 'automatic' })
  world.installPolicy()
  // Where the exchange exists it is taken away; where it does not, production refuses by itself.
  const options = EXCHANGE_HERE ? { exchangeOptions: { platform: 'win32' } } : {}
  const before = treeListing(world.projectDir)
  for (const [index, mode] of ['manual', 'automatic'].entries()) {
    const result = await world.sourceApply(options).apply({ editId: world.editOf(`race-room:round-${index}`).editId, mode })
    assert.deepEqual([result.status, result.code, result.detail.cause], ['refused', 'exchange-unavailable', 'exchange-unsupported-platform'], mode)
  }
  assert.deepEqual(treeListing(world.projectDir), before, 'nothing in the project changed')
  assert.deepEqual(filesUnder(world.recovery()).filter((file) => file.endsWith('.candidate')), [], 'no candidate was even written')
  assert.deepEqual(world.pendingEdits().filter((edit) => edit.closedAt === null).length, 2, 'both edits stay pending')
})

async function runApplyCommand(world, argv, { wrap = (operation) => operation, ...options } = {}) {
  const { runObsidianCommand } = await import('../src/commands/obsidian.mjs')
  const out = []
  const exit = await runObsidianCommand({ argv, seams: {}, loadProject: world.loadProject, dataRoot: world.dataRoot, env: world.env, clock: world.clock, stdout: (text) => out.push(text), stderr: (text) => out.push(text),
    contributions: [createSourceApplyContribution({ create: (context) => wrap(world.sourceApply({ ...context, ...options })) })] })
  const text = out.join('\n')
  return { exit, text, json: argv.includes('--json') ? JSON.parse(text) : null }
}

test('apply command: list, show, run and recover answer one JSON document with the exit codes of the obsidian command, and the contribution registers the engine operation and replaces the placeholder', needsExchange, async (t) => {
  const registry = createObsidianRegistry({ contributions: [createSourceApplyContribution()] })
  assert.deepEqual([registry.extensions.applyOperation().id, registry.operations.describe().map((item) => item.name), registry.contributions], ['atelier.source-apply/v1', ['apply'], ['atelier.source-apply']])
  assert.equal(typeof createApplyCommandOperation().run, 'function')
  const shipped = await import('../src/runtime/obsidian/contributions/source-apply.mjs')
  assert.equal(shipped.default.id, 'atelier.source-apply')

  const world = raceWorld(t, 2)
  const [first, second] = [0, 1].map((index) => world.editOf(`race-room:round-${index}`).editId)
  const listed = await runApplyCommand(world, ['apply', 'list', '--json'])
  assert.deepEqual([listed.exit, listed.json.ok, listed.json.operation, listed.json.edits.map((edit) => [edit.editId, edit.nodeId, edit.state])], [0, true, 'apply', [[first, 'race-room:round-0', 'queued'], [second, 'race-room:round-1', 'queued']].sort(([left], [right]) => (left < right ? -1 : 1))])
  const refused = await runApplyCommand(world, ['apply', 'run', first, '--json'], { exchangeOptions: { platform: 'win32' } })
  assert.deepEqual([refused.exit, refused.json.ok, refused.json.result.status, refused.json.result.code], [3, false, 'refused', 'exchange-unavailable'])
  const ran = await runApplyCommand(world, ['apply', 'run', first, '--actor', 'person-synthetic', '--json'])
  assert.deepEqual([ran.exit, ran.json.ok, ran.json.result.status, ran.json.result.actor], [0, true, 'applied', 'person-synthetic'])
  assert.match(fs.readFileSync(world.source('race-room/rounds/round-0.md'), 'utf8'), /Edited sentence 0\./)
  const shown = await runApplyCommand(world, ['apply', 'show', first, '--json'])
  assert.deepEqual([shown.exit, shown.json.edit.operation.state, shown.json.edit.outcomes.at(-1).status], [0, 'applied', 'applied'])
  const human = await runApplyCommand(world, ['apply', 'run', second, '--actor=person-two'])
  assert.deepEqual([human.exit, human.text.split('\n')[0]], [0, 'applied: applied'])
  assert.deepEqual((await runApplyCommand(world, ['apply', 'recover', '--json'])).json.recovered, [])
  for (const [argv, code] of [[['apply', 'run', '--json'], 'usage'], [['apply', 'run', 'not-an-edit', '--json'], 'usage'], [['apply', 'run', first, '--actor', 'not an actor', '--json'], 'usage'], [['apply', 'run', first, 'person-positional', '--json'], 'usage'], [['apply', 'list', '--actor', 'person-x', '--json'], 'usage'], [['apply', 'sideways', '--json'], 'usage'], [['apply', 'show', `edit-${'0'.repeat(32)}`, '--json'], 'unknown-edit']]) {
    const answer = await runApplyCommand(world, argv)
    assert.deepEqual([answer.exit, answer.json.error.code], [2, code], argv.join(' '))
  }
})

test('apply never writes inside a git directory: a nested repository, any spelling of .git on the way, and a git directory that lives under another name are refused; a git that cannot say where its directory is refuses too', async (t) => {
  const { locateSource } = await import('../src/projection/obsidian/edits/apply.mjs')
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'atelier-gitdir-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  const write = (relative, text = 'synthetic\n') => { fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true }); fs.writeFileSync(path.join(dir, relative), text) }
  // `plain` holds a nested repository; the git directory of `apart` is `apart/storage`, named by a `gitdir:` file.
  write('plain/notes/kept.md')
  git(path.join(dir, 'plain'), ['init', '-q'])
  write('plain/vendor/lib/readme.md')
  git(path.join(dir, 'plain/vendor/lib'), ['init', '-q'])
  write('plain/vendor/lib/.git/info/inside.md')
  write('plain/.git/info/top.md')
  fs.mkdirSync(path.join(dir, 'apart'))
  git(dir, ['init', '-q', `--separate-git-dir=${path.join(dir, 'apart', 'storage')}`, path.join(dir, 'apart')])
  assert.match(fs.readFileSync(path.join(dir, 'apart/.git'), 'utf8'), /^gitdir: /)
  write('apart/storage/info/inside.md')
  write('apart/notes/kept.md')
  const project = { repos: [{ name: 'plain', path: path.join(dir, 'plain') }, { name: 'apart', path: path.join(dir, 'apart') }] }
  const locate = (repoId, relative, rules = SOURCE_APPLY_PRIMITIVES) => {
    try { return { located: locateSource({ project, repoId, relative, managedRoots: [], isGitIgnored: rules.isGitIgnored, gitDirectory: rules.gitDirectory, env: process.env }).absolute } } catch (error) { return { code: error.code, cause: error.detail?.cause } }
  }
  assert.deepEqual(locate('plain', '.git/info/top.md'), { code: 'source-inside-git-directory', cause: undefined })
  assert.deepEqual(locate('plain', 'vendor/lib/.git/info/inside.md').code, 'source-inside-git-directory', 'a nested repository')
  assert.deepEqual(locate('plain', 'vendor/lib/.GIT/info/inside.md').code, 'source-inside-git-directory', 'whatever the case of the name')
  assert.deepEqual(locate('apart', 'storage/info/inside.md').code, 'source-inside-git-directory', 'a git directory that is not called .git')
  assert.deepEqual(locate('plain', 'notes/kept.md'), { located: path.join(dir, 'plain/notes/kept.md') })
  assert.deepEqual(locate('apart', 'notes/kept.md'), { located: path.join(dir, 'apart/notes/kept.md') })
  assert.deepEqual(locate('plain', 'notes/kept.md', { ...SOURCE_APPLY_PRIMITIVES, gitDirectory: () => null }), { code: 'source-ignore-state-unknown', cause: 'git-directory-unknown' })
  // Mutation control: the first segment alone does not see any of the three.
  const firstSegmentOnly = { ...SOURCE_APPLY_PRIMITIVES, gitDirectory: ({ repositoryRoot }) => path.join(repositoryRoot, '.git'), isGitIgnored: () => false }
  assert.deepEqual(locate('apart', 'storage/info/inside.md', firstSegmentOnly), { located: path.join(dir, 'apart/storage/info/inside.md') }, 'without the question to git, the git directory under another name is written into')
})

test('an exchange that reports a failure is not believed: the outcome is read from the digests on disk, so a swap that happened is recorded as applied with its backup, and one that did not happen is a refusal that leaves the source alone', needsExchange, async (t) => {
  const world = raceWorld(t, 2)
  const failure = () => Object.assign(new Error('synthetic exchange failure'), { name: 'ExchangeRefusal', code: 'exchange-failed' })
  const rows = [
    { name: 'swapped, then reported failed', commit: ({ candidatePath, sourcePath, exchange }) => { exchange(candidatePath, sourcePath); throw failure() }, expected: ['applied', 'applied-after-restart'], source: 'candidate' },
    { name: 'never swapped', commit: () => { throw failure() }, expected: ['refused', 'exchange-unavailable'], source: 'base' },
  ]
  for (const [index, row] of rows.entries()) {
    const sourceFile = world.source(`race-room/rounds/round-${index}.md`)
    const base = fs.readFileSync(sourceFile)
    const candidate = replaceNth(base, `Original sentence ${index}.`, `Edited sentence ${index}.`)
    const edit = world.editOf(`race-room:round-${index}`)
    const result = await world.sourceApply({}, { ...SOURCE_APPLY_PRIMITIVES, commit: row.commit }).apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
    assert.deepEqual([result.status, result.code], row.expected, `${row.name}: ${JSON.stringify(result)}`)
    assert.deepEqual(fs.readFileSync(sourceFile), { base, candidate }[row.source], `${row.name}: the source is the ${row.source}`)
    const shown = await world.sourceApply().show(edit.editId)
    assert.deepEqual([shown.object.outcomeUnknown, shown.operation.state], [false, row.source === 'candidate' ? 'applied' : 'pending'], row.name)
    assert.deepEqual(filesUnder(world.recovery()).filter((file) => /\.candidate$/.test(file)), [], `${row.name}: nothing is left at a candidate path`)
    if (row.source === 'candidate') {
      assert.deepEqual([result.actor, result.oldSourceDigest, result.newSourceDigest], ['person-synthetic', bytesDigest(base), bytesDigest(candidate)])
      assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), result.backupRef)), base, 'the old source is the retained backup')
      const again = await world.sourceApply().apply({ editId: edit.editId, mode: 'manual' })
      assert.deepEqual([again.status, again.code, again.replayed], ['applied', 'already-applied', true], 'a repeated request is answered from the record')
    }
  }
})

test('apply: nothing between the first exchange and the exchange back can return with the outcome left unknown: a typed failure of the exchange back, or the displaced file vanishing before it is retained, is settled from the digests on disk', needsExchange, async (t) => {
  const theirs = Buffer.from('another program wrote this between the read and the exchange\n')
  async function round(name, arrange) {
    const world = raceWorld(t, 1)
    const sourceFile = world.source('race-room/rounds/round-0.md')
    const base = fs.readFileSync(sourceFile)
    const candidate = replaceNth(base, 'Original sentence 0.', 'Edited sentence 0.')
    const edit = world.editOf('race-room:round-0')
    const { primitives = {}, after = () => {} } = arrange(t)
    const result = await world.sourceApply({ beforeExchange: async () => { fs.writeFileSync(sourceFile, theirs) } }, { ...SOURCE_APPLY_PRIMITIVES, ...primitives }).apply({ editId: edit.editId, mode: 'manual', actor: 'person-synthetic' })
    after()
    const shown = await world.sourceApply().show(edit.editId)
    const kept = filesUnder(world.recovery()).filter((file) => fs.readFileSync(file).equals(theirs))
    return { name, result, shown, kept, atSource: fs.readFileSync(sourceFile), base, candidate }
  }
  const typedFailure = () => ({ primitives: { exchangeBack: () => { throw new PublicationRefusal('exchange-failed', 'synthetic typed failure of the second exchange') } } })
  const typed = await round('typed failure of the exchange back', typedFailure)
  assert.deepEqual([typed.result.status, typed.result.code], ['conflict', 'apply-interrupted-needs-person'], JSON.stringify(typed.result))
  assert.equal(typed.shown.object.outcomeUnknown, false, 'the intent is settled, not left for a later call to find')
  // The documented consequence: the exchange back did not happen, so the source path keeps the candidate, whole, and
  // the other program's bytes are retained with the recovery references the person is given.
  assert.deepEqual(typed.atSource, typed.candidate, 'the source is one whole version: the candidate')
  assert.ok(typed.kept.length >= 1, 'the bytes the other program wrote are retained')
  assert.ok((typed.result.detail?.recoveryRefs ?? typed.result.recoveryRefs ?? []).length >= 1, 'and the person is told where')

  // The candidate path is opened without following a link four times: to write it, to verify what was written, after
  // the exchange for the digest of what was displaced, and once more to retain those bytes. The fourth finds it gone.
  const vanished = await round('the displaced file gone before it is retained', (context) => {
    let opens = 0
    const gone = failOnce(context, 'openSync', (file, flags) => typeof file === 'string' && file.endsWith('.candidate') && typeof flags === 'number' && (flags & fs.constants.O_NOFOLLOW) !== 0 && (opens += 1) === 4, 'ENOENT')
    return { after: () => { assert.equal(gone.failed(), 1, 'the injected failure fired'); gone.restore() } }
  })
  assert.equal(vanished.result.status === 'refused' || vanished.result.status === 'conflict', true, JSON.stringify(vanished.result))
  assert.ok(SOURCE_APPLY_REFUSALS.includes(vanished.result.code), `${vanished.result.code} is a declared code`)
  assert.equal(vanished.shown.object.outcomeUnknown, false, 'settled from disk, not thrown with the intent open')
  assert.ok(vanished.atSource.equals(vanished.candidate) || vanished.atSource.equals(theirs) || vanished.atSource.equals(vanished.base), 'the source is one whole version')
  assert.ok(vanished.kept.length >= 1 || vanished.atSource.equals(theirs), 'the other program\'s bytes are in the source or retained')
})

test('apply recovery: a candidate path that may not be looked at is reported for its own record and delays no other interrupted apply', needsExchange, async (t) => {
  const world = raceWorld(t, 2)
  const crashAt = (index) => world.sourceApply({ leasePid: GONE_HOLDER_PID, crash: (step) => { if (step === 'exchanged') throw new Error('crash at exchanged') } }).apply({ editId: world.editOf(`race-room:round-${index}`).editId, mode: 'manual' })
  await assert.rejects(crashAt(0), /crash at/)
  await assert.rejects(crashAt(1), /crash at/)
  // The first candidate path whose directory is looked at answers EACCES once, as an unsearchable directory would.
  const denied = failOnce(t, 'lstatSync', (file) => typeof file === 'string' && file.endsWith('exchange.candidate'), 'EACCES')
  const first = (await world.sourceApply().recover()).recovered
  denied.restore()
  assert.equal(denied.failed(), 1, 'the injected failure fired')
  assert.deepEqual(first.map((item) => [item.status, item.code]).sort(), [['applied', 'applied-after-restart'], ['refused', 'recovery-state-unreadable']], JSON.stringify(first))
  // Nothing was guessed for the unreadable one: once it can be looked at, it settles from its digests like the other.
  const second = (await world.sourceApply().recover()).recovered
  assert.deepEqual(second.map((item) => [item.status, item.code]), [['applied', 'applied-after-restart']], JSON.stringify(second))
  for (const index of [0, 1]) assert.ok(fs.readFileSync(world.source(`race-room/rounds/round-${index}.md`)).includes(`Edited sentence ${index}.`), 'both sources hold their applied edit')
})

test('apply: a file this process may not read refuses corpus-unreadable or source-unreadable with the cause, names no file, and writes nothing', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'permission bits do not deny a read here' : needsExchange.skip }, async (t) => {
  const world = raceWorld(t, 1)
  const sourceFile = world.source('race-room/rounds/round-0.md')
  const before = fs.readFileSync(sourceFile)
  fs.chmodSync(sourceFile, 0o000)
  t.after(() => { try { fs.chmodSync(sourceFile, 0o644) } catch { /* the world is removed anyway */ } })
  const result = await world.sourceApply().apply({ editId: world.editOf('race-room:round-0').editId, mode: 'manual', actor: 'person-synthetic' })
  fs.chmodSync(sourceFile, 0o644)
  assert.deepEqual([result.status, result.code, result.detail?.cause, SOURCE_APPLY_REFUSALS.includes(result.code)], ['refused', 'corpus-unreadable', 'EACCES', true], JSON.stringify(result))
  assert.equal(/rounds|\.md/.test(JSON.stringify(result)), false, 'the refusal names no file')
  // Readable while the graph is built, not at the moment of the apply: the source read has its own code.
  // The apply opens the source without following a link; the graph's own read of the same file does not pass that flag.
  const late = failOnce(t, 'openSync', (file, flags) => typeof file === 'string' && typeof flags === 'number' && (flags & fs.constants.O_NOFOLLOW) !== 0 && path.resolve(file) === path.resolve(sourceFile), 'EACCES')
  fs.chmodSync(sourceFile, 0o644)
  const second = await world.sourceApply().apply({ editId: world.editOf('race-room:round-0').editId, mode: 'manual', actor: 'person-synthetic' })
  late.restore()
  assert.deepEqual([second.status, second.code, late.failed()], ['refused', 'source-unreadable', 1], JSON.stringify(second))
  assert.deepEqual(fs.readFileSync(sourceFile), before, 'the source is as it was')
  assert.deepEqual(filesUnder(world.recovery()).filter((file) => file.endsWith('.candidate')), [], 'no candidate was written')
})

// A file system call that fails once, for one path, the way it fails when another program removes or replaces what
// was there a moment ago. `when` sees the arguments of the call.
function failOnce(t, method, when, code) {
  const original = fs[method]
  let failed = 0
  fs[method] = function patched(...args) {
    if (failed === 0 && when(...args)) { failed += 1; throw Object.assign(new Error(`${code}: synthetic race`), { code }) }
    return original.apply(this, args)
  }
  const restore = () => { fs[method] = original }
  t.after(restore)
  return { restore, failed: () => failed }
}

test('apply beside a program that removes or replaces a path between two calls: every such race is one of the declared typed refusals, in both modes of failure, and writes nothing', needsExchange, async (t) => {
  const world = raceWorld(t, 5)
  const sourceOf = (index) => world.source(`race-room/rounds/round-${index}.md`)
  const sources = () => treeListing(world.repo('race-room'), { skip: (relative) => relative.startsWith('.git/') })
  const before = sources()
  const same = (left, right) => typeof left === 'string' && path.resolve(left) === path.resolve(right)
  const rows = [
    // Armed by the open of the source. Its mode is read from that descriptor, so the one later look at the path is
    // the second reading that prepares the note again, which sees the file on its next call: applied, or typed.
    { name: 'the source gone for one call after it was read', code: 'ENOENT', method: 'lstatSync', armedBy: 'openSync', when: (index, armed) => (file, options) => armed() && same(file, sourceOf(index)) && options === undefined, expected: ['source-missing'], mayNotFire: true },
    { name: 'the directory of the source replaced before the volume check', code: 'ENOTDIR', method: 'statSync', when: (index) => (file) => same(file, path.dirname(sourceOf(index))), expected: ['source-missing'] },
    { name: 'the recovery directory removed before the volume check', code: 'ENOENT', method: 'statSync', when: () => (file) => same(file, world.recovery()), expected: ['workspace-not-prepared'] },
    { name: 'the workspace state removed between the pointer and its resolution', code: 'ENOENT', method: 'realpathSync', when: () => (file) => typeof file === 'string' && file.includes(APPLY_WORKSPACE_ID), expected: ['workspace-not-prepared'] },
    { name: 'a directory on the way to the source replaced by a file while it is walked', code: 'ENOTDIR', method: 'lstatSync', when: (index) => (file, options) => same(file, sourceOf(index)) && options !== undefined, expected: ['source-missing'] },
  ]
  for (const [index, row] of rows.entries()) {
    const edit = world.editOf(`race-room:round-${index}`)
    const apply = world.sourceApply()
    let armed = false
    const arming = row.armedBy ? failOnce(t, row.armedBy, (file) => { if (same(file, sourceOf(index))) armed = true; return false }, 'never') : null
    const fault = failOnce(t, row.method, row.when(index, () => armed), row.code)
    let result
    try { result = await apply.apply({ editId: edit.editId, mode: 'manual' }) } finally { fault.restore(); arming?.restore() }
    assert.ok(!row.armedBy || armed, `${row.name}: the source was opened`)
    if (row.mayNotFire && result.status === 'applied') continue
    assert.equal(fault.failed(), 1, `${row.name}: the call was made`)
    assert.deepEqual([result.status, row.expected.includes(result.code), SOURCE_APPLY_REFUSALS.includes(result.code)], ['refused', true, true], `${row.name}: ${result.code}`)
    assert.deepEqual(sources()[`rounds/round-${index}.md`], before[`rounds/round-${index}.md`], `${row.name}: the source is untouched`)
    assert.equal((await world.sourceApply().apply({ editId: edit.editId, mode: 'manual' })).status, 'applied', `${row.name}: the edit is still there and applies once the race is over`)
  }
})

test('apply beside a real removal: the source deleted, or its directory replaced by a file, after the path was checked refuses typed and creates nothing', needsExchange, async (t) => {
  const world = raceWorld(t, 2)
  const removals = [
    { code: 'source-missing', act: (file) => fs.rmSync(file) },
    { code: 'source-not-regular-file', act: (file) => { fs.rmSync(path.dirname(file), { recursive: true }); fs.writeFileSync(path.dirname(file), 'a file now') } },
  ]
  for (const [index, removal] of removals.entries()) {
    const file = world.source(`race-room/rounds/round-${index}.md`)
    const apply = world.sourceApply({}, { ...SOURCE_APPLY_PRIMITIVES, isGitIgnored: () => { removal.act(file); return false } })
    const result = await apply.apply({ editId: world.editOf(`race-room:round-${index}`).editId, mode: 'manual' })
    assert.deepEqual([result.status, result.code], ['refused', removal.code])
    assert.equal(fs.existsSync(file), false, 'no source file is created')
    if (index === 0) fs.writeFileSync(file, 'restored for the next round')
  }
})

test('apply command beside a damaged object log: recover settles the healthy interrupted apply and reports the damaged object by its code, show answers a typed refusal, and nothing is repaired or deleted', needsExchange, async (t) => {
  const world = raceWorld(t, 2)
  const [healthy, damaged] = [0, 1].map((index) => world.editOf(`race-room:round-${index}`))
  for (const edit of [healthy, damaged]) {
    await assert.rejects(world.sourceApply({ leasePid: GONE_HOLDER_PID, crash: (step) => { if (step === 'intent-recorded') throw new Error(`crash at ${step}`) } }).apply({ editId: edit.editId, mode: 'manual' }), /crash at/)
  }
  // Another program wrote over an event of the second object. Its log can no longer be read.
  const directory = objectDirectory(world.workspaceRoot(), { repoId: 'race-room', nodeId: 'race-room:round-1' })
  fs.writeFileSync(path.join(directory, eventFile(1)), '{"half":')
  const before = { object: snapshotTree(directory), sources: treeListing(world.repo('race-room'), { skip: (relative) => relative.startsWith('.git/') }) }
  const candidatesOf = () => filesUnder(world.recovery()).filter((file) => /\.candidate$/.test(file)).length
  assert.equal(candidatesOf(), 2)

  const recovered = await runApplyCommand(world, ['apply', 'recover', '--json'])
  assert.equal(recovered.exit, 0, recovered.text)
  assert.deepEqual(recovered.json.recovered.map((item) => [item.editId, item.status, item.code]).sort(), [[healthy.editId, 'refused', 'interrupted-before-exchange'], [damaged.editId, 'refused', 'object-event-malformed']].sort())
  assert.equal((await world.sourceApply().show(healthy.editId)).object.outcomeUnknown, false, 'the healthy apply is settled')
  assert.equal(candidatesOf(), 1, 'the candidate of the damaged object stays where it is')
  assert.deepEqual({ object: snapshotTree(directory), sources: treeListing(world.repo('race-room'), { skip: (relative) => relative.startsWith('.git/') }) }, before, 'the damaged log is not repaired or deleted, and no source changed')

  for (const argv of [['apply', 'show', damaged.editId, '--json'], ['apply', 'run', damaged.editId, '--json']]) {
    const answer = await runApplyCommand(world, argv)
    const code = answer.json.error?.code ?? answer.json.result?.code
    assert.deepEqual([answer.exit === 2 || answer.exit === 3, code], [true, 'object-event-malformed'], `${argv[1]}: ${answer.text}`)
    assert.ok(!answer.text.includes('internal-error'), argv[1])
  }
  const listed = await runApplyCommand(world, ['apply', 'list', '--json'])
  assert.equal(listed.exit, 0, listed.text)
  assert.deepEqual(listed.json.edits.map((edit) => edit.editId).sort(), [healthy.editId, damaged.editId].sort(), 'a damaged object hides no other edit from the listing')
  // Mutation control: a recovery that stops at the first unreadable object settles nothing else, and even then the
  // command answers with the code.
  const stopsAtFirst = await runApplyCommand(world, ['apply', 'recover', '--json'], { wrap: (operation) => ({ ...operation, recover: async () => { throw new EditArbitrationRefusal('object-event-malformed', 'synthetic') } }) })
  assert.deepEqual([stopsAtFirst.exit, stopsAtFirst.json.error.code], [2, 'object-event-malformed'], stopsAtFirst.text)
  // The store of the view refusing is typed at the same boundary.
  const storeRefuses = await runApplyCommand(world, ['apply', 'show', healthy.editId, '--json'], { seams: { createRecoveryStore: () => { throw new PublicationRefusal('recovery-object-corrupt', 'synthetic') } } })
  assert.deepEqual([storeRefuses.exit, storeRefuses.json.error.code], [2, 'recovery-object-corrupt'], storeRefuses.text)
})

test('apply disclosure: results, listings, recovery reports, command output, events and apply errors hold no note text, source text, title or machine path', needsExchange, async (t) => {
  const world = applyWorld(t)
  for (const scope of [WHOLE, EAST]) world.publishDirectly(scope.scopeId)
  world.editNote('east-wing:lantern', 'once a minute', 'twice a minute')
  world.editNote('west-wing:tide', 'at noon', 'at one')
  world.editNote('east-wing:compass', 'painted red', 'painted blue')
  world.editNote('east-wing:compass', 'painted red', 'painted green', 'scope-east')
  for (const scope of [WHOLE, EAST]) world.queueDirectly(scope.scopeId)
  const sourceApply = world.sourceApply()
  const collected = [await sourceApply.list()]
  collected.push(await sourceApply.apply({ editId: world.editOf('east-wing:lantern').editId, mode: 'manual' }))
  collected.push(await sourceApply.apply({ editId: world.editOf('east-wing:compass').editId, mode: 'manual' }))
  fs.appendFileSync(world.source('west-wing/logs/tide.md'), '\nA line saved by somebody else.\n')
  collected.push(await sourceApply.apply({ editId: world.editOf('west-wing:tide').editId, mode: 'automatic' }))
  collected.push(await sourceApply.apply({ editId: world.editOf('west-wing:tide').editId, mode: 'manual' }))
  for (const edit of world.pendingEdits()) collected.push(await sourceApply.show(edit.editId))
  collected.push(await sourceApply.recover(), await sourceApply.recheck(), await sourceApply.list())
  for (const argv of [['apply', 'list'], ['apply', 'list', '--json'], ['apply', 'show', world.editOf('west-wing:tide').editId], ['apply', 'run', world.editOf('west-wing:tide').editId], ['apply', 'run', 'edit-unknown', '--json']]) collected.push((await runApplyCommand(world, argv)).text)
  for (const file of [...filesUnder(path.join(world.workspaceRoot(), 'state', 'objects')), ...filesUnder(path.join(world.workspaceRoot(), 'state', 'object-index'))]) collected.push(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(collected.filter((item) => item?.status).map((item) => item.code).sort(), ['applied', 'object-conflicted', 'stale-source', 'stale-source'])

  const forbidden = [world.dir, fs.realpathSync.native(os.tmpdir()), os.homedir(), 'Lantern room', 'Tide log', 'Compass rose', 'The lamp', 'a minute', 'High water', 'painted', 'somebody else', 'lantern.md', 'tide.md', 'notes/', 'logs/', '--d486', '# ']
  const walk = (value, trail) => {
    if (typeof value === 'string') { for (const text of forbidden) assert.equal(value.includes(text), false, `${trail} discloses ${JSON.stringify(text.slice(0, 12))}`); return }
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${trail}[${index}]`)); return }
    if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) { walk(key, `${trail}.key`); walk(item, `${trail}.${key}`) }
  }
  walk(collected, 'collected')
  // Mutation control: the walk fails on a result that carries a path.
  assert.throws(() => walk([{ status: 'refused', code: 'source-missing', detail: { file: world.source(LANTERN) } }], 'mutant'), assert.AssertionError)
})

test('apply leaves the old source where the maintenance engine looks again: a holder of the old file that writes after the apply is captured on a later tick, and surfaced as source-changed-after-apply', needsExchange, async (t) => {
  const world = applyWorld(t)
  const engine = world.engine()
  await engine.tick()
  world.editNote('east-wing:lantern', 'once a minute', 'twice a minute')
  world.advance(1000)
  await engine.tick()
  const edit = world.editOf('east-wing:lantern')
  const base = fs.readFileSync(world.source(LANTERN))
  // Another program opened the source before the apply and keeps it open.
  const held = fs.openSync(world.source(LANTERN), 'r+')
  t.after(() => { try { fs.closeSync(held) } catch { /* closed below */ } })
  const sourceApply = world.sourceApply()
  const result = await sourceApply.apply({ editId: edit.editId, mode: 'manual' })
  assert.equal(result.code, 'applied')
  world.advance(1000)
  assert.deepEqual((await engine.tick()).lateWriters, [], 'nothing was written late yet')
  const late = utf8('\nwritten through a descriptor opened before the apply\n')
  fs.writeSync(held, late, 0, late.length, base.length)
  fs.fsyncSync(held)
  fs.closeSync(held)
  world.advance(1000)
  const report = await engine.tick()
  assert.deepEqual(report.lateWriters.map((finding) => [finding.journalId, finding.digestAtMove, finding.observedDigest]), [[result.applyId, sha256Digest(base), sha256Digest(Buffer.concat([base, late]))]], 'the engine tick found the late write in the backup of the apply')
  assert.deepEqual(fs.readFileSync(path.join(world.workspaceRoot(), report.lateWriters[0].objectRef)), Buffer.concat([base, late]), 'and retained it')
  assert.match(fs.readFileSync(world.source(LANTERN), 'utf8'), /twice a minute/, 'the source keeps the applied edit')
  assert.deepEqual((await sourceApply.show(edit.editId)).lateWriters.map((finding) => [finding.code, finding.applyId]), [['source-changed-after-apply', result.applyId]])
  world.advance(1000)
  assert.deepEqual((await engine.tick()).lateWriters, [], 'a finding is reported once')
})
