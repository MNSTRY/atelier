import { createBabylonPortFactory } from './babylon-scene-port.mjs'
import { createGraphNavigator } from './navigator.mjs'

const activeCanvases = new WeakMap()
function unavailableHost(reason, dispose = () => {}) {
  const unavailable = () => ({ status: 'unavailable' })
  return Object.freeze({ status: 'unavailable', reason,
    select: unavailable, selectEdge: unavailable, receiveSelection: unavailable,
    focus: unavailable, expand: unavailable, openEvidence: unavailable, setQuestion: unavailable,
    setLens: unavailable, update: unavailable, fit() {}, reset() {}, zoom() {}, pan() {},
    snapshot: () => null, dispose, clear: dispose })
}

// The browser owns scheduling, input and engine lifetime; the reused port owns
// scene geometry. Graphics availability never controls the companion document.
export function mountGraphCanvas(canvas, { B, view, onIntent, onAvailability = () => {},
  createEngine = element => new B.Engine(element, true, { preserveDrawingBuffer: false, stencil: true }),
} = {}) {
  if (!canvas?.ownerDocument?.defaultView) throw new TypeError('Browser canvas required')
  if (activeCanvases.has(canvas)) return unavailableHost('canvas-in-use')
  const lease = {}
  activeCanvases.set(canvas, lease)
  const document = canvas.ownerDocument, window = document.defaultView
  const listeners = [], cameras = new Set()
  let engine, navigator, camera, frame = null, down = null, disposed = false, lost = false
  let motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  const listen = (target, event, handler, options) => {
    target.addEventListener(event, handler, options)
    listeners.push(() => target.removeEventListener(event, handler, options))
  }
  const available = state => { try { onAvailability(state) } catch { /* Consumer notification. */ } }
  function dispose() {
    if (disposed) return
    disposed = true
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    down = null
    listeners.splice(0).reverse().forEach(remove => remove())
    try { navigator?.dispose() } finally {
      for (const item of cameras) item.detachControl()
      cameras.clear()
      try { engine?.dispose() } finally {
        engine = camera = navigator = null
        if (activeCanvases.get(canvas) === lease) {
          activeCanvases.delete(canvas)
          // Reset the owned drawing buffer synchronously, including the last
          // composited frame, before a narrower view may be delivered.
          const width = canvas.width
          canvas.width = width === 0 ? 1 : 0
          canvas.width = width
        }
      }
    }
  }
  function applyMotion() {
    if (!camera) return
    camera.inertia = motion?.matches ? 0 : .85
    camera.panningInertia = motion?.matches ? 0 : .85
    if (motion?.matches) stopInertia()
  }
  function stopInertia() {
    if (!camera) return
    for (const name of ['inertialAlphaOffset', 'inertialBetaOffset', 'inertialRadiusOffset', 'inertialPanningX', 'inertialPanningY']) camera[name] = 0
  }
  function fit() {
    if (!camera || !navigator) return
    const positions = camera.getScene().meshes.filter(mesh => mesh.isPickable && mesh.isEnabled()).map(mesh => mesh.position)
    if (!positions.length) return
    const min = new B.Vector3(Infinity, Infinity, Infinity), max = new B.Vector3(-Infinity, -Infinity, -Infinity)
    for (const point of positions) { min.minimizeInPlace(point); max.maximizeInPlace(point) }
    camera.setTarget(min.add(max).scale(.5), false, false, true)
    const aspect = Math.max(.1, engine.getRenderWidth() / Math.max(1, engine.getRenderHeight()))
    const fov = Math.min(camera.fov, 2 * Math.atan(Math.tan(camera.fov / 2) * aspect))
    camera.upperRadiusLimit = 400
    camera.radius = Math.max(camera.lowerRadiusLimit, max.subtract(min).length() / (2 * Math.sin(fov / 2)) + 2)
    stopInertia()
  }
  function loop() {
    frame = null
    if (disposed || lost || document.hidden) return
    navigator.frame()
    frame = window.requestAnimationFrame(loop)
  }
  function active() { return !disposed && !lost && !document.hidden }
  try {
    engine = createEngine(canvas)
    const baseFactory = createBabylonPortFactory(B, engine, { onSceneCreated(created) {
      camera = created.camera
      cameras.add(camera)
      camera.lowerBetaLimit = .15
      camera.upperBetaLimit = Math.PI / 2 - .05
      camera.panningDistanceLimit = 150
      camera.attachControl(canvas, true)
      applyMotion()
    } })
    navigator = createGraphNavigator({ onIntent, createPort(profile, bind) {
      const port = baseFactory(profile, bind)
      const ownCamera = camera
      // Preserve the retained controller and geometry; apply CR-4's measured
      // orbit-preserving focus behavior at this presentation port boundary.
      return { ...port, focus(position) {
        ownCamera.setTarget(B.Vector3.FromArray(position), false, false, true)
        for (const name of ['inertialAlphaOffset', 'inertialBetaOffset', 'inertialRadiusOffset', 'inertialPanningX', 'inertialPanningY']) ownCamera[name] = 0
      }, dispose() {
        ownCamera.detachControl()
        cameras.delete(ownCamera)
        if (camera === ownCamera) camera = null
        port.dispose()
      } }
    } })
    const mounted = navigator.mount(view)
    engine.resize()
    fit()
    listen(canvas, 'pointerdown', event => {
      if (event.button === 0 && active()) down = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false }
    })
    listen(canvas, 'pointermove', event => {
      if (down?.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) down.dragged = true
    })
    listen(canvas, 'pointerup', event => {
      const start = down
      down = null
      if (!active() || !start || start.dragged || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const scale = engine.getHardwareScalingLevel()
      const x = (event.clientX - rect.left) * engine.getRenderWidth() * scale / rect.width
      const y = (event.clientY - rect.top) * engine.getRenderHeight() * scale / rect.height
      navigator.pickAt(x, y)
    })
    for (const event of ['pointercancel', 'pointerleave']) listen(canvas, event, () => { down = null })
    listen(window, 'resize', () => { if (active()) engine.resize() })
    listen(document, 'visibilitychange', () => {
      if (disposed || lost) return
      if (document.hidden) { navigator.pause(); if (frame !== null) window.cancelAnimationFrame(frame); frame = null }
      else { engine.resize(); navigator.resume(); if (frame === null) frame = window.requestAnimationFrame(loop) }
    })
    listen(canvas, 'webglcontextlost', event => {
      event.preventDefault()
      lost = true
      navigator.pause()
      if (frame !== null) window.cancelAnimationFrame(frame)
      frame = null
      available({ status: 'unavailable', reason: 'graphics-context-lost' })
    })
    if (motion) listen(motion, 'change', applyMotion)
    if (document.hidden) navigator.pause()
    else frame = window.requestAnimationFrame(loop)
    available({ status: mounted.status, reducedMotion: Boolean(motion?.matches) })
    return Object.freeze({
      get status() { return disposed || lost ? 'unavailable' : navigator.snapshot().sceneNodes ? 'ready' : 'empty' },
      select(ref, options) { return active() ? navigator.select(ref, options) : { status: 'unavailable' } },
      selectEdge(edgeId, options) { return active() ? navigator.selectEdge(edgeId, options) : { status: 'unavailable' } },
      receiveSelection(selection) { return active() ? navigator.receiveSelection(selection) : { status: 'unavailable' } },
      focus(ref) { return active() ? navigator.focus(ref) : { status: 'unavailable' } },
      expand(ref, direction) { return active() ? navigator.expand(ref, direction) : { status: 'unavailable' } },
      openEvidence(evidenceId) { return active() ? navigator.openEvidence(evidenceId) : { status: 'unavailable' } },
      setQuestion(questionId) { return active() ? navigator.setQuestion(questionId) : { status: 'unavailable' } },
      setLens(lens) { if (!active()) return { status: 'unavailable' }; const result = navigator.setLens(lens); fit(); return result },
      update(next) { if (!active()) return { status: 'unavailable' }; const result = navigator.update(next); fit(); return result },
      fit() { if (active()) fit() },
      reset() { if (!active()) return; navigator.setLens('all'); if (camera) { camera.alpha = Math.PI / 2; camera.beta = .7; fit() } },
      zoom(factor) { if (active() && camera && Number.isFinite(factor) && factor > 0) { camera.radius = Math.max(camera.lowerRadiusLimit, Math.min(camera.upperRadiusLimit, camera.radius * factor)); stopInertia() } },
      pan(dx, dz) { if (active() && camera && Number.isFinite(dx) && Number.isFinite(dz)) { const target = camera.target; camera.setTarget(new B.Vector3(Math.max(-150, Math.min(150, target.x + dx)), target.y, Math.max(-150, Math.min(150, target.z + dz))), false, false, true); stopInertia() } },
      snapshot() { return navigator?.snapshot() ?? null },
      dispose,
      clear: dispose,
    })
  } catch (error) {
    dispose()
    available({ status: 'unavailable', reason: 'graphics-unavailable' })
    return unavailableHost('graphics-unavailable', dispose)
  }
}
