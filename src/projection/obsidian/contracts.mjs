import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { validateJsonSchema } from '../../export/atelier-export-contract.mjs'

// Obsidian projection contracts: closed v1 document shapes, the checks a JSON
// schema cannot express, and the scope selector algebra.
//
// Nothing here publishes, applies or reads a vault. selectScope and the path
// helpers are pure functions of their arguments; only schema loading touches
// the filesystem, and only to read the shipped contract files.

export const OBSIDIAN_EXT_KEY = 'mnstry.atelier.obsidian'

export const DECLARED_RELATION_TYPES = Object.freeze([
  'related', 'supports', 'supersedes', 'implements', 'depends_on', 'evidences', 'contradicts', 'belongs_to',
])
export const DERIVED_RELATION_TYPE = 'links_to'
export const RELATION_TYPES = Object.freeze([...DECLARED_RELATION_TYPES, DERIVED_RELATION_TYPE])

// An edit class is listed only once an apply implementation and its checks
// exist. Everything else refuses.
export const IMPLEMENTED_EDIT_CLASSES = Object.freeze(['body-replacement'])

export const SCOPE_MODES = Object.freeze(['full', 'focus', 'scoped'])
export const EXPANSION_DIRECTIONS = Object.freeze(['outgoing', 'incoming', 'both'])
export const EXPANSION_ORDERS = Object.freeze(['canonical-id'])
export const MAX_EXPANSION_DEPTH = 8
const MAX_SELECTOR_DEPTH = 64

// Portable shapes may be committed or shared and must never carry a
// machine-local absolute path, port or policy. Private shapes live only in
// ignored machine-private state.
export const OBSIDIAN_CONTRACTS = Object.freeze([
  ['corpus-profile', 'portable'],
  ['scope', 'portable'],
  ['source-snapshot', 'portable'],
  ['generation-manifest', 'portable'],
  ['publication-journal', 'private'],
  ['service-state', 'private'],
  ['edit-operation', 'portable'],
  ['apply-policy', 'private'],
  ['proposal-receipt', 'portable'],
  ['acceptance-receipt', 'portable'],
  ['ext-settings', 'portable'],
].map(([shape, portability]) => Object.freeze({
  shape,
  portability,
  name: `atelier-obsidian-${shape}`,
  schemaConst: `atelier-obsidian-${shape}/v1`,
  contractFile: `contracts/atelier-obsidian-${shape}.v1.schema.json`,
  fixtureRoot: `fixtures/obsidian/contracts/${shape}`,
})))

export class ObsidianContractRefusal extends Error {
  constructor(code, message, detail = {}) {
    super(`${code}: ${message}`)
    this.name = 'ObsidianContractRefusal'
    this.code = code
    this.detail = detail
  }
}

function refuse(code, message, detail) {
  throw new ObsidianContractRefusal(code, message, detail)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Code-unit comparison: locale-independent, so ordering is identical on every
// machine.
function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

// ---------------------------------------------------------------------------
// Document validation
// ---------------------------------------------------------------------------

const schemaCache = new Map()

function contractFor(shape) {
  const contract = OBSIDIAN_CONTRACTS.find((item) => item.shape === shape)
  if (!contract) refuse('unknown-contract-shape', 'no Obsidian contract is registered for the requested shape')
  return contract
}

function loadSchema(contract) {
  if (!schemaCache.has(contract.shape)) {
    const url = new URL(`../../../${contract.contractFile}`, import.meta.url)
    schemaCache.set(contract.shape, JSON.parse(fs.readFileSync(url, 'utf8')))
  }
  return schemaCache.get(contract.shape)
}

const ABSOLUTE_PATH = /^(?:\/|~[\\/]|[A-Za-z]:[\\/]|\\\\|file:)/

export function isAbsolutePathLike(value) {
  return typeof value === 'string' && ABSOLUTE_PATH.test(value)
}

function collectAbsolutePaths(value, pointer, found) {
  if (typeof value === 'string') {
    if (isAbsolutePathLike(value)) found.push(pointer || '/')
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectAbsolutePaths(item, `${pointer}/${index}`, found))
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) collectAbsolutePaths(item, `${pointer}/${key}`, found)
  }
}

