// Presentation geometry for the constellation. Positions are presentation only:
// distance never asserts a relation. The force layout itself is injected so this
// package carries no layout dependency; any ForceAtlas2-compatible function works.

function prng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

/** Zone-seeded starting positions, deterministic for a seed. */
export function seedPositions(model, { seed = 3 } = {}) {
  const rnd = prng(seed)
  const n = Math.max(1, model.zones.length)
  const index = new Map(model.zones.map(z => [z.id, z.index]))
  const out = new Map()
  for (const node of model.nodes) {
    const zi = index.get(node.zone) ?? 0
    const angle = (zi / n) * Math.PI * 2
    const r = 60 + zi * 6
    out.set(node.id, { x: Math.cos(angle) * r + (rnd() - 0.5) * 40, y: Math.sin(angle) * r + (rnd() - 0.5) * 40 })
  }
  return out
}

/** Edge weights for a force layout: declared relations pull hardest, written links least. */
export const LAYOUT_WEIGHTS = Object.freeze({ relation: 1, containment: 0.45, link: 0.22 })

/**
 * Run an injected force layout and write normalised x/y onto model nodes.
 * `Graph` is a graphology constructor; `forceAtlas2` the graphology-layout-forceatlas2 default export.
 */
export function layoutWorkspace(model, { Graph, forceAtlas2, seed = 3, iterations = 700, settings = {} }) {
  if (typeof Graph !== 'function' || typeof forceAtlas2?.assign !== 'function') throw new TypeError('Inject a graphology Graph and a ForceAtlas2 implementation')
  const graph = new Graph({ type: 'directed', multi: true, allowSelfLoops: false })
  const start = seedPositions(model, { seed })
  for (const node of model.nodes) graph.addNode(node.id, { ...start.get(node.id), size: 1 + Math.sqrt(node.degree) })
  for (const e of model.edges) graph.addEdge(e.source, e.target, { weight: LAYOUT_WEIGHTS[e.kind] ?? 0.22 })
  const resolved = { ...forceAtlas2.inferSettings(graph), linLogMode: true, outboundAttractionDistribution: true, adjustSizes: false, barnesHutOptimize: graph.order > 600, barnesHutTheta: 0.6, gravity: 0.12, scalingRatio: 14, slowDown: 2, edgeWeightInfluence: 1, ...settings }
  forceAtlas2.assign(graph, { iterations, settings: resolved, getEdgeWeight: 'weight' })
  const positions = new Map()
  graph.forEachNode((id, a) => positions.set(id, { x: a.x, y: a.y }))
  normalizePositions(model, positions)
  return { algorithm: 'forceatlas2-linlog', iterations, settings: resolved }
}

/** Fit positions into a stable 1000-unit frame centred on the origin and write them onto nodes. */
export function normalizePositions(model, positions) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of positions.values()) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y) }
  const scale = 1000 / Math.max(maxX - minX, maxY - minY, 1)
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  for (const node of model.nodes) {
    const p = positions.get(node.id) ?? { x: cx, y: cy }
    node.x = Math.round((p.x - cx) * scale * 10) / 10
    node.y = Math.round((p.y - cy) * scale * 10) / 10
  }
  return model
}

/** Zone glow and label geometry: a coarse density grid per zone and an anchor on its densest area. */
export function zoneGeometry(model, { cell = 55 } = {}) {
  const out = []
  for (const zone of model.zones) {
    const members = model.nodes.filter(n => n.zone === zone.id && Number.isFinite(n.x) && Number.isFinite(n.y))
    if (!members.length) continue
    const cx = members.reduce((s, n) => s + n.x, 0) / members.length
    const cy = members.reduce((s, n) => s + n.y, 0) / members.length
    const grid = new Map()
    for (const n of members) {
      const k = Math.round(n.x / cell) + ',' + Math.round(n.y / cell)
      const g = grid.get(k) ?? { x: 0, y: 0, count: 0 }
      g.x += n.x; g.y += n.y; g.count++
      grid.set(k, g)
    }
    const blobs = [...grid.values()].map(g => ({ x: Math.round(g.x / g.count), y: Math.round(g.y / g.count), weight: g.count }))
    const score = b => b.weight / (1 + Math.hypot(b.x - cx, b.y - cy) / 120)
    const anchor = blobs.reduce((best, b) => score(b) > score(best) ? b : best, blobs[0])
    out.push({ id: zone.id, label: zone.label, count: zone.count, index: zone.index, anchor: { x: anchor.x, y: anchor.y }, blobs })
  }
  return out
}
