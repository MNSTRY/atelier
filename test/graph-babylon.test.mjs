import assert from 'node:assert/strict'
import test from 'node:test'
import { createGraphNavigator, layoutGraph, refKey } from '../src/graph-view/babylon/navigator.mjs'
import fs from 'node:fs'

function harness() {
  const ports = []
  const intents = []
  let failing = false
  const navigator = createGraphNavigator({ onIntent: event => intents.push(event), createPort(profile, bind) {
    if (failing) throw new Error('Synthetic allocation failure')
    const port = { profile, meshes: profile.nodes.map(node => ({ name: 'spoofed-identity', node })), disposed: false,
      rendered: 0, selected: null, focused: null, render() { this.rendered++ }, pick() { return this.hit },
      select(ref) { this.selected = ref }, focus(position) { this.focused = position }, dispose() { this.disposed = true } }
    for (const mesh of port.meshes) bind(mesh, mesh.node)
    ports.push(port)
    return port
  } })
  return { navigator, ports, intents, failNext: () => { failing = true } }
}

test('qualified refs survive equal local IDs, mesh spoofing and mutation of source input', () => {
  const h = harness(), view = makeFixture()
  h.navigator.mount(view)
  const port = h.ports[0]
  const expected = structuredClone(view.nodes[1].ref)
  view.nodes[1].ref.localId = 'mutated'
  const mesh = port.meshes.find(mesh => mesh.node.ref.kind === expected.repoId && mesh.node.ref.id === expected.localId)
  port.hit = { ...mesh }
  assert.equal(h.navigator.pickAt(0, 0), null)
  port.hit = mesh
  h.navigator.pickAt(0, 0)
  assert.deepEqual(h.intents, [{ type: 'select', projectionDigest: view.projectionDigest, ref: expected }])
  assert.equal(Object.hasOwn(h.intents[0], 'mesh'), false)
  h.navigator.dispose()
})

test('search selection and focus are independent; stale selection produces no intent', () => {
  const h = harness(), view = makeFixture()
  h.navigator.mount(view)
  h.navigator.focus(view.nodes[2].ref)
  assert.equal(h.navigator.snapshot().selected, null)
  assert.equal(h.intents.length, 0)
  assert.equal(h.navigator.select(view.nodes[1].ref, { projectionDigest: `sha256:${'d'.repeat(64)}` }).status, 'stale')
  assert.equal(h.navigator.select(view.nodes[1].ref, { focus: true }).status, 'applied')
  assert.deepEqual(h.navigator.snapshot().selected, view.nodes[1].ref)
  assert.deepEqual(h.navigator.snapshot().focused, view.nodes[1].ref)
  assert.equal(h.intents.length, 1)
  h.navigator.dispose()
})

test('large received projections remain bounded and distant search targets become selectable', () => {
  const h = harness(), view = makeFixture(500)
  h.navigator.mount(view)
  assert.equal(h.navigator.snapshot().sceneNodes, 48)
  assert.equal(h.navigator.snapshot().omittedNodes, 452)
  const target = view.nodes[400].ref
  h.navigator.select(target, { focus: true })
  assert.deepEqual(h.navigator.snapshot().selected, target)
  assert.ok(h.navigator.snapshot().sceneNodes <= 48)
  assert.ok(h.navigator.snapshot().sceneEdges <= 96)
  assert.deepEqual(h.navigator.expand(target, 'out').intent, { type: 'expand', projectionDigest: view.projectionDigest, ref: target, direction: 'out' })
  assert.equal(h.ports[0].disposed, true)
  h.navigator.dispose()
})

test('layout is deterministic under input order and unchanged when lenses change', () => {
  const view = makeFixture(30), h = harness()
  assert.deepEqual([...layoutGraph(view.nodes)], [...layoutGraph([...view.nodes].reverse())])
  h.navigator.mount(view)
  const positions = new Map(h.ports[0].profile.nodes.map(node => [JSON.stringify(node.ref), node.position]))
  h.navigator.setLens('contradictions')
  const port = h.ports.at(-1)
  assert.ok(port.profile.edges.every(edge => edge.label === 'contradicts'))
  for (const node of port.profile.nodes) assert.deepEqual(node.position, positions.get(JSON.stringify(node.ref)))
  h.navigator.dispose()
})