function duplicates(values) {
  const seen = new Set()
  const repeated = new Set()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated].sort(compareIds)
}

function pathsOverlap(left, right) {
  const a = left.replace(/\/+$/, '')
  const b = right.replace(/\/+$/, '')
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

function selectorDuplicateIds(selector, pointer, errors, depth = 0) {
  if (!isPlainObject(selector) || depth > MAX_SELECTOR_DEPTH) return
  if (Array.isArray(selector.ids) && duplicates(selector.ids).length > 0) {
    errors.push({ code: 'duplicate-identity', message: `${pointer}/ids repeats an identity` })
  }
  for (const operator of ['union', 'intersection', 'exclude']) {
    if (!Array.isArray(selector[operator])) continue
    selector[operator].forEach((child, index) => selectorDuplicateIds(child, `${pointer}/${operator}/${index}`, errors, depth + 1))
  }
}

const SEMANTIC_CHECKS = {
  'corpus-profile'(doc, errors) {
    for (const repoId of duplicates(doc.repositories.map((repo) => repo.repoId))) {
      errors.push({ code: 'duplicate-identity', message: `/repositories repeats repository identity ${repoId}` })
    }
    doc.repositories.forEach((repo, index) => {
      for (let other = 0; other < index; other += 1) {
        if (pathsOverlap(repo.root, doc.repositories[other].root)) {
          errors.push({ code: 'overlapping-managed-roots', message: `/repositories/${index}/root overlaps /repositories/${other}/root` })
        }
      }
    })
  },
  scope(doc, errors) {
    selectorDuplicateIds(doc.selector, '/selector', errors)
  },
  'source-snapshot'(doc, errors) {
    for (const repoId of duplicates(doc.repositories.map((repo) => repo.repoId))) {
      errors.push({ code: 'duplicate-identity', message: `/repositories repeats repository identity ${repoId}` })
    }
    doc.repositories.forEach((repo, index) => {
      if (duplicates(repo.files.map((file) => file.path)).length > 0) {
        errors.push({ code: 'duplicate-identity', message: `/repositories/${index}/files repeats a path` })
      }
    })
  },
  'generation-manifest'(doc, errors) {
    const identities = doc.notes.map((note) => `${note.repoId}\u0000${note.nodeId}`)
    if (duplicates(identities).length > 0) errors.push({ code: 'duplicate-identity', message: '/notes repeats a canonical identity' })
    if (duplicates(doc.notes.map((note) => note.path.toLowerCase())).length > 0) {
      errors.push({ code: 'path-collision', message: '/notes allocates one path to more than one note' })
    }
    if (duplicates(doc.links.map((link) => link.edgeId)).length > 0) errors.push({ code: 'duplicate-identity', message: '/links repeats an edge identity' })
    const nodeIds = new Set(doc.notes.map((note) => note.nodeId))
    doc.links.forEach((link, index) => {
      if (!nodeIds.has(link.sourceNodeId)) errors.push({ code: 'unknown-edge-endpoint', message: `/links/${index}/sourceNodeId is not a note in this generation` })
      if (link.targetState === 'in-scope' && !nodeIds.has(link.targetNodeId)) {
        errors.push({ code: 'unknown-edge-endpoint', message: `/links/${index}/targetNodeId is declared in-scope but is not a note in this generation` })
      }
    })
    doc.notes.forEach((note, index) => {
      const ranges = [note.regions.frontmatter, note.regions.body, ...note.regions.generated.map((region) => region.range)].filter(Boolean)
      if (ranges.some((range) => range.end < range.start)) errors.push({ code: 'invalid-byte-range', message: `/notes/${index}/regions has a range that ends before it starts` })
    })
    if (doc.completeness.status === 'complete' && doc.completeness.writtenNotes !== doc.completeness.expectedNotes) {
      errors.push({ code: 'incomplete-generation', message: '/completeness claims complete with unwritten notes' })
    }
  },
  'publication-journal'(doc, errors) {
    const sequence = doc.entries.map((entry) => entry.seq)
    if (duplicates(sequence).length > 0) errors.push({ code: 'duplicate-identity', message: '/entries repeats a sequence number' })
    if (sequence.some((seq, index) => index > 0 && seq <= sequence[index - 1])) {
      errors.push({ code: 'journal-out-of-order', message: '/entries sequence numbers must strictly increase' })
    }
  },
  'service-state'() {},
  'edit-operation'() {},
  'apply-policy'(doc, errors) {
    selectorDuplicateIds(doc.selector, '/selector', errors)
    for (const editClass of doc.allowedEditClasses) {
      if (!IMPLEMENTED_EDIT_CLASSES.includes(editClass)) errors.push({ code: 'unimplemented-edit-class', message: '/allowedEditClasses names a class with no apply implementation' })
    }
  },
  'proposal-receipt'() {},
  'acceptance-receipt'(doc, errors) {
    if (duplicates(doc.evidence.map((item) => item.name)).length > 0) errors.push({ code: 'duplicate-identity', message: '/evidence repeats an evidence name' })
  },
  'ext-settings'(doc, errors) {
    const scopeIds = doc.scopes.map((scope) => scope.scopeId)
    for (const scopeId of duplicates(scopeIds)) errors.push({ code: 'duplicate-identity', message: `/scopes repeats scope identity ${scopeId}` })
    if (doc.defaultScopeId !== undefined && !scopeIds.includes(doc.defaultScopeId)) {
      errors.push({ code: 'unknown-scope', message: '/defaultScopeId does not name a declared scope' })
    }
    doc.scopes.forEach((scope, index) => selectorDuplicateIds(scope.selector, `/scopes/${index}/selector`, errors))
  },
}

// Returns every reason a document is refused: [] means accepted. Each error is
// { layer: 'schema' | 'semantic', code, message }. Semantic checks run only on
// schema-valid documents, so they can rely on the shape.
export function validateObsidianContract(shape, doc) {
  const contract = contractFor(shape)
  const schemaErrors = validateJsonSchema(loadSchema(contract), doc)
  if (schemaErrors.length > 0) return schemaErrors.map((message) => ({ layer: 'schema', code: 'schema-violation', message }))
  const errors = []
  SEMANTIC_CHECKS[shape](doc, errors)
  if (contract.portability === 'portable') {
    const found = []
    collectAbsolutePaths(doc, '', found)
    for (const pointer of found) errors.push({ code: 'absolute-path-in-portable-shape', message: `${pointer} carries a machine-local absolute path` })
  }
  return errors.map((error) => ({ layer: 'semantic', ...error }))
}

export function assertObsidianContract(shape, doc) {
  const errors = validateObsidianContract(shape, doc)
  if (errors.length > 0) refuse('invalid-contract-document', `${shape} document refused`, { shape, errors })
  return doc
}

// Reads the settings object a project keeps under its ext container. Absent
// settings mean the integration is not configured; anything present must
// satisfy the closed ext-settings contract, so unknown keys refuse here rather
// than in the unchanged project v1 schema.
export function readObsidianExtSettings(projectConfigDoc) {
  const ext = projectConfigDoc?.ext
  if (!isPlainObject(ext) || !Object.hasOwn(ext, OBSIDIAN_EXT_KEY)) return null
  const settings = ext[OBSIDIAN_EXT_KEY]
  const errors = validateObsidianContract('ext-settings', settings)
  if (errors.length > 0) refuse('invalid-ext-settings', 'project Obsidian settings refused', { errors })
  return settings
}

// ---------------------------------------------------------------------------
// Note identity and readable paths
// ---------------------------------------------------------------------------

const RESERVED_BASENAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// Stable identity suffix: a digest of repository identity and node identity,
// never of a title or a mutable checkout path.
export function identitySuffix(repoId, nodeId, length = 12) {
  if (typeof repoId !== 'string' || repoId === '' || typeof nodeId !== 'string' || nodeId === '') {
    refuse('invalid-identity', 'repository and node identity must be non-empty strings')
  }
  if (!Number.isInteger(length) || length < 12 || length > 64) refuse('invalid-identity', 'identity suffix length must be 12 to 64')
  return createHash('sha256').update(`${repoId}\u0000${nodeId}`).digest('hex').slice(0, length)
}

export function readableTitle(title) {
  const cleaned = String(title ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim()
  if (cleaned === '') return 'Untitled'
  return RESERVED_BASENAMES.test(cleaned) ? `_${cleaned}` : cleaned
}

export function notePath(node, length = 12) {
  return `notes/${readableTitle(node.title)}--${identitySuffix(node.repo, node.id, length)}.md`
}

// Allocates one path per canonical identity. Duplicate titles are allowed and
// stay distinct through the suffix; a case-folded collision extends the suffix
// of the later identity (in canonical-id order) until the paths differ.
export function allocateNotePaths(nodes) {
  const ordered = [...nodes].sort((left, right) => compareIds(left.id, right.id))
  const taken = new Set()
  const allocated = {}
  for (const node of ordered) {
    let length = 12
    let candidate = notePath(node, length)
    while (taken.has(candidate.toLowerCase())) {
      length += 4
      if (length > 64) refuse('path-collision', 'unable to allocate a distinct note path')
      candidate = notePath(node, length)
    }
    taken.add(candidate.toLowerCase())
    allocated[node.id] = candidate
  }
  return allocated
}

// ---------------------------------------------------------------------------
// Canonical snapshot and profile views
// ---------------------------------------------------------------------------

function profileView(profile) {
  if (!isPlainObject(profile) || !Array.isArray(profile.repositories) || !Array.isArray(profile.audience?.allow)) {
    refuse('invalid-profile', 'profile must declare repositories and an audience allow list')
  }
  const repositories = new Map()
  for (const repo of profile.repositories) {
    if (!isPlainObject(repo) || typeof repo.repoId !== 'string' || repo.repoId === '') refuse('invalid-profile', 'repository entries need a repoId')
    if (repositories.has(repo.repoId)) refuse('duplicate-identity', 'profile repeats a repository identity')
    repositories.set(repo.repoId, repo)
  }
  return { repositories, allowedAudiences: new Set(profile.audience.allow) }
}

function indexSnapshot(canonicalSnapshot) {
  if (!isPlainObject(canonicalSnapshot) || !Array.isArray(canonicalSnapshot.nodes) || !Array.isArray(canonicalSnapshot.edges)) {
    refuse('invalid-snapshot', 'canonical snapshot must carry nodes and edges arrays')
  }
  const nodes = new Map()
  for (const node of canonicalSnapshot.nodes) {
    if (!isPlainObject(node) || typeof node.id !== 'string' || node.id === '' || typeof node.repo !== 'string' || typeof node.path !== 'string') {
      refuse('invalid-snapshot', 'every node needs string id, repo and path')
    }
    if (node.tags !== undefined && !Array.isArray(node.tags)) refuse('invalid-snapshot', 'node tags must be an array')
    // Duplicate titles are fine; a repeated canonical identity is never merged.
    if (nodes.has(node.id)) refuse('duplicate-identity', 'canonical snapshot repeats a node identity')
    nodes.set(node.id, node)
  }
  const edges = new Map()
  for (const edge of canonicalSnapshot.edges) {
    if (!isPlainObject(edge) || typeof edge.id !== 'string' || edge.id === '') refuse('invalid-snapshot', 'every edge needs a string id')
    if (edges.has(edge.id)) refuse('duplicate-identity', 'canonical snapshot repeats an edge identity')
    if (!RELATION_TYPES.includes(edge.type)) refuse('unknown-relation-type', 'edge uses a relation type outside the canonical set', { edgeId: edge.id })
    const derived = edge.type === DERIVED_RELATION_TYPE
    if (derived ? edge.origin === 'declared' || typeof edge.origin !== 'string' : edge.origin !== 'declared') {
      refuse('relation-origin-mismatch', 'declared relation types are declared; links_to is derived', { edgeId: edge.id })
    }
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) refuse('unknown-edge-endpoint', 'edge endpoint is not a node in the snapshot', { edgeId: edge.id })
    edges.set(edge.id, edge)
  }
  return { nodes, edges }
}

// ---------------------------------------------------------------------------
// Scope selection
// ---------------------------------------------------------------------------

// The three set primitives the literal oracles are sensitive to. Production
// always uses these; test/obsidian-contract.test.mjs substitutes deliberately
// broken ones through createScopeSelectorForOracleTests to prove the oracles can fail.
export const SCOPE_PRIMITIVES = Object.freeze({
  // Eligibility and audience. Fails closed: only an explicit eligible: true in
  // an enrolled repository with an allowed audience is visible.
  isVisible(node, view) {
    if (node.eligible !== true) return false
    const repo = view.repositories.get(node.repo)
    if (!repo || repo.enrollment !== 'enrolled') return false
    const audience = node.audience ?? repo.audience
    return audience === undefined || view.allowedAudiences.has(audience)
  },
  // exclude: [base, ...removed] keeps base members absent from every removed set.
  difference(base, removed) {
    return new Set([...base].filter((id) => !removed.some((set) => set.has(id))))
  },
  // Expansion may add a node only while the total stays within the node budget.
  hasBudget(selectedCount, maxNodes) {
    return selectedCount < maxNodes
  },
})

const LEAF_OPERATORS = ['all', 'ids', 'repo', 'tag', 'type']
const SET_OPERATORS = ['union', 'intersection', 'exclude']

function selectorOperator(selector) {
  if (!isPlainObject(selector)) refuse('unknown-selector', 'selector must be an object')
  const keys = Object.keys(selector).filter((key) => key !== 'ext')
  const operators = keys.filter((key) => LEAF_OPERATORS.includes(key) || SET_OPERATORS.includes(key))
  const extras = keys.filter((key) => !operators.includes(key))
  const allowedExtras = operators[0] === 'repo' ? ['pathPrefix'] : []
  if (operators.length !== 1 || extras.some((key) => !allowedExtras.includes(key))) {
    refuse('unknown-selector', 'selector must use exactly one known operator')
  }
  return operators[0]
}

function requestsMembers(selector) {
  const operator = selectorOperator(selector)
  if (operator === 'ids') return selector.ids.length > 0
  if (SET_OPERATORS.includes(operator)) return selector[operator].some(requestsMembers)
  return true
}

function normalizeExpansion(expansion) {
  if (expansion === undefined || expansion === null) return null
  if (!isPlainObject(expansion)) refuse('invalid-expansion', 'expansion must be an object')
  const unknown = Object.keys(expansion).filter((key) => !['depth', 'maxNodes', 'direction', 'order', 'ext'].includes(key))
  if (unknown.length > 0) refuse('invalid-expansion', 'expansion carries an unknown key')
  // Expansion without both budgets would be unbounded; refuse, never default.
  if (expansion.depth === undefined || expansion.maxNodes === undefined) {
    refuse('missing-expansion-budget', 'expansion requires both a depth and a maxNodes budget')
  }
  const { depth, maxNodes, direction = 'outgoing', order = 'canonical-id' } = expansion
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_EXPANSION_DEPTH) refuse('invalid-expansion', `depth must be an integer from 1 to ${MAX_EXPANSION_DEPTH}`)
  if (!Number.isInteger(maxNodes) || maxNodes < 1) refuse('invalid-expansion', 'maxNodes must be a positive integer')
  if (!EXPANSION_DIRECTIONS.includes(direction)) refuse('invalid-expansion', 'unknown expansion direction')
  if (!EXPANSION_ORDERS.includes(order)) refuse('invalid-expansion', 'unknown expansion order')
  return { depth, maxNodes, direction, order }
}

