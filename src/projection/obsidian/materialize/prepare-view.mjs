import { createHash } from 'node:crypto'
import { unclosedFenceAtEnd } from '../../../graph/knowledge-graph.mjs'
import {
  DERIVED_RELATION_TYPE, IDENTITY_KEYS, RELATION_TYPES, SCOPE_PRIMITIVES, assertObsidianContract, identityLineTexts, identitySuffix, manifestLayoutVersion, readableTitle,
  selectScope,
} from '../contracts.mjs'
import { assertStrictUtf8, readMarkdownLens, refuse, sha256Digest } from './byte-lens.mjs'
import { allocateLegacyPaths, allocateViewPaths, collisionKey, titleWithinBudget, viewsOfRegistry, withViewSection } from './path-registry.mjs'
import { REDACTION_RULES, assertOnlyVaultIdentities, assertViewRedaction, createDenyMatcher } from './redaction.mjs'
import { isUserOwnedSettingsPath, prepareSettings } from './settings.mjs'

// prepareView: a pure preparation of one Obsidian view. It reads sources
// through the caller, returns note, attachment and settings bytes plus a
// generation manifest, and writes nothing. The canonical graph is the only
// graph authority: notes and relation rows serialize canonical nodes and
// edges, and only canonical resolved link and embed occurrences are rewritten.
// An embedded asset is copied only when the canonical graph resolved it; the
// emitter never infers one from authored bytes.
//
// A view is laid out in vault layout 2: folders mirror the repository, the
// file name is the note's title and each note names its identity in generated
// front-matter properties (see "Vault layout" in docs/obsidian-contract.md).
// Layout 1, the earlier release's, is kept for a view whose prior generation
// is in layout 1 and holds a note with an open edit, and for recovering a
// layout 1 generation as it was published.
//
// Redaction happens where bytes are made. Every title, path and identity that
// reaches an output is looked up through `vault`, the set selectScope returned
// for this view, so a node outside it cannot be serialized by any branch; the
// redaction guard checks the whole result before anything is returned.
//
// Preparation is incremental when the caller passes a preparation cache (see
// createPreparationCache). Every note's bytes and manifest entry are a pure
// function of a small set of inputs: the layout, the pinned source digest, the
// node record, the allocated paths, the generated rows, the outside-selection
// count and the rewritten occurrences with their emitted targets. Those inputs
// are serialized into a dependency key per note; a note whose key matches the
// cached one reuses the cached bytes and manifest entry instead of being
// emitted again, so the result is byte-identical to a full preparation by
// construction. The cache holds derived state only and can be dropped at any
// time; the redaction guard still runs over the whole result.

export const EMITTER_VERSION = '2.0.0'
export const VAULT_LAYOUTS = Object.freeze({
  1: Object.freeze({ version: 1, emitterVersion: '1.0.0', manifestSchema: 'atelier-obsidian-generation-manifest/v1', contractVersion: '1.0.0' }),
  2: Object.freeze({ version: 2, emitterVersion: EMITTER_VERSION, manifestSchema: 'atelier-obsidian-generation-manifest/v2', contractVersion: '2.0.0' }),
})
export const CURRENT_VAULT_LAYOUT = 2
const EXT_KEY = 'mnstry.atelier.obsidian'
const EMBEDDABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
// Bytes left for an asset's readable stem beside the longest suffix and extension (layout 1).
const ASSET_STEM_BYTE_BUDGET = 255 - '--'.length - 64 - '.'.length - 16
const RELATIONS_HEADING = '## Relations (generated)\n\n%% Generated from the canonical graph. Edits to this section are not applied to any source. %%\n\n'

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0)
const utf8 = (text) => Buffer.from(text, 'utf8')
const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

// Text placed in generated prose. Anything that could start a link, a tag, an
// embed or a comment is removed or escaped, so generated prose can never add a
// native graph edge that the canonical graph does not hold.
function plainText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>#|^$%~=!&]/g, (character) => `\\${character}`)
}

