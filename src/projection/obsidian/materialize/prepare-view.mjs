import { createHash } from 'node:crypto'
import { unclosedFenceAtEnd } from '../../../graph/knowledge-graph.mjs'
import { DERIVED_RELATION_TYPE, RELATION_TYPES, SCOPE_PRIMITIVES, assertObsidianContract, identitySuffix, readableTitle, selectScope } from '../contracts.mjs'
import { assertStrictUtf8, readMarkdownLens, refuse, sha256Digest } from './byte-lens.mjs'
import { allocateWorkspacePaths, collisionKey, emptyPathRegistry, titleWithinBudget } from './path-registry.mjs'
import { isUserOwnedSettingsPath, prepareSettings } from './settings.mjs'

// prepareView: a pure preparation of one Obsidian view. It reads sources
// through the caller, returns note, attachment and settings bytes plus a
// generation manifest, and writes nothing. The canonical graph is the only
// graph authority: notes and relation rows serialize canonical nodes and
// edges, and only canonical resolved link and embed occurrences are rewritten.
// An embedded asset is copied only when the canonical graph resolved it; the
// emitter never infers one from authored bytes.
//
// Redaction happens where bytes are made. Every title, path and identity that
// reaches an output is looked up through `vault`, the set selectScope returned
// for this view, so a node outside it cannot be serialized by any branch.
//
// Preparation is incremental when the caller passes a preparation cache (see
// createPreparationCache). Every note's bytes and manifest entry are a pure
// function of a small set of inputs: the pinned source digest, the node
// record, the allocated path, the generated rows, the outside-selection count
// and the rewritten occurrences with their emitted targets. Those inputs are
// serialized into a dependency key per note; a note whose key matches the
// cached one reuses the cached bytes and manifest entry instead of being
// emitted again, so the result is byte-identical to a full preparation by
// construction. The cache holds derived state only and can be dropped at any
// time; the redaction guard still runs over the whole result.

export const EMITTER_VERSION = '1.0.0'
const EXT_KEY = 'mnstry.atelier.obsidian'
const EMBEDDABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
// Bytes left for an asset's readable stem beside the longest suffix and extension.
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

