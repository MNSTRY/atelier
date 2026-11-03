import { referenceKey, semanticBinding, createSemanticPickingMap } from './semantic-picking.mjs'

// DOM-free contribution boundary. Hosts own engine, render-loop, input and overlays.
// Scene ports own only their scene, camera, meshes and materials.
export function createSceneController({ createPort, onSemanticEvent = () => {} }) {
  let current = null
  let disposed = false
  let paused = false

  function live() {
    if (disposed) throw new Error('Controller disposed')
    if (!current) throw new Error('Scene not mounted')
    return current
  }

  function prepare(profile) {
    // Freeze producer bytes before allocating any graphics resources.
    const copy = structuredClone(profile)
    if (!copy.profileId || !copy.profileRevision || !Array.isArray(copy.nodes) || !Array.isArray(copy.edges)) {
      throw new TypeError('Versioned graph projection required')
    }
    if (!copy.nodes.length || copy.nodes.length > 48 || copy.edges.length > 96) throw new RangeError('Small graph envelope exceeded')
    const nodes = new Map()
    for (const node of copy.nodes) {
      const key = referenceKey(node.ref)
      semanticBinding(node)
      if (nodes.has(key)) throw new Error('Duplicate semantic reference')
      if (typeof node.label !== 'string' || !node.label.trim() || !Array.isArray(node.position) ||
          node.position.length !== 3 || node.position.some(value => !Number.isFinite(value))) {
        throw new TypeError('Label and finite scene position required')
      }
      nodes.set(key, node)
    }
    for (const edge of copy.edges) {
      if (!nodes.has(referenceKey(edge.from)) || !nodes.has(referenceKey(edge.to)) ||
          typeof edge.label !== 'string' || !edge.label.trim()) throw new Error('Unresolved relation')
    }
    const picking = createSemanticPickingMap()
    let port
    try {
      port = createPort(copy, (mesh, node) => {
        const supplied = nodes.get(referenceKey(node.ref))
        if (!supplied) throw new Error('Port attempted to bind an unresolved reference')
        picking.bind(mesh, supplied)
      })
      for (const method of ['render', 'pick', 'focus', 'select', 'dispose']) {
        if (typeof port?.[method] !== 'function') throw new TypeError('Incomplete scene port')
      }
      return { profile: copy, nodes, picking, port, selected: [] }
    } catch (error) {
      port?.dispose?.()
      picking.clear()
      throw error
    }
  }

  function release(scene) {
    scene.picking.clear()
    scene.port.dispose()
  }

  function emit(scene, type, binding) {
    // No mesh/engine/DOM handles escape this event.
    const event = Object.freeze({ type, profileId: scene.profile.profileId,
      profileRevision: scene.profile.profileRevision, ...binding })
    onSemanticEvent(event)
    return event
  }

  return Object.freeze({
    mount(profile) {
      if (disposed) throw new Error('Controller disposed')
      if (current) throw new Error('Use rebuild for a replaced scene')
      current = prepare(profile)
    },
    applyCommand(command) {
      const scene = live()
      if (paused) return { status: 'paused' }
      if (!['select', 'inspect', 'focus'].includes(command?.type)) return { status: 'unsupported', type: command?.type }
      const node = scene.nodes.get(referenceKey(command.target))
      if (!node) return { status: 'unavailable-reference' }
      const binding = semanticBinding(node)
      if (command.type === 'select') {
        scene.port.select(binding.target)
        scene.selected = [binding.target]
      }
      if (command.type === 'focus') scene.port.focus(node.position)
      return { status: 'applied', event: emit(scene, command.type, binding) }
    },
    pickAt(x, y) {
      const scene = live()
      if (paused || !Number.isFinite(x) || !Number.isFinite(y)) return null
      const binding = scene.picking.resolve(scene.port.pick(x, y))
      if (!binding) return null
      scene.port.select(binding.target)
      scene.selected = [binding.target]
      return emit(scene, 'select', binding)
    },
    frame() {
      if (disposed || paused || !current) return false
      current.port.render()
      return true
    },
    pause() { live(); paused = true },
    resume() { live(); paused = false },
    rebuild(profile) {
      const old = live()
      const next = prepare(profile)
      // Preserve only exact references still provided by the next producer revision.
      next.selected = old.selected.filter(ref => next.nodes.has(referenceKey(ref)))
      try { next.port.select(next.selected[0] ?? null) }
      catch (error) { release(next); throw error }
      current = next
      release(old)
    },
    structuredProjection() {
      const scene = live()
      return { profileId: scene.profile.profileId, profileRevision: scene.profile.profileRevision,
        selected: structuredClone(scene.selected),
        nodes: [...scene.nodes.values()].map(node => ({ label: node.label, ...semanticBinding(node) })),
        relations: scene.profile.edges.map(edge => structuredClone(edge)),
        interactionLimits: 'Structured projection; no spatial rendering or activity completion claim' }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (current) release(current)
      current = null
    },
  })
}
