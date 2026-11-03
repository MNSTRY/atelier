import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGraphViewReader, parseGraphView, serializeGraphView, assertGraphViewIntent, runGraphViewCommand } from '../src/graph-view/index.mjs'
import { canonicalJson, digestJson } from '../src/graph-view/contracts.mjs'

const fixture = new URL('../fixtures/graph-view/synthetic-authorized-input.v1.json', import.meta.url)
const input = () => JSON.parse(fs.readFileSync(fixture, 'utf8'))
const at = () => Date.parse('2030-01-01T00:00:00Z')
function reader(graph = input(), overrides = {}) {
  return createGraphViewReader({ loadAuthorizedGraph: async () => ({ graph, binding: { trusted: true } }), revalidate: async () => true, now: at, ...overrides })
}
const fails = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === `graph-view: ${code}`)

test('same inputs and reversed table/set ordering produce identical canonical bytes', async () => {
  const graph = input()
  const a = await reader(graph).exportGraphView({ limit: 100 })
  for (const key of ['nodes', 'edges', 'evidence', 'questions', 'diagnostics']) graph[key].reverse()
  graph.sourceSnapshot.repositories.reverse()
  for (const repo of graph.sourceSnapshot.repositories) repo.files.reverse()
  graph.accessContext.authorizedRepoIds.reverse()
  graph.capabilities.queries.reverse()
  for (const node of graph.nodes) node.tags.reverse()
  const b = await reader(graph).exportGraphView({ limit: 100 })
  assert.equal(a, b)
  const fixtureBytes = fs.readFileSync(new URL('../fixtures/graph-view/synthetic-view.v1.json', import.meta.url), 'utf8')
  // Git may convert the transport fixture to CRLF on Windows. Its parsed
  // payload/digest stay fixed; the normative serializer still emits JCS + LF.
  const expected = `${canonicalJson(parseGraphView(fixtureBytes))}\n`
  assert.equal(a, expected)
  assert.equal(a, `${canonicalJson(parseGraphView(fixtureBytes.replace(/\r?\n/g, '\r\n')))}\n`)
  assert.equal(a.includes('\r'), false)
  const view = parseGraphView(a)
  const { projectionDigest, ...payload } = view
  assert.equal(projectionDigest, digestJson(payload))
  assert.equal(serializeGraphView(view), a)
})

test('qualified identities, duplicate triples, support closure and abstention remain inspectable', async () => {
  const view = await reader().readGraphView()
  assert.equal(view.nodes.filter(node => node.ref.localId === 'observation').length, 2)
  assert.equal(view.edges.filter(edge => edge.predicate === 'supports').length, 2)
  const evidenceIds = new Set(view.evidence.map(item => item.evidenceId))
  for (const edge of view.edges) for (const id of [edge.sourceRef, ...edge.supportRefs]) assert.ok(evidenceIds.has(id))
  assert.equal(view.evidence.length, 5)
  assert.equal(view.questions.find(item => item.coverage === 'abstain').nodeRefs.length, 0)
  assert.equal(view.page.truncated, false)
})

test('metadata search, directed expansion, question retrieval and honest bounded pages', async () => {
  const graph = input(), host = reader(graph)
  const searched = await host.readGraphView({ search: 'SECOND OBSERVATION' })
  assert.equal(searched.nodes.length, 1)
  assert.equal(searched.nodes[0].ref.repoId, 'synthetic:workshop')
  const expanded = await host.readGraphView({ focusRef: graph.nodes[2].ref, depth: 1, direction: 'out', relationFilter: ['contradicts'] })
  assert.equal(expanded.nodes.length, 2)
  assert.deepEqual(expanded.edges.map(edge => edge.predicate), ['contradicts'])
  const question = await host.readGraphView({ questionId: 'synthetic-question-unknown' })
  assert.equal(question.nodes.length, 0)
  assert.equal(question.questions[0].coverage, 'abstain')
  const first = await host.readGraphView({ limit: 2 })
  assert.equal(first.nodes.length, 2)
  assert.equal(first.page.omitted.nodes, 2)
  assert.equal(first.page.truncated, true)
  const second = await host.readGraphView({ snapshot: first.snapshot, limit: 2, cursor: first.page.nextCursor })
  assert.equal(second.nodes.length, 2)
  assert.equal(second.page.nextCursor, null)
  assert.equal(new Set([...first.nodes, ...second.nodes].map(node => JSON.stringify(node.ref))).size, 4)
  await fails(host.readGraphView({ limit: 3, cursor: first.page.nextCursor }), 'stale_cursor')
})

