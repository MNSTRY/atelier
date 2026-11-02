import { createSceneController } from './scene-controller.mjs'
import { assertGraphViewIntent } from '../intents.mjs'
import { refKey as suppliedRefKey } from '../refs.mjs'

const LIMIT = 48
const EDGE_LIMIT = 96
export const refKey = ref => {
  if (!ref || Object.keys(ref).sort().join(',') !== 'localId,repoId' ||
      ['repoId', 'localId'].some(field => typeof ref[field] !== 'string' || !ref[field].trim() || ref[field].length > 512)) {
    throw new TypeError('Qualified repository and local reference required')
  }
  return suppliedRefKey(ref)
}
const copyRef = ref => Object.freeze({ repoId: ref.repoId, localId: ref.localId })
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const clone = value => JSON.parse(JSON.stringify(value))

// Coordinates are a repeatable presentation of the received view, never relations.
// Compute once over the complete bounded input, then retain across lens changes.
export function layoutGraph(nodes) {
  const ordered = [...nodes].sort((a, b) => compare(refKey(a.ref), refKey(b.ref)))
  const width = Math.max(1, Math.ceil(Math.sqrt(ordered.length)))
  return new Map(ordered.map((node, index) => [refKey(node.ref), [
    (index % width - (width - 1) / 2) * 1.8,
    0,
    (Math.floor(index / width) - (Math.ceil(ordered.length / width) - 1) / 2) * 1.8,
  ]]))
}

function receive(view) {
  if (view?.schema !== 'atelier.graph-view@v1' || !/^sha256:[a-f0-9]{64}$/.test(view.projectionDigest ?? '')) {
    throw new TypeError('Versioned graph-view projection and digest required')
  }
  if (!Array.isArray(view.nodes) || !Array.isArray(view.edges) || view.nodes.length > 500 || view.edges.length > 2000) {
    throw new RangeError('Bounded graph-view envelope exceeded')
  }
  if (new TextEncoder().encode(JSON.stringify(view)).byteLength > 2 * 1024 * 1024) throw new RangeError('Bounded graph-view byte envelope exceeded')
  if (!Array.isArray(view.evidence) || view.evidence.length > 4000 || !Array.isArray(view.questions) || view.questions.length > 100 ||
      !Array.isArray(view.capabilities?.queries)) throw new TypeError('Bounded evidence, questions and query capabilities required')
  // Retain only presentation inputs and opaque intent targets. Source bodies,
  // host claims and arbitrary extension fields have no renderer storage path.
  const received = {
    schema: view.schema, projectionDigest: view.projectionDigest, completeness: view.completeness,
    nodes: view.nodes.map(node => ({ ref: copyRef(node.ref), title: node.title, displayEligible: node.displayEligible,
      sourceRef: { revision: node.sourceRef?.revision } })),
    edges: view.edges.map(edge => ({ edgeId: edge.edgeId, source: copyRef(edge.source), target: copyRef(edge.target),
      predicate: edge.predicate, acceptanceState: edge.acceptanceState })),
    evidence: view.evidence.map(item => ({ evidenceId: item.evidenceId })),
    questions: view.questions.map(item => ({ questionId: item.questionId })),
    capabilities: { queries: [...view.capabilities.queries] },
    page: view.page ? { limit: view.page.limit, offset: view.page.offset, nextCursor: view.page.nextCursor, truncated: view.page.truncated,
      returned: Object.fromEntries(['nodes','edges','evidence','questions','diagnostics'].map(key => [key, view.page.returned?.[key]])),
      omitted: Object.fromEntries(['nodes','edges','evidence','questions','diagnostics'].map(key => [key, view.page.omitted?.[key]])) } : null,
  }
  const nodes = new Map()
  for (const node of received.nodes) {
    const key = refKey(node.ref)
    if (nodes.has(key) || typeof node.title !== 'string' || !node.title.trim() || node.title.length > 4096 || node.displayEligible !== true) throw new TypeError('Unique eligible titled nodes required')
    if (typeof node.sourceRef?.revision !== 'string' || !node.sourceRef.revision) throw new TypeError('Source revision required')
    nodes.set(key, node)
  }
  const edgeIds = new Set()
  for (const edge of received.edges) {
    if (typeof edge.edgeId !== 'string' || !edge.edgeId || edgeIds.has(edge.edgeId) ||
        !nodes.has(refKey(edge.source)) || !nodes.has(refKey(edge.target)) ||
        typeof edge.predicate !== 'string' || !edge.predicate || edge.acceptanceState !== 'active') throw new TypeError('Unique active edges with received endpoints required')
    edgeIds.add(edge.edgeId)
  }
  return { view: received, nodes, positions: layoutGraph(received.nodes) }
}

