import { createHash } from 'node:crypto'
import { DERIVED_RELATION_TYPE, RELATION_TYPES, assertObsidianContract, identitySuffix, readableTitle, selectScope } from '../contracts.mjs'
import { assertStrictUtf8, readMarkdownLens, refuse, sha256Digest } from './byte-lens.mjs'
import { allocateWorkspacePaths, emptyPathRegistry } from './path-registry.mjs'
import { isUserOwnedSettingsPath, prepareSettings } from './settings.mjs'

// prepareView: a pure preparation of one Obsidian view. It reads sources
// through the caller, returns note, attachment and settings bytes plus a
// generation manifest, and writes nothing. The canonical graph is the only
// graph authority: notes and relation rows serialize canonical nodes and
// edges, and only canonical resolved link occurrences are rewritten.
//
// Redaction happens where bytes are made. Every title, path and identity that
// reaches an output is looked up through `vault`, the set selectScope returned
// for this view, so a node outside it cannot be serialized by any branch.

export const EMITTER_VERSION = '1.0.0'
const EXT_KEY = 'mnstry.atelier.obsidian'
const EMBEDDABLE = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'])
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
  return (repoId, relativePath) => {
    const pinned = expected.get(`${repoId}\u0000${relativePath}`)
    if (!pinned) refuse('source-not-in-snapshot', 'a selected source is not pinned by the source snapshot')
    const bytes = snapshot.readSource(repoId, relativePath)
    if (!Buffer.isBuffer(bytes)) refuse('invalid-source', 'readSource must return a Buffer')
    if (bytes.length !== pinned.byteLength || sha256Digest(bytes) !== pinned.rawDigest) {
      refuse('mixed-read', 'source bytes differ from the digest pinned by the source snapshot')
    }
    return { bytes, rawDigest: pinned.rawDigest }
  }
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