test('empty lenses release graphics rather than leaving stale marks; later data can mount', () => {
  const view = makeFixture(), h = harness()
  view.edges = []
  h.navigator.mount(view)
  assert.equal(h.navigator.setLens('contradictions').status, 'empty')
  assert.equal(h.ports[0].disposed, true)
  assert.equal(h.navigator.snapshot().sceneNodes, 0)
  assert.equal(h.navigator.frame(), false)
  assert.equal(h.navigator.pickAt(0, 0), null)
  h.navigator.setLens('all')
  assert.equal(h.navigator.snapshot().sceneNodes, 8)
  h.navigator.dispose()
})

test('paused navigation and changed projections suppress events and frames', () => {
  const h = harness(), view = makeFixture()
  h.navigator.mount(view)
  h.navigator.pause()
  assert.equal(h.navigator.select(view.nodes[0].ref).status, 'paused')
  assert.equal(h.navigator.expand(view.nodes[0].ref).status, 'paused')
  h.navigator.update({ ...view, projectionDigest: `sha256:${'e'.repeat(64)}` })
  assert.equal(h.navigator.frame(), false)
  assert.equal(h.navigator.pickAt(0, 0), null)
  assert.equal(h.intents.length, 0)
  h.navigator.resume()
  assert.equal(h.navigator.frame(), true)
  h.navigator.dispose()
})

test('failed replacement preserves the usable prior scene and digest', () => {
  const h = harness(), view = makeFixture()
  h.navigator.mount(view)
  h.failNext()
  assert.throws(() => h.navigator.update({ ...view, projectionDigest: `sha256:${'e'.repeat(64)}` }), /allocation failure/)
  assert.equal(h.ports[0].disposed, false)
  assert.equal(h.navigator.snapshot().projectionDigest, view.projectionDigest)
  assert.equal(h.navigator.frame(), true)
  h.navigator.dispose()
})

test('malformed refs and endpoints fail before allocation; repeated dispose releases every scene', () => {
  assert.throws(() => refKey({ repoId: 'x' }), /Qualified/)
  const bad = makeFixture(), h = harness()
  bad.edges[0].target = { repoId: 'unreceived', localId: 'missing' }
  assert.throws(() => h.navigator.mount(bad), /received endpoints/)
  assert.equal(h.ports.length, 0)
  h.navigator.mount(makeFixture())
  h.navigator.dispose()
  h.navigator.dispose()
  assert.equal(h.ports.every(port => port.disposed), true)
  assert.throws(() => h.navigator.snapshot(), /unavailable/)
})

test('shared projection fixture emits the same exact node, edge, evidence and question intents', () => {
  const view = JSON.parse(fs.readFileSync(new URL('../fixtures/graph-view/synthetic-view.v1.json', import.meta.url), 'utf8'))
  const h = harness()
  h.navigator.mount(view)
  h.navigator.select(view.nodes[0].ref)
  h.navigator.selectEdge(view.edges[0].edgeId)
  h.navigator.openEvidence(view.evidence[0].evidenceId)
  h.navigator.setQuestion(view.questions[0].questionId)
  assert.deepEqual(h.intents, [
    { type: 'select', projectionDigest: view.projectionDigest, ref: view.nodes[0].ref },
    { type: 'select', projectionDigest: view.projectionDigest, edgeId: view.edges[0].edgeId },
    { type: 'openEvidence', projectionDigest: view.projectionDigest, evidenceId: view.evidence[0].evidenceId },
    { type: 'setQuestion', projectionDigest: view.projectionDigest, questionId: view.questions[0].questionId },
  ])
  assert.equal(h.navigator.openEvidence('not-received').status, 'unavailable')
  assert.equal(h.navigator.selectEdge('not-received').status, 'unavailable')
  h.navigator.dispose()
})