// Reuses the retained DOM-free scene controller. This layer only maps the
// producer's graph-view refs into its transient versioned presentation bindings.
export function createGraphNavigator({ createPort, onIntent = () => {} }) {
  let current = null
  let selected = null
  let selectedEdgeId = null
  let questionId = null
  let focused = null
  let lens = 'all'
  let paused = false
  let disposed = false
  let shown = []
  let sceneEdgeCount = 0
  let sceneScope = null
  let matchingCount = 0
  let eligibleEdgeCount = 0
  let sceneController
  let sceneReady = false
  let activePort = null
  let preparedPort = null
  let silent = 0
  let publishing = false
  let publicationSelection = null

  function live() {
    if (disposed || !current) throw new Error('Graph navigator unavailable')
    return current
  }
  function nodeFor(ref) { return live().nodes.get(refKey(ref)) }
  function binding(node) {
    return { domain: 'atelier', kind: node.ref.repoId, id: node.ref.localId, revision: node.sourceRef.revision }
  }
  function emit(type, fields) {
    const intent = assertGraphViewIntent(live().view, { type, projectionDigest: live().view.projectionDigest, ...fields })
    // Notification failures cannot undo an already applied presentation change.
    if (!silent) try { onIntent(intent) } catch { /* The consuming host owns delivery recovery. */ }
    return intent
  }
  function candidates(input, nextLens, focus) {
    const endpoints = new Set(input.view.edges.filter(edge => nextLens === 'all' ||
      (nextLens === 'contradictions' && edge.predicate === 'contradicts') ||
      (nextLens === 'support' && ['supports', 'evidences'].includes(edge.predicate)))
      .flatMap(edge => [refKey(edge.source), refKey(edge.target)]))
    let result = [...input.nodes.values()].filter(node => nextLens === 'all' || endpoints.has(refKey(node.ref)) ||
      (focus && refKey(node.ref) === refKey(focus)))
    if (focus) {
      const key = refKey(focus)
      const neighbors = new Set(input.view.edges.filter(edge => refKey(edge.source) === key || refKey(edge.target) === key)
        .flatMap(edge => [refKey(edge.source), refKey(edge.target)]))
      result = result.filter(node => refKey(node.ref) === key || neighbors.has(refKey(node.ref)))
    }
    result.sort((a, b) => compare(refKey(a.ref), refKey(b.ref)))
    if (focus) result.sort((a, b) => Number(refKey(b.ref) === refKey(focus)) - Number(refKey(a.ref) === refKey(focus)))
    return result
  }
  function profile(input, nextLens, focus) {
    const matching = candidates(input, nextLens, focus)
    const visible = matching.slice(0, LIMIT)
    const visibleKeys = new Set(visible.map(node => refKey(node.ref)))
    const edges = input.view.edges.filter(edge => visibleKeys.has(refKey(edge.source)) && visibleKeys.has(refKey(edge.target)) &&
      (nextLens === 'all' || (nextLens === 'contradictions' && edge.predicate === 'contradicts') ||
        (nextLens === 'support' && ['supports', 'evidences'].includes(edge.predicate))))
      .sort((a, b) => compare(a.edgeId, b.edgeId))
    const result = {
      profileId: 'atelier.graph-view', profileRevision: input.view.projectionDigest,
      nodes: visible.map(node => ({ ref: binding(node), label: node.title, position: input.positions.get(refKey(node.ref)),
        sourceRevision: node.sourceRef.revision, evidenceIds: [] })),
      edges: edges.slice(0, EDGE_LIMIT).map(edge => ({ from: binding(input.nodes.get(refKey(edge.source))),
        to: binding(input.nodes.get(refKey(edge.target))), label: edge.predicate, edgeId: edge.edgeId })),
    }
    return { result, visible: visible.map(node => copyRef(node.ref)), matchingCount: matching.length, eligibleEdgeCount: edges.length }
  }
  function publishScene(input, nextLens, focus) {
    const prepared = profile(input, nextLens, focus)
    if (!prepared.result.nodes.length) {
      sceneController.dispose()
      sceneController = makeController()
      sceneReady = false
      activePort = null
    } else {
      const retained = current?.view.projectionDigest === input.view.projectionDigest && selected &&
        prepared.visible.some(ref => refKey(ref) === refKey(selected)) ? input.nodes.get(refKey(selected)) : null
      publicationSelection = retained ? binding(retained) : null
      publishing = true
      try {
        if (!sceneReady) sceneController.mount(prepared.result)
        else sceneController.rebuild(prepared.result)
      } finally { publishing = false; publicationSelection = null }
      sceneReady = true
      activePort = preparedPort
      if (paused) sceneController.pause()
    }
    shown = prepared.visible
    matchingCount = prepared.matchingCount
    eligibleEdgeCount = prepared.eligibleEdgeCount
    sceneEdgeCount = prepared.result.edges.length
    sceneScope = focus ? { kind: 'one-hop', ref: copyRef(focus) } : { kind: 'lens', lens: nextLens }
    return { status: sceneReady ? 'ready' : 'empty' }
  }
  function makeController() { return createSceneController({ createPort(profile, bind) {
    const port = createPort(profile, bind)
    for (const method of ['render', 'pick', 'focus', 'select', 'dispose']) {
      if (typeof port?.[method] !== 'function') { port?.dispose?.(); throw new TypeError('Complete scene port required') }
    }
    // A fresh mount does not ask the retained controller to restore selection.
    // Initialize the new port before publishing it, including after an empty lens.
    try { port.select(publicationSelection) } catch (error) { port.dispose(); throw error }
    // Reconcile the retained controller's rebuild highlight against the current
    // consumer selection; an old node cannot undo a clear or edge selection.
    const boundary = { render: () => port.render(), pick: (x, y) => port.pick(x, y),
      focus: position => port.focus(position), dispose: () => port.dispose(),
      select(ref) { port.select(publishing ? publicationSelection : ref) } }
    preparedPort = boundary
    return boundary
  }, onSemanticEvent(event) {
    if (event.type !== 'select') return
    const ref = { repoId: event.target.kind, localId: event.target.id }
    if (!shown.some(item => refKey(item) === refKey(ref))) return
    selected = copyRef(ref)
    selectedEdgeId = null
    emit('select', { ref: selected })
  } }) }
  sceneController = makeController()
  const api = Object.freeze({
    mount(view) {
      if (disposed || current) throw new Error('Mount requires a fresh navigator')
      const next = receive(view)
      const result = publishScene(next, lens, null)
      current = next
      return result
    },
    update(view) {
      live()
      const next = receive(view)
      const result = publishScene(next, lens, focused && next.nodes.has(refKey(focused)) ? focused : null)
      const changed = current.view.projectionDigest !== next.view.projectionDigest
      current = next
      if (changed || (selected && !next.nodes.has(refKey(selected)))) { selected = null; activePort?.select(null) }
      if (changed || (selectedEdgeId && !next.view.edges.some(edge => edge.edgeId === selectedEdgeId))) selectedEdgeId = null
      if (questionId && !next.view.questions?.some(question => question.questionId === questionId)) questionId = null
      if (focused && !next.nodes.has(refKey(focused))) focused = null
      return result
    },
    select(ref, { projectionDigest = live().view.projectionDigest, focus = false } = {}) {
      live()
      if (paused) return { status: 'paused' }
      if (projectionDigest !== current.view.projectionDigest) return { status: 'stale' }
      const node = nodeFor(ref)
      if (!node) return { status: 'unavailable' }
      if (!shown.some(item => refKey(item) === refKey(ref))) {
        const result = publishScene(current, lens, ref)
        if (result.status !== 'ready') return result
      }
      const result = sceneController.applyCommand({ type: 'select', target: binding(node) })
      if (focus && result.status === 'applied') {
        sceneController.applyCommand({ type: 'focus', target: binding(node) })
        focused = copyRef(ref)
      }
      return { status: result.status }
    },
    focus(ref) {
      if (paused) return { status: 'paused' }
      const node = nodeFor(ref)
      if (!node) return { status: 'unavailable' }
      if (!shown.some(item => refKey(item) === refKey(ref))) {
        const result = publishScene(current, lens, ref)
        if (result.status !== 'ready') return result
      }
      const result = sceneController.applyCommand({ type: 'focus', target: binding(node) })
      if (result.status === 'applied') focused = copyRef(ref)
      return { status: result.status }
    },
    setLens(nextLens) {
      live()
      if (paused) return { status: 'paused' }
      if (!['all', 'support', 'contradictions'].includes(nextLens)) return { status: 'unsupported' }
      const result = publishScene(current, nextLens, null)
      lens = nextLens; focused = null
      return result
    },
    expand(ref, direction = 'both') {
      if (paused) return { status: 'paused' }
      if (!nodeFor(ref) || !['in', 'out', 'both'].includes(direction)) return { status: 'unavailable' }
      return { status: 'requested', intent: emit('expand', { ref: copyRef(ref), direction }) }
    },
    selectEdge(edgeId, { projectionDigest = live().view.projectionDigest } = {}) {
      live()
      if (paused) return { status: 'paused' }
      if (projectionDigest !== current.view.projectionDigest) return { status: 'stale' }
      if (!current.view.edges.some(edge => edge.edgeId === edgeId)) return { status: 'unavailable' }
      activePort?.select(null)
      selectedEdgeId = edgeId
      selected = null
      return { status: 'requested', intent: emit('select', { edgeId }) }
    },
    openEvidence(evidenceId) {
      if (paused) return { status: 'paused' }
      if (!live().view.evidence?.some(item => item.evidenceId === evidenceId)) return { status: 'unavailable' }
      return { status: 'requested', intent: emit('openEvidence', { evidenceId }) }
    },
    setQuestion(nextId) {
      if (paused) return { status: 'paused' }
      if (!live().view.questions?.some(item => item.questionId === nextId)) return { status: 'unavailable' }
      questionId = nextId
      return { status: 'requested', intent: emit('setQuestion', { questionId }) }
    },
    receiveSelection(selection) {
      live()
      if (paused) return { status: 'paused' }
      if (selection === null) { activePort?.select(null); selected = selectedEdgeId = null; return { status: 'applied' } }
      if (selection?.projectionDigest !== current.view.projectionDigest) return { status: 'stale' }
      const fields = Object.keys(selection).sort().join(',')
      if (fields !== 'projectionDigest,ref' && fields !== 'edgeId,projectionDigest') throw new TypeError('Selection readback requires one exact target')
      assertGraphViewIntent(current.view, { ...selection, type: 'select' })
      silent++
      try {
        return selection.ref ? api.select(selection.ref, { projectionDigest: selection.projectionDigest }) :
          api.selectEdge(selection.edgeId, { projectionDigest: selection.projectionDigest })
      } finally { silent-- }
    },
    pickAt(x, y) { live(); return sceneReady && sceneController.pickAt(x, y) ? { status: 'selected' } : null },
    frame() { return sceneController.frame() },
    pause() { live(); if (sceneReady) sceneController.pause(); paused = true },
    resume() { live(); if (sceneReady) sceneController.resume(); paused = false },
    snapshot() {
      live()
      return clone({ projectionDigest: current.view.projectionDigest, selected, selectedEdgeId, questionId, focused, lens, paused, shown,
        sceneNodes: shown.length, sceneEdges: sceneEdgeCount, omittedNodes: matchingCount - shown.length,
        omittedEdges: eligibleEdgeCount - sceneEdgeCount, sceneScope,
        unrenderedProjectionNodes: current.view.nodes.length - shown.length,
        unrenderedProjectionEdges: current.view.edges.length - sceneEdgeCount,
        page: current.view.page ?? null, completeness: current.view.completeness ?? 'unqualified-fixture' })
    },
    dispose() {
      if (disposed) return
      disposed = true
      try { sceneController.dispose() } finally { current = activePort = preparedPort = null; selected = focused = selectedEdgeId = questionId = null; shown = [] }
    },
  })
  return api
}