function encodeHref(fileName) {
  return encodeURIComponent(fileName).replace(/[()']/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

// A vault path as a Markdown link target: every segment percent-encoded.
const encodeVaultPath = (vaultPath) => vaultPath.split('/').map(encodeHref).join('/')

const legacyBasename = (notePathValue) => notePathValue.slice('notes/'.length, -'.md'.length)

// How a link names a note: layout 1 by its unique basename, layout 2 by its
// full vault path, which the app looks up as an exact path before any other
// match. A wikilink keeps `.md` so a note named after a file never resolves
// to the file.
function noteLinkTarget(layout, notePathValue) {
  if (layout.version === 1) {
    const stem = legacyBasename(notePathValue)
    return { markdown: encodeHref(`${stem}.md`), wikilink: stem }
  }
  return { markdown: encodeVaultPath(notePathValue), wikilink: notePathValue }
}

function edgeIdentifier(edge) {
  return `e-${createHash('sha256').update(`${edge.source}\u0000${edge.type}\u0000${edge.target}`).digest('hex').slice(0, 32)}`
}

function timestampFrom(clock) {
  if (typeof clock !== 'function') refuse('missing-clock', 'prepareView needs an injected clock for the manifest freshness timestamp')
  const value = clock()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) refuse('missing-clock', 'the injected clock did not return a time')
  return date.toISOString()
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function sourceReader(snapshot) {
  const expected = new Map()
  for (const repo of snapshot.document.repositories) {
    for (const file of repo.files) expected.set(`${repo.repoId}\u0000${file.path}`, file)
  }
  const pinnedFor = (repoId, relativePath) => {
    const pinned = expected.get(`${repoId}\u0000${relativePath}`)
    if (!pinned) refuse('source-not-in-snapshot', 'a selected source is not pinned by the source snapshot')
    return pinned
  }
  const read = (repoId, relativePath) => {
    const pinned = pinnedFor(repoId, relativePath)
    const bytes = snapshot.readSource(repoId, relativePath)
    if (!Buffer.isBuffer(bytes)) refuse('invalid-source', 'readSource must return a Buffer')
    if (bytes.length !== pinned.byteLength || sha256Digest(bytes) !== pinned.rawDigest) {
      refuse('mixed-read', 'source bytes differ from the digest pinned by the source snapshot')
    }
    return { bytes, rawDigest: pinned.rawDigest }
  }
  read.pinned = pinnedFor
  return read
}

// ---------------------------------------------------------------------------
// Preparation cache
// ---------------------------------------------------------------------------

// Derived, droppable state for incremental preparation: one entry per note
// path holding the dependency key the note was emitted under and everything
// the note contributed to the result. It is private to the process that made
// it and is never written anywhere.
export function createPreparationCache() {
  return { notes: new Map() }
}

function isPreparationCache(cache) {
  return cache !== null && typeof cache === 'object' && cache.notes instanceof Map
}

// Everything the emitted bytes and the manifest entry of one note depend on,
// in a canonical serialization. A cached note is reused only under an equal
// key. The layout and emitter version are part of the key so an entry states
// which emitter produced it, should a cache ever outlive this module. The
// identity block and where it goes are functions of the node record and the
// source bytes, which the key holds through the pinned digest.
function dependencyKey({ layout, node, notePathValue, attachmentPathValue, pinned, rows, outsideCount, occurrences, emittedTarget }) {
  // A wrapper note serializes the record's summary and tags; a Markdown note never does.
  const wrapper = node.extension === 'md' ? null : JSON.stringify([String(node.summary ?? ''), Array.isArray(node.tags) ? node.tags : null])
  const parts = [
    layout.emitterVersion, notePathValue, node.repo, node.id, node.path, String(node.extension), String(node.title ?? ''), String(wrapper),
    pinned.rawDigest, String(pinned.byteLength), String(outsideCount), rows.join(''),
  ]
  // Layout 1 keys are exactly the earlier release's; layout 2 adds its own inputs after them.
  if (layout.version !== 1) parts.push(`layout-${layout.version}`, String(attachmentPathValue ?? ''))
  for (const occurrence of occurrences) {
    const target = emittedTarget(occurrence)
    parts.push(JSON.stringify([
      occurrence.type ?? null, occurrence.syntax ?? null, occurrence.embed === true, occurrence.href ?? null, occurrence.target ?? null,
      occurrence.range?.byteStart ?? null, occurrence.range?.byteEnd ?? null, occurrence.targetRange?.byteStart ?? null, occurrence.targetRange?.byteEnd ?? null,
      target.key, target.markdown, target.wikilink, target.alias,
    ]))
  }
  // JSON escapes every control character, so no field can shift into its neighbour.
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

// The byte edits for one source: each is { start, end, emitted } over the
// source Buffer. Offsets come from the canonical occurrence; the bytes under
// them are compared with what the graph read, so a graph built from different
// bytes refuses instead of rewriting the wrong place. `emittedTarget` names
// what an occurrence is rewritten to: { key, markdown, wikilink, alias }.
// Links and asset embeds go through here together, so one overlap check covers
// both.
function linkEdits({ source, lens, occurrences, emittedTarget }) {
  const edits = []
  for (const occurrence of occurrences) {
    const { range, targetRange } = occurrence
    const offsets = [range?.byteStart, targetRange?.byteStart, targetRange?.byteEnd, range?.byteEnd]
    if (offsets.some((offset) => !Number.isInteger(offset)) || offsets.some((offset, index) => index > 0 && offset < offsets[index - 1])) {
      refuse('link-offsets-unavailable', 'a canonical link occurrence carries no usable byte offsets')
    }
    if (range.byteStart < lens.body.start || range.byteEnd > lens.body.end) refuse('link-outside-body', 'a canonical link occurrence lies outside the authored body')
    const written = source.subarray(targetRange.byteStart, targetRange.byteEnd).toString('utf8')
    const target = emittedTarget(occurrence)
    if (occurrence.syntax === 'markdown') {
      if (written !== occurrence.href) refuse('mixed-read', 'source bytes under a canonical link differ from the link the graph read')
      edits.push({ ...target.key, start: targetRange.byteStart, end: targetRange.byteEnd, emitted: utf8(target.markdown) })
    } else if (occurrence.syntax === 'wikilink') {
      const whole = source.subarray(range.byteStart, range.byteEnd).toString('utf8')
      if (written.trim() !== occurrence.href || !whole.startsWith('[[') || !whole.endsWith(']]')) {
        refuse('mixed-read', 'source bytes under a canonical link differ from the link the graph read')
      }
      edits.push({ ...target.key, start: targetRange.byteStart, end: targetRange.byteEnd, emitted: utf8(target.wikilink) })
      // Keep the words the author chose visible: without an alias the editor
      // would display the allocated file name. An embed has no label: what
      // follows its target (a size, a fragment) stays as authored.
      const tail = source.subarray(targetRange.byteEnd, range.byteEnd - 2).toString('utf8')
      if (target.alias && !occurrence.embed && !tail.includes('|')) {
        edits.push({ ...target.key, start: range.byteEnd - 2, end: range.byteEnd - 2, emitted: utf8(`|${occurrence.href}`) })
      }
    } else {
      refuse('unsupported-link', 'a canonical link occurrence uses an unknown syntax')
    }
  }
  edits.sort((left, right) => left.start - right.start || left.end - right.end)
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].start < edits[index - 1].end) refuse('link-overlap', 'canonical link occurrences overlap')
  }
  return edits
}

// Applies edits to the body and returns the emitted bytes plus, for each edit,
// its source range, its range in `prefixLength`-offset note space and both
// byte strings.
function applyEdits({ source, from, to, edits, noteOffset }) {
  const parts = []
  const inversions = []
  let cursor = from
  let written = noteOffset
  for (const edit of edits) {
    const kept = source.subarray(cursor, edit.start)
    parts.push(kept)
    written += kept.length
    parts.push(edit.emitted)
    inversions.push({
      edgeKey: edit.edgeKey,
      assetKey: edit.assetKey,
      source: { start: edit.start, end: edit.end },
      note: { start: written, end: written + edit.emitted.length },
      ext: { [EXT_KEY]: { original: base64url(source.subarray(edit.start, edit.end)), emitted: base64url(edit.emitted), encoding: 'base64url' } },
    })
    written += edit.emitted.length
    cursor = edit.end
  }
  parts.push(source.subarray(cursor, to))
  return { bytes: Buffer.concat(parts), inversions }
}

// ---------------------------------------------------------------------------
// The identity block (layout 2)
// ---------------------------------------------------------------------------

const identityText = (node, eol) => identityLineTexts(node).map((line) => `${line}${eol}`).join('')

// The key of one line of a block mapping at column 0, or null when the line
// is not one: a quoted or plain key followed by `:` and a space, a tab or the
// end of the line.
function blockMappingKey(line) {
  let key
  let rest
  if (line.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(line)
    if (!match) return null
    try { key = JSON.parse(`"${match[1]}"`) } catch { return null }
    rest = line.slice(match[0].length)
  } else if (line.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'/.exec(line)
    if (!match) return null
    key = match[1].replaceAll("''", "'")
    rest = line.slice(match[0].length)
  } else {
    if (/^[-?:,[\]{}#&*!|>%@`]/.test(line)) return null
    const colon = /:(?:[ \t]|$)/.exec(line)
    if (!colon) return null
    key = line.slice(0, colon.index).trimEnd()
    rest = line.slice(colon.index)
    if (key === '' || /[ \t]#/.test(key)) return null
  }
  return /^[ \t]*:(?:[ \t]|$)/.test(rest) ? key : null
}

// Whether identity lines can be appended to this front matter without changing
// what it means: a block mapping at column 0 (blank and comment lines aside,
// every line at column 0 is `key:`, everything else is indented under one) that
// does not already use one of the identity keys. Answers 'fits', 'author-keys'
// (the author wrote one of the three keys, which would then show in Properties
// instead of the generated one) or 'shape' (a flow or sequence root, an
// indented root, a directive or document marker, or a line that is no key).
function identityLinesFit(yaml) {
  let first = true
  let authorKeys = false
  for (const raw of yaml.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '' || /^[ \t]*#/.test(line)) continue
    if (/^[ \t]/.test(line)) {
      if (first || line.startsWith('\t')) return 'shape'
      continue
    }
    first = false
    const key = blockMappingKey(line)
    if (key === null) return 'shape'
    if (IDENTITY_KEYS.includes(key)) authorKeys = true
  }
  return authorKeys ? 'author-keys' : 'fits'
}

// Where the identity lines of a Markdown note go, decided from the source
// bytes alone: appended to its front matter, in a generated front matter of
// their own, or, for a front matter that cannot take them, at the end.
function identityPlacement(source, lens) {
  if (lens.frontmatter === null) {
    const firstBreak = source.indexOf(0x0a, lens.body.start)
    const eol = firstBreak > lens.body.start && source[firstBreak - 1] === 0x0d ? '\r\n' : '\n'
    return { kind: 'generated-frontmatter', eol }
  }
  const { start, end } = lens.frontmatter
  const openingEnd = source.indexOf(0x0a, start) + 1
  const closingStart = source.lastIndexOf(0x0a, end - 2) + 1
  const fit = identityLinesFit(source.subarray(openingEnd, closingStart).toString('utf8'))
  if (fit !== 'fits') return { kind: 'tail', authorKeys: fit === 'author-keys' }
  return { kind: 'frontmatter-lines', at: closingStart, eol: source[closingStart - 2] === 0x0d ? '\r\n' : '\n' }
}

// ---------------------------------------------------------------------------
// Generated sections
// ---------------------------------------------------------------------------

function separatorAfter(bytes) {
  if (bytes.length === 0) return ''
  return bytes[bytes.length - 1] === 0x0a ? '\n' : '\n\n'
}

// `titles` memoizes the two renderings of a title per node for one
// preparation: a node's title is rendered once however many rows name it.
function titleRenderings() {
  const readable = new Map()
  const plain = new Map()
  return {
    readableOf: (target) => { if (!readable.has(target.id)) readable.set(target.id, readableTitle(target.title)); return readable.get(target.id) },
    plainOf: (origin) => { if (!plain.has(origin.id)) plain.set(origin.id, plainText(origin.title)); return plain.get(origin.id) },
  }
}

function relationRows({ layout, node, outgoing, incoming, vaultNode, pathOf, titles }) {
  const rows = []
  for (const type of RELATION_TYPES) {
    for (const edge of outgoing) {
      if (edge.type !== type) continue
      const target = vaultNode(edge.target)
      if (!target) continue
      rows.push(`- ${type} → [[${noteLinkTarget(layout, pathOf(target)).wikilink}|${titles.readableOf(target)}]]\n`)
    }
    // An incoming row is plain text: a link here would give this note an
    // outgoing native link that the canonical graph does not hold.
    if (type === DERIVED_RELATION_TYPE) continue
    for (const edge of incoming) {
      if (edge.type !== type) continue
      const origin = vaultNode(edge.source)
      if (!origin || origin.id === node.id) continue
      rows.push(`- ${type} ← ${titles.plainOf(origin)}\n`)
    }
  }
  return rows
}

// An authored body that ends inside a fenced code block would swallow whatever
// follows it. The closing fence is generated, never authored: it is the first
// bytes of the first generated region, so authored ranges and inversion stay
// exact. It repeats the opener's indentation, character and length, starts on
// its own line and uses the source's line ending. The fence rules are the
// canonical graph scanner's, not restated here.
function fenceClosureFor(source, finalNewline) {
  const fence = unclosedFenceAtEnd(source.toString('utf8'))
  if (!fence) return null
  const firstBreak = source.indexOf(0x0a)
  const crlf = finalNewline === 'crlf' || (finalNewline === 'none' && firstBreak > 0 && source[firstBreak - 1] === 0x0d)
  const eol = crlf ? '\r\n' : '\n'
  const line = `${' '.repeat(fence.indent)}${fence.char.repeat(fence.length)}`
  return { fence: line, text: `${finalNewline === 'none' ? eol : ''}${line}${eol}` }
}

// `identity`, when given, is the text of identity lines that go at the very
// end of the note, in a comment block, as the last generated region.
function generatedSections({ precedingBytes, offset, rows, outsideCount, closure = null, identity = null }) {
  const regions = []
  const parts = []
  let cursor = offset
  const push = (kind, text) => {
    const closes = closure && regions.length === 0
    const bytes = utf8(closes ? `${closure.text}${text}` : text)
    parts.push(bytes)
    regions.push({
      kind,
      range: { start: cursor, end: cursor + bytes.length },
      ...(closes ? { ext: { [EXT_KEY]: { fenceClosure: { fence: closure.fence, byteLength: Buffer.byteLength(closure.text, 'utf8') } } } } : {}),
    })
    cursor += bytes.length
  }
  if (closure) precedingBytes = utf8(closure.text)
  if (rows.length > 0) push('relations', `${separatorAfter(precedingBytes)}${RELATIONS_HEADING}${rows.join('')}`)
  if (outsideCount > 0) {
    const lead = rows.length > 0 ? '\n' : `${separatorAfter(precedingBytes)}${RELATIONS_HEADING}`
    push('outside-selection', `${lead}Relationships leading outside this view: ${outsideCount}\n`)
  }
  if (identity !== null) push('identity', `${regions.length > 0 ? '\n' : separatorAfter(precedingBytes)}%%\n${identity}%%\n`)
  return { bytes: Buffer.concat(parts), regions }
}

// The wrapper's own lines. `format` and `source` are what the redaction guard
// recognises as the node's own extension and path.
function wrapperLines(node) {
  return {
    format: `- Format: ${plainText(node.extension)}`,
    source: `- Source: ${plainText(node.repo)} · ${node.path.split('/').map(plainText).join(' / ')}`,
  }
}

function wrapperRepresentation({ node, attachmentPath }) {
  const own = wrapperLines(node)
  const lines = [`# ${plainText(node.title)}\n`]
  if (node.summary) lines.push(`\n${plainText(node.summary)}\n`)
  lines.push(`\n${own.format}\n`)
  lines.push(`${own.source}\n`)
  if (Array.isArray(node.tags) && node.tags.length > 0) lines.push(`- Tags: ${node.tags.map(plainText).join(', ')}\n`)
  lines.push(`- Original: [[${attachmentPath}|Open the original file]]\n`)
  if (EMBEDDABLE.has(String(node.extension).toLowerCase())) lines.push(`\n![[${attachmentPath}]]\n`)
  return utf8(lines.join(''))
}

// ---------------------------------------------------------------------------
// prepareView
// ---------------------------------------------------------------------------

function assertContained(relativePath) {
  const parts = relativePath.split('/')
  if (relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\u0000') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    refuse('path-escapes-vault', 'a prepared path would leave the vault root')
  }
}

// One note, from its inputs alone: the prepared files (the note and, for a
// wrapper, its attachment), the manifest entry, the attachment record, the
// inversions it contributes per rewritten edge, and whether it closed a fence.
// Nothing outside the arguments is read, which is what lets the result be
// cached under the dependency key.
function emitNote({ layout, node, notePathValue, attachmentPathValue, source: { bytes: source, rawDigest }, rows, outsideCount, occurrences, emittedTarget, key }) {
  const sourceRecord = { path: node.path, rawDigest, byteLength: source.length }
  const assetInversions = new Map()
  const edgeInversions = new Map()
  const files = []
  let attachment = null
  let authored
  let regions
  let closure = null
  let identityAtEnd = null
  let placementOf = null

  if (node.extension === 'md') {
    const lens = readMarkdownLens(source, { repoId: node.repo, nodeId: node.id })
    const edits = linkEdits({ source, lens, occurrences, emittedTarget })
    const placement = layout.version === 1 ? null : identityPlacement(source, lens)
    placementOf = placement
    let prefix = source.subarray(0, lens.body.start)
    let frontmatter = lens.frontmatter
    let identity = null
    if (placement?.kind === 'frontmatter-lines') {
      const block = utf8(identityText(node, placement.eol))
      prefix = Buffer.concat([source.subarray(0, placement.at), block, source.subarray(placement.at, lens.body.start)])
      identity = { start: placement.at, end: placement.at + block.length }
      frontmatter = { start: lens.frontmatter.start, end: lens.frontmatter.end + block.length }
    } else if (placement?.kind === 'generated-frontmatter') {
      // After a byte order prefix, which the app strips before it reads front matter.
      const block = utf8(`---${placement.eol}${identityText(node, placement.eol)}---${placement.eol}`)
      prefix = Buffer.concat([source.subarray(0, lens.body.start), block])
      identity = { start: lens.body.start, end: lens.body.start + block.length }
      frontmatter = identity
    } else if (placement?.kind === 'tail') {
      identityAtEnd = identityText(node, '\n')
    }
    const body = applyEdits({ source, from: lens.body.start, to: lens.body.end, edits, noteOffset: prefix.length })
    authored = Buffer.concat([prefix, body.bytes])
    for (const { edgeKey, assetKey, ...inversion } of body.inversions) {
      if (assetKey !== undefined) {
        if (!assetInversions.has(assetKey)) assetInversions.set(assetKey, [])
        assetInversions.get(assetKey).push(inversion)
        continue
      }
      if (!edgeInversions.has(edgeKey)) edgeInversions.set(edgeKey, [])
      edgeInversions.get(edgeKey).push(inversion)
    }
    regions = {
      ...(frontmatter ? { frontmatter } : {}),
      ...(identity ? { identity } : {}),
      body: { start: prefix.length, end: authored.length },
    }
    closure = fenceClosureFor(source, lens.finalNewline)
    Object.assign(sourceRecord, { kind: 'markdown', finalNewline: lens.finalNewline, ...(lens.bom ? { bom: lens.bom } : {}) })
  } else {
    const extension = /^[a-z0-9]{1,16}$/.test(String(node.extension).toLowerCase()) ? String(node.extension).toLowerCase() : 'bin'
    const attachmentPath = layout.version === 1 ? `attachments/${legacyBasename(notePathValue)}.${extension}` : attachmentPathValue
    assertContained(attachmentPath)
    attachment = { path: attachmentPath, digest: rawDigest, byteLength: source.length }
    files.push({ path: attachmentPath, kind: 'attachment', bytes: source, digest: rawDigest })
    const identityBlock = layout.version === 1 ? Buffer.alloc(0) : utf8(`---\n${identityText(node, '\n')}---\n`)
    authored = Buffer.concat([identityBlock, wrapperRepresentation({ node, attachmentPath })])
    regions = {
      ...(identityBlock.length > 0 ? { frontmatter: { start: 0, end: identityBlock.length }, identity: { start: 0, end: identityBlock.length } } : {}),
      body: { start: authored.length, end: authored.length },
      representation: { start: identityBlock.length, end: authored.length },
    }
    Object.assign(sourceRecord, { kind: 'wrapper', attachment: attachmentPath })
  }

  const generated = generatedSections({ precedingBytes: authored, offset: authored.length, rows, outsideCount, closure, identity: identityAtEnd })
  const bytes = Buffer.concat([authored, generated.bytes])
  assertStrictUtf8(bytes)
  assertContained(notePathValue)
  const { representation, ...authoredRegions } = regions
  if (identityAtEnd !== null) authoredRegions.identity = { ...generated.regions.at(-1).range }
  files.push({ path: notePathValue, kind: 'note', bytes, digest: sha256Digest(bytes) })
  const note = {
    repoId: node.repo,
    nodeId: node.id,
    path: notePathValue,
    title: String(node.title || 'Untitled').slice(0, 512),
    noteDigest: sha256Digest(bytes),
    regions: {
      ...authoredRegions,
      generated: [...(representation ? [{ kind: 'representation', range: representation }] : []), ...generated.regions],
    },
    ext: {
      [EXT_KEY]: {
        source: sourceRecord,
        ...(assetInversions.size > 0
          ? { assetEmbeds: [...assetInversions].map(([attachmentKey, inversions]) => ({ attachment: attachmentKey, inversions })).sort((left, right) => compare(left.attachment, right.attachment)) }
          : {}),
      },
    },
  }
  // Only the closure that precedes a generated section is emitted; one before the end-of-note identity block counts.
  return {
    key, files, attachment, note, edgeInversions: [...edgeInversions], fenceClosed: Boolean(closure && generated.regions.length > 0),
    // The author wrote an identity key of their own: it, not the generated block, is what Properties shows.
    authorIdentityKeys: placementOf?.authorKeys === true,
  }
}

// ---------------------------------------------------------------------------
// Embedded assets
// ---------------------------------------------------------------------------

// The assets this view may copy, by id. Fails closed like a node: only an
// explicit eligible: true, in a repository the profile enrols, under the
// repository's audience rule. A malformed or repeated record is withheld.
function visibleAssets(graph, profile) {
  const view = { repositories: new Map(profile.repositories.map((repo) => [repo.repoId, repo])), allowedAudiences: new Set(profile.audience.allow) }
  const seen = new Set()
  const visible = new Map()
  for (const asset of Array.isArray(graph.assets) ? graph.assets : []) {
    if (!asset || typeof asset.id !== 'string' || asset.id === '' || typeof asset.repo !== 'string' || asset.repo === '' || typeof asset.path !== 'string' || asset.path === '') continue
    if (seen.has(asset.id)) {
      visible.delete(asset.id)
      continue
    }
    seen.add(asset.id)
    if (SCOPE_PRIMITIVES.isVisible({ eligible: asset.eligible, repo: asset.repo }, view)) visible.set(asset.id, asset)
  }
  return visible
}

// Layout 1: attachments/<readable stem>--<identity suffix>.<ext>, from the
// repository and asset identity alone. The suffix lengthens only when two
// assets of this view would share a name on a case- or normalization-
// insensitive filesystem.
function allocateLegacyAssetPaths(assets) {
  const taken = new Set()
  const allocated = new Map()
  for (const asset of [...assets].sort((left, right) => compare(left.repo, right.repo) || compare(left.id, right.id))) {
    const name = asset.path.split('/').at(-1)
    const dot = name.lastIndexOf('.')
    const written = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
    const extension = /^[a-z0-9]{1,16}$/.test(written) ? written : 'bin'
    const stem = readableTitle(titleWithinBudget(dot > 0 ? name.slice(0, dot) : name, ASSET_STEM_BYTE_BUDGET))
    let length = 12
    let candidate = `attachments/${stem}--${identitySuffix(asset.repo, asset.id, length)}.${extension}`
    while (taken.has(collisionKey(candidate))) {
      length += 4
      if (length > 64) refuse('path-collision', 'unable to allocate a distinct attachment path')
      candidate = `attachments/${stem}--${identitySuffix(asset.repo, asset.id, length)}.${extension}`
    }
    taken.add(collisionKey(candidate))
    assertContained(candidate)
    allocated.set(asset.id, candidate)
  }
  return allocated
}

function canonicalSnapshotOf(graph) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.links)) {
    refuse('invalid-snapshot', 'snapshot.graph must carry canonical nodes, edges and links')
  }
  const known = new Set(graph.nodes.map((node) => node?.id))
  // A declared relation may name an identity outside the census. It has no
  // note to point at, so it is not part of any view.
  const edges = graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target))
  return { nodes: graph.nodes, edges, externalEdgeCount: graph.edges.length - edges.length }
}

