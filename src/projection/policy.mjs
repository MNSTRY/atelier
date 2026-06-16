export const LOCAL_AUDIENCES = ['public', 'team', 'operator', 'staff', 'private', 'sensitive']
export const RUNTIME_VISIBILITIES = ['private', 'shared', 'platform', 'public']
export const RUNTIME_SPACE_DATA_BOUNDARIES = [
  'public_shareable',
  'member_shareable',
  'client_visible',
  'practitioner_private',
  'specially_protected',
]

export const VALID_AUDIENCES = new Set(LOCAL_AUDIENCES)
export const VALID_RUNTIME_VISIBILITIES = new Set(RUNTIME_VISIBILITIES)
export const VALID_RUNTIME_SPACE_DATA_BOUNDARIES = new Set(RUNTIME_SPACE_DATA_BOUNDARIES)

export const PROJECTION_TARGETS = {
  public: new Set(['public']),
  team: new Set(['public', 'team']),
  operator: new Set(['public', 'team', 'operator', 'staff']),
  local: new Set(LOCAL_AUDIENCES),
}

export function normalizeAudience(value) {
  return typeof value === 'string' && VALID_AUDIENCES.has(value.trim()) ? value.trim() : null
}

export function projectionTarget(value = 'local') {
  return Object.hasOwn(PROJECTION_TARGETS, value) ? value : 'local'
}

export function canProjectNode(node, target = 'local') {
  const normalizedTarget = projectionTarget(target)
  const audience = normalizeAudience(node?.audience)
  const reasons = []
  if (!audience) reasons.push('missing-or-invalid-audience')
  if (audience && !PROJECTION_TARGETS[normalizedTarget].has(audience)) {
    reasons.push(`audience-${audience}-blocked-for-${normalizedTarget}`)
  }
  return {
    ok: reasons.length === 0,
    audience,
    target: normalizedTarget,
    reasons,
  }
}

export function projectGraph(graph, { target = 'local' } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  const allowedNodes = []
  const blocked = []
  const byId = new Map()

  for (const node of nodes) {
    const verdict = canProjectNode(node, target)
    if (verdict.ok) {
      allowedNodes.push(node)
      byId.set(node.id, node)
    } else {
      blocked.push({ id: node?.id ?? null, repo: node?.repo ?? null, path: node?.path ?? null, reasons: verdict.reasons })
    }
  }

  const allowedEdges = []
  for (const edge of edges) {
    if (byId.has(edge.source) && byId.has(edge.target)) allowedEdges.push(edge)
    else blocked.push({ edge, reasons: ['edge-endpoint-blocked'] })
  }

  return {
    target: projectionTarget(target),
    nodes: allowedNodes,
    edges: allowedEdges,
    blocked,
  }
}

export function publicSourceVerdict(nodes, kgIds) {
  const byId = new Map((nodes ?? []).map((node) => [node.id, node]))
  const failures = []
  for (const kgId of kgIds) {
    const node = byId.get(kgId)
    if (!node) {
      failures.push({ kgId, reason: 'source-node-not-found' })
      continue
    }
    const verdict = canProjectNode(node, 'public')
    if (!verdict.ok) failures.push({ kgId, reason: verdict.reasons.join(','), audience: node.audience ?? null })
  }
  return { ok: failures.length === 0, failures }
}