// The byte edits for one source: each is { start, end, emitted } over the
// source Buffer. Offsets come from the canonical occurrence; the bytes under
// them are compared with what the graph read, so a graph built from different
// bytes refuses instead of rewriting the wrong place.
function linkEdits({ source, lens, occurrences, targetPath }) {
  const edits = []
  for (const occurrence of occurrences) {
    const { range, targetRange } = occurrence
    const offsets = [range?.byteStart, targetRange?.byteStart, targetRange?.byteEnd, range?.byteEnd]
    if (offsets.some((offset) => !Number.isInteger(offset)) || offsets.some((offset, index) => index > 0 && offset < offsets[index - 1])) {
      refuse('link-offsets-unavailable', 'a canonical link occurrence carries no usable byte offsets')
    }
    if (range.byteStart < lens.body.start || range.byteEnd > lens.body.end) refuse('link-outside-body', 'a canonical link occurrence lies outside the authored body')
    const written = source.subarray(targetRange.byteStart, targetRange.byteEnd).toString('utf8')
    const allocated = targetPath(occurrence.target)
    if (occurrence.syntax === 'markdown') {
      if (written !== occurrence.href) refuse('mixed-read', 'source bytes under a canonical link differ from the link the graph read')
      edits.push({ edgeKey: occurrence.target, start: targetRange.byteStart, end: targetRange.byteEnd, emitted: utf8(encodeHref(`${noteBasename(allocated)}.md`)) })
    } else if (occurrence.syntax === 'wikilink') {
      const whole = source.subarray(range.byteStart, range.byteEnd).toString('utf8')
      if (written.trim() !== occurrence.href || !whole.startsWith('[[') || !whole.endsWith(']]')) {
        refuse('mixed-read', 'source bytes under a canonical link differ from the link the graph read')
      }
      edits.push({ edgeKey: occurrence.target, start: targetRange.byteStart, end: targetRange.byteEnd, emitted: utf8(noteBasename(allocated)) })
      // Keep the words the author chose visible: without an alias the editor
      // would display the allocated file name.
      const tail = source.subarray(targetRange.byteEnd, range.byteEnd - 2).toString('utf8')
      if (!occurrence.embed && !tail.includes('|')) {
        edits.push({ edgeKey: occurrence.target, start: range.byteEnd - 2, end: range.byteEnd - 2, emitted: utf8(`|${occurrence.href}`) })
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

function relationRows({ node, outgoing, incoming, vaultNode, pathOf }) {
  const rows = []
  for (const type of RELATION_TYPES) {
    for (const edge of outgoing.filter((item) => item.type === type)) {
      const target = vaultNode(edge.target)
      if (!target) continue
      rows.push(`- ${type} → [[${noteBasename(pathOf(target))}|${readableTitle(target.title)}]]\n`)
    }
    // An incoming row is plain text: a link here would give this note an
    // outgoing native link that the canonical graph does not hold.
    if (type === DERIVED_RELATION_TYPE) continue
    for (const edge of incoming.filter((item) => item.type === type)) {
      const origin = vaultNode(edge.source)
      if (!origin || origin.id === node.id) continue
      rows.push(`- ${type} ← ${plainText(origin.title)}\n`)
    }
  }
  return rows
}

function generatedSections({ precedingBytes, offset, rows, outsideCount }) {
  const regions = []
  const parts = []
  let cursor = offset
  const push = (kind, text) => {
    const bytes = utf8(text)
    parts.push(bytes)
    regions.push({ kind, range: { start: cursor, end: cursor + bytes.length } })
    cursor += bytes.length
  }
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

export function prepareView({ snapshot, profile, scope, persistentPathRegistry = null, priorManifest = null, existingSettings = null, clock, generationId, vaultRootBytes, maxFullPathBytes } = {}) {
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

  const read = sourceReader(snapshot)
  const orderedNodes = [...vault].map((id) => nodeById.get(id)).sort((left, right) => compare(left.repo, right.repo) || compare(left.id, right.id))
  const files = []
  const notes = []
  const attachments = []
  const inversionsByEdge = new Map()

  for (const node of orderedNodes) {
    const notePathValue = pathOf(node)
    const { bytes: source, rawDigest } = read(node.repo, node.path)
    const outgoing = vaultEdges.filter((edge) => edge.source === node.id).sort((left, right) => compare(left.target, right.target))
    const incoming = vaultEdges.filter((edge) => edge.target === node.id).sort((left, right) => compare(left.source, right.source))
    const rows = relationRows({ node, outgoing, incoming, vaultNode, pathOf })
    const outsideCount = outsideEdges.filter((edge) => edge.source === node.id || edge.target === node.id).length
    const sourceRecord = { path: node.path, rawDigest, byteLength: source.length }
    let authored
    let regions

    if (node.extension === 'md') {
      const lens = readMarkdownLens(source, { repoId: node.repo, nodeId: node.id })
      const edits = linkEdits({ source, lens, occurrences: occurrencesBySource.get(node.id) ?? [], targetPath: (id) => pathOf(vaultNode(id)) })
      const prefix = source.subarray(0, lens.body.start)
      const body = applyEdits({ source, from: lens.body.start, to: lens.body.end, edits, noteOffset: prefix.length })
      authored = Buffer.concat([prefix, body.bytes])
      for (const { edgeKey, ...inversion } of body.inversions) {
        const key = `${node.id}\u0000${edgeKey}`
        if (!inversionsByEdge.has(key)) inversionsByEdge.set(key, [])
        inversionsByEdge.get(key).push(inversion)
      }
      regions = {
        ...(lens.frontmatter ? { frontmatter: lens.frontmatter } : {}),
        body: { start: lens.body.start, end: authored.length },
      }
      Object.assign(sourceRecord, { kind: 'markdown', finalNewline: lens.finalNewline, ...(lens.bom ? { bom: lens.bom } : {}) })
    } else {
      const extension = /^[a-z0-9]{1,16}$/.test(String(node.extension).toLowerCase()) ? String(node.extension).toLowerCase() : 'bin'
      const attachmentPath = `attachments/${noteBasename(notePathValue)}.${extension}`
      assertContained(attachmentPath)
      attachments.push({ path: attachmentPath, digest: rawDigest, byteLength: source.length })
      files.push({ path: attachmentPath, kind: 'attachment', bytes: source, digest: rawDigest })
      authored = wrapperRepresentation({ node, attachmentPath })
      regions = { body: { start: authored.length, end: authored.length }, representation: { start: 0, end: authored.length } }
      Object.assign(sourceRecord, { kind: 'wrapper', attachment: attachmentPath })
    }

    const generated = generatedSections({ precedingBytes: authored, offset: authored.length, rows, outsideCount })
    const bytes = Buffer.concat([authored, generated.bytes])
    assertStrictUtf8(bytes)
    assertContained(notePathValue)
    const { representation, ...authoredRegions } = regions
    files.push({ path: notePathValue, kind: 'note', bytes, digest: sha256Digest(bytes) })
    notes.push({
      repoId: node.repo,
      nodeId: node.id,
      path: notePathValue,
      title: String(node.title || 'Untitled').slice(0, 512),
      noteDigest: sha256Digest(bytes),
      regions: {
        ...authoredRegions,
        generated: [...(representation ? [{ kind: 'representation', range: representation }] : []), ...generated.regions],
      },
      ext: { [EXT_KEY]: { source: sourceRecord } },
    })
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
  for (const file of files) {
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
  assertOnlyVaultIdentities({ manifest, files, vaultSuffixes: new Set(orderedNodes.map((node) => identitySuffix(node.repo, node.id, 64))) })

  const prior = new Map((priorManifest?.notes ?? []).map((note) => [note.path, note.noteDigest]))
  const changes = { added: [], changed: [], unchanged: [], removed: [] }
  for (const note of notes) changes[!prior.has(note.path) ? 'added' : prior.get(note.path) === note.noteDigest ? 'unchanged' : 'changed'].push(note.path)
  const present = new Set(notes.map((note) => note.path))
  // Removal is reported, never performed: an editable note leaves a vault only
  // under the publication protocol.
  changes.removed = [...prior.keys()].filter((notePathValue) => !present.has(notePathValue)).sort(compare)

  return {
    manifest,
    manifestBytes: utf8(`${JSON.stringify(manifest, null, 2)}\n`),
    files,
    persistentPathRegistry: registry,
    changes,
    diagnostics: [
      ...selection.diagnostics,
      ...(canonical.externalEdgeCount > 0 ? ['relations-to-identities-outside-the-census-are-not-emitted'] : []),
    ],
  }
}

// Last check before anything is returned: every allocated-path suffix that
// appears in generated bytes or in the manifest belongs to a note of this
// view. Authored bytes are exempt; they are the author's and are never read
// for meaning here.
function assertOnlyVaultIdentities({ manifest, files, vaultSuffixes }) {
  const byPrefix = new Map()
  for (const full of vaultSuffixes) byPrefix.set(full.slice(0, 12), [...(byPrefix.get(full.slice(0, 12)) ?? []), full])
  const allowed = (suffix) => (byPrefix.get(suffix.slice(0, 12)) ?? []).some((full) => full.startsWith(suffix))
  const check = (text) => {
    for (const match of text.matchAll(/--([0-9a-f]{12,64})(?![0-9a-f])/g)) {
      if (!allowed(match[1])) refuse('redaction-failure', 'generated output names a note that is not part of this view')
    }
  }
  const byPath = new Map(files.map((file) => [file.path, file.bytes]))
  for (const note of manifest.notes) {
    const bytes = byPath.get(note.path)
    for (const region of note.regions.generated) check(bytes.subarray(region.range.start, region.range.end).toString('utf8'))
  }
  for (const link of manifest.links) {
    for (const inversion of link.inversions ?? []) check(Buffer.from(inversion.ext[EXT_KEY].emitted, 'base64url').toString('utf8'))
  }
  for (const note of manifest.notes) check(note.path)
  for (const attachment of manifest.attachments) check(attachment.path)
}

// Adds the fail-closed eligibility flag selectScope reads. A node is eligible
// only when `isEligible` returns exactly true for it.
export function withEligibility(graph, isEligible) {
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, eligible: isEligible(node) === true })) }
}