test('source/grant changes invalidate previous snapshots and cursors', async () => {
  const graph = input(), host = reader(graph)
  const previous = await host.readGraphView({ limit: 2 })
  graph.accessContext.grantRevision = 'synthetic-grant-r2'
  await fails(host.readGraphView({ snapshot: previous.snapshot, limit: 2 }), 'stale_source')
  await fails(host.readGraphView({ cursor: previous.page.nextCursor, limit: 2 }), 'stale_cursor')
  graph.nodes[0].summary = 'A changed authorized source summary.'
  assert.notEqual((await host.readGraphView()).snapshot, previous.snapshot)
})

test('trusted loader controls universe; caller readerScope and arbitrary metadata never serialize', async () => {
  const graph = input()
  for (const node of graph.nodes) { node.body = 'BODY-SHOULD-NOT-LEAVE'; node.relations = { related: ['DENIED-TARGET-SHOULD-NOT-LEAVE'] } }
  graph.accessContext.principalRef = 'PRIVATE-BINDING-SHOULD-NOT-LEAVE'
  graph.rawError = 'DENIED-REPO-SHOULD-NOT-LEAVE'
  const host = reader(graph)
  const bytes = await host.exportGraphView()
  assert.doesNotMatch(bytes, /SHOULD-NOT-LEAVE/)
  await fails(host.readGraphView({ ext: { readerScope: ['synthetic:workshop'] } }), 'contract_mismatch')
  await fails(host.readGraphView({ readerScope: ['synthetic:workshop'] }), 'contract_mismatch')
  await fails(host.readGraphView({ focusRef: { repoId: 'not-present', localId: 'guessed' } }), 'unavailable')
  await fails(host.readGraphView({ focusRef: { repoId: 'synthetic:garden', localId: 'missing' } }), 'unavailable')
})

test('revocation and expiry during delivery refuse bytes and errors without echoing host details', async () => {
  const graph = input()
  await fails(reader(graph, { revalidate: async () => false }).exportGraphView(), 'policy_refusal')
  await fails(reader(graph, { revalidate: async () => { throw new Error('hidden host path') } }).exportGraphView(), 'policy_refusal')
  await fails(reader(graph, { now: () => Date.parse('2031-01-01T00:00:00Z') }).readGraphView(), 'policy_refusal')
  await fails(reader(graph, { now: () => NaN }).readGraphView(), 'policy_refusal')
  let checked = false
  await fails(reader(graph, { revalidate: async () => { checked = true; return false } }).readGraphView({ focusRef: { repoId: 'unknown', localId: 'unknown' } }), 'policy_refusal')
  assert.equal(checked, true)
})

test('dangling/duplicate IDs, stale verified pins, malformed ranges and unknown predicates fail closed', async () => {
  const mutations = [
    graph => graph.nodes.push(graph.nodes[0]),
    graph => graph.edges[0].target = { repoId: 'denied', localId: 'hidden' },
    graph => graph.evidence.pop(),
    graph => graph.nodes[0].sourceRef.digest = `sha256:${'0'.repeat(64)}`,
    graph => graph.evidence[0].sourceRef.locator.range.end = -1,
    graph => graph.evidence[0].sourceRef.locator.range.start = 5,
    graph => graph.nodes[0].sourceRef.path = '../outside.md',
    graph => graph.edges[0].predicate = 'invented-canonical',
  ]
  for (const mutate of mutations) {
    const graph = input(); mutate(graph)
    await fails(reader(graph).readGraphView(), 'contract_mismatch')
  }
})

test('budgets and all support occurrences are retained or refused', async () => {
  await fails(reader().readGraphView({ limit: 501 }), 'contract_mismatch')
  await fails(reader().readGraphView({ focusRef: input().nodes[0].ref, depth: 3 }), 'contract_mismatch')
  const graph = input()
  graph.capabilities.maxSlice = 1
  await fails(reader(graph).readGraphView({ limit: 2 }), 'budget_exceeded')
  const view = await reader().readGraphView({ limit: 1 })
  for (const edge of view.edges) assert.ok(edge.supportRefs.length > 0)
})

