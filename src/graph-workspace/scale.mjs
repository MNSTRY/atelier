// Scale primitives for workspaces with tens of thousands of records.
//
// The map draws every readable record while that stays legible and fast.
// Beyond a budget, the whole is shown as zones (with honest counts and directed
// bundles between them) and a person opens one zone at a time. Nothing here hides
// a record silently: every bounded result states what it left out.

export const DEFAULT_BUDGET = Object.freeze({ records: 12000, links: 60000 })

/** Decide how the whole should be drawn for this model and budget. */
export function planMap(model, budget = DEFAULT_BUDGET) {
  const records = model.nodes.length, links = model.edges.length
  if (records <= budget.records && links <= budget.links) return { mode: 'records', records, links }
  return { mode: 'zones', records, links, reason: records > budget.records ? 'records-over-budget' : 'links-over-budget', budget: { ...budget } }
}

/** Zone-level summary of the whole: counts by type and directed bundles by edge class. */
export function aggregateZones(model) {
  const zoneOfId = new Map(model.nodes.map(n => [n.id, n.zone]))
  const zones = model.zones.map(z => ({ id: z.id, label: z.label, index: z.index, count: z.count, types: Object.create(null), declaredRelations: 0 }))
  const byId = new Map(zones.map(z => [z.id, z]))
  for (const n of model.nodes) { const z = byId.get(n.zone); z.types[n.type] = (z.types[n.type] ?? 0) + 1 }
  const bundles = new Map()
  let internal = 0
  for (const e of model.edges) {
    const a = zoneOfId.get(e.source), b = zoneOfId.get(e.target)
    if (a === b) { internal++; if (e.kind === 'relation') byId.get(a).declaredRelations++; continue }
    const key = a + '\u0000' + b
    const bundle = bundles.get(key) ?? { from: a, to: b, total: 0, link: 0, containment: 0, relation: 0 }
    bundle.total++; bundle[e.kind]++
    bundles.set(key, bundle)
  }
  return {
    schema: 'atelier.graph-workspace-zones@v1',
    coverage: { records: model.nodes.length, zones: zones.length, linksInsideZones: internal, linksBetweenZones: model.edges.length - internal, linksOutsideReadableSet: model.coverage.linksOutsideReadableSet },
    zones,
    bundles: [...bundles.values()].sort((x, y) => y.total - x.total || (x.from + x.to < y.from + y.to ? -1 : 1)),
  }
}

/** Records ranked by connection count, then title, for budgets and label priority. */
export function rankRecords(model) {
  return [...model.nodes].sort((a, b) => b.degree - a.degree || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0))
}

/**
 * A bounded sub-model for one zone. Members are kept by rank up to `limit`.
 * Every link touching the zone is accounted for exactly once:
 *   drawn (both ends kept) + omittedInsideZone + toOtherZones + omittedToOtherZones = links touching the zone.
 * Plan concept declarations are projected onto the kept records, with omissions counted.
 */
export function zoneSlice(model, zoneId, { limit = DEFAULT_BUDGET.records } = {}) {
  const members = rankRecords(model).filter(n => n.zone === zoneId)
  const kept = members.slice(0, limit)
  const keep = new Set(kept.map(n => n.id))
  const inZone = new Set(members.map(n => n.id))
  const zoneOfId = new Map(model.nodes.map(n => [n.id, n.zone]))
  const edges = []
  const boundary = new Map()
  let omittedInsideZone = 0, omittedToOtherZones = 0, touching = 0
  for (const e of model.edges) {
    const s = inZone.has(e.source), t = inZone.has(e.target)
    if (!s && !t) continue
    touching++
    if (keep.has(e.source) && keep.has(e.target)) { edges.push(e); continue }
    if (s && t) { omittedInsideZone++; continue }
    const memberEnd = s ? e.source : e.target
    if (!keep.has(memberEnd)) { omittedToOtherZones++; continue }
    const other = zoneOfId.get(s ? e.target : e.source)
    boundary.set(other, (boundary.get(other) ?? 0) + 1)
  }
  const toOtherZones = [...boundary.values()].reduce((a, b) => a + b, 0)
  const byClass = { link: 0, containment: 0, relation: 0 }
  for (const e of edges) byClass[e.kind]++
  const plan = model.plan ? {
    ...model.plan,
    concepts: model.plan.concepts.map(c => {
      const declaredBy = c.declaredBy.filter(id => keep.has(id))
      return { ...c, declaredBy, omittedDeclarations: c.declaredBy.length - declaredBy.length }
    }),
  } : null
  return {
    ...model,
    nodes: kept.map(n => ({ ...n })),
    edges,
    zones: model.zones.filter(z => z.id === zoneId).map(z => ({ ...z, count: kept.length })),
    plan,
    coverage: { records: kept.length, links: edges.length, byClass, linksOutsideReadableSet: model.coverage.linksOutsideReadableSet },
    slice: {
      zone: zoneId, membersInZone: members.length, omittedRecords: members.length - kept.length,
      linksTouchingZone: touching, omittedLinksInsideZone: omittedInsideZone, omittedLinksToOtherZones: omittedToOtherZones, linksToOtherZonesCount: toOtherZones,
      linksToOtherZones: [...boundary.entries()].map(([zone, count]) => ({ zone, count })).sort((a, b) => b.count - a.count),
    },
  }
}

/** Deprecated alpha.15 name of `planMap`, kept for one release. */
export const planConstellation = planMap