const noteBasename = (notePathValue) => notePathValue.slice('notes/'.length, -'.md'.length)

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
// key. The emitter version is part of the key so a cache never survives a
// change of the emitter within one process.
function dependencyKey({ node, notePathValue, pinned, rows, outsideCount, occurrences, emittedTarget }) {
  // A wrapper note serializes the record's summary and tags; a Markdown note never does.
  const wrapper = node.extension === 'md' ? null : JSON.stringify([String(node.summary ?? ''), Array.isArray(node.tags) ? node.tags : null])
  const parts = [
    EMITTER_VERSION, notePathValue, node.repo, node.id, node.path, String(node.extension), String(node.title ?? ''), String(wrapper),
    pinned.rawDigest, String(pinned.byteLength), String(outsideCount), rows.join(''),
  ]
  for (const occurrence of occurrences) {
    const target = emittedTarget(occurrence)
    parts.push(JSON.stringify([
      occurrence.type ?? null, occurrence.syntax ?? null, occurrence.embed === true, occurrence.href ?? null, occurrence.target ?? null,
      occurrence.range?.byteStart ?? null, occurrence.range?.byteEnd ?? null, occurrence.targetRange?.byteStart ?? null, occurrence.targetRange?.byteEnd ?? null,
      target.key, target.markdown, target.wikilink, target.alias,
    ]))
  }
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
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

function relationRows({ node, outgoing, incoming, vaultNode, pathOf, titles }) {
  const rows = []
  for (const type of RELATION_TYPES) {
    for (const edge of outgoing) {
      if (edge.type !== type) continue
      const target = vaultNode(edge.target)
      if (!target) continue
      rows.push(`- ${type} → [[${noteBasename(pathOf(target))}|${titles.readableOf(target)}]]\n`)
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

function generatedSections({ precedingBytes, offset, rows, outsideCount, closure = null }) {
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
  return { bytes: Buffer.concat(parts), regions }
}

function wrapperRepresentation({ node, attachmentPath }) {
  const lines = [`# ${plainText(node.title)}\n`]
  if (node.summary) lines.push(`\n${plainText(node.summary)}\n`)
  lines.push(`\n- Format: ${plainText(node.extension)}\n`)
  lines.push(`- Source: ${plainText(node.repo)} · ${node.path.split('/').map(plainText).join(' / ')}\n`)
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
function emitNote({ node, notePathValue, source: { bytes: source, rawDigest }, rows, outsideCount, occurrences, emittedTarget, key }) {
  const sourceRecord = { path: node.path, rawDigest, byteLength: source.length }
  const assetInversions = new Map()
  const edgeInversions = new Map()
  const files = []
  let attachment = null
  let authored
  let regions
  let closure = null

  if (node.extension === 'md') {
    const lens = readMarkdownLens(source, { repoId: node.repo, nodeId: node.id })
    const edits = linkEdits({ source, lens, occurrences, emittedTarget })
    const prefix = source.subarray(0, lens.body.start)
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
      ...(lens.frontmatter ? { frontmatter: lens.frontmatter } : {}),
      body: { start: lens.body.start, end: authored.length },
    }
    closure = fenceClosureFor(source, lens.finalNewline)
    Object.assign(sourceRecord, { kind: 'markdown', finalNewline: lens.finalNewline, ...(lens.bom ? { bom: lens.bom } : {}) })
  } else {
    const extension = /^[a-z0-9]{1,16}$/.test(String(node.extension).toLowerCase()) ? String(node.extension).toLowerCase() : 'bin'
    const attachmentPath = `attachments/${noteBasename(notePathValue)}.${extension}`
    assertContained(attachmentPath)
    attachment = { path: attachmentPath, digest: rawDigest, byteLength: source.length }
    files.push({ path: attachmentPath, kind: 'attachment', bytes: source, digest: rawDigest })
    authored = wrapperRepresentation({ node, attachmentPath })
    regions = { body: { start: authored.length, end: authored.length }, representation: { start: 0, end: authored.length } }
    Object.assign(sourceRecord, { kind: 'wrapper', attachment: attachmentPath })
  }

  const generated = generatedSections({ precedingBytes: authored, offset: authored.length, rows, outsideCount, closure })
  const bytes = Buffer.concat([authored, generated.bytes])
  assertStrictUtf8(bytes)
  assertContained(notePathValue)
  const { representation, ...authoredRegions } = regions
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
          ? { assetEmbeds: [...assetInversions].map(([attachment, inversions]) => ({ attachment, inversions })).sort((left, right) => compare(left.attachment, right.attachment)) }
          : {}),
      },
    },
  }
  return { key, files, attachment, note, edgeInversions: [...edgeInversions], fenceClosed: Boolean(closure && generated.regions.length > 0) }
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

// attachments/<readable stem>--<identity suffix>.<ext>, from the repository and
// asset identity alone. The suffix lengthens only when two assets of this view
// would share a name on a case- or normalization-insensitive filesystem.
function allocateAssetPaths(assets) {
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

// A path the prior generation published stays allocated even when the caller
// lost the registry: the prior manifest seeds any identity the registry lacks.
function seededRegistry({ registry, priorManifest, workspaceId }) {
  if (!priorManifest) return registry
  const base = registry ?? emptyPathRegistry(workspaceId)
  if (!Array.isArray(base.entries)) return base
  const known = new Set(base.entries.map((entry) => `${entry?.repoId}\u0000${entry?.nodeId}`))
  const recovered = priorManifest.notes.filter((note) => !known.has(`${note.repoId}\u0000${note.nodeId}`)).map(({ repoId, nodeId, path }) => ({ repoId, nodeId, path }))
  return { ...base, entries: [...base.entries, ...recovered] }
}

export function prepareView({ snapshot, profile, scope, persistentPathRegistry = null, priorManifest = null, existingSettings = null, clock, generationId, vaultRootBytes, maxFullPathBytes, cache = null } = {}) {
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
  const checkedAt = timestampFrom(clock)
  const canonical = canonicalSnapshotOf(snapshot.graph)

  // Selection and visibility come from the contract, never from this module.
  const universe = selectScope({ canonicalSnapshot: canonical, profile, selector: { all: true }, mode: 'scoped' })
  const selection = selectScope({ canonicalSnapshot: canonical, profile, selector: scope.selector, expansion: scope.expansion, mode: scope.mode })
  const nodeById = new Map(canonical.nodes.map((node) => [node.id, node]))
  const vault = new Set(selection.vaultNodes)
  const vaultNode = (id) => (vault.has(id) ? nodeById.get(id) : null)

  const { registry, pathOf: allocatedPath } = allocateWorkspacePaths({
    registry: seededRegistry({ registry: persistentPathRegistry, priorManifest, workspaceId: profile.workspaceId }),
    workspaceId: profile.workspaceId,
    nodes: universe.nodes.map((id) => nodeById.get(id)),
    ...(vaultRootBytes === undefined ? {} : { vaultRootBytes }),
    ...(maxFullPathBytes === undefined ? {} : { maxFullPathBytes }),
  })
  const pathOf = (node) => allocatedPath(node.repo, node.id)
  for (const note of priorManifest?.notes ?? []) {
    const current = allocatedPath(note.repoId, note.nodeId)
    if (current !== null && current !== note.path) refuse('path-registry-divergence', 'the path registry and the prior manifest disagree about an allocated path')
  }

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
  const assets = visibleAssets(snapshot.graph, profile)
  const embeddedAssets = new Map()
  for (const embed of Array.isArray(snapshot.graph.embeds) ? snapshot.graph.embeds : []) {
    const asset = assets.get(embed?.asset?.id)
    if (!asset || !vault.has(embed.source) || nodeById.get(embed.source).extension !== 'md') continue
    embeddedAssets.set(asset.id, asset)
    if (!occurrencesBySource.has(embed.source)) occurrencesBySource.set(embed.source, [])
    occurrencesBySource.get(embed.source).push(embed)
  }
  const assetPaths = allocateAssetPaths(embeddedAssets.values())
  const emittedTarget = (occurrence) => {
    if (occurrence.type === 'embeds_asset') {
      const attachment = assetPaths.get(occurrence.asset.id)
      return { key: { assetKey: attachment }, markdown: attachment.split('/').map(encodeHref).join('/'), wikilink: attachment, alias: false }
    }
    const stem = noteBasename(pathOf(vaultNode(occurrence.target)))
    return { key: { edgeKey: occurrence.target }, markdown: encodeHref(`${stem}.md`), wikilink: stem, alias: true }
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
  const titles = titleRenderings()

  for (const node of orderedNodes) {
    const notePathValue = pathOf(node)
    const pinned = read.pinned(node.repo, node.path)
    const outgoing = (outgoingBy.get(node.id) ?? []).slice().sort((left, right) => compare(left.target, right.target))
    const incoming = (incomingBy.get(node.id) ?? []).slice().sort((left, right) => compare(left.source, right.source))
    const rows = relationRows({ node, outgoing, incoming, vaultNode, pathOf, titles })
    const outsideCount = outsideCountBy.get(node.id) ?? 0
    const occurrences = occurrencesBySource.get(node.id) ?? []
    const key = reusable ? dependencyKey({ node, notePathValue, pinned, rows, outsideCount, occurrences, emittedTarget }) : null
    const cached = reusable?.get(notePathValue)
    let entry
    if (cached && cached.key === key) {
      entry = cached
      preparation.reused += 1
    } else {
      entry = emitNote({ node, notePathValue, source: read(node.repo, node.path), rows, outsideCount, occurrences, emittedTarget, key })
      preparation.emitted += 1
    }
    if (nextCache) nextCache.set(notePathValue, entry)
    // The result never aliases the cache: a caller may change what it was handed.
    for (const file of entry.files) files.push({ ...file })
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
    schema: 'atelier-obsidian-generation-manifest/v1',
    contractVersion: '1.0.0',
    generationId: generationId ?? `gen-${contentDigest.digest('hex').slice(0, 32)}`,
    scopeId: scope.scopeId,
    snapshotId: snapshot.document.snapshotId,
    notes,
    links,
    attachments,
    completeness: { status: 'complete', expectedNotes: orderedNodes.length, writtenNotes: notes.length },
    freshness: { status: 'current', checkedAt },
    ext: { [EXT_KEY]: { emitterVersion: EMITTER_VERSION, mode: selection.mode, settings: settings.ownership } },
  }
  assertObsidianContract('generation-manifest', manifest)
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
      ...[...canonical.nodes, ...(Array.isArray(snapshot.graph.assets) ? snapshot.graph.assets : [])]
        .filter((item) => item && typeof item.repo === 'string' && item.repo !== '' && typeof item.id === 'string' && item.id !== '')
        .map((item) => identitySuffix(item.repo, item.id, 64)),
    ].filter((suffix) => !vaultSuffixes.has(suffix))),
  })

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

  return {
    manifest,
    manifestBytes: utf8(`${JSON.stringify(manifest, null, 2)}\n`),
    files,
    persistentPathRegistry: registry,
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

// Last check before anything is returned. Two rules, because the two kinds of
// bytes differ: a substring the emitter itself produced from an allocated path
// (note and attachment paths, rewritten link targets) may name only a note or
// asset of this view; free text in a generated region (titles, tags, source
// paths, which are the author's words) is refused only when it names an
// identity of the census that is outside this view. Author text that merely
// looks like an identity suffix, such as a content-hashed asset name, is not
// a redaction failure.
function assertOnlyVaultIdentities({ manifest, files, vaultSuffixes, forbiddenSuffixes }) {
  const index = (suffixes) => {
    const byPrefix = new Map()
    for (const full of suffixes) byPrefix.set(full.slice(0, 12), [...(byPrefix.get(full.slice(0, 12)) ?? []), full])
    return (suffix) => (byPrefix.get(suffix.slice(0, 12)) ?? []).some((full) => full.startsWith(suffix))
  }
  const allowed = index(vaultSuffixes)
  const forbidden = index(forbiddenSuffixes)
  const suffixesIn = (text) => [...text.matchAll(/--([0-9a-f]{12,64})(?![0-9a-f])/g)].map((match) => match[1])
  // An emitted path ends in the allocated suffix (before the extension); the
  // readable part before it is the author's title and may look like anything.
  // A wikilink rewrite may append `|<the author's own words>`; only the part
  // before the first `|` is an emitted path.
  const checkEmitted = (text) => {
    for (const segment of text.split('|')[0].split('#')[0].split('/')) {
      const trailing = /--([0-9a-f]{12,64})(?:\.[^./]+)?$/.exec(segment)
      if (trailing && !allowed(trailing[1])) refuse('redaction-failure', 'an emitted path names a note that is not part of this view')
    }
    for (const suffix of suffixesIn(text)) if (forbidden(suffix)) refuse('redaction-failure', 'an emitted path names a note that is not part of this view')
  }
  const checkText = (text) => {
    for (const suffix of suffixesIn(text)) if (forbidden(suffix)) refuse('redaction-failure', 'generated output names a note that is not part of this view')
  }
  const byPath = new Map(files.map((file) => [file.path, file.bytes]))
  for (const note of manifest.notes) {
    const bytes = byPath.get(note.path)
    for (const region of note.regions.generated) checkText(bytes.subarray(region.range.start, region.range.end).toString('utf8'))
  }
  for (const link of manifest.links) {
    for (const inversion of link.inversions ?? []) checkEmitted(Buffer.from(inversion.ext[EXT_KEY].emitted, 'base64url').toString('utf8'))
  }
  for (const note of manifest.notes) {
    for (const embed of note.ext[EXT_KEY].assetEmbeds ?? []) {
      checkEmitted(embed.attachment)
      for (const inversion of embed.inversions) checkEmitted(Buffer.from(inversion.ext[EXT_KEY].emitted, 'base64url').toString('utf8'))
    }
  }
  for (const note of manifest.notes) checkEmitted(note.path)
  for (const attachment of manifest.attachments) checkEmitted(attachment.path)
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
