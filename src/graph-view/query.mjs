import { VALID_RELATIONS } from '../graph/graph.mjs'
import { GRAPH_VIEW_SCHEMA, assertShape, assertRelativePath, projectShape, digestJson, canonicalJson, refKey, compareText, sortedUnique, refuse, serializeGraphView } from './contracts.mjs'

const TABLES = ['nodes', 'edges', 'evidence', 'questions', 'diagnostics']
const keys = { nodes: item => refKey(item.ref), edges: item => item.edgeId, evidence: item => item.evidenceId, questions: item => item.questionId, diagnostics: item => item.diagnosticId }
const shapes = { nodes: 'node', edges: 'edge', evidence: 'evidence', questions: 'question', diagnostics: 'diagnostic' }
const sourceKey = pin => canonicalJson([pin.repoId, pin.path, pin.revision, pin.digest])
const sortRefs = refs => refs.sort((a, b) => compareText(refKey(a), refKey(b)))
const count = tables => Object.fromEntries(TABLES.map(key => [key, tables[key].length]))

function indexUnique(items, key) {
  const result = new Map()
  for (const item of items) {
    const id = key(item)
    if (result.has(id)) refuse('contract_mismatch')
    result.set(id, item)
  }
  return result
}

function normalize(raw) {
  if (!raw || typeof raw.producerVersion !== 'string' || !raw.producerVersion || raw.producerVersion.length > 128) refuse('contract_mismatch')
  if (!['complete', 'incomplete'].includes(raw.completeness)) refuse('contract_mismatch')
  const graph = { producerVersion: raw.producerVersion, completeness: raw.completeness }
  graph.sourceSnapshot = projectShape('sourceSnapshot', {
    ...raw.sourceSnapshot,
    repositories: raw.sourceSnapshot?.repositories?.map(repo => ({ ...repo, omittedFiles: 0 })),
  })
  const expiry = raw.accessContext?.expiresAt
  graph.accessContext = projectShape('accessContext', { ...raw.accessContext, expiresAt: typeof expiry === 'number' && Number.isFinite(expiry) ? new Date(expiry).toISOString() : expiry })
  graph.capabilities = projectShape('capabilities', { maxSlice: 500, maxDepth: 2, sourceReads: false, proposalIntents: [], queries: ['metadata-search', 'neighborhood', 'question', 'source-impact'], ...raw.capabilities })
  graph.accessContext.authorizedRepoIds = sortedUnique(graph.accessContext.authorizedRepoIds)
  graph.capabilities.queries = sortedUnique(graph.capabilities.queries)
  graph.capabilities.proposalIntents = sortedUnique(graph.capabilities.proposalIntents)
  const repositories = indexUnique(graph.sourceSnapshot.repositories, repo => repo.repoId)
  if ([...repositories.keys()].some(id => !graph.accessContext.authorizedRepoIds.includes(id))) refuse('contract_mismatch')
  for (const repo of repositories.values()) {
    indexUnique(repo.files, file => file.path)
    for (const file of repo.files) assertRelativePath(file.path)
    repo.files.sort((a, b) => compareText(a.path, b.path))
  }
  graph.sourceSnapshot.repositories.sort((a, b) => compareText(a.repoId, b.repoId))
  for (const table of TABLES) {
    if (!Array.isArray(raw[table]) || raw[table].length > 20000) refuse('budget_exceeded')
    graph[table] = raw[table].map(item => projectShape(shapes[table], table === 'diagnostics' && item.code === 'authorized-source-unavailable' ? { ...item, diagnosticId: digestJson({ code: item.code, repoId: item.repoId }) } : item))
    indexUnique(graph[table], keys[table])
    graph[table].sort((a, b) => compareText(keys[table](a), keys[table](b)))
  }
  const missingRepositories = graph.accessContext.authorizedRepoIds.filter(id => !repositories.has(id))
  const unavailable = graph.diagnostics.filter(item => item.code === 'authorized-source-unavailable').map(item => item.repoId).sort(compareText)
  if (canonicalJson(missingRepositories) !== canonicalJson(unavailable) || (missingRepositories.length > 0 && graph.completeness !== 'incomplete') || graph.diagnostics.some(item => item.repoId && !graph.accessContext.authorizedRepoIds.includes(item.repoId))) refuse('contract_mismatch')
  for (const node of graph.nodes) node.tags = sortedUnique(node.tags)
  if (raw.edges.some(edge => edge.eligible === false)) refuse('contract_mismatch')
  for (const edge of graph.edges) {
    if (edge.predicate !== 'links_to' && !VALID_RELATIONS.has(edge.predicate)) refuse('contract_mismatch')
    edge.supportRefs = sortedUnique(edge.supportRefs)
    edge.reviewRefs = sortedUnique(edge.reviewRefs)
  }
  for (const item of [...graph.questions, ...graph.diagnostics]) {
    sortRefs(item.nodeRefs)
    item.evidenceRefs = sortedUnique(item.evidenceRefs)
    if (item.contradictingRefs) item.contradictingRefs = sortedUnique(item.contradictingRefs)
    if (item.gaps) item.gaps = sortedUnique(item.gaps)
  }
  const nodes = new Map(graph.nodes.map(node => [refKey(node.ref), node]))
  const evidence = new Map(graph.evidence.map(item => [item.evidenceId, item]))
  const checkSource = (source, verified = true) => {
    assertRelativePath(source.path)
    if (source.locator?.rangeDigest && !source.locator.range) refuse('contract_mismatch')
    for (const range of [source.locator?.range, source.locator?.targetRange].filter(Boolean)) {
      if (range.end < range.start || (range.byteStart === undefined) !== (range.byteEnd === undefined) || (range.byteStart !== undefined && range.byteEnd < range.byteStart)) refuse('contract_mismatch')
    }
    const repo = repositories.get(source.repoId)
    if (!repo) refuse('contract_mismatch')
    if (verified && (source.revision !== repo.digest || !repo.files.some(file => file.path === source.path && file.rawDigest === source.digest))) refuse('contract_mismatch')
  }
  for (const node of graph.nodes) {
    if (node.ref.repoId !== node.sourceRef.repoId) refuse('contract_mismatch')
    checkSource(node.sourceRef)
  }
  for (const item of graph.evidence) checkSource(item.sourceRef, item.verification === 'verified-source')
  for (const repo of repositories.values()) for (const field of ['config', 'plan']) if (repo.inputs[field]) {
    if (repo.inputs[field].repoId !== repo.repoId) refuse('contract_mismatch')
    checkSource(repo.inputs[field])
  }
  for (const edge of graph.edges) {
    if (!nodes.has(refKey(edge.source)) || !nodes.has(refKey(edge.target)) || !evidence.has(edge.sourceRef) || !edge.supportRefs.includes(edge.sourceRef) || edge.supportRefs.length === 0 || edge.supportRefs.some(id => !evidence.has(id))) refuse('contract_mismatch')
  }
  for (const item of [...graph.questions, ...graph.diagnostics]) {
    if (item.nodeRefs.some(ref => !nodes.has(refKey(ref))) || [...item.evidenceRefs, ...(item.contradictingRefs ?? [])].some(id => !evidence.has(id))) refuse('contract_mismatch')
  }
  return graph
}

