// Label placement for dense graphs. Pure: give it candidates, a text measurer and
// the space available; it returns where each label goes, or leaves it out.
// - importance first; zoom and a budget decide how deep into the list to go,
// - four slots per label (right, left, above, below), first free slot wins,
// - nothing overlaps another label, a reserved rectangle (zone names, chrome) or the edge,
// - secondary labels are left out rather than shrunk.

export const overlaps = (a, b, gap = 0) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top

/**
 * candidates: [{ id, x, y, r, priority, text, size }] in viewport pixels (any order).
 * measure(text, size, emphasis) → width in pixels.
 * Returns placed labels [{ id, text, size, x, y, left, right, top, bottom }].
 */
export function placeLabels({ candidates, measure, width, height, reserved = [], budget = 25, threshold = 0, margin = 4, cell = 80, minSize = 11 }) {
  if (typeof measure !== 'function') throw new TypeError('A text measurer is required')
  const ordered = candidates.filter(c => c.priority >= threshold && Number.isFinite(c.x) && Number.isFinite(c.y)).sort((a, b) => b.priority - a.priority)
  const grid = new Map()
  const cellsFor = r => { const out = []; for (let x = Math.floor(r.left / cell); x <= Math.floor(r.right / cell); x++) for (let y = Math.floor(r.top / cell); y <= Math.floor(r.bottom / cell); y++) out.push(x + ',' + y); return out }
  const placed = []
  for (const c of ordered) {
    if (placed.length >= budget) break
    const size = Math.max(minSize, c.size ?? 12)
    const w = measure(c.text, size, !!c.emphasis)
    const half = size * 0.72
    const r = c.r ?? 4
    const slots = [[c.x + r + 5, c.y], [c.x - r - 5 - w, c.y], [c.x - w / 2, c.y - r - size * 0.9], [c.x - w / 2, c.y + r + size * 0.9]]
    for (const [sx, sy] of slots) {
      const rect = { left: sx - 3, right: sx + w + 3, top: sy - half, bottom: sy + half }
      if (rect.left < margin || rect.top < margin || rect.right > width - margin || rect.bottom > height - margin) continue
      const cells = cellsFor(rect)
      if (cells.some(k => (grid.get(k) ?? []).some(o => overlaps(o, rect, 3)))) continue
      if (reserved.some(o => overlaps(o, rect, 4))) continue
      for (const k of cells) { if (!grid.has(k)) grid.set(k, []); grid.get(k).push(rect) }
      placed.push({ id: c.id, text: c.text, size, x: sx, y: sy, ...rect })
      break
    }
  }
  return placed
}

/** Rank-based label threshold for a camera ratio (1 = whole graph fitted, smaller = closer). */
export function labelThreshold(ratio, boost = 1) {
  return Math.max(0, Math.min(0.94, 0.8 * ratio - 0.04)) / Math.max(0.1, boost)
}

/** Label budget for a viewport: about 20–25 at a fitted desktop view, more as you zoom in. */
export function labelBudget(width, height, ratio, boost = 1, cap = 45) {
  return Math.round(Math.min(cap, Math.max(10, (width * height) / 52000 / Math.max(0.35, Math.min(1, ratio)))) * boost)
}