test('shared selection readback emits no echo and old digests cannot rebind a changed view', () => {
  const h = harness(), view = makeFixture()
  h.navigator.mount(view)
  h.navigator.receiveSelection({ projectionDigest: view.projectionDigest, ref: view.nodes[2].ref })
  assert.deepEqual(h.navigator.snapshot().selected, view.nodes[2].ref)
  assert.equal(h.intents.length, 0)
  const next = { ...view, projectionDigest: `sha256:${'f'.repeat(64)}` }
  h.navigator.update(next)
  assert.equal(h.navigator.snapshot().selected, null)
  assert.equal(h.navigator.receiveSelection({ projectionDigest: view.projectionDigest, ref: view.nodes[2].ref }).status, 'stale')
  h.navigator.receiveSelection({ projectionDigest: next.projectionDigest, ref: view.nodes[2].ref })
  assert.deepEqual(h.navigator.snapshot().selected, view.nodes[2].ref)
  assert.equal(h.intents.length, 0)
  h.navigator.dispose()
})

test('search can reveal a received source outside the current lens without inventing an edge', () => {
  const h = harness(), view = makeFixture()
  view.edges = []
  h.navigator.mount(view)
  h.navigator.setLens('support')
  assert.equal(h.navigator.select(view.nodes[0].ref).status, 'applied')
  assert.equal(h.navigator.snapshot().sceneNodes, 1)
  assert.equal(h.navigator.snapshot().sceneEdges, 0)
  assert.deepEqual(h.navigator.snapshot().selected, view.nodes[0].ref)
  h.navigator.dispose()
})

test('clears and edge selection cannot restore a stale node highlight after any rebuild', () => {
  const h = harness(), view = makeFixture()
  h.navigator.mount(view)
  h.navigator.select(view.nodes[0].ref)
  h.navigator.receiveSelection(null)
  h.navigator.setLens('all')
  assert.equal(h.ports.at(-1).selected, null)
  assert.equal(h.navigator.snapshot().selected, null)
  h.navigator.select(view.nodes[0].ref)
  h.navigator.selectEdge(view.edges[0].edgeId)
  h.navigator.setLens('all')
  assert.equal(h.ports.at(-1).selected, null)
  assert.equal(h.navigator.snapshot().selectedEdgeId, view.edges[0].edgeId)
  h.navigator.select(view.nodes[0].ref)
  h.navigator.update({ ...view, projectionDigest: `sha256:${'e'.repeat(64)}` })
  h.navigator.setLens('all')
  assert.equal(h.ports.at(-1).selected, null)
  h.navigator.dispose()
})

test('selection readback refuses intent-type overrides without mutating state or highlight', () => {
  const h = harness(), view = makeFixture()
  h.navigator.mount(view)
  h.navigator.select(view.nodes[0].ref)
  const before = h.navigator.snapshot(), highlight = h.ports.at(-1).selected
  assert.throws(() => h.navigator.receiveSelection({ type: 'expand', projectionDigest: view.projectionDigest,
    ref: view.nodes[1].ref, direction: 'out' }), /Selection readback/)
  assert.deepEqual(h.navigator.snapshot(), before)
  assert.deepEqual(h.ports.at(-1).selected, highlight)
  h.navigator.dispose()
})

function makeFixture(count = 8) {
  const nodes = Array.from({ length: count }, (_, index) => ({
    ref: { repoId: index % 2 ? 'repo-synthetic-b' : 'repo-synthetic-a', localId: `record-${Math.floor(index / 2)}` },
    title: `Synthetic record ${index + 1}`, displayEligible: true,
    sourceRef: { repoId: index % 2 ? 'repo-synthetic-b' : 'repo-synthetic-a', path: `notes/record-${index}.md`,
      revision: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` },
  }))
  return {
    schema: 'atelier.graph-view@v1', projectionDigest: `sha256:${'c'.repeat(64)}`,
    nodes, evidence: [], questions: [], capabilities: { queries: ['neighborhood'] },
    edges: nodes.slice(1).map((node, index) => ({ edgeId: `edge-${index}`, source: nodes[index].ref, target: node.ref,
      predicate: index % 3 === 0 ? 'contradicts' : 'supports', family: 'source-declaration',
      acceptanceState: 'active', supportRefs: [] })),
  }
}