// What a layout 2 prior generation published, which the view's allocation
// keeps (see allocateViewPaths). A layout 1 prior generation offers nothing:
// its paths are the earlier layout's.
function publishedOf(priorManifest) {
  if (!priorManifest || manifestLayoutVersion(priorManifest) !== CURRENT_VAULT_LAYOUT) return null
  return {
    notes: priorManifest.notes.map(({ repoId, nodeId, path: notePathValue, ext }) => {
      const attachment = ext?.[EXT_KEY]?.source?.attachment
      return { repoId, nodeId, path: notePathValue, ...(typeof attachment === 'string' ? { attachment } : {}) }
    }),
    assets: priorManifest.attachments
      .filter((item) => item.ext?.[EXT_KEY]?.kind === 'embedded-asset')
      .map((item) => ({ repoId: item.ext[EXT_KEY].repoId, assetPath: item.ext[EXT_KEY].assetPath, path: item.path })),
  }
}

// `layoutHeld` are the notes that hold a layout 1 view in layout 1: those of
// open edits and of edits closed on this tick (see layoutHeldPaths in
// src/runtime/obsidian/pending-edits.mjs).
function layoutOf({ layout, priorManifest, layoutHeld }) {
  if (layout !== undefined && layout !== null) {
    if (!Object.hasOwn(VAULT_LAYOUTS, layout)) refuse('invalid-layout', 'the vault layout must be 1 or 2')
    return VAULT_LAYOUTS[layout]
  }
  // A layout 1 view that holds a note stays in layout 1 until no note of it is held.
  const held = new Set(layoutHeld)
  if (priorManifest && manifestLayoutVersion(priorManifest) === 1 && priorManifest.notes.some((note) => held.has(note.path))) return VAULT_LAYOUTS[1]
  return VAULT_LAYOUTS[CURRENT_VAULT_LAYOUT]
}

