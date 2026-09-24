import { identityLineTexts } from '../contracts.mjs'
import { refuse } from './byte-lens.mjs'

// The redaction guard: the last check before a prepared view is returned. It
// judges the assembled result, every note included, whether the note was
// emitted on this call or reused from the preparation cache, and refuses the
// view with `redaction-failure`, naming the in-view note (or file) and the
// rule, never the value. See "The redaction guard" in docs/obsidian-contract.md.
//
//   allow-list  every path the emitter wrote (note and attachment paths,
//               rewritten link and embed targets, link targets in generated
//               regions) is one allocated to this view, and each identity
//               block names exactly its own note
//   deny-list   the free text of the generated regions, read as a reader
//               sees it, names no unambiguous identifier of anything outside
//               this view (refused) and no bare word that is one (reported)
//   coverage    both run over every note of the view
//
// REDACTION_RULES are the rules production uses. The mutation controls in
// test/obsidian-materialization.test.mjs replace one at a time through
// createViewPreparationForOracleTests to prove each is load-bearing.

const EXT = 'mnstry.atelier.obsidian'
const RELATIONS_HEADING_LINE = '## Relations (generated)'
const RELATIONS_NOTE_LINE = '%% Generated from the canonical graph. Edits to this section are not applied to any source. %%'
const RELATION_OUT = /^- [a-z_]+ → \[\[([^[\]|]*)\|(.*)\]\]$/
const RELATION_IN = /^- [a-z_]+ ← (.*)$/
const OUTSIDE_COUNT = /^Relationships leading outside this view: [0-9]+$/
const ORIGINAL_LINK = /^- Original: \[\[([^[\]|]*)\|Open the original file\]\]$/
const EMBED_LINE = /^!\[\[([^[\]|]*)\]\]$/
// Every link a generated region holds: a wikilink or embed not escaped by a
// backslash, and a Markdown link target. Generated free text escapes `[`, `]`
// and `|`, so only links the emitter wrote remain.
const GENERATED_WIKILINK = /(?<!\\)!?\[\[([^[\]\n]*?)\]\]/g
const GENERATED_MARKDOWN_LINK = /(?<!\\)\]\(([^()\n]*)\)/g

const linesOf = (text) => text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