test('intents bind exact semantic identity/digest and do not create authority', async () => {
  const view = await reader().readGraphView()
  assert.equal(assertGraphViewIntent(view, { type: 'select', projectionDigest: view.projectionDigest, edgeId: view.edges[0].edgeId }).edgeId, view.edges[0].edgeId)
  assert.equal(assertGraphViewIntent(view, { type: 'openEvidence', projectionDigest: view.projectionDigest, evidenceId: view.evidence[0].evidenceId }).type, 'openEvidence')
  assert.throws(() => assertGraphViewIntent(view, { type: 'select', projectionDigest: `sha256:${'0'.repeat(64)}`, ref: view.nodes[0].ref }), { code: 'stale_source' })
  assert.throws(() => assertGraphViewIntent(view, { type: 'select', projectionDigest: view.projectionDigest, ref: view.nodes[0].ref, edgeId: view.edges[0].edgeId }), { code: 'contract_mismatch' })
  assert.throws(() => assertGraphViewIntent(view, { type: 'toString', projectionDigest: view.projectionDigest }), { code: 'contract_mismatch' })
  assert.throws(() => assertGraphViewIntent(view, { type: 'expand', projectionDigest: view.projectionDigest, ref: null, direction: 'both' }), { code: 'contract_mismatch' })
  assert.throws(() => assertGraphViewIntent(view, { type: 'openEvidence', projectionDigest: view.projectionDigest, ref: view.nodes[0].ref }), { code: 'contract_mismatch' })
})

test('CLI validates fixture locally; export uses trusted operation and refuses output overwrite', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-graph-view-'))
  try {
    let stdout = '', stderr = '', operation
    const io = { stdout: value => { stdout += value }, stderr: value => { stderr += value } }
    assert.equal(await runGraphViewCommand([], io), 2)
    assert.match(stderr, /host_binding_required/)
    const out = path.join(tmp, 'view.json')
    const host = reader(input(), { loadAuthorizedGraph: async request => { operation = request.operation; return { graph: input(), binding: { trusted: true } } } })
    assert.equal(await runGraphViewCommand(['--out', out], { ...io, reader: host }), 0)
    assert.equal(operation, 'export')
    assert.equal(await runGraphViewCommand(['--out', out], { ...io, reader: host }), 2)
    assert.equal(await runGraphViewCommand(['--validate', out], io), 0)
    assert.equal(stdout, 'graph-view fixture valid\n')
    assert.equal(await runGraphViewCommand(['--validate', out, '--out', path.join(tmp, 'copy.json')], io), 2)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('100, 500 and 2000-record synthetic inputs remain bounded and paginate deterministically', async () => {
  for (const size of [100, 500, 2000]) {
    const graph = input(), repo = graph.sourceSnapshot.repositories[0]
    graph.sourceSnapshot.repositories = [repo]
    graph.accessContext.authorizedRepoIds = [repo.repoId]
    graph.edges = []; graph.evidence = []; graph.questions = []; graph.diagnostics = []
    const template = graph.nodes[0]
    repo.files = Array.from({ length: size }, (_, index) => ({ path: `content/record-${index}.md`, rawDigest: template.sourceRef.digest, byteLength: 100 }))
    graph.nodes = repo.files.map((file, index) => ({ ...template, ref: { repoId: repo.repoId, localId: `record-${String(index).padStart(4, '0')}` }, sourceRef: { ...template.sourceRef, path: file.path }, title: `Record ${index}` }))
    const host = reader(graph), first = await host.readGraphView({ limit: 50 })
    assert.equal(first.nodes.length, 50)
    assert.equal(first.page.omitted.nodes, size - 50)
    assert.equal(first.sourceSnapshot.repositories[0].files.length, 50)
    assert.equal(first.sourceSnapshot.repositories[0].omittedFiles, size - 50)
    assert.equal(await host.exportGraphView({ limit: 50 }), serializeGraphView(first))
    assert.ok(Buffer.byteLength(serializeGraphView(first)) < 100000)
  }
})

test('transport parser refuses altered digests, dangling endpoints and false returned counts', async () => {
  const original = await reader().readGraphView()
  const tampered = structuredClone(original)
  tampered.nodes[0].title = 'Changed without a new digest'
  assert.throws(() => parseGraphView(JSON.stringify(tampered)), { code: 'digest_mismatch' })
  for (const mutate of [view => view.edges[0].target.localId = 'missing', view => view.page.returned.nodes = 999]) {
    const view = structuredClone(original); mutate(view)
    const { projectionDigest, ...payload } = view
    view.projectionDigest = digestJson(payload)
    assert.throws(() => parseGraphView(JSON.stringify(view)), { code: 'contract_mismatch' })
  }
})

test('exact cited-byte digest survives the source occurrence projection', async () => {
  const graph = input(), rangeDigest = `sha256:${'a'.repeat(64)}`
  graph.evidence[0].sourceRef.locator.rangeDigest = rangeDigest
  const view = await reader(graph).readGraphView()
  assert.equal(view.evidence.find(item => item.evidenceId === graph.evidence[0].evidenceId).sourceRef.locator.rangeDigest, rangeDigest)
  delete graph.evidence[0].sourceRef.locator.range
  await fails(reader(graph).readGraphView(), 'contract_mismatch')
})