function normalizedRequest(request, graph) {
  assertShape('request', request)
  if (request.limit && request.limit > graph.capabilities.maxSlice) refuse('budget_exceeded')
  if ((request.depth ?? 0) > graph.capabilities.maxDepth) refuse('budget_exceeded')
  if (request.search && !graph.capabilities.queries.includes('metadata-search') || request.questionId && !graph.capabilities.queries.includes('question') || request.focusRef && !graph.capabilities.queries.includes('neighborhood')) refuse('policy_refusal')
  const query = {
    questionId: request.questionId ?? null,
    focusRef: request.focusRef ?? null,
    relationFilter: sortedUnique(request.relationFilter ?? []),
    direction: request.direction ?? 'both',
    depth: request.depth ?? 0,
    limit: request.limit ?? Math.min(100, graph.capabilities.maxSlice),
    search: (request.search ?? '').normalize('NFC').trim().toLowerCase(),
  }
  if (query.depth > 0 && !query.focusRef) refuse('contract_mismatch')
  return query
}

function slice(graph, query, request, snapshot) {
  let candidates = graph.nodes
  let question = null
  if (query.questionId) {
    question = graph.questions.find(item => item.questionId === query.questionId)
    if (!question) refuse('unavailable')
    const allowed = new Set(question.nodeRefs.map(refKey))
    candidates = candidates.filter(node => allowed.has(refKey(node.ref)))
  }
  if (query.focusRef) {
    const focus = refKey(query.focusRef)
    if (!graph.nodes.some(node => refKey(node.ref) === focus)) refuse('unavailable')
    const visited = new Set([focus])
    let frontier = new Set([focus])
    for (let depth = 0; depth < query.depth; depth += 1) {
      const next = new Set()
      for (const edge of graph.edges) {
        if (query.relationFilter.length && !query.relationFilter.includes(edge.predicate)) continue
        const from = refKey(edge.source), to = refKey(edge.target)
        if (query.direction !== 'in' && frontier.has(from)) next.add(to)
        if (query.direction !== 'out' && frontier.has(to)) next.add(from)
      }
      frontier = new Set([...next].filter(key => !visited.has(key)))
      for (const key of frontier) visited.add(key)
    }
    candidates = candidates.filter(node => visited.has(refKey(node.ref)))
  }
  if (query.search) candidates = candidates.filter(node => [node.title, node.summary, ...node.tags].some(value => value.toLowerCase().includes(query.search)))
  const queryDigest = digestJson({ snapshot, query })
  let offset = 0
  if (request.cursor) {
    let cursor
    try { cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) } catch { refuse('stale_cursor') }
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'offset,queryDigest' || cursor.queryDigest !== queryDigest || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset >= candidates.length || cursor.offset % query.limit !== 0) refuse('stale_cursor')
    offset = cursor.offset
  }
  const nodes = candidates.slice(offset, offset + query.limit)
  const candidateRefs = new Set(candidates.map(node => refKey(node.ref)))
  const visibleRefs = new Set(nodes.map(node => refKey(node.ref)))
  const matchingEdges = graph.edges.filter(edge => candidateRefs.has(refKey(edge.source)) && candidateRefs.has(refKey(edge.target)) && (!query.relationFilter.length || query.relationFilter.includes(edge.predicate)))
  const edges = matchingEdges.filter(edge => visibleRefs.has(refKey(edge.source)) && visibleRefs.has(refKey(edge.target))).slice(0, Math.min(2000, query.limit * 4))
  const needed = new Set(edges.flatMap(edge => [edge.sourceRef, ...edge.supportRefs]))
  const nodeSources = new Set(nodes.map(node => sourceKey(node.sourceRef)))
  for (const item of graph.evidence) if (nodeSources.has(sourceKey(item.sourceRef))) needed.add(item.evidenceId)
  const selectedQuestions = (question ? [question] : graph.questions.filter(item => (!query.focusRef && !query.search) || item.nodeRefs.some(ref => visibleRefs.has(refKey(ref))))).slice(0, 100)
  for (const item of selectedQuestions) for (const id of [...item.evidenceRefs, ...item.contradictingRefs]) needed.add(id)
  if (needed.size > 4000) refuse('budget_exceeded')
  const evidence = graph.evidence.filter(item => needed.has(item.evidenceId))
  const evidenceIds = new Set(evidence.map(item => item.evidenceId))
  const questions = selectedQuestions.map(item => ({ ...item, nodeRefs: item.nodeRefs.filter(ref => visibleRefs.has(refKey(ref))), omissionState: item.nodeRefs.some(ref => !visibleRefs.has(refKey(ref))) ? 'bounded' : item.omissionState }))
  const diagnostics = graph.diagnostics.filter(item => item.nodeRefs.every(ref => visibleRefs.has(refKey(ref))) && item.evidenceRefs.every(id => evidenceIds.has(id))).slice(0, query.limit)
  const selected = { nodes, edges, evidence, questions, diagnostics }
  const total = { nodes: candidates, edges: matchingEdges, evidence: graph.evidence, questions: question ? [question] : graph.questions, diagnostics: graph.diagnostics }
  const returned = count(selected), totals = count(total)
  const omitted = Object.fromEntries(TABLES.map(key => [key, totals[key] - returned[key]]))
  const nextCursor = offset + nodes.length < candidates.length ? Buffer.from(canonicalJson({ offset: offset + nodes.length, queryDigest })).toString('base64url') : null
  const sourcePins = [...nodes.map(node => node.sourceRef), ...evidence.map(item => item.sourceRef), ...graph.sourceSnapshot.repositories.flatMap(repo => [repo.inputs.config, repo.inputs.plan]).filter(Boolean)]
  const sourceSnapshot = { ...graph.sourceSnapshot, repositories: graph.sourceSnapshot.repositories.map(repo => {
    const selectedPaths = new Set(sourcePins.filter(pin => pin.repoId === repo.repoId).map(pin => pin.path))
    const files = repo.files.filter(file => selectedPaths.has(file.path))
    return { ...repo, files, omittedFiles: repo.files.length - files.length }
  }) }
  const payload = { schema: GRAPH_VIEW_SCHEMA, producerVersion: graph.producerVersion, snapshot, completeness: graph.completeness, sourceSnapshot, accessContext: graph.accessContext, ...selected, capabilities: graph.capabilities, query, page: { offset, limit: query.limit, returned, omitted, truncated: Object.values(omitted).some(value => value > 0), nextCursor } }
  return { ...payload, projectionDigest: digestJson(payload) }
}