// Generated prose escapes Markdown punctuation with a backslash (see plainText
// in prepare-view.mjs). A reader sees the text without those backslashes, and
// the deny-list reads it the same way.
const ESCAPED = /\\([\\`*_[\]<>#|^$%~=!&])/g
const asRead = (text) => text.replace(ESCAPED, '$1')

// An identity or a path matches only as a whole token, never inside a longer
// one. A letter or digit beside the match, or one of `. _ : / -` joined to a
// letter or digit beside it, continues the token; sentence punctuation after
// it (a full stop, a colon before a space) does not.
const ALNUM = /^[\p{L}\p{N}]$/u
const JOINERS = new Set(['.', '_', ':', '/', '-'])

function codePointAt(text, index) {
  if (index < 0 || index >= text.length) return ''
  const code = text.codePointAt(index)
  // A low surrogate is the second half of the character before it.
  if (code >= 0xdc00 && code <= 0xdfff && index > 0) return String.fromCodePoint(text.codePointAt(index - 1))
  return String.fromCodePoint(code)
}
const isAlnumAt = (text, index) => ALNUM.test(codePointAt(text, index))
const continuesAfter = (text, end) => isAlnumAt(text, end) || (JOINERS.has(text[end]) && isAlnumAt(text, end + 1))
const continuesBefore = (text, start) => isAlnumAt(text, start - 1) || (JOINERS.has(text[start - 1]) && isAlnumAt(text, start - 2))

const REFUSE = 2
const DIAGNOSE = 1
const UNITS = 0x10000

// One Aho–Corasick automaton over every value, read in UTF-16 code units, with
// the token boundary tested at each hit: linear in the text, whatever the
// number of values. `refuse` values refuse a view, `diagnose` values are
// reported; the matcher answers the stronger of what a text holds ('refuse',
// 'diagnose' or null). Values and texts are compared in NFC.
export function createDenyMatcher({ refuse: refused = [], diagnose = [] } = {}) {
  const next = new Map()
  const parent = [0]
  const unit = [0]
  const depth = [0]
  const output = [null]
  const add = (raw, strength) => {
    if (typeof raw !== 'string' || raw === '') return
    const value = raw.normalize('NFC')
    let state = 0
    for (let index = 0; index < value.length; index += 1) {
      const key = state * UNITS + value.charCodeAt(index)
      let child = next.get(key)
      if (child === undefined) {
        child = parent.length
        next.set(key, child)
        parent.push(state)
        unit.push(value.charCodeAt(index))
        depth.push(depth[state] + 1)
        output.push(null)
      }
      state = child
    }
    if (output[state] === null) output[state] = { length: value.length, strength }
    else output[state].strength = Math.max(output[state].strength, strength)
  }
  for (const value of refused) add(value, REFUSE)
  for (const value of diagnose) add(value, DIAGNOSE)
  // Failure and output links, state by state in order of depth.
  const fail = new Int32Array(parent.length)
  const outputLink = new Int32Array(parent.length).fill(-1)
  const byDepth = []
  for (let state = 1; state < parent.length; state += 1) (byDepth[depth[state]] ??= []).push(state)
  for (const states of byDepth) {
    for (const state of states ?? []) {
      let target = 0
      if (parent[state] !== 0) {
        let from = fail[parent[state]]
        while (from !== 0 && !next.has(from * UNITS + unit[state])) from = fail[from]
        target = next.get(from * UNITS + unit[state]) ?? 0
      }
      fail[state] = target
      outputLink[state] = output[target] !== null ? target : outputLink[target]
    }
  }
  return function match(raw) {
    const text = String(raw).normalize('NFC')
    let state = 0
    let found = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      while (state !== 0 && !next.has(state * UNITS + code)) state = fail[state]
      state = next.get(state * UNITS + code) ?? 0
      for (let hit = output[state] !== null ? state : outputLink[state]; hit > 0; hit = outputLink[hit]) {
        const { length, strength } = output[hit]
        if (strength <= found || continuesBefore(text, index - length + 1) || continuesAfter(text, index + 1)) continue
        found = strength
        if (found === REFUSE) return 'refuse'
      }
    }
    return found === REFUSE ? 'refuse' : found === DIAGNOSE ? 'diagnose' : null
  }
}

// What one generated region of one note says: the link targets it holds and
// its free text, the author's words that reached it. A line that is not one
// of the shapes the emitter writes is free text as a whole.
function readGeneratedRegion({ kind, text, fence, own }) {
  const links = [...text.matchAll(GENERATED_WIKILINK)].map((match) => match[1].split('|')[0].split('#')[0])
    .concat([...text.matchAll(GENERATED_MARKDOWN_LINK)].map((match) => match[1]))
  const freeText = []
  for (const line of linesOf(text)) {
    if (line === '' || line === fence) continue
    if (kind === 'representation') {
      if (line.startsWith('# ')) freeText.push(line.slice(2))
      else if (line === own.format || line === own.source || ORIGINAL_LINK.test(line) || EMBED_LINE.test(line)) continue
      else if (line.startsWith('- Tags: ')) freeText.push(line.slice('- Tags: '.length))
      else freeText.push(line)
      continue
    }
    if (line === RELATIONS_HEADING_LINE || line === RELATIONS_NOTE_LINE || OUTSIDE_COUNT.test(line)) continue
    const outgoing = RELATION_OUT.exec(line)
    if (outgoing) { freeText.push(outgoing[2]); continue }
    const incoming = RELATION_IN.exec(line)
    if (incoming) { freeText.push(incoming[1]); continue }
    freeText.push(line.replace(GENERATED_WIKILINK, ' '))
  }
  return { links, freeText: freeText.map(asRead) }
}

// Whether an identity region holds exactly the identity lines of its own note
// and nothing but the front-matter delimiters, the comment delimiters of the
// end-of-note placement, blank lines and a fence closure around them.
function identityRegionIsOwn(text, node, fence) {
  const expected = identityLineTexts(node)
  const lines = linesOf(text)
  const named = lines.filter((line) => line.startsWith('atelier-'))
  if (named.length !== expected.length || named.some((line, index) => line !== expected[index])) return false
  return lines.every((line) => named.includes(line) || line === '' || line === '---' || line === '%%' || (fence !== null && line === fence))
}

// Everything the rules judge about one note, read once.
export function readNoteForRedaction({ note, bytes, node, own }) {
  const regions = []
  for (const region of note.regions.generated) {
    if (region.kind === 'identity') continue
    const fence = region.ext?.[EXT]?.fenceClosure?.fence ?? null
    regions.push(readGeneratedRegion({ kind: region.kind, text: bytes.subarray(region.range.start, region.range.end).toString('utf8'), fence, own }))
  }
  const identity = note.regions.identity
  const identityRegion = note.regions.generated.find((region) => region.kind === 'identity')
  const identityFence = identityRegion?.ext?.[EXT]?.fenceClosure?.fence ?? null
  return {
    note,
    links: regions.flatMap((region) => region.links),
    freeText: regions.flatMap((region) => region.freeText),
    identity: identity === undefined ? null : { own: identityRegionIsOwn(bytes.subarray(identity.start, identity.end).toString('utf8'), node, identityFence) },
  }
}

// A refusal names the in-view note (or file) and the rule, never the value.
const refuseAt = (rule, where, message) => refuse('redaction-failure', `${message} (${rule}, ${where})`, { rule, ...(where.endsWith('.md') ? { notePath: where } : { filePath: where }) })

// Rule 1. `view.allocatedPathOf(nodeId)` is the path allocated to a node of
// this view (null for any other), `view.attachments` the files it holds and
// `view.linkTargets` every spelling a rewritten or generated link of this
// view may use.
function allowList({ manifest, notes, read, view, layoutVersion }) {
  const judgedIds = new Set(notes.map((note) => note.nodeId))
  const pathOfNode = new Map(manifest.notes.map((note) => [note.nodeId, note.path]))
  for (const note of notes) {
    if (view.allocatedPathOf(note.nodeId) !== note.path) refuseAt('allow-list', note.path, 'a note path is not the one allocated to a note of this view')
    for (const embed of note.ext?.[EXT]?.assetEmbeds ?? []) {
      if (!view.attachments.has(embed.attachment)) refuseAt('allow-list', note.path, 'an embed names a file that is not part of this view')
    }
  }
  for (const attachment of manifest.attachments) {
    if (!view.attachments.has(attachment.path)) refuseAt('allow-list', attachment.path, 'an attachment is not a file of this view')
  }
  for (const link of manifest.links.filter((item) => judgedIds.has(item.sourceNodeId))) {
    for (const inversion of link.inversions ?? []) checkInversion(inversion, pathOfNode.get(link.sourceNodeId), view)
  }
  for (const note of notes) {
    for (const embed of note.ext?.[EXT]?.assetEmbeds ?? []) for (const inversion of embed.inversions) checkInversion(inversion, note.path, view)
  }
  for (const entry of read) {
    for (const target of entry.links) if (!view.linkTargets.has(target)) refuseAt('allow-list', entry.note.path, 'a generated link names a file that is not part of this view')
    if (layoutVersion >= 2 && (entry.identity === null || !entry.identity.own)) refuseAt('identity-block', entry.note.path, 'an identity block does not name exactly its own note')
  }
}

function checkInversion(inversion, notePath, view) {
  const ext = inversion.ext?.[EXT] ?? {}
  const emitted = Buffer.from(ext.emitted ?? '', 'base64url').toString('utf8')
  // The words an author chose, appended after a rewritten wikilink target: authored bytes, not a path.
  if ((ext.original ?? '') === '' && emitted.startsWith('|')) return
  if (!view.linkTargets.has(emitted)) refuseAt('allow-list', notePath, 'an emitted link names a file that is not part of this view')
}

// Rule 2. A refused value refuses the view; a reported one (an identity that
// is a bare word) is recorded through `report` and the view goes on.
function denyList({ read, deny, report }) {
  for (const entry of read) {
    let reported = false
    for (const text of entry.freeText) {
      const found = deny(text)
      if (found === 'refuse') refuseAt('deny-list', entry.note.path, 'generated text names an identity that is not part of this view')
      if (found === 'diagnose' && !reported) {
        reported = true
        report({ code: 'bare-identity-in-generated-text', rule: 'deny-list', repoId: entry.note.repoId, nodeId: entry.note.nodeId, notePath: entry.note.path })
      }
    }
  }
}

export const REDACTION_RULES = Object.freeze({
  // Rule 3: which notes the other rules judge. Every note of the view.
  judged: ({ notes }) => notes,
  allowList,
  denyList,
})

// Returns what rule 2 reported.
export function assertViewRedaction({ manifest, files, reused, nodeOf, ownOf, view, deny, layoutVersion }, rules = REDACTION_RULES) {
  const notes = rules.judged({ notes: manifest.notes, reused })
  const byPath = new Map(files.map((file) => [file.path, file.bytes]))
  const read = notes.map((note) => readNoteForRedaction({ note, bytes: byPath.get(note.path), node: nodeOf(note.nodeId), own: ownOf(note.nodeId) }))
  const reported = []
  rules.allowList({ manifest, notes, read, view, layoutVersion })
  rules.denyList({ read, deny, report: (item) => reported.push(item) })
  return reported
}

// Layout 1 only, as the earlier release checked it. Two rules, because the two
// kinds of bytes differ: a substring the emitter itself produced from an
// allocated path (note and attachment paths, rewritten link targets) may name
// only a note or asset of this view; free text in a generated region (titles,
// tags, source paths, which are the author's words) is refused only when it
// names an identity of the census that is outside this view. Author text that
// merely looks like an identity suffix, such as a content-hashed asset name,
// is not a redaction failure.
export function assertOnlyVaultIdentities({ manifest, files, vaultSuffixes, forbiddenSuffixes }) {
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
    for (const inversion of link.inversions ?? []) checkEmitted(Buffer.from(inversion.ext[EXT].emitted, 'base64url').toString('utf8'))
  }
  for (const note of manifest.notes) {
    for (const embed of note.ext[EXT].assetEmbeds ?? []) {
      checkEmitted(embed.attachment)
      for (const inversion of embed.inversions) checkEmitted(Buffer.from(inversion.ext[EXT].emitted, 'base64url').toString('utf8'))
    }
  }
  for (const note of manifest.notes) checkEmitted(note.path)
  for (const attachment of manifest.attachments) checkEmitted(attachment.path)
}
