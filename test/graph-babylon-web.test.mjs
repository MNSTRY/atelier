import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mountGraphCanvas } from '../src/graph-view/babylon/web-host.mjs'

const view = JSON.parse(fs.readFileSync(new URL('../fixtures/graph-view/synthetic-view.v1.json', import.meta.url), 'utf8'))

// A deterministic host fixture exercises the real wrapper and retained port.
// It provides no WebGL paint, browser performance or human acceptance evidence.
class Target extends EventTarget {
  listeners = new Map()
  addEventListener(type, callback, options) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(callback)
    super.addEventListener(type, callback, options)
  }
  removeEventListener(type, callback, options) {
    this.listeners.get(type)?.delete(callback)
    super.removeEventListener(type, callback, options)
  }
  listenerCount() { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0) }
}
class Vector {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }) }
  static Zero() { return new Vector() }
  static FromArray(values) { return new Vector(...values) }
  copyFromFloats(x, y, z) { Object.assign(this, { x, y, z }) }
  minimizeInPlace(v) { for (const key of ['x','y','z']) this[key] = Math.min(this[key], v[key]) }
  maximizeInPlace(v) { for (const key of ['x','y','z']) this[key] = Math.max(this[key], v[key]) }
  add(v) { return new Vector(this.x + v.x, this.y + v.y, this.z + v.z) }
  subtract(v) { return new Vector(this.x - v.x, this.y - v.y, this.z - v.z) }
  scale(n) { return new Vector(this.x * n, this.y * n, this.z * n) }
  length() { return Math.hypot(this.x, this.y, this.z) }
}
function fixture() {
  const window = new Target(), document = new Target(), canvas = new Target(), motion = new Target()
  const pendingFrames = new Map(), engines = []
  motion.matches = true
  window.matchMedia = () => motion
  let nextFrame = 0, width = 400
  window.requestAnimationFrame = callback => { pendingFrames.set(++nextFrame, callback); return nextFrame }
  window.cancelAnimationFrame = id => pendingFrames.delete(id)
  document.defaultView = window
  document.hidden = false
  canvas.ownerDocument = document
  canvas.bitmap = 'fixture-frame'
  canvas.resets = 0
  Object.defineProperty(canvas, 'width', { get: () => width, set: value => {
    if (value !== width) { canvas.bitmap = 'clear'; canvas.resets++ }
    width = value
  } })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300 })
  class Scene {
    constructor(engine) { this.engine = engine; this.meshes = []; engine.scenes.push(this) }
    pick(x, y, predicate) { return { hit: true, pickedMesh: this.meshes.find(predicate) } }
    render() {}
    dispose() { this.engine.scenes = this.engine.scenes.filter(scene => scene !== this); this.meshes = [] }
  }
  class Camera {
    constructor(name, alpha, beta, radius, target, scene) {
      Object.assign(this, { alpha, beta, radius, target, scene, fov: .8 })
      scene.activeCamera = this
    }
    getScene() { return this.scene }
    setTarget(value) { this.target = value }
    attachControl() {}
    detachControl() {}
  }
  class Color { static Black() { return new Color() } }
  const mesh = (name, scene) => {
    const item = { name, position: new Vector(), scaling: { setAll() {} }, isPickable: true, isEnabled: () => true }
    scene.meshes.push(item)
    return item
  }
  const B = { Scene, ArcRotateCamera: Camera, Vector3: Vector, Color3: Color, Color4: Color,
    HemisphericLight: class {}, StandardMaterial: class {},
    MeshBuilder: { CreateSphere: (name, options, scene) => mesh(name, scene), CreateLines: (name, options, scene) => mesh(name, scene) } }
  const createEngine = () => {
    const engine = { scenes: [], disposed: false, resize() {}, getRenderWidth: () => 400, getRenderHeight: () => 300,
      getHardwareScalingLevel: () => 1, dispose() { this.disposed = true } }
    engines.push(engine)
    return engine
  }
  const events = []
  const mount = () => mountGraphCanvas(canvas, { B, view, createEngine, onIntent: event => events.push(event) })
  return { canvas, window, document, motion, pendingFrames, engines, events, mount, B }
}
function pointer(target, type, x, y) {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y })
  target.dispatchEvent(event)
}

