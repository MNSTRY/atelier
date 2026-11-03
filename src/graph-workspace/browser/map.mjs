// Renderer dependencies are injected so Atelier carries no graph-drawing package:
//   deps = { Sigma, Graph, EdgeArrowProgram, FA2Layout? }  (sigma 3, graphology,
//   sigma/rendering's EdgeArrowProgram, graphology-layout-forceatlas2/worker).
//
// The map: every readable record, alive. Sigma (WebGL) draws nodes and
// edges; two canvases around it draw zone glows (behind) and labels (in front).
// Labels are placed by priority with collision checks, faded by zoom, and drawn
// with a halo instead of a box. Hovering lights a neighbourhood; selecting keeps it.
// Selecting never moves the camera. "Show on map" and "Open" are explicit.
import { zoneGeometry, LAYOUT_WEIGHTS } from '../geometry.mjs'
import { placeLabels, labelThreshold, labelBudget } from '../labels.mjs'

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const hexToRgba = (hex, a) => { const n = parseInt(hex.slice(1, 7), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})` }
const mix = (a, b, t) => { const p = parseInt(a.slice(1, 7), 16), q = parseInt(b.slice(1, 7), 16); const c = s => Math.round(((p >> s) & 255) * (1 - t) + ((q >> s) & 255) * t); return '#' + [16, 8, 0].map(s => c(s).toString(16).padStart(2, '0')).join('') }

export function createMap({ container, model, palette, font = 'system-ui, sans-serif', deps, reserveSelector = '[data-graph-reserve]', onSelect = () => {}, onHover = () => {}, onOpen = () => {} }) {
  const { Sigma, Graph, EdgeArrowProgram, FA2Layout = null } = deps ?? {}
  if (typeof Sigma !== 'function' || typeof Graph !== 'function' || typeof EdgeArrowProgram !== 'function') throw new TypeError('Inject sigma 3 (Sigma, EdgeArrowProgram) and graphology (Graph)')
  if (model.nodes.some(n => !Number.isFinite(n.x) || !Number.isFinite(n.y))) throw new TypeError('Lay the model out first (layoutWorkspace or stored positions)')
  const zones = new Map(model.zones.map(z => [z.id, z]))
  const zoneColor = id => palette.zones[(zones.get(id)?.index ?? 0) % palette.zones.length]
  const graph = new Graph({ type: 'directed', multi: true })
  const byId = new Map(model.nodes.map(n => [n.id, n]))
  // Label importance is the record's connection rank (0..1), so it adapts to any degree spread.
  const ranked = [...model.nodes].sort((a, b) => b.degree - a.degree || (a.title < b.title ? -1 : 1))
  const rank = new Map(ranked.map((n, i) => [n.id, 1 - i / Math.max(1, ranked.length - 1)]))
  const widthCache = new Map()
  for (const n of model.nodes) {
    graph.addNode(n.id, { x: n.x, y: n.y, finalX: n.x, finalY: n.y, size: Math.min(10, 1.3 + 0.95 * Math.log2(1 + n.degree)), color: zoneColor(n.zone), label: n.title, zone: n.zone })
  }
  for (const e of model.edges) graph.addEdgeWithKey(e.id, e.source, e.target, { structural: e.kind === 'relation', kind: e.kind, type: 'line' })

  const zoneCanvas = document.createElement('canvas')
  const labelCanvas = document.createElement('canvas')
  zoneCanvas.className = 'layer-zones'
  labelCanvas.className = 'layer-labels'
  zoneCanvas.setAttribute('aria-hidden', 'true')
  labelCanvas.setAttribute('aria-hidden', 'true')
  const sigmaHost = document.createElement('div')
  sigmaHost.className = 'layer-sigma'
  // The room styles target .map; a container marked only .constellation (alpha.15) gets both.
  container.classList.add('map')
  container.replaceChildren(zoneCanvas, sigmaHost, labelCanvas)

  // Node sizes are in screen pixels; a small viewport needs proportionally smaller dots.
  const sizeScale = () => Math.max(0.45, Math.min(1, Math.min(container.clientWidth, container.clientHeight) / 820))
  const state = { hovered: null, selected: null, lens: null, dimAll: false, neighbours: new Set(), lit: null, zonesOn: true, linksOn: true, labelBoost: 1, focusZone: null }
  let geometry = model.zoneGeometry ?? zoneGeometry(model)
  let placedLabels = []
  let frameTimes = []
  const overlayTimes = []

  function neighbourhood(id) {
    const set = new Set([id])
    if (id && graph.hasNode(id)) graph.forEachNeighbor(id, n => set.add(n))
    return set
  }
  function activeSet() {
    if (state.hovered) return neighbourhood(state.hovered)
    if (state.selected) return neighbourhood(state.selected)
    return null
  }

  let renderer = null
  renderer = new Sigma(graph, sigmaHost, {
    renderLabels: false,
    renderEdgeLabels: false,
    defaultEdgeType: 'line',
    edgeProgramClasses: { arrow: EdgeArrowProgram },
    zIndex: true,
    minCameraRatio: 0.035,
    maxCameraRatio: 1.6,
    stagePadding: 40,
    hideEdgesOnMove: false,
    defaultDrawNodeHover: () => {},
    nodeReducer(node, data) {
      const set = activeSet()
      const lit = state.lit
      const res = { ...data, size: data.size * sizeScale() }
      if (set) {
        if (!set.has(node)) { res.color = mix(data.color, palette.dim, 0.82); res.zIndex = 0 }
        else { res.zIndex = 2; if (node === state.hovered || node === state.selected) { res.size = data.size * 1.35; res.color = data.color } }
      } else if (lit) {
        if (!lit.has(node)) { res.color = mix(data.color, palette.dim, 0.86); res.zIndex = 0 } else res.zIndex = 2
      } else if (state.focusZone && data.zone !== state.focusZone) {
        res.color = mix(data.color, palette.dim, 0.7)
      }
      return res
    },
    edgeReducer(edge, data) {
      const res = { ...data }
      const [s, t] = graph.extremities(edge)
      const set = activeSet()
      if (set) {
        const focus = state.hovered ?? state.selected
        if (s !== focus && t !== focus) { res.hidden = true; return res }
        res.color = data.structural ? palette.edgeStructural : mix(palette.edge, palette.canvas, 0.15)
        res.size = data.structural ? 1.8 : 1
        if (data.structural) res.type = 'arrow'
        res.zIndex = 2
        return res
      }
      if (state.lit) {
        if (!(state.lit.has(s) && state.lit.has(t))) { res.hidden = true; return res }
        res.color = mix(palette.edgeStructural, palette.canvas, 0.35); res.size = 1; return res
      }
      // Close in, link-only edges become long strands across the view; keep declared ones.
      if (data.kind === 'link' && (!state.linksOn || state.near)) { res.hidden = true; return res }
      // Solid colours pre-mixed with the canvas: no alpha accumulation into white.
      res.color = data.structural ? mix(palette.edgeStructural, palette.canvas, 0.45) : data.kind === 'containment' ? mix(palette.edge, palette.canvas, 0.86) : mix(palette.edge, palette.canvas, 0.8)
      res.size = data.structural ? 1.1 : 0.45
      return res
    },
  })
  const camera = renderer.getCamera()
  state.near = false
  camera.on('updated', s => { const near = s.ratio < 0.3; if (near !== state.near) { state.near = near; renderer.refresh({ skipIndexation: true }) } })

  // ── Layers ──
  function sizeCanvas(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = container.clientWidth, h = container.clientHeight
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr)
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px'
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    return { ctx, w, h }
  }
  function unitPixels() {
    const a = renderer.graphToViewport({ x: 0, y: 0 }), b = renderer.graphToViewport({ x: 100, y: 0 })
    return Math.hypot(b.x - a.x, b.y - a.y) / 100
  }
  let glow = null
  function buildGlow() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const z of geometry) for (const b of z.blobs) { const r = 34 + 11 * Math.sqrt(b.weight); minX = Math.min(minX, b.x - r); maxX = Math.max(maxX, b.x + r); minY = Math.min(minY, b.y - r); maxY = Math.max(maxY, b.y + r) }
    const size = 1400, scale = size / Math.max(maxX - minX, maxY - minY, 1)
    const canvas = document.createElement('canvas')
    canvas.width = Number.isFinite(minX) ? Math.ceil((maxX - minX) * scale) : 0; canvas.height = Number.isFinite(minY) ? Math.ceil((maxY - minY) * scale) : 0
    const ctx = canvas.getContext('2d')
    ctx.globalCompositeOperation = palette.mode === 'dark' ? 'lighter' : 'multiply'
    for (const zone of geometry) {
      const color = zoneColor(zone.id)
      for (const blob of zone.blobs) {
        const x = (blob.x - minX) * scale, y = (blob.y - minY) * scale, r = (34 + 11 * Math.sqrt(blob.weight)) * scale
        const g = ctx.createRadialGradient(x, y, 0, x, y, r)
        const a = (palette.mode === 'dark' ? 0.085 : 0.06) * Math.min(2.2, Math.sqrt(blob.weight))
        g.addColorStop(0, hexToRgba(color, a)); g.addColorStop(1, hexToRgba(color, 0))
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      }
    }
    glow = { canvas, minX, minY, maxX, maxY }
  }
  function drawZones() {
    const { ctx } = sizeCanvas(zoneCanvas)
    if (!state.zonesOn) return
    if (!glow) buildGlow()
    // An empty or single-point readable set has no area to glow.
    if (!glow.canvas.width || !glow.canvas.height || !Number.isFinite(glow.minX)) return
    const a = renderer.graphToViewport({ x: glow.minX, y: glow.minY }), b = renderer.graphToViewport({ x: glow.maxX, y: glow.maxY })
    ctx.globalAlpha = (activeSet() || state.lit || state.focusZone) ? 0.45 : 1
    // The viewport flips the graph's y axis; mirror the glow image to match.
    const left = Math.min(a.x, b.x), width = Math.abs(b.x - a.x), height = Math.abs(b.y - a.y)
    if (a.y > b.y) { ctx.save(); ctx.translate(left, a.y); ctx.scale(1, -1); ctx.drawImage(glow.canvas, 0, 0, width, height); ctx.restore() }
    else ctx.drawImage(glow.canvas, left, a.y, width, height)
    ctx.globalAlpha = 1
  }
  let zoneLabelRects = []
  function reservedRects() {
    const host = container.getBoundingClientRect()
    return [...document.querySelectorAll(reserveSelector)].filter(el => !el.hidden).map(el => { const r = el.getBoundingClientRect(); return { left: r.left - host.left, top: r.top - host.top, right: r.right - host.left, bottom: r.bottom - host.top } }).filter(r => r.right > r.left)
  }
  function drawZoneNames(ctx, chrome) {
    const ratio = camera.ratio
    const dim = !!(activeSet() || state.lit)
    // Zone names: strongest when zoomed out, gone when close.
    const alpha = Math.max(0, Math.min(1, (ratio - 0.32) / 0.4)) * (dim ? 0.35 : 1)
    zoneLabelRects = []
    if (alpha <= 0.02 || !state.zonesOn) return
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const zone of [...geometry].sort((a, b) => b.count - a.count)) {
      const p = renderer.graphToViewport(zone.anchor)
      const size = Math.round(Math.min(19, 11 + Math.sqrt(zone.count) / 3))
      ctx.font = `600 ${size}px ${font}`
      ctx.letterSpacing = '0.14em'
      const text = zone.label.toUpperCase()
      const width = ctx.measureText(text).width
      const vw = container.clientWidth, vh = container.clientHeight
      p.x = Math.max(width / 2 + 10, Math.min(vw - width / 2 - 10, p.x))
      if (p.y < 70 || p.y > vh - 20) continue
      const rect = { left: p.x - width / 2 - 6, right: p.x + width / 2 + 6, top: p.y - size, bottom: p.y + size }
      if (zoneLabelRects.some(r => overlaps(r, rect, 4))) continue
      if (chrome.some(r => overlaps(r, rect, 4))) continue
      zoneLabelRects.push({ ...rect, zone: zone.id })
      ctx.letterSpacing = '0.14em'
      ctx.lineWidth = 5
      ctx.strokeStyle = hexToRgba(palette.labelHalo, 0.75 * alpha)
      ctx.strokeText(text, p.x, p.y)
      ctx.fillStyle = hexToRgba(zoneColor(zone.id), Math.min(1, 0.95 * alpha))
      ctx.fillText(text, p.x, p.y)
      ctx.letterSpacing = '0px'
    }
  }
  const overlaps = (a, b, gap = 0) => a.left < b.right + gap && a.right + gap > b.left && a.top < b.bottom + gap && a.bottom + gap > b.top

  function drawLabels() {
    const { ctx, w, h } = sizeCanvas(labelCanvas)
    const ratio = camera.ratio
    // Chrome claims its space first: no zone name or label under the host's controls.
    const chrome = reservedRects()
    drawZoneNames(ctx, chrome)
    ctx.letterSpacing = '0px'
    ctx.textAlign = 'left'
    const set = activeSet()
    const focus = state.hovered ?? state.selected
    const candidates = []
    // Importance first; zoom decides how deep into the list we go.
    // Bounded work per frame: the neighbourhood when one is active, otherwise the
    // highest-ranked records the current zoom could show.
    const pool = set ? [...set] : state.lit ? [...state.lit] : ranked.slice(0, Math.min(ranked.length, Math.round(ranked.length * Math.min(1, 1.15 - 0.8 * ratio) + 60))).map(n => n.id)
    if (state.selected && !pool.includes(state.selected)) pool.push(state.selected)
    for (const id of pool) {
      const node = byId.get(id)
      const display = renderer.getNodeDisplayData(id)
      if (!display || display.hidden) continue
      const p = renderer.framedGraphToViewport(display)
      if (p.x < -50 || p.y < -20 || p.x > w + 50 || p.y > h + 20) continue
      let priority = rank.get(id)
      let threshold = labelThreshold(ratio, state.labelBoost)
      if (set) { priority += id === focus ? 10 : 2; threshold = 0 }
      else if (state.lit) { priority += 1.5; threshold = Math.min(threshold, 0.25) }
      if (id === state.selected) { priority += 20; threshold = 0 }
      if (priority < threshold) continue
      candidates.push({ id, node, p, priority, r: renderer.scaleSize(display.size) })
    }
    const style = c => { const emphasis = c.id === focus || c.id === state.selected; return { emphasis, size: emphasis ? 14 : c.priority > 0.75 || set ? 12.5 : 11.5, weight: emphasis ? 650 : c.priority > 0.6 ? 560 : 450 } }
    const prepared = candidates.map(c => { const st = style(c); let text = c.node.title; if (text.length > 42 && !st.emphasis) text = text.slice(0, 40).trimEnd() + '\u2026'; return { id: c.id, x: c.p.x, y: c.p.y, r: c.r, priority: c.priority, text, size: st.size, emphasis: st.emphasis, weight: st.weight } })
    const weightOf = new Map(prepared.map(c => [c.id, c]))
    const measure = (text, size, emphasis) => {
      const c = prepared.find(x => x.text === text && x.size === size) ?? { weight: emphasis ? 650 : 450 }
      ctx.font = `${c.weight} ${size}px ${font}`
      const key = ctx.font + '|' + text
      let width = widthCache.get(key)
      if (width === undefined) { width = ctx.measureText(text).width; widthCache.set(key, width) }
      return width
    }
    const budget = set ? 60 : labelBudget(w, h, ratio, state.labelBoost)
    placedLabels = placeLabels({ candidates: prepared, measure, width: w, height: h, reserved: [...zoneLabelRects, ...chrome], budget })
    ctx.lineJoin = 'round'
    ctx.textBaseline = 'middle'
    for (const label of placedLabels) {
      const c = weightOf.get(label.id)
      ctx.font = `${c.weight} ${label.size}px ${font}`
      ctx.lineWidth = 3
      ctx.strokeStyle = hexToRgba(palette.labelHalo, 0.85)
      ctx.strokeText(label.text, label.x, label.y)
      ctx.fillStyle = c.emphasis ? palette.label : hexToRgba(palette.label, set && !c.emphasis ? 0.92 : Math.min(1, 0.62 + c.priority * 0.5))
      ctx.fillText(label.text, label.x, label.y)
    }
    // A selection ring, drawn here so it stays crisp at any zoom.
    if (state.selected && graph.hasNode(state.selected)) {
      const d = renderer.getNodeDisplayData(state.selected)
      if (d) {
        const p = renderer.framedGraphToViewport(d), r = renderer.scaleSize(d.size) + 5
        ctx.lineWidth = 2; ctx.strokeStyle = palette.selection
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke()
      }
    }
  }

  let last = performance.now()
  renderer.on('afterRender', () => {
    const now = performance.now()
    frameTimes.push(now - last); last = now
    if (frameTimes.length > 120) frameTimes.shift()
    const t0 = performance.now()
    drawZones()
    const t1 = performance.now()
    drawLabels()
    overlayTimes.push({ zones: t1 - t0, labels: performance.now() - t1 })
    if (overlayTimes.length > 120) overlayTimes.shift()
  })

  // ── Interaction ──
  let dragged = null, dragMoved = false
  renderer.on('enterNode', ({ node }) => { state.hovered = node; container.style.cursor = 'pointer'; onHover(node); renderer.refresh({ skipIndexation: true }) })
  renderer.on('leaveNode', () => { state.hovered = null; container.style.cursor = ''; onHover(null); renderer.refresh({ skipIndexation: true }) })
  renderer.on('clickNode', ({ node }) => { if (!dragMoved) onSelect(node) })
  renderer.on('doubleClickNode', ({ node, event }) => { event.preventSigmaDefault(); onOpen(node) })
  renderer.on('clickStage', () => { if (!dragMoved) onSelect(null) })
  renderer.on('downNode', ({ node }) => { dragged = node; dragMoved = false; graph.setNodeAttribute(node, 'fixed', true) })
  renderer.getMouseCaptor().on('mousemovebody', event => {
    if (!dragged) return
    dragMoved = true
    const p = renderer.viewportToGraph(event)
    graph.mergeNodeAttributes(dragged, { x: p.x, y: p.y })
    event.preventSigmaDefault(); event.original.preventDefault(); event.original.stopPropagation()
  })
  renderer.getMouseCaptor().on('mouseup', () => {
    if (dragged) { if (!physics) graph.removeNodeAttribute(dragged, 'fixed'); if (dragMoved) refreshGeometry() }
    dragged = null
    setTimeout(() => { dragMoved = false }, 0)
  })

  // ── Physics (play) ──
  let physics = null, geometryTimer = null
  function refreshGeometry() {
    const moved = { ...model, nodes: model.nodes.map(n => ({ ...n, x: graph.getNodeAttribute(n.id, 'x'), y: graph.getNodeAttribute(n.id, 'y') })) }
    geometry = zoneGeometry(moved)
    glow = null
  }
  function setPhysics(on) {
    if (on && !physics && !reduced() && FA2Layout) {
      graph.forEachEdge((e, a) => graph.setEdgeAttribute(e, 'weight', LAYOUT_WEIGHTS[a.kind] ?? 0.22))
      physics = new FA2Layout(graph, { settings: { linLogMode: true, outboundAttractionDistribution: true, gravity: 0.12, scalingRatio: 14, barnesHutOptimize: graph.order > 600, slowDown: 6 }, getEdgeWeight: 'weight' })
      physics.start()
      geometryTimer = setInterval(refreshGeometry, 400)
    } else if (!on && physics) {
      physics.kill(); physics = null; clearInterval(geometryTimer); refreshGeometry()
    }
    return !!physics
  }

  // ── Intro: the camera settles onto the whole while zones and labels fade in.
  // Camera-only, so no graph reindexing; skipped entirely under reduced motion.
  function intro() {
    if (reduced()) return Promise.resolve()
    camera.setState({ x: 0.5, y: 0.5, ratio: 1.55, angle: 0 })
    container.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' })
    return camera.animate({ ratio: 1 }, { duration: 1100, easing: 'cubicOut' })
  }

  const api = {
    renderer, graph, camera,
    intro,
    get hovered() { return state.hovered },
    select(id) { state.selected = id; renderer.refresh({ skipIndexation: true }) },
    setLens(ids) { state.lit = ids ? new Set(ids) : null; renderer.refresh({ skipIndexation: true }) },
    setFocusZone(zone) { state.focusZone = zone; renderer.refresh({ skipIndexation: true }) },
    setOption(key, value) { state[key] = value; renderer.refresh({ skipIndexation: true }) },
    setPhysics,
    get physics() { return !!physics },
    showNode(id, { ratio = 0.22, duration = 600 } = {}) {
      const d = renderer.getNodeDisplayData(id)
      if (!d) return Promise.resolve()
      return camera.animate({ x: d.x, y: d.y, ratio: Math.min(camera.ratio, ratio) }, { duration: reduced() ? 0 : duration })
    },
    dive(id) {
      const d = renderer.getNodeDisplayData(id)
      if (!d) return Promise.resolve(null)
      const before = camera.getState()
      return camera.animate({ x: d.x, y: d.y, ratio: 0.08 }, { duration: reduced() ? 0 : 520 }).then(() => ({ before }))
    },
    restore(cameraState) { return camera.animate(cameraState, { duration: reduced() ? 0 : 480 }) },
    fit() { return camera.animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: reduced() ? 0 : 450 }) },
    zoom(factor) { return camera.animate({ ratio: Math.max(0.035, Math.min(1.6, camera.ratio / factor)) }, { duration: reduced() ? 0 : 220 }) },
    nodeViewport(id) { const d = renderer.getNodeDisplayData(id); return d ? renderer.framedGraphToViewport(d) : null },
    labels: () => placedLabels.map(l => ({ ...l })),
    zoneLabels: () => zoneLabelRects.map(r => ({ ...r })),
    frameStats() { const s = [...frameTimes].sort((a, b) => a - b); const med = k => { const v = overlayTimes.map(o => o[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] ?? null }; return { samples: s.length, medianMs: s[Math.floor(s.length / 2)] ?? null, p90Ms: s[Math.floor(s.length * 0.9)] ?? null, overlayZonesMs: med('zones'), overlayLabelsMs: med('labels') } },
    setPalette(next) { Object.assign(palette, next); glow = null; graph.updateEachNodeAttributes((id, a) => ({ ...a, color: zoneColor(a.zone) }), { attributes: ['color'] }); renderer.refresh() },
    refresh() { renderer.refresh({ skipIndexation: true }) },
    kill() { setPhysics(false); renderer.kill(); container.replaceChildren() },
  }
  return api
}

/** Deprecated alpha.15 name of `createMap`, kept for one release. */
export const createConstellation = createMap
