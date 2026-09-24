import { refuse } from '../../../runtime/obsidian/errors.mjs'
import { EXPANSION_DIRECTIONS, EXPANSION_ORDERS, MAX_EXPANSION_DEPTH, ObsidianContractRefusal, SCOPE_MODES, assertObsidianContract, selectScope } from '../contracts.mjs'
import { allocateWorkspacePaths } from '../materialize/path-registry.mjs'
import { buildFocusQuery, focusBookmarkPayload } from './focus.mjs'

// Selection: a requested scope (full, scoped or focus, with an optional
// bounded expansion) becomes an exact scope document, the exact selected set
// and, for a focus, the graph query and bookmark payload derived from it.
//
// Selection is the contract's selectScope, unchanged: this module adds no
// selector, no default and no fallback. An empty result is reported as
// empty, or refused when the caller did not say empty is acceptable. It is
// never widened. The note paths are the ones the workspace path registry
// allocates, so a focus names the files a full vault of this workspace holds.

export const SELECTION_SCHEMA = 'atelier-obsidian-selection/v1'
export const SCOPE_CONTRACT_SCHEMA = 'atelier-obsidian-scope/v1'
export const EMPTY_SELECTION_REASONS = Object.freeze(['explicit-empty', 'no-visible-members'])

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The exact document: the caller's members, the two expansion defaults the
// contract allows filled in, and nothing else. A budget is never defaulted.
export function scopeDocumentOf({ scopeId, mode, selector, expansion, ext } = {}) {
  if (typeof scopeId !== 'string' || scopeId === '') refuse('invalid-scope', 'a scope names itself with a scopeId')
  if (!SCOPE_MODES.includes(mode)) refuse('invalid-scope', 'scope mode must be full, focus or scoped', { mode: String(mode).slice(0, 32) })
  if (!isPlainObject(selector)) refuse('invalid-scope', 'a scope carries a selector object')
  let normalizedExpansion
  if (expansion !== undefined && expansion !== null) {
    if (!isPlainObject(expansion)) refuse('invalid-expansion', 'expansion must be an object')
    if (expansion.depth === undefined || expansion.maxNodes === undefined) refuse('missing-expansion-budget', 'expansion requires both a depth and a maxNodes budget; neither is defaulted')
    // The budgets are checked here, before the contract, so a bad budget is an expansion fault and not a generic scope fault.
    if (!Number.isInteger(expansion.depth) || expansion.depth < 1 || expansion.depth > MAX_EXPANSION_DEPTH) refuse('invalid-expansion', `depth must be an integer from 1 to ${MAX_EXPANSION_DEPTH}`)
    if (!Number.isInteger(expansion.maxNodes) || expansion.maxNodes < 1) refuse('invalid-expansion', 'maxNodes must be a positive integer')
    const direction = expansion.direction ?? 'outgoing'
    const order = expansion.order ?? 'canonical-id'
    if (!EXPANSION_DIRECTIONS.includes(direction)) refuse('invalid-expansion', 'unknown expansion direction')
    if (!EXPANSION_ORDERS.includes(order)) refuse('invalid-expansion', 'unknown expansion order')
    normalizedExpansion = { depth: expansion.depth, maxNodes: expansion.maxNodes, direction, order, ...(expansion.ext === undefined ? {} : { ext: expansion.ext }) }
  }
  const document = {
    schema: SCOPE_CONTRACT_SCHEMA,
    scopeId,
    mode,
    selector,
    ...(normalizedExpansion === undefined ? {} : { expansion: normalizedExpansion }),
    ...(ext === undefined ? {} : { ext }),
  }
  try { assertObsidianContract('scope', document) } catch (error) {
    if (error instanceof ObsidianContractRefusal) refuse('invalid-scope', 'the requested scope does not satisfy the scope contract', { errors: error.detail?.errors ?? [] })
    throw error
  }
  return document
}

function contractRefusalToTyped(error) {
  if (error instanceof ObsidianContractRefusal) refuse(error.code, error.message.replace(`${error.code}: `, ''), error.detail ?? {})
  throw error
}

// `pathRegistry` is the workspace's persisted path registry when the caller
// has one (AOP-1 keeps it in the maintenance state store); without it the
// paths are those a fresh workspace would allocate. Both are deterministic.
export function resolveSelection({ canonicalSnapshot, profile, scope, allowEmpty = false, pathRegistry = null, select = selectScope } = {}) {
  const document = scopeDocumentOf(scope)
  let result
  try {
    result = select({ canonicalSnapshot, profile, selector: document.selector, expansion: document.expansion, mode: document.mode })
  } catch (error) { contractRefusalToTyped(error) }

  const empty = result.nodes.length === 0
  const emptyReason = empty ? (result.diagnostics.includes('selection-has-no-visible-members') ? 'no-visible-members' : 'explicit-empty') : null
  if (empty && document.mode === 'focus') {
    // A graph filter naming no note would show the whole vault or nothing, depending on the app. Neither is the request.
    refuse('focus-selection-empty', 'the focus selects no visible note; a focus is never widened', { reason: emptyReason, unresolvedIds: result.unresolvedIds })
  }
  if (empty && allowEmpty !== true) refuse('selection-empty', 'the selection has no visible member; pass allowEmpty to produce an honest empty scope', { reason: emptyReason, unresolvedIds: result.unresolvedIds })

  const workspaceId = typeof profile?.workspaceId === 'string' ? profile.workspaceId : 'ws-unnamed'
  const nodeById = new Map(canonicalSnapshot.nodes.map((node) => [node.id, node]))
  // Paths are allocated over every visible node of the workspace, as a prepared view allocates them: a name that
  // collides takes a qualifier, so which name a note gets depends on the notes allocated with it, and an identity
  // that left the census releases its name. A node that cannot be laid out has no path and is left out here too.
  let pathOf
  try {
    const visible = selectScope({ canonicalSnapshot, profile, selector: { all: true }, mode: 'scoped' }).nodes.map((id) => nodeById.get(id))
    const census = { nodes: canonicalSnapshot.nodes, ...(Array.isArray(canonicalSnapshot.assets) ? { assets: canonicalSnapshot.assets } : {}) }
    ;({ pathOf } = allocateWorkspacePaths({ registry: pathRegistry, workspaceId, nodes: visible, census }))
  } catch (error) { contractRefusalToTyped(error) }
  const notePaths = Object.fromEntries(result.nodes.map((id) => [id, pathOf(nodeById.get(id).repo, id)]).filter(([, notePath]) => notePath !== null))

  let focus = null
  if (document.mode === 'focus') {
    const built = buildFocusQuery(result.nodes.filter((id) => Object.hasOwn(notePaths, id)).map((id) => notePaths[id]))
    focus = { ...built, bookmark: focusBookmarkPayload({ scopeId: document.scopeId, query: built.query }) }
  }

  return {
    schema: SELECTION_SCHEMA,
    scope: document,
    mode: document.mode,
    nodes: result.nodes,
    edges: result.edges,
    outsideSelectionEdges: result.outsideSelectionEdges,
    vaultNodes: result.vaultNodes,
    vaultEdges: result.vaultEdges,
    truncated: result.truncated,
    unresolvedIds: result.unresolvedIds,
    diagnostics: result.diagnostics,
    empty,
    emptyReason,
    notePaths,
    focus,
  }
}