test('returning drags, pointer cancellation and departure cannot turn into node clicks', () => {
  const f = fixture(), host = f.mount()
  assert.equal(host.status, 'ready')
  pointer(f.canvas, 'pointerdown', 20, 20)
  pointer(f.canvas, 'pointerup', 20, 20)
  assert.equal(f.events.length, 1)
  pointer(f.canvas, 'pointerdown', 20, 20)
  pointer(f.canvas, 'pointermove', 60, 30)
  pointer(f.canvas, 'pointermove', 20, 20)
  pointer(f.canvas, 'pointerup', 20, 20)
  assert.equal(f.events.length, 1)
  pointer(f.canvas, 'pointerdown', 20, 20)
  pointer(f.canvas, 'pointercancel', 20, 20)
  pointer(f.canvas, 'pointerup', 20, 20)
  assert.equal(f.events.length, 1)
  pointer(f.canvas, 'pointerdown', 20, 20)
  pointer(f.canvas, 'pointerleave', 20, 20)
  pointer(f.canvas, 'pointerup', 20, 20)
  assert.equal(f.events.length, 1)
  host.dispose()
})

test('clear removes the bitmap, scheduled work, engine scenes and wrapper listeners synchronously', () => {
  const f = fixture(), host = f.mount()
  assert.equal(f.engines[0].scenes[0].activeCamera.inertia, 0)
  host.clear()
  assert.equal(host.status, 'unavailable')
  assert.equal(f.canvas.bitmap, 'clear')
  assert.equal(f.pendingFrames.size, 0)
  assert.equal(f.engines[0].scenes.length, 0)
  assert.equal(f.engines[0].disposed, true)
  for (const target of [f.canvas, f.window, f.document, f.motion]) assert.equal(target.listenerCount(), 0)
  pointer(f.canvas, 'pointerdown', 20, 20)
  pointer(f.canvas, 'pointerup', 20, 20)
  assert.equal(f.events.length, 0)
})

test('an empty lens clears pixels synchronously and retains the host for a nonempty lens', () => {
  const f = fixture(), host = f.mount(), noEdges = structuredClone(view)
  noEdges.edges = []
  host.update(noEdges)
  const listeners = f.canvas.listenerCount()
  assert.equal(host.setLens('support').status, 'empty')
  assert.equal(f.canvas.bitmap, 'clear')
  assert.equal(host.status, 'empty')
  assert.equal(f.engines[0].scenes.length, 0)
  assert.equal(f.engines[0].disposed, false)
  assert.equal(f.pendingFrames.size, 1)
  assert.equal(f.canvas.listenerCount(), listeners)
  assert.equal(host.setLens('all').status, 'ready')
  assert.equal(f.engines[0].scenes.length, 1)
  assert.equal(f.engines.length, 1)
  host.dispose()
})

test('an empty replacement clears pixels before returning and later data can mount', () => {
  const f = fixture(), host = f.mount()
  const empty = { ...structuredClone(view), projectionDigest: `sha256:${'e'.repeat(64)}`, nodes: [], edges: [] }
  assert.equal(host.update(empty).status, 'empty')
  assert.equal(f.canvas.bitmap, 'clear')
  assert.equal(host.snapshot().sceneNodes, 0)
  assert.equal(f.engines[0].disposed, false)
  assert.equal(host.update(view).status, 'ready')
  assert.equal(f.engines.length, 1)
  host.dispose()
})

test('a canvas has one host owner and disposing a former owner cannot clear its replacement', () => {
  const f = fixture(), first = f.mount(), refused = f.mount()
  assert.equal(refused.reason, 'canvas-in-use')
  assert.equal(f.engines.length, 1)
  first.dispose()
  const replacement = f.mount()
  assert.equal(replacement.status, 'ready')
  f.canvas.bitmap = 'replacement-frame'
  first.dispose()
  refused.dispose()
  assert.equal(f.canvas.bitmap, 'replacement-frame')
  replacement.dispose()
})

test('graphics initialization failure returns the complete unavailable API and releases ownership', () => {
  const f = fixture()
  const failed = mountGraphCanvas(f.canvas, { B: f.B, view, createEngine() { throw new Error('Synthetic graphics unavailable') } })
  assert.equal(failed.status, 'unavailable')
  assert.doesNotThrow(() => { failed.fit(); failed.reset(); failed.zoom(1); failed.pan(1, 1) })
  assert.equal(failed.select(view.nodes[0].ref).status, 'unavailable')
  const fresh = f.mount()
  assert.equal(fresh.status, 'ready')
  failed.dispose()
  assert.equal(fresh.status, 'ready')
  fresh.dispose()
})
