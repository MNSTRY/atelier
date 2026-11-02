import { canonicalize } from '../attestation/jcs.mjs'

const order = (left, right) => left < right ? -1 : left > right ? 1 : 0
const text = value => typeof value === 'string' && value.length > 0
const fail = () => { throw new TypeError('Snapshot comparison requires matching authorized graph views') }
const refKey = ref => ref && text(ref.repoId) && text(ref.localId) ? canonicalize([ref.repoId, ref.localId]) : fail()
const sourceKey = ref => ref && text(ref.repoId) && text(ref.path) ? canonicalize([ref.repoId, ref.path]) : fail()

function index(items, keyOf) {
  if (!Array.isArray(items)) fail()
  const records = new Map()
  for (const item of items) {
    const key = keyOf(item)
    if (!text(key) || records.has(key)) fail()
    records.set(key, item)
  }
  return records
}

function changes(before, after, identity) {
  const added = [], removed = [], changed = []
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort(order)) {
    if (!before.has(key)) added.push(identity(after.get(key)))
    else if (!after.has(key)) removed.push(identity(before.get(key)))
    else if (canonicalize(before.get(key)) !== canonicalize(after.get(key))) changed.push(identity(after.get(key)))
  }
  return { added, removed, changed }
}

function records(view) {
  if (!view || view.schema !== 'atelier.graph-view@v1' || !text(view.projectionDigest) || !view.accessContext) fail()
  const nodes = index(view.nodes, node => refKey(node.ref))
  const edges = index(view.edges, edge => text(edge.edgeId) ? edge.edgeId : fail())
  const evidence = index(view.evidence, item => text(item.evidenceId) ? item.evidenceId : fail())
  const questions = index(view.questions, item => text(item.questionId) ? item.questionId : fail())
  const sources = new Map()
  function addSource(source) {
    if (!source) return
    const key = sourceKey(source)
    // Keep all exact source pins (including locators), not whichever record
    // happened to be visited last. One source can support several questions.
    if (!sources.has(key)) sources.set(key, { repoId: source.repoId, path: source.path, pins: new Set() })
    sources.get(key).pins.add(canonicalize(source))
  }
  for (const item of [...nodes.values(), ...evidence.values()]) addSource(item.sourceRef)
  for (const repository of view.sourceSnapshot?.repositories ?? []) {
    for (const file of repository.files ?? []) addSource({ repoId: repository.repoId, path: file.path, revision: repository.digest, digest: file.rawDigest, byteLength: file.byteLength })
    for (const input of Object.values(repository.inputs ?? {})) addSource(input)
  }
  for (const [key, source] of sources) sources.set(key, { ...source, pins: [...source.pins].sort(order) })
  for (const edge of edges.values()) {
    if (!nodes.has(refKey(edge.source)) || !nodes.has(refKey(edge.target)) ||
        !Array.isArray(edge.supportRefs) || edge.supportRefs.some(id => !evidence.has(id))) fail()
  }
  for (const question of questions.values()) {
    if (!Array.isArray(question.nodeRefs) || question.nodeRefs.some(ref => !nodes.has(refKey(ref))) ||
        !Array.isArray(question.evidenceRefs) || question.evidenceRefs.some(id => !evidence.has(id)) ||
        (question.contradictingRefs !== undefined && (!Array.isArray(question.contradictingRefs) || question.contradictingRefs.some(id => !evidence.has(id))))) fail()
  }
  return { nodes, edges, evidence, questions, sources }
}

// Derived data only. The trusted caller must revalidate BOTH snapshots before
// calling. Matching accessContext refuses changed grants/principals/filters;
// it is a compatibility check, never proof of recipient authorization.
export function compareGraphSnapshots(before, after) {
  if (!before?.accessContext || canonicalize(before.accessContext) !== canonicalize(after?.accessContext)) fail()
  const a = records(before), b = records(after)
  const nodes = changes(a.nodes, b.nodes, node => node.ref)
  const edges = changes(a.edges, b.edges, edge => edge.edgeId)
  const sources = changes(a.sources, b.sources, source => ({ repoId: source.repoId, path: source.path }))
  const evidenceChanges = changes(a.evidence, b.evidence, item => item.evidenceId)
  const questionChanges = changes(a.questions, b.questions, item => item.questionId)
  const affectedNodes = new Set([...nodes.added, ...nodes.removed, ...nodes.changed].map(refKey))
  const affectedEdges = new Set([...edges.added, ...edges.removed, ...edges.changed])
  const affectedSources = new Set([...sources.added, ...sources.removed, ...sources.changed].map(sourceKey))
  const affectedEvidence = new Set([...evidenceChanges.added, ...evidenceChanges.removed, ...evidenceChanges.changed])
  const affectedQuestions = new Set([...questionChanges.added, ...questionChanges.removed, ...questionChanges.changed])
  const adjacency = new Map()
  for (const graph of [a, b]) {
    for (const node of graph.nodes.values()) if (node.sourceRef && affectedSources.has(sourceKey(node.sourceRef))) affectedNodes.add(refKey(node.ref))
    for (const item of graph.evidence.values()) if (item.sourceRef && affectedSources.has(sourceKey(item.sourceRef))) affectedEvidence.add(item.evidenceId)
    for (const edge of graph.edges.values()) {
      const from = refKey(edge.source), to = refKey(edge.target)
      if (!adjacency.has(from)) adjacency.set(from, new Set())
      if (!adjacency.has(to)) adjacency.set(to, new Set())
      adjacency.get(from).add(to)
      adjacency.get(to).add(from)
      if (affectedEdges.has(edge.edgeId) || edge.supportRefs.some(id => affectedEvidence.has(id))) {
        affectedNodes.add(from); affectedNodes.add(to)
      }
    }
  }
  // Conservative possible-impact reachability, not a claim that every link is
  // a semantic dependency. Coverage is limited to the supplied authorized slice.
  const queue = [...affectedNodes]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const neighbor of adjacency.get(queue[cursor]) ?? []) if (!affectedNodes.has(neighbor)) {
      affectedNodes.add(neighbor); queue.push(neighbor)
    }
  }
  for (const graph of [a, b]) for (const question of graph.questions.values()) {
    if (question.nodeRefs.some(ref => affectedNodes.has(refKey(ref))) || [...question.evidenceRefs, ...(question.contradictingRefs ?? [])].some(id => affectedEvidence.has(id))) affectedQuestions.add(question.questionId)
  }
  return {
    beforeDigest: before.projectionDigest, afterDigest: after.projectionDigest,
    nodes, edges, sources,
    possibleImpact: { scope: 'supplied-authorized-slice', questionIds: [...affectedQuestions].sort(order) },
  }
}