// Host-only ports close over authenticated context. No caller-supplied graph,
// identity, scope, or grant enters the request. Nothing is cached here.
export function createGraphViewReader({ loadAuthorizedGraph, revalidate, now = () => Date.now() }) {
  if (typeof loadAuthorizedGraph !== 'function' || typeof revalidate !== 'function' || typeof now !== 'function') throw new TypeError('graph-view host ports required')
  const run = async (request, operation) => {
    assertShape('request', request)
    let loaded
    try { loaded = await loadAuthorizedGraph({ operation }) } catch { refuse('policy_refusal') }
    if (!loaded?.binding || !loaded.graph) refuse('policy_refusal')
    let view, bytes, pendingError
    const expiresAt = typeof loaded.graph?.accessContext?.expiresAt === 'number' ? loaded.graph.accessContext.expiresAt : Date.parse(loaded.graph?.accessContext?.expiresAt)
    try {
      const graph = normalize(loaded.graph)
      const snapshot = digestJson(graph)
      if (request.snapshot && request.snapshot !== snapshot) refuse('stale_source')
      const query = normalizedRequest(request, graph)
      if (operation === 'export' && graph.capabilities.export !== true) refuse('policy_refusal')
      view = slice(graph, query, request, snapshot)
      bytes = serializeGraphView(view)
    } catch (error) { pendingError = error }
    let current = false
    try { current = await revalidate(loaded.binding) } catch { refuse('policy_refusal') }
    const deliveredAt = now()
    if (current !== true || !Number.isFinite(expiresAt) || !Number.isFinite(deliveredAt) || deliveredAt >= expiresAt) refuse('policy_refusal')
    if (pendingError) {
      if (!['contract_mismatch', 'budget_exceeded', 'policy_refusal', 'stale_source', 'stale_cursor', 'unavailable'].includes(pendingError.code)) refuse('contract_mismatch')
      throw pendingError
    }
    return { view, bytes }
  }
  return Object.freeze({
    readGraphView: async (request = {}) => (await run(request, 'read')).view,
    exportGraphView: async (request = {}) => (await run(request, 'export')).bytes,
  })
}
