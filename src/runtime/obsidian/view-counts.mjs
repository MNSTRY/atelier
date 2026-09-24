import { selectScope } from '../../projection/obsidian/contracts.mjs'
import { DEFAULT_ELIGIBILITY, buildGraph, profileFor } from './pipeline.mjs'

// How many notes a view would show on this machine, and why the other notes
// its selector names are withheld: the numbers a person sees before a view is
// declared or first opened. Read-only. The canonical graph is built as the
// engine builds it, with the same fail-closed eligibility, and the selection
// is the contract's own selectScope, so the count is the view's.

// { corpus, named, shown, withheld: { unclassified, audience }, truncated }: the notes of the project; those the
// view's selector names, whatever their classification and audience; those the view shows under `audienceAllow`
// (with its expansion); and, of the named ones, how many are withheld because they carry no classification, or an
// audience that is not admitted.
export function viewCounts({ project, audienceAllow, scope, workspaceId = 'ws-unprepared' }) {
  const graph = buildGraph({ project, eligibility: DEFAULT_ELIGIBILITY })
  const known = new Set(graph.nodes.map((node) => node.id))
  const edges = graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target))
  const profile = profileFor({ project, workspaceId, audienceAllow })
  const selection = selectScope({ canonicalSnapshot: { nodes: graph.nodes, edges }, profile, selector: scope.selector, expansion: scope.expansion, mode: scope.mode })
  // The same selector over every note made visible names what it would show if nothing were withheld.
  const everyNote = graph.nodes.map((node) => ({ ...node, eligible: true, audience: undefined }))
  const named = selectScope({ canonicalSnapshot: { nodes: everyNote, edges: [] }, profile, selector: scope.selector, mode: scope.mode === 'focus' ? 'scoped' : scope.mode }).nodes
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const allowed = new Set(audienceAllow)
  const withheld = { unclassified: 0, audience: 0 }
  for (const id of named) {
    const node = byId.get(id)
    if (node.eligible !== true) withheld.unclassified += 1
    else if (node.audience !== undefined && !allowed.has(node.audience)) withheld.audience += 1
  }
  return { corpus: graph.nodes.length, named: named.length, shown: selection.nodes.length, withheld, truncated: selection.truncated }
}
