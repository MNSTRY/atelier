// Workspace model: the shared read model behind every graph-workspace room.
//
// Input is an Atelier knowledge graph (`mnstry.atelier-knowledge-graph@v1`) that a
// host has already limited to what the reader may see, plus an optional knowledge
// plan. Output is plain data the browser rooms can draw. This module reads no files,
// grants nothing and infers no relation:
// - zones come only from the owner's folder structure (a zone rule),
// - concept membership comes only from a record's own `concept:<id>` tag,
// - edges keep their declared direction and fall into three classes.

const SCHEMA = 'mnstry.atelier-knowledge-graph@v1'
export const EDGE_CLASSES = Object.freeze(['link', 'containment', 'relation'])

/** `related` is a written link, `belongs_to` is folder containment, anything else is a declared relation. */
export function edgeClass(type) {
  if (type === 'related') return 'link'
  if (type === 'belongs_to') return 'containment'
  return 'relation'
}

const humanize = folder => folder.replace(/^[_\d-]+/, '').replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase()) || 'Other'

export function validateZoneRule(rule = {}) {
  const prefix = rule.prefix ?? ''
  const depth = rule.depth ?? 1
  if (typeof prefix !== 'string' || prefix.includes('..') || prefix.startsWith('/')) throw new TypeError('Zone rule prefix must be a relative path prefix')
  if (!Number.isInteger(depth) || depth < 1 || depth > 4) throw new TypeError('Zone rule depth must be an integer from 1 to 4')
  const labels = rule.labels ?? {}
  if (typeof labels !== 'object' || Array.isArray(labels) || Object.values(labels).some(v => typeof v !== 'string' || v.length > 80)) throw new TypeError('Zone rule labels must map folders to short names')
  return { prefix, depth, labels: { ...labels }, rootLabel: typeof rule.rootLabel === 'string' ? rule.rootLabel.slice(0, 80) : 'Workspace root' }
}

/** The owner-configured zone of a record path. Records outside the prefix share one root zone. */
export function zoneOf(path, rule) {
  const r = validateZoneRule(rule)
  if (typeof path !== 'string' || !path.startsWith(r.prefix)) return { id: '_root', label: r.rootLabel }
  const parts = path.slice(r.prefix.length).split('/')
  if (parts.length <= r.depth) return { id: '_root', label: r.rootLabel }
  const folder = parts.slice(0, r.depth).join('/')
  return { id: folder, label: r.labels[folder] ?? humanize(folder.split('/').at(-1)) }
}

export function buildWorkspaceModel({ graph, plan = null, zoneRule = {}, summaryLength = 280 }) {
  if (graph?.schema !== SCHEMA || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new TypeError('An Atelier knowledge graph v1 is required')
  const rule = validateZoneRule(zoneRule)
  const seenIds = new Set()
  const nodes = graph.nodes.map(n => {
    if (typeof n.id !== 'string' || !n.id || seenIds.has(n.id)) throw new TypeError('Knowledge graph node ids must be unique non-empty strings')
    seenIds.add(n.id)
    const zone = zoneOf(n.path ?? '', rule)
    const tags = Array.isArray(n.tags) ? n.tags.filter(t => typeof t === 'string') : []
    return {
      id: n.id, title: typeof n.title === 'string' && n.title ? n.title : n.id,
      summary: typeof n.summary === 'string' ? n.summary.split('\n')[0].slice(0, summaryLength) : '',
      type: n.type ?? 'document', status: n.status ?? null, audience: n.audience ?? null, path: n.path ?? null,
      tags: tags.filter(t => !t.startsWith('concept:')).slice(0, 8),
      concepts: tags.filter(t => t.startsWith('concept:')).map(t => t.slice(8)),
      zone: zone.id, zoneLabel: zone.label, degree: 0, relationDegree: 0,
    }
  })
  const byId = new Map(nodes.map(n => [n.id, n]))
  const edges = []
  const seen = new Set()
  let outside = 0
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) { outside++; continue }
    if (e.source === e.target) continue
    const key = `${e.source}\u0000${e.target}\u0000${e.type}`
    if (seen.has(key)) continue
    seen.add(key)
    const kind = edgeClass(e.type)
    edges.push({ id: 'e' + edges.length, source: e.source, target: e.target, type: e.type, kind, declared: e.declared !== false })
    for (const id of [e.source, e.target]) { const n = byId.get(id); n.degree++; if (kind === 'relation') n.relationDegree++ }
  }
  const counts = new Map()
  for (const n of nodes) counts.set(n.zone, { id: n.zone, label: n.zoneLabel, count: (counts.get(n.zone)?.count ?? 0) + 1 })
  const zones = [...counts.values()].sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1)).map((z, index) => ({ ...z, index }))
  return {
    schema: 'atelier.graph-workspace-model@v1',
    coverage: { records: nodes.length, links: edges.length, linksOutsideReadableSet: outside, byClass: Object.fromEntries(EDGE_CLASSES.map(k => [k, edges.filter(e => e.kind === k).length])) },
    nodes, edges, zones,
    plan: plan ? planModel(plan, nodes) : null,
  }
}

function planModel(plan, nodes) {
  const concepts = Array.isArray(plan.concepts) ? plan.concepts.filter(c => typeof c?.id === 'string') : []
  const ids = new Set(concepts.map(c => c.id))
  return {
    purpose: typeof plan.purpose === 'string' ? plan.purpose : null,
    concepts: concepts.map(c => ({
      id: c.id, title: typeof c.title === 'string' ? c.title : c.id.replace(/-/g, ' ').replace(/^\w/, x => x.toUpperCase()),
      definition: c.definition ?? '', identityRule: c.identityRule ?? '',
      declaredBy: nodes.filter(n => n.concepts.includes(c.id)).map(n => n.id),
    })),
    relations: (plan.relations ?? []).filter(r => ids.has(r.from) && ids.has(r.to)).map(r => ({ id: r.id, predicate: r.predicate, from: r.from, to: r.to, meaning: r.meaning ?? '' })),
    questions: (plan.questions ?? []).map(q => ({ id: q.id, question: q.question ?? q.title ?? q.id, concepts: (q.concepts ?? []).filter(id => ids.has(id)), relations: q.relations ?? [] })),
  }
}

/** Neighbour ids of a record, in either direction, without duplicates. */
export function neighbours(model, id) {
  const out = new Set()
  for (const e of model.edges) { if (e.source === id) out.add(e.target); else if (e.target === id) out.add(e.source) }
  return [...out]
}
