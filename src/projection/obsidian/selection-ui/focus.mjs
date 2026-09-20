import { createHash } from 'node:crypto'
import { refuse } from '../../../runtime/obsidian/errors.mjs'

// Focus: the full vault stays on disk and the native Graph view is filtered
// with a "Search files" query derived from the selected set. The query names
// every selected note by its exact vault-relative path, quoted and escaped
// the way the app's search syntax reads a quoted term, joined with OR.
//
// Nothing here writes a file. The query and the core-Bookmark payload are
// values a person, an agent or the acceptance procedure applies in the app;
// `.obsidian/workspace.json`, `.obsidian/graph.json` and
// `.obsidian/bookmarks.json` belong to the person and are never written by
// Atelier. Whether the installed app applies the query as built is an
// acceptance question (AP-02), not something this module can answer.

export const FOCUS_QUERY_VERSION = 'obsidian-graph-search-paths/v1'
export const FOCUS_BOOKMARK_TYPE = 'graph'
// The files under .obsidian/ the app's UI owns. Atelier reads none of them
// and writes none of them; a focus is applied through the app, never by
// editing these.
export const UI_OWNED_SETTINGS_FILES = Object.freeze(['workspace.json', 'graph.json', 'bookmarks.json'])
export const MAX_FOCUS_PATHS = 100000

// A quoted search term: backslash and double quote are escaped; anything
// that is not printable text cannot be typed into a search box and refuses.
export const FOCUS_QUERY_PRIMITIVES = Object.freeze({
  escape(value) {
    return value.replace(/[\\"]/g, (character) => `\\${character}`)
  },
  term(path) {
    return `path:"${path}"`
  },
  join(terms) {
    return terms.join(' OR ')
  },
})

function normalizePath(value, index) {
  if (typeof value !== 'string' || value === '') refuse('focus-path-unrepresentable', 'a focus path must be a non-empty string', { index })
  const normalized = value.normalize('NFC')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(normalized)) refuse('focus-path-unrepresentable', 'a focus path carries a control character and cannot be a search term', { index })
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    refuse('focus-path-unrepresentable', 'a focus path must be a normalized vault-relative path', { index })
  }
  return normalized
}

// Test seam: the oracles in test/obsidian-acceptance.test.mjs substitute a
// builder that drops escaping to prove the escaping oracle can fail.
// Production uses buildFocusQuery.
export function createFocusQueryBuilderForOracleTests(primitives = FOCUS_QUERY_PRIMITIVES) {
  const { escape, term, join } = { ...FOCUS_QUERY_PRIMITIVES, ...primitives }
  return function buildFocusQuery(paths) {
    if (!Array.isArray(paths)) refuse('focus-selection-empty', 'a focus needs the list of selected note paths')
    if (paths.length === 0) refuse('focus-selection-empty', 'a focus with no selected note would filter nothing; it is refused, never widened to the whole vault')
    if (paths.length > MAX_FOCUS_PATHS) refuse('focus-too-large', `a focus names at most ${MAX_FOCUS_PATHS} notes`, { count: paths.length })
    const normalized = paths.map(normalizePath)
    if (new Set(normalized).size !== normalized.length) refuse('duplicate-identity', 'a focus names a note path more than once')
    // The order is the order given (canonical-id order from the selection), so the same selection is the same query.
    const terms = normalized.map((path) => term(escape(path)))
    const query = join(terms)
    return {
      version: FOCUS_QUERY_VERSION,
      query,
      queryDigest: `sha256:${createHash('sha256').update(query, 'utf8').digest('hex')}`,
      paths: normalized,
    }
  }
}

export const buildFocusQuery = createFocusQueryBuilderForOracleTests()

// The payload of a core-plugin graph bookmark that retains this focus. The
// app assigns the creation time when the bookmark is made there; nothing
// nondeterministic is part of the payload. Only the graph type is supported:
// core Bookmarks retain graph views, not local-graph views.
export function focusBookmarkPayload({ scopeId, query }) {
  if (typeof scopeId !== 'string' || scopeId === '') refuse('invalid-scope', 'a focus bookmark names its scope')
  if (typeof query !== 'string' || query === '') refuse('focus-selection-empty', 'a focus bookmark carries a non-empty query')
  return { type: FOCUS_BOOKMARK_TYPE, title: `Atelier focus ${scopeId}`, options: { search: query } }
}