export function prepareView(options = {}) {
  return prepareWithRules(REDACTION_RULES, options)
}

// Test seam only: the mutation controls of the redaction guard substitute a
// rule through this. Runtime code uses prepareView.
export function createViewPreparationForOracleTests(rules = REDACTION_RULES) {
  const guard = { ...REDACTION_RULES, ...rules }
  return (options = {}) => prepareWithRules(guard, options)
}

// `heldNotePaths` are the vault files held for an open edit: they stay in the
// vault, so their names stay taken. `layoutHeldNotePaths`, when given, are the
// notes that hold a layout 1 view in layout 1 (open edits and edits closed on
// this tick); without it, `heldNotePaths` do. `viewScopeIds`, when given, are
// the views still maintained: the registry drops the sections of any other.
function prepareWithRules(guard, { snapshot, profile, scope, persistentPathRegistry = null, priorManifest = null, existingSettings = null, clock, generationId, vaultRootBytes, maxFullPathBytes, cache = null, heldNotePaths = null, layoutHeldNotePaths = null, viewScopeIds = null, layout: requestedLayout } = {}) {
  if (cache !== null && !isPreparationCache(cache)) refuse('invalid-preparation-cache', 'the preparation cache must come from createPreparationCache')
  assertObsidianContract('corpus-profile', profile)
  assertObsidianContract('scope', scope)
  if (!snapshot || typeof snapshot.readSource !== 'function') refuse('invalid-snapshot', 'snapshot needs a source snapshot document, a canonical graph and readSource')
  assertObsidianContract('source-snapshot', snapshot.document)
  if (snapshot.document.workspaceId !== profile.workspaceId) refuse('invalid-snapshot', 'source snapshot and corpus profile name different workspaces')
  if (priorManifest) {
    assertObsidianContract('generation-manifest', priorManifest)
    if (priorManifest.scopeId !== scope.scopeId) refuse('prior-manifest-mismatch', 'the prior manifest belongs to another scope')
  }
  for (const [name, value] of [['heldNotePaths', heldNotePaths], ['layoutHeldNotePaths', layoutHeldNotePaths]]) {
    if (value !== null && !Array.isArray(value)) refuse('invalid-held-notes', `${name} must be an array of note paths`)
  }
  if (viewScopeIds !== null && !(Array.isArray(viewScopeIds) && viewScopeIds.every((id) => typeof id === 'string'))) refuse('invalid-view-scopes', 'viewScopeIds must be an array of scope identities')
  const layout = layoutOf({ layout: requestedLayout, priorManifest, layoutHeld: layoutHeldNotePaths ?? heldNotePaths ?? [] })
  const checkedAt = timestampFrom(clock)
  const canonical = canonicalSnapshotOf(snapshot.graph)

  // Selection and visibility come from the contract, never from this module.
  const universe = selectScope({ canonicalSnapshot: canonical, profile, selector: { all: true }, mode: 'scoped' })
  const selection = selectScope({ canonicalSnapshot: canonical, profile, selector: scope.selector, expansion: scope.expansion, mode: scope.mode })
  const nodeById = new Map(canonical.nodes.map((node) => [node.id, node]))
  const vault = new Set(selection.vaultNodes)
  const vaultNode = (id) => (vault.has(id) ? nodeById.get(id) : null)
  const universeNodes = universe.nodes.map((id) => nodeById.get(id))
  const assets = visibleAssets(snapshot.graph, profile)
  const censusAssets = Array.isArray(snapshot.graph.assets) ? snapshot.graph.assets : []
  const usable = (item) => item && typeof item.repo === 'string' && item.repo !== '' && typeof item.id === 'string' && item.id !== ''
  const limits = { ...(vaultRootBytes === undefined ? {} : { vaultRootBytes }), ...(maxFullPathBytes === undefined ? {} : { maxFullPathBytes }) }
  // Every view's allocation of the registry, this one's included; a registry of another shape or workspace refuses.
  const views = viewsOfRegistry(persistentPathRegistry, profile.workspaceId)

  const edgeById = new Map(canonical.edges.map((edge) => [edge.id, edge]))
  const vaultEdges = selection.vaultEdges.map((id) => edgeById.get(id)).filter((edge) => vault.has(edge.source) && vault.has(edge.target))
  const outsideEdges = selection.outsideSelectionEdges.map((id) => edgeById.get(id)).filter((edge) => vault.has(edge.source) !== vault.has(edge.target))
  const vaultLinkPairs = new Set(vaultEdges.filter((edge) => edge.type === DERIVED_RELATION_TYPE).map((edge) => `${edge.source}\u0000${edge.target}`))
  const occurrencesBySource = new Map()
  for (const link of snapshot.graph.links) {
    if (!vaultLinkPairs.has(`${link.source}\u0000${link.target}`)) continue
    if (!occurrencesBySource.has(link.source)) occurrencesBySource.set(link.source, [])
    occurrencesBySource.get(link.source).push(link)
  }

  // Asset embeds: canonical occurrences whose source is a note of this view and
  // whose asset this view may copy. Anything else is left exactly as authored
  // and appears in no output.
  const embeddedAssets = new Map()
  for (const embed of Array.isArray(snapshot.graph.embeds) ? snapshot.graph.embeds : []) {
    const asset = assets.get(embed?.asset?.id)
    if (!asset || !vault.has(embed.source) || nodeById.get(embed.source).extension !== 'md') continue
    embeddedAssets.set(asset.id, asset)
    if (!occurrencesBySource.has(embed.source)) occurrencesBySource.set(embed.source, [])
    occurrencesBySource.get(embed.source).push(embed)
  }

  // Layout 2 paths are allocated for this view alone, seeded from what its
  // prior generation published; a file held for an open edit keeps its name
  // taken. A view prepared in layout 1 holds layout 1 files, none of which is a
  // layout 2 path. The registry keeps the result as this view's section,
  // whichever layout the view is prepared in.
  const readable = allocateViewPaths({
    published: publishedOf(priorManifest),
    nodes: [...vault].map((id) => nodeById.get(id)),
    assets: [...embeddedAssets.values()],
    occupied: layout.version === 1 ? [] : heldNotePaths ?? [],
    ...limits,
  })
  const legacy = layout.version === 1
    ? allocateLegacyPaths({ nodes: universeNodes, priorManifest: priorManifest && manifestLayoutVersion(priorManifest) === 1 ? priorManifest : null, ...limits })
    : null
  const allocatedPath = legacy ? legacy.pathOf : readable.pathOf
  const pathOf = (node) => allocatedPath(node.repo, node.id)
  const attachmentOf = (node) => (legacy ? null : readable.attachmentOf(node.repo, node.id))
  // Layout 1 paths are derived from identities; a disagreement there is state that cannot be trusted.
  if (legacy && priorManifest && manifestLayoutVersion(priorManifest) === 1) {
    for (const note of priorManifest.notes) {
      const current = allocatedPath(note.repoId, note.nodeId)
      if (current !== null && current !== note.path) refuse('path-registry-divergence', 'the path registry and the prior manifest disagree about an allocated path')
    }
  }
  const assetPaths = legacy
    ? allocateLegacyAssetPaths(embeddedAssets.values())
    : new Map([...embeddedAssets.values()].map((asset) => [asset.id, readable.assetPathOf(asset.repo, asset.path)]))
  for (const assetPath of assetPaths.values()) assertContained(assetPath)
  const emittedTarget = (occurrence) => {
    if (occurrence.type === 'embeds_asset') {
      const attachment = assetPaths.get(occurrence.asset.id)
      return { key: { assetKey: attachment }, markdown: encodeVaultPath(attachment), wikilink: attachment, alias: false }
    }
    const target = noteLinkTarget(layout, pathOf(vaultNode(occurrence.target)))
    return { key: { edgeKey: occurrence.target }, markdown: target.markdown, wikilink: target.wikilink, alias: true }
  }

  const read = sourceReader(snapshot)
  const orderedNodes = [...vault].map((id) => nodeById.get(id)).sort((left, right) => compare(left.repo, right.repo) || compare(left.id, right.id))
  // Edges indexed by endpoint once, so a note's rows cost its degree and not
  // the size of the view.
  const outgoingBy = new Map()
  const incomingBy = new Map()
  const outsideCountBy = new Map()
  for (const edge of vaultEdges) {
    if (!outgoingBy.has(edge.source)) outgoingBy.set(edge.source, [])
    outgoingBy.get(edge.source).push(edge)
    if (!incomingBy.has(edge.target)) incomingBy.set(edge.target, [])
    incomingBy.get(edge.target).push(edge)
  }
  for (const edge of outsideEdges) {
    // An outside edge has exactly one endpoint in the vault; the other endpoint's count is never read.
    outsideCountBy.set(edge.source, (outsideCountBy.get(edge.source) ?? 0) + 1)
    outsideCountBy.set(edge.target, (outsideCountBy.get(edge.target) ?? 0) + 1)
  }
  const files = []
  const notes = []
  const attachments = []
  const inversionsByEdge = new Map()
  let fenceClosed = false
  const reusable = isPreparationCache(cache) ? cache.notes : null
  const nextCache = reusable ? new Map() : null
  const preparation = { emitted: 0, reused: 0 }
  const reusedPaths = new Set()
  const authorKeyNotes = []
  const titles = titleRenderings()

  for (const node of orderedNodes) {
    const notePathValue = pathOf(node)
    const attachmentPathValue = node.extension === 'md' ? null : attachmentOf(node)
    const pinned = read.pinned(node.repo, node.path)
    const outgoing = (outgoingBy.get(node.id) ?? []).slice().sort((left, right) => compare(left.target, right.target))
    const incoming = (incomingBy.get(node.id) ?? []).slice().sort((left, right) => compare(left.source, right.source))
    const rows = relationRows({ layout, node, outgoing, incoming, vaultNode, pathOf, titles })
    const outsideCount = outsideCountBy.get(node.id) ?? 0
    const occurrences = occurrencesBySource.get(node.id) ?? []
    const key = reusable ? dependencyKey({ layout, node, notePathValue, attachmentPathValue, pinned, rows, outsideCount, occurrences, emittedTarget }) : null
    const cached = reusable?.get(notePathValue)
    let entry
    if (cached && cached.key === key) {
      entry = cached
      preparation.reused += 1
      reusedPaths.add(notePathValue)
    } else {
      entry = emitNote({ layout, node, notePathValue, attachmentPathValue, source: read(node.repo, node.path), rows, outsideCount, occurrences, emittedTarget, key })
      preparation.emitted += 1
    }
    if (entry.authorIdentityKeys) authorKeyNotes.push({ code: 'author-identity-properties', repoId: node.repo, nodeId: node.id, notePath: notePathValue })
    if (nextCache) nextCache.set(notePathValue, entry)
    // The result never aliases the cache: a caller may change what it was handed, bytes included.
    for (const file of entry.files) files.push({ ...file, bytes: Buffer.from(file.bytes) })
    if (entry.attachment) attachments.push(structuredClone(entry.attachment))
    notes.push(structuredClone(entry.note))
    for (const [edgeKey, inversions] of entry.edgeInversions) {
      const inversionKey = `${node.id}\u0000${edgeKey}`
      if (!inversionsByEdge.has(inversionKey)) inversionsByEdge.set(inversionKey, [])
      inversionsByEdge.get(inversionKey).push(...structuredClone(inversions))
    }
    if (entry.fenceClosed) fenceClosed = true
  }

  // One copy per asset, however many notes embed it, read through the pinned
  // snapshot like every other source.
  for (const asset of embeddedAssets.values()) {
    const attachmentPath = assetPaths.get(asset.id)
    const { bytes, rawDigest } = read(asset.repo, asset.path)
    attachments.push({ path: attachmentPath, digest: rawDigest, byteLength: bytes.length, ext: { [EXT_KEY]: { kind: 'embedded-asset', repoId: asset.repo, assetPath: asset.path } } })
    files.push({ path: attachmentPath, kind: 'attachment', bytes, digest: rawDigest })
  }

  const links = vaultEdges
    .map((edge) => {
      const inversions = edge.type === DERIVED_RELATION_TYPE ? inversionsByEdge.get(`${edge.source}\u0000${edge.target}`) ?? [] : []
      return {
        edgeId: edgeIdentifier(edge),
        sourceNodeId: edge.source,
        targetNodeId: edge.target,
        type: edge.type,
        origin: edge.type === DERIVED_RELATION_TYPE ? 'markdown' : 'declared',
        targetState: 'in-scope',
        ...(inversions.length > 0 ? { inversions } : {}),
      }
    })
    .sort((left, right) => compare(left.edgeId, right.edgeId))

  const settings = prepareSettings({ existing: existingSettings })
  files.push(...settings.files)
  const occupied = new Set()
  for (const file of files) {
    if (occupied.has(collisionKey(file.path))) refuse('path-collision', 'two prepared files would occupy one path')
    occupied.add(collisionKey(file.path))
    assertContained(file.path)
    if (isUserOwnedSettingsPath(file.path)) refuse('user-owned-settings', 'a prepared view may not carry a settings file the person owns')
  }
  files.sort((left, right) => compare(left.path, right.path))
  attachments.sort((left, right) => compare(left.path, right.path))

  const contentDigest = createHash('sha256')
  for (const file of files) contentDigest.update(`${file.path}\u0000${file.digest}\n`)
  const manifest = {
    schema: layout.manifestSchema,
    contractVersion: layout.contractVersion,
    ...(layout.version === 1 ? {} : { layoutVersion: layout.version }),
    generationId: generationId ?? `gen-${contentDigest.digest('hex').slice(0, 32)}`,
    scopeId: scope.scopeId,
    snapshotId: snapshot.document.snapshotId,
    notes,
    links,
    attachments,
    completeness: { status: 'complete', expectedNotes: orderedNodes.length, writtenNotes: notes.length },
    freshness: { status: 'current', checkedAt },
    ext: { [EXT_KEY]: { emitterVersion: layout.emitterVersion, mode: selection.mode, settings: settings.ownership } },
  }
  assertObsidianContract('generation-manifest', manifest)
  // What was laid out anyway and should be known, naming the note: a layout 2 generation records it.
  const noteDiagnostics = legacy ? [] : [...readable.diagnostics, ...authorKeyNotes]

  // The redaction guard, over the whole result. Its deny-list holds the
  // identifiers of every census node and asset outside this view, and follows
  // the audience. Of one the audience may not see (withheld), an unambiguous
  // identifier refuses the view (an identity qualified by any repository of
  // the census, a repository-qualified path, a repository-relative path with a
  // folder, a vault path) and an ambiguous one is reported (a bare-word
  // identity, a file name at a repository's root, such as README.md). Of one
  // the audience may see but this view does not select, every identifier is
  // reported. An identifier this view's own notes share names nothing outside
  // it.
  const viewAttachments = new Set(attachments.map((item) => item.path))
  const visible = new Set(universe.nodes)
  const censusRepositories = new Set([...canonical.nodes, ...censusAssets].filter(usable).map((item) => item.repo))
  const qualified = (id) => id.indexOf(':') > 0 && censusRepositories.has(id.slice(0, id.indexOf(':')))
  const refused = []
  const reported = []
  const unselected = []
  const identifierOf = (item, withheld) => {
    const id = String(item.id)
    for (const [value, unambiguous] of [[id, qualified(id)], [`${item.repo}/${item.path}`, true], [item.path, item.path.includes('/')]]) {
      ;(!withheld ? unselected : unambiguous ? refused : reported).push(value)
    }
  }
  for (const item of canonical.nodes) {
    if (!usable(item) || vault.has(item.id) || typeof item.path !== 'string') continue
    const withheld = !visible.has(item.id)
    identifierOf(item, withheld)
    const allocated = legacy ? legacy.pathOf(item.repo, item.id) : null
    if (allocated !== null) (withheld ? refused : unselected).push(allocated)
  }
  for (const item of censusAssets) if (usable(item) && typeof item.path === 'string' && !embeddedAssets.has(item.id)) identifierOf(item, !assets.has(item.id))
  // Vault paths of notes and files outside this view, what other views hold for them and what this view held
  // before: refused for what the audience may not see, reported otherwise (a note gone from the census included).
  const inView = (repoId, nodeId) => vault.has(nodeId) && nodeById.get(nodeId)?.repo === repoId
  const withheldNode = (repoId, nodeId) => nodeById.get(nodeId)?.repo === repoId && !visible.has(nodeId)
  const copied = new Set([...embeddedAssets.values()].map((asset) => `${asset.repo}\u0000${asset.path}`))
  const withheldAssets = new Set(censusAssets.filter((item) => usable(item) && typeof item.path === 'string' && !assets.has(item.id)).map((item) => `${item.repo}\u0000${item.path}`))
  for (const section of Object.values(views)) {
    for (const entry of section.entries) {
      if (!inView(entry?.repoId, entry?.nodeId)) (withheldNode(entry?.repoId, entry?.nodeId) ? refused : unselected).push(entry?.path, ...(entry?.attachment ? [entry.attachment] : []))
    }
    for (const entry of section.assets) {
      const key = `${entry?.repoId}\u0000${entry?.assetPath}`
      if (!copied.has(key)) (withheldAssets.has(key) ? refused : unselected).push(entry?.path)
    }
  }
  for (const note of priorManifest?.notes ?? []) if (!inView(note.repoId, note.nodeId)) (withheldNode(note.repoId, note.nodeId) ? refused : unselected).push(note.path)
  const own = new Set()
  for (const node of orderedNodes) for (const value of [node.id, `${node.repo}/${node.path}`, node.path, pathOf(node), attachmentOf(node)]) if (typeof value === 'string') own.add(value.normalize('NFC'))
  for (const asset of embeddedAssets.values()) for (const value of [asset.id, `${asset.repo}/${asset.path}`, asset.path, assetPaths.get(asset.id)]) if (typeof value === 'string') own.add(value.normalize('NFC'))
  const outside = (values) => values.filter((value) => typeof value === 'string' && value !== '' && !own.has(value.normalize('NFC')))
  const linkTargets = new Set()
  for (const node of orderedNodes) {
    const target = noteLinkTarget(layout, pathOf(node))
    linkTargets.add(target.markdown).add(target.wikilink)
  }
  for (const attachmentPath of viewAttachments) linkTargets.add(attachmentPath).add(encodeVaultPath(attachmentPath))
  const allocatedInView = new Map(orderedNodes.map((node) => [node.id, pathOf(node)]))
  const wrapperAttachments = new Set(orderedNodes.filter((node) => node.extension !== 'md').map((node) => (legacy ? `attachments/${legacyBasename(pathOf(node))}.${/^[a-z0-9]{1,16}$/.test(String(node.extension).toLowerCase()) ? String(node.extension).toLowerCase() : 'bin'}` : attachmentOf(node))))
  const allowedAttachments = new Set([...wrapperAttachments, ...assetPaths.values()])
  const guardReported = assertViewRedaction({
    manifest,
    files,
    reused: reusedPaths,
    nodeOf: (nodeId) => nodeById.get(nodeId),
    ownOf: (nodeId) => wrapperLines(nodeById.get(nodeId)),
    view: { allocatedPathOf: (nodeId) => allocatedInView.get(nodeId) ?? null, attachments: allowedAttachments, linkTargets },
    deny: createDenyMatcher({ refuse: outside(refused), diagnose: outside(reported), notice: outside(unselected) }),
    layoutVersion: layout.version,
  }, guard)
  if (!legacy) noteDiagnostics.push(...guardReported)
  if (legacy) {
    const vaultSuffixes = new Set([...orderedNodes, ...embeddedAssets.values()].map((item) => identitySuffix(item.repo, item.id, 64)))
    assertOnlyVaultIdentities({
      manifest,
      files,
      vaultSuffixes,
      // Every census identity that is not part of this view: withheld, out of
      // the selection, or an asset this view does not copy.
      forbiddenSuffixes: new Set([
        // A record without a usable identity is not in any view and has no
        // suffix to forbid; it must not abort the view either.
        ...[...canonical.nodes, ...censusAssets].filter(usable).map((item) => identitySuffix(item.repo, item.id, 64)),
      ].filter((suffix) => !vaultSuffixes.has(suffix))),
    })
  }

  const prior = new Map((priorManifest?.notes ?? []).map((note) => [note.path, note.noteDigest]))
  const changes = { added: [], changed: [], unchanged: [], removed: [] }
  for (const note of notes) changes[!prior.has(note.path) ? 'added' : prior.get(note.path) === note.noteDigest ? 'unchanged' : 'changed'].push(note.path)
  const present = new Set(notes.map((note) => note.path))
  // Removal is reported, never performed: an editable note leaves a vault only
  // under the publication protocol.
  changes.removed = [...prior.keys()].filter((notePathValue) => !present.has(notePathValue)).sort(compare)

  // The cache is replaced only by a preparation that passed every check, and
  // holds exactly the notes of this view.
  if (nextCache) cache.notes = nextCache
  if (noteDiagnostics.length > 0) manifest.ext[EXT_KEY].diagnostics = noteDiagnostics

  return {
    manifest,
    manifestBytes: utf8(`${JSON.stringify(manifest, null, 2)}\n`),
    files,
    persistentPathRegistry: withViewSection(persistentPathRegistry, { workspaceId: profile.workspaceId, scopeId: scope.scopeId, section: readable.section, keep: viewScopeIds }),
    changes,
    // How many notes were emitted on this call and how many were reused from the cache; without a cache every note is emitted.
    preparation,
    diagnostics: [
      ...selection.diagnostics,
      ...(canonical.externalEdgeCount > 0 ? ['relations-to-identities-outside-the-census-are-not-emitted'] : []),
      ...(fenceClosed ? ['unclosed-code-fence-closed-in-generated-region'] : []),
    ],
  }
}

// Adds the fail-closed eligibility flag selectScope reads. A node is eligible
// only when `isEligible` returns exactly true for it. Embedded assets follow
// the same rule through `isAssetEligible`; without it every asset is withheld.
export function withEligibility(graph, isEligible, isAssetEligible = null) {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, eligible: isEligible(node) === true })),
    ...(Array.isArray(graph.assets)
      ? { assets: graph.assets.map((asset) => ({ ...asset, eligible: typeof isAssetEligible === 'function' && isAssetEligible(asset) === true })) }
      : {}),
  }
}