// Test seam only. Substituting isVisible removes the eligibility and audience
// boundary, so nothing outside test/obsidian-contract.test.mjs may call this;
// runtime code uses selectScope.
export function createScopeSelectorForOracleTests(primitives = SCOPE_PRIMITIVES) {
  const { isVisible, difference, hasBudget } = { ...SCOPE_PRIMITIVES, ...primitives }

  function evaluate(selector, context, depth) {
    if (depth > MAX_SELECTOR_DEPTH) refuse('invalid-selector', 'selector nesting is too deep')
    const operator = selectorOperator(selector)
    const value = selector[operator]
    const matching = (predicate) => new Set(context.visibleNodes.filter(predicate).map((node) => node.id))

    if (operator === 'all') {
      if (value !== true) refuse('invalid-selector', 'all must be true')
      return matching(() => true)
    }
    if (operator === 'ids') {
      if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) refuse('invalid-selector', 'ids must be an array of strings')
      if (new Set(value).size !== value.length) refuse('duplicate-identity', 'ids selector repeats an identity')
      // Absent and withheld identities are reported together, so the report
      // cannot be used to confirm that a withheld object exists.
      for (const id of value) if (!context.visible.has(id)) context.unresolvedIds.add(id)
      return new Set(value.filter((id) => context.visible.has(id)))
    }
    if (operator === 'repo') {
      if (typeof value !== 'string' || !context.view.repositories.has(value)) refuse('unknown-repo', 'selector names a repository outside the profile')
      const prefix = selector.pathPrefix
      if (prefix === undefined) return matching((node) => node.repo === value)
      if (typeof prefix !== 'string' || prefix === '' || isAbsolutePathLike(prefix)) refuse('invalid-selector', 'pathPrefix must be a repository-relative path')
      const directory = prefix.endsWith('/') ? prefix : `${prefix}/`
      return matching((node) => node.repo === value && (node.path === prefix || node.path.startsWith(directory)))
    }
    if (operator === 'tag' || operator === 'type') {
      if (typeof value !== 'string' || value === '') refuse('invalid-selector', `${operator} must be a non-empty string`)
      return operator === 'tag'
        ? matching((node) => (node.tags ?? []).includes(value))
        : matching((node) => node.type === value)
    }
    if (!Array.isArray(value) || value.length === 0) refuse('invalid-selector', `${operator} needs at least one member selector`)
    const sets = value.map((child) => evaluate(child, context, depth + 1))
    if (operator === 'union') return new Set(sets.flatMap((set) => [...set]))
    if (operator === 'intersection') return new Set([...sets[0]].filter((id) => sets.every((set) => set.has(id))))
    return difference(sets[0], sets.slice(1))
  }

  function expand(selected, budget, visibleEdges) {
    let truncated = false
    let frontier = [...selected]
    for (let hop = 0; hop < budget.depth && frontier.length > 0; hop += 1) {
      const from = new Set(frontier)
      const candidates = new Set()
      for (const edge of visibleEdges) {
        if (budget.direction !== 'incoming' && from.has(edge.source) && !selected.has(edge.target)) candidates.add(edge.target)
        if (budget.direction !== 'outgoing' && from.has(edge.target) && !selected.has(edge.source)) candidates.add(edge.source)
      }
      frontier = []
      for (const id of [...candidates].sort(compareIds)) {
        if (!hasBudget(selected.size, budget.maxNodes)) {
          truncated = true
          continue
        }
        selected.add(id)
        frontier.push(id)
      }
    }
    return truncated
  }

  return function selectScope({ canonicalSnapshot, profile, selector, expansion, mode = 'scoped' } = {}) {
    if (!SCOPE_MODES.includes(mode)) refuse('unknown-mode', 'scope mode must be full, focus or scoped')
    const view = profileView(profile)
    const { nodes, edges } = indexSnapshot(canonicalSnapshot)
    const budget = normalizeExpansion(expansion)

    const visibleNodes = [...nodes.values()].filter((node) => isVisible(node, view))
    const visible = new Set(visibleNodes.map((node) => node.id))
    // An edge with a withheld endpoint does not exist for selection purposes:
    // it is not selected, not traversed and not reported as outside-selection.
    const seenEdgeKeys = new Set()
    const visibleEdges = [...edges.values()]
      .filter((edge) => visible.has(edge.source) && visible.has(edge.target))
      .sort((left, right) => compareIds(left.id, right.id))
      .filter((edge) => {
        const key = JSON.stringify([edge.source, edge.target, edge.type, edge.origin])
        if (seenEdgeKeys.has(key)) return false
        seenEdgeKeys.add(key)
        return true
      })

    const context = { view, visibleNodes, visible, unresolvedIds: new Set() }
    const selected = evaluate(selector, context, 0)
    if (mode === 'full' && selectorOperator(selector) !== 'all') refuse('full-mode-requires-all', 'full mode selects the whole authorized corpus')
    const truncated = budget ? expand(selected, budget, visibleEdges) : false

    const inside = (edge) => selected.has(edge.source) && selected.has(edge.target)
    const touching = (edge) => selected.has(edge.source) !== selected.has(edge.target)
    const nodeIds = [...selected].sort(compareIds)
    const diagnostics = []
    if (nodeIds.length === 0 && requestsMembers(selector)) diagnostics.push('selection-has-no-visible-members')
    if (truncated) diagnostics.push('expansion-truncated-at-node-budget')

    // Focus keeps the full vault and filters the graph; it is not a
    // confidentiality boundary. Scoped and full vaults hold the selection only.
    const vaultNodes = mode === 'focus' ? [...visible].sort(compareIds) : nodeIds
    const vaultEdges = mode === 'focus' ? visibleEdges.map((edge) => edge.id) : visibleEdges.filter(inside).map((edge) => edge.id)

    return {
      mode,
      nodes: nodeIds,
      edges: visibleEdges.filter(inside).map((edge) => edge.id),
      outsideSelectionEdges: visibleEdges.filter(touching).map((edge) => edge.id),
      vaultNodes,
      vaultEdges,
      truncated,
      unresolvedIds: [...context.unresolvedIds].sort(compareIds),
      diagnostics,
    }
  }
}

export const selectScope = createScopeSelectorForOracleTests()

// Resolves a title-only wikilink among visible nodes. A title shared by more
// than one visible node refuses instead of choosing a target.
export function resolveTitleLink({ canonicalSnapshot, profile, input }) {
  const match = typeof input === 'string' ? input.match(/^\[\[([^[\]|#^]+)\]\]$/) : null
  if (!match) refuse('unsupported-link', 'only a plain title wikilink can be resolved by title')
  const title = match[1].trim()
  const view = profileView(profile)
  const { nodes } = indexSnapshot(canonicalSnapshot)
  const targets = [...nodes.values()].filter((node) => SCOPE_PRIMITIVES.isVisible(node, view) && node.title === title)
  if (targets.length === 0) refuse('unresolved-target', 'no visible node carries that title')
  if (targets.length > 1) refuse('ambiguous-target', 'more than one visible node carries that title')
  return targets[0].id
}
