import path from 'node:path'
import { canProjectNode, projectGraph } from './policy.mjs'

export const ALIGNMENT_PROJECTION_SCHEMA = 'mnstry.alignment-projection@v1'
export const PROJECTION_POLICY_VERSION = 'projection-policy@v1'

// Root graph names are workspace-configured via sduiMap.rootGraphs. The kit
// ships no defaults, so name-based alignment classification stays inactive
// until a workspace supplies its own graph names.
export const DEFAULT_ROOT_GRAPHS = []

export const DEFAULT_PROOF_GATES = [
  'tenant-purity',
  'token-check',
  'sdui-check',
  'action-check',
  'media-check',
  'consent-check',
  'provider-check',
  'browser-proof',
  'storybook-proof',
]

function posixRelative(root, file) {
  if (!root || !file) return file ?? null
  return path.relative(root, file).split(path.sep).join('/')
}

function defaultSourceCommitResolver() {
  return null
}

export function projectionRecord(node, { target = 'team', sourceCommitResolver = defaultSourceCommitResolver } = {}) {
  const verdict = canProjectNode(node, target)
  return {
    target,
    sourceKgId: node.id,
    allowed: verdict.ok,
    reasons: verdict.reasons,
    policyVersion: PROJECTION_POLICY_VERSION,
    sourceCommit: sourceCommitResolver(node),
  }
}

export function stableProjectionForCheck(value) {
  return {
    ...value,
    generatedAt: null,
    projectionRecords: (value?.projectionRecords ?? []).map((record) => ({ ...record, sourceCommit: null })),
  }
}

function hasAlignmentPath(node, alignmentRepo, alignmentRoot) {
  if (!alignmentRepo || !alignmentRoot) return false
  return node.repo === alignmentRepo && String(node.path ?? '').startsWith(alignmentRoot.replace(/\/?$/, '/'))
}

function isAlignmentNode(node, { alignmentRepo, alignmentRoot, alignmentTags, rootGraphs }) {
  if (hasAlignmentPath(node, alignmentRepo, alignmentRoot)) return true
  const tags = new Set(node.tags ?? [])
  if (alignmentTags.some((tag) => tags.has(tag))) return true
  const haystack = [node.title, node.summary, node.path].join(' ').toLowerCase()
  return rootGraphs.some((name) => haystack.includes(name.toLowerCase()))
}

export function buildAlignmentProjection({
  graph,
  target = 'team',
  workspaceRoot = null,
  graphPath = null,
  sduiMap = {},
  conformance = {},
  tenantTheme = {},
  tokenReport = '',
  alignmentRepo = null,
  alignmentRoot = null,
  alignmentTags = ['mnstry-alignment', 'sdui'],
  rootGraphs = sduiMap.rootGraphs ?? DEFAULT_ROOT_GRAPHS,
  proofGates = DEFAULT_PROOF_GATES,
  previousProjection = null,
  now = () => new Date(),
  sourceCommitResolver = defaultSourceCommitResolver,
  source = {},
} = {}) {
  const gatedGraph = projectGraph(graph ?? { nodes: [], edges: [] }, { target })
  const alignmentNodes = (gatedGraph.nodes ?? []).filter((node) =>
    isAlignmentNode(node, { alignmentRepo, alignmentRoot, alignmentTags, rootGraphs })
  )
  const alignmentIds = new Set(alignmentNodes.map((node) => node.id))
  const alignmentEdges = (gatedGraph.edges ?? []).filter((edge) => alignmentIds.has(edge.source) || alignmentIds.has(edge.target))
  const audienceCounts = {}
  const statusCounts = {}

  for (const node of alignmentNodes) {
    audienceCounts[node.audience] = (audienceCounts[node.audience] ?? 0) + 1
    statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1
  }

  const primitiveMap = sduiMap.primitiveMap ?? []
  const gaps = []
  for (const node of alignmentNodes) {
    if (!node.surfaced && String(node.path ?? '').endsWith('.md')) {
      gaps.push({ severity: 'info', type: 'unsurfaced-alignment-doc', node: node.id, path: `${node.repo}/${node.path}` })
    }
    if (hasAlignmentPath(node, alignmentRepo, alignmentRoot) && !Object.values(node.relations ?? {}).some((targets) => Array.isArray(targets) && targets.length)) {
      gaps.push({ severity: 'info', type: 'missing-declared-relations', node: node.id, path: `${node.repo}/${node.path}` })
    }
  }

  for (const diagnostic of graph?.diagnostics ?? []) {
    gaps.push({
      severity: diagnostic.severity ?? 'warning',
      type: diagnostic.type ?? 'graph-diagnostic',
      node: diagnostic.node ?? null,
      path: diagnostic.path ? `${diagnostic.repo}/${diagnostic.path}` : null,
      message: diagnostic.message ?? '',
    })
  }

  const projectionRecords = (graph?.nodes ?? []).map((node) => projectionRecord(node, { target, sourceCommitResolver }))
  const projection = {
    schema: ALIGNMENT_PROJECTION_SCHEMA,
    generatedAt: previousProjection?.generatedAt ?? now().toISOString(),
    source: {
      graph: source.graph ?? posixRelative(workspaceRoot, graphPath),
      sduiMap: source.sduiMap ?? null,
      conformanceContract: source.conformanceContract ?? null,
    },
    summary: {
      graphNodes: graph?.nodeCount ?? graph?.nodes?.length ?? 0,
      graphEdges: graph?.edgeCount ?? graph?.edges?.length ?? 0,
      alignmentNodes: alignmentNodes.length,
      alignmentEdges: alignmentEdges.length,
      rootGraphs: rootGraphs.length,
      sduiMappings: primitiveMap.length,
      proofGates: proofGates.length,
      audienceCounts,
      statusCounts,
      gaps: gaps.length,
      blockedByProjection: gatedGraph.blocked.length,
      diagnostics: (graph?.diagnostics ?? []).length,
    },
    projectionGate: {
      target: gatedGraph.target,
      blocked: gatedGraph.blocked,
    },
    projectionRecords,
    rootGraphs,
    proofGates,
    contracts: {
      conformanceVersion: conformance.version ?? conformance.contractVersion ?? null,
      tenantThemeName: tenantTheme.name ?? tenantTheme.project ?? null,
      tokenReportPresent: Boolean(String(tokenReport).trim()),
      acceptedSduiPrimitiveCount: sduiMap.acceptedSduiPrimitives?.length ?? 0,
    },
    nodes: alignmentNodes,
    edges: alignmentEdges,
    primitiveMap,
    gaps,
  }

  const comparableProjection = stableProjectionForCheck(projection)
  const comparablePrevious = previousProjection ? stableProjectionForCheck(previousProjection) : null
  if (JSON.stringify(comparableProjection) !== JSON.stringify(comparablePrevious)) {
    projection.generatedAt = now().toISOString()
  }

  return projection
}
