import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  createVanillaIngestionBridge, createCandidateExtractor, readVanillaCapture,
  normalizeNativeExtraction, createNativeNormalizer,
  createVanillaCompositionBinding, createComposition,
} from '@mnstry/atelier/ingestion/optional'
import { prepareSemanticInput, prepareSemanticProposals, readSemanticProposals } from '../../src/ingestion/semantic.mjs'

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/atelier-ingestion/semantic-operation.json', import.meta.url)))
const sha = value => createHash('sha256').update(value).digest('hex')
const clone = value => structuredClone(value)
const usage = { inputTokens: 12, outputTokens: 7, cost: 0.003, currency: 'USD', elapsedMs: 9, retries: 0 }

function semanticFixture() {
  const plan = { planId: 'invented-plan', planDigest: `sha256:${sha('invented-plan')}` }
  const lines = fixture.sourceText.trimEnd().split('\n')
  const references = [1, 2, 3].map(line => ({ sourceId: 'notes', sourceDigest: sha(fixture.sourceText),
    attemptId: 'invented-structural-attempt', locator: { kind: 'line', value: String(line) } }))
  const store = { getEvidence(request) {
    const reference = references.find(ref => ref.locator.value === request.locator.value)
    assert.ok(reference, 'The injected owner serves only the selected exact locations')
    for (const [key, value] of Object.entries({ ...plan, ...reference })) assert.deepEqual(request[key], value)
    return { schema: 'mnstry.atelier-ingestion-evidence@v1', ...plan, ...clone(reference), ref: 'notes.txt',
      text: lines[Number(reference.locator.value) - 1], freshness: 'current', integrity: 'verified',
      readScope: 'all-plan', semanticAcceptance: 'pending', synthesized: false }
  } }
  const input = prepareSemanticInput({ store, plan, domain: fixture.domain, references, identityCandidates: [] })
  return { input, store }
}

function graphify(input) {
  return { nodes: [
    { id: 'nora', label: 'Nora', type: 'person', source_location: 'line:1' },
    { id: 'atlas-project', label: 'Atlas', type: 'project', source_location: 'line:1' },
    { id: 'atlas-organization', label: 'Atlas', type: 'organization', source_location: 'line:3' },
  ], edges: [
    { id: 'management', source: 'nora', target: 'atlas-project', relation: 'manages', source_location: 'line:1',
      direction: 'subject-to-object', negated: false, modality: 'possible', scope: input.domain.data.scope,
      time: { from: null, until: null, expression: 'through June', unknowns: ['year'] } },
    { id: 'nonownership', source: 'nora', target: 'atlas-project', relation: 'owns', source_location: 'line:2',
      direction: 'subject-to-object', negated: true, modality: 'asserted', scope: input.domain.data.scope,
      time: { from: null, until: null, expression: null, unknowns: [] } },
  ] }
}

function ownerMappings({ noSupport = false, unmappedPredicate = false } = {}) {
  const types = { person: 'person', project: 'project', organization: 'organization' }
  const predicates = { manages: 'manages', owns: 'owns', funds: 'funds' }
  return {
    entityType: ({ native, input }) => Object.hasOwn(types, native.type)
      ? { id: types[native.type], approved: true, ownerRef: input.domainRef } : null,
    identity: ({ native, nativeRef, kind, input }) => ({
      id: native.id ?? `${kind}-${nativeRef.index + 1}`, ownerRef: input.domainRef,
      identity: { status: 'source-local', candidateIds: [] },
    }),
    predicate: ({ native, input }) => !unmappedPredicate && Object.hasOwn(predicates, native.relation)
      ? { id: predicates[native.relation], approved: true, ownerRef: input.domainRef } : null,
    evidence: ({ native, input }) => {
      if (noSupport && native.id === 'management') return []
      const value = native.source_location?.match(/^line:(\d+)$/u)?.[1]
        ?? (native.source_id === 'invented-span-3' ? '3' : null)
      const span = input.evidence.find(item => item.reference.locator.value === value)
      return span ? [{ reference: span.reference, quote: span.receipt.text }] : []
    },
    participants: ({ native, entityMappings, input }) => ({
      subjectId: entityMappings.find(entity => entity.nativeId === native.source)?.id,
      objectId: native.target === null ? null : entityMappings.find(entity => entity.nativeId === native.target)?.id,
      ownerRef: input.domainRef,
    }),
    qualifiers: () => ({ paths: Object.fromEntries(['direction', 'negated', 'modality', 'scope', 'time'].map(key => [key, [key]])) }),
  }
}

// An explicit injected-port test double, not the durable semantic runner/intake.
// The real canonical input/proposal validators still validate every completion.
function hostPorts({ route = 'authored' } = {}) {
  const semantic = semanticFixture()
  const extractor = { id: 'invented-extractor', version: '1.0.0', route,
    model: route === 'model' ? 'host-selected-model' : null, configurationDigest: sha(route),
    promptDigest: sha('invented-prompt'), parameters: { normalization: 'owner-mapped-v1' } }
  const state = { operationId: 'operation-1', phase: 'reserved', head: 'invented-reservation-head',
    input: semantic.input, extractor, freshness: 'current', usage: null,
    attempt: { status: 'begun', attempt: { attemptId: 'capture-1' } } }
  const counts = { begin: 0, capture: 0, complete: 0 }
  let reserved = false, proposals = null
  const controls = { readback: null, afterCapture: null }
  const status = () => {
    const result = clone(state)
    if (controls.readback === 'missing') delete result.attempt.output
    if (controls.readback === 'mismatch' && result.attempt.completion) result.attempt.completion.outputDigest = sha('different envelope')
    return result
  }
  const runner = {
    begin() {
      counts.begin++
      if (reserved) {
        assert.equal(state.phase, 'completed', 'A reserved execution cannot automatically extract again')
        return { ...status(), cacheReuse: true }
      }
      reserved = true
      return { ...status(), execution: 'ready-for-host', cacheReuse: false }
    },
    status({ operationId }) { assert.equal(operationId, state.operationId); return status() },
    complete(request) {
      counts.complete++
      assert.equal(request.operationId, state.operationId)
      assert.equal(request.confirm, state.head)
      assert.equal(request.output, state.attempt.output)
      assert.equal(request.expectedOutputDigest, state.attempt.completion.outputDigest)
      proposals = prepareSemanticProposals({ ...semantic, candidates: request.candidates })
      state.phase = 'completed'; state.head = 'invented-completed-head'; state.usage = clone(request.usage)
      return { ...status(), proposals: clone(proposals) }
    },
    proposals({ operationId, query }) {
      assert.equal(operationId, state.operationId); assert.ok(proposals)
      return { answerClass: 'pending-proposals', ...readSemanticProposals({ ...semantic, proposals, query }) }
    },
    context() { return { answerClass: 'accepted-knowledge', hits: [] } },
  }
  const captureAttempt = request => {
    counts.capture++
    assert.ok(reserved); assert.equal(request.attemptId, state.attempt.attempt.attemptId)
    assert.equal(sha(request.output), request.expectedOutputDigest)
    assert.equal(state.attempt.status, 'begun')
    state.attempt.status = 'complete'; state.attempt.output = request.output
    state.attempt.completion = { schema: 'mnstry.atelier-intake-completion@v1', attemptId: request.attemptId,
      attemptDigest: sha('invented manifest'), outputDigest: request.expectedOutputDigest,
      bytes: Buffer.byteLength(request.output), integrity: 'verified', semanticAcceptance: 'pending' }
    controls.afterCapture?.()
    return clone(state.attempt.completion)
  }
  const bridge = () => createVanillaIngestionBridge({ runner, captureAttempt,
    now: () => fixture.domain.at, monotonic: () => 0 })
  return { ...semantic, runner, bridge, captureAttempt, counts, controls, state,
    begin: { operationId: state.operationId, attemptId: 'capture-1' } }
}

test('installed authored bridge reserves first and keeps canonical proposals pending', async () => {
  const host = hostPorts()
  const native = graphify(host.input)
  const handoff = normalizeNativeExtraction({ bytes: Buffer.from(JSON.stringify(native)), input: host.input,
    profile: 'graphify', mappers: ownerMappings() })
  const authored = createCandidateExtractor(() => handoff.candidates)
  const result = await host.bridge().execute({ begin: host.begin, extract: args => {
    assert.equal(host.counts.begin, 1); assert.equal(host.state.attempt.status, 'begun')
    return authored(args)
  }, query: 'owns' })
  assert.deepEqual(host.counts, { begin: 1, capture: 1, complete: 1 })
  assert.equal(result.status.usage.cost, 0); assert.equal(result.status.usage.inputTokens, 0)
  assert.equal(result.coverage, 'selected-spans-only'); assert.equal(result.semanticAcceptance, 'pending')
  assert.equal(result.canonicalMutation, false); assert.equal(result.authority, 'none')
  assert.equal(result.proposalView.answerClass, 'pending-proposals')
  assert.equal(result.proposalView.assertions[0].negated, true)
  assert.deepEqual(result.sourceReferences, host.input.evidence.map(span => span.reference))
  assert.equal(host.runner.context().hits.length, 0)
})

test('host-selected extraction saves exact bytes/usage once, then resumes refused interpretation and reuses completion', async () => {
  const host = hostPorts({ route: 'model' })
  const candidates = normalizeNativeExtraction({ bytes: Buffer.from(JSON.stringify(graphify(host.input))),
    input: host.input, profile: 'graphify', mappers: ownerMappings() }).candidates
  const raw = Buffer.from(`  ${JSON.stringify(candidates)}\n`)
  let calls = 0
  await assert.rejects(host.bridge().execute({ begin: host.begin, extract: ({ extractor }) => {
    assert.equal(extractor.model, 'host-selected-model'); calls++
    return { output: raw, usage }
  }, normalize: () => { throw new Error('Invented interpretation refusal') } }), error => {
    assert.equal(error.recovery.extractorMayRunAgain, false); assert.ok(error.captured)
    assert.equal(error.recovery.nextAction, 'resume-interpretation-from-capture'); return true
  })
  const saved = readVanillaCapture(host.runner.status(host.begin))
  assert.deepEqual(saved.bytes, raw); assert.deepEqual(saved.capture.usage, usage)
  assert.equal(saved.capture.raw.sha256, sha(raw))
  assert.equal(saved.outputDigest, sha(saved.outputEnvelope)); assert.notEqual(saved.outputDigest, sha(raw))
  assert.equal(saved.capture.usageAssurance, 'host-reported')
  const resumed = await host.bridge().resume({ operationId: host.begin.operationId, query: 'owns' })
  assert.equal(resumed.status.phase, 'completed'); assert.equal(resumed.proposalView.assertions[0].negated, true)
  const cached = await host.bridge().execute({ begin: host.begin,
    extract: () => { calls++; throw new Error('Cached extraction must not run') },
    normalize: () => { throw new Error('Completed candidates must not be reinterpreted') } })
  assert.equal(cached.cacheReuse, true); assert.equal(calls, 1)
  assert.deepEqual(cached.capture.usage, usage)
  assert.deepEqual(host.counts, { begin: 2, capture: 1, complete: 1 })
})

for (const fault of ['missing', 'mismatch']) test(`failed ${fault} capture readback retains bytes, usage and original attempted receipt`, async () => {
  const host = hostPorts()
  const raw = Buffer.from(JSON.stringify(graphify(host.input))), original = Buffer.from(raw)
  const reported = clone(usage)
  let calls = 0
  host.controls.afterCapture = () => { host.controls.readback = fault; raw.fill(0); reported.cost = 99 }
  await assert.rejects(host.bridge().execute({ begin: host.begin,
    extract: () => { calls++; return { output: raw, usage: reported } },
    normalize: createNativeNormalizer({ profile: 'graphify', mappers: ownerMappings() }) }), error => {
    assert.equal(error.captured, undefined)
    assert.deepEqual(error.uncaptured.output, original); assert.deepEqual(error.uncaptured.usage, usage)
    assert.equal(error.attemptedCapture.attemptId, 'capture-1')
    assert.deepEqual(error.attemptedCapture.completion, host.state.attempt.completion)
    assert.equal(error.recovery.extractorMayRunAgain, false); return true
  })
  await assert.rejects(host.bridge().execute({ begin: host.begin, extract: () => { calls++; return {} } }))
  assert.equal(calls, 1)
  host.controls.readback = null
  const resumed = await host.bridge().resume({ operationId: host.begin.operationId,
    normalize: createNativeNormalizer({ profile: 'graphify', mappers: ownerMappings() }) })
  assert.equal(resumed.status.phase, 'completed')
  assert.deepEqual(readVanillaCapture(resumed.status).bytes, original)
  assert.equal(host.counts.capture, 1); assert.equal(calls, 1)
})

test('saved raw response, envelope and extractor/input pins independently refuse corruption', async () => {
  const host = hostPorts()
  await host.bridge().execute({ begin: host.begin, extract: () => ({ output: JSON.stringify(graphify(host.input)), usage }),
    normalize: createNativeNormalizer({ profile: 'graphify', mappers: ownerMappings() }) })
  const status = host.runner.status(host.begin)
  for (const mutate of [
    value => { value.input.digest = sha('changed input') },
    value => { value.extractor.model = 'another host model' },
    value => { value.attempt.completion.outputDigest = sha('changed envelope') },
    value => { const envelope = JSON.parse(value.attempt.output); envelope.raw.sha256 = sha('changed response'); value.attempt.output = JSON.stringify(envelope) },
  ]) {
    const corrupted = clone(status); mutate(corrupted)
    assert.throws(() => readVanillaCapture(corrupted), { code: 'VANILLA_CAPTURE_INTEGRITY' })
  }
  assert.equal(host.counts.capture, 1)
})

test('pure native handoff preserves rich qualifiers and duplicate labels through current canonical validators', () => {
  const semantic = semanticFixture(), raw = Buffer.from(` ${JSON.stringify(graphify(semantic.input))}\n`)
  const handoff = normalizeNativeExtraction({ bytes: raw, input: semantic.input, profile: 'graphify', mappers: ownerMappings() })
  assert.equal(handoff.refused, false); assert.deepEqual(handoff.unresolved, [])
  assert.deepEqual(handoff.rawBinding, { bytes: raw.length, sha256: sha(raw) })
  const proposals = prepareSemanticProposals({ ...semantic, candidates: handoff.candidates })
  const duplicateLabels = proposals.entities.filter(entity => entity.label === 'Atlas')
  assert.equal(duplicateLabels.length, 2); assert.notEqual(duplicateLabels[0].id, duplicateLabels[1].id)
  assert.equal(proposals.assertions[0].modality, 'possible')
  assert.deepEqual(proposals.assertions[0].time, { from: null, until: null, expression: 'through June', unknowns: ['year'] })
  assert.equal(proposals.assertions[1].negated, true)
  assert.deepEqual(proposals.assertions[0].evidence[0].locator, { kind: 'line', value: '1' })
  assert.equal(proposals.authority, 'none'); assert.equal(proposals.canonicalMutation, false)
  assert.equal(proposals.coverage, 'selected-spans-only')
})

test('unmapped native relations/qualifiers remain located unknowns and missing support refuses normalization', () => {
  const semantic = semanticFixture()
  const native = graphify(semantic.input)
  native.edges[0].relation = 'unmodeled'
  native.edges[1].extraQualifier = 'unrepresented'
  const raw = Buffer.from(JSON.stringify(native))
  const handoff = normalizeNativeExtraction({ bytes: raw, input: semantic.input, profile: 'graphify', mappers: ownerMappings() })
  assert.equal(handoff.refused, false); assert.equal(handoff.candidates.assertions.length, 0)
  assert.deepEqual(handoff.unresolved.map(item => item.code), ['NATIVE_PREDICATE_UNMAPPED', 'NATIVE_QUALIFIER_UNMAPPED'])
  assert.deepEqual(handoff.unresolved.map(item => item.native), native.edges)
  assert.equal(prepareSemanticProposals({ ...semantic, candidates: handoff.candidates }).counts.abstentions, 2)
  const noSupport = ownerMappings({ noSupport: true })
  const missing = normalizeNativeExtraction({ bytes: raw, input: semantic.input, profile: 'graphify', mappers: noSupport })
  assert.equal(missing.refused, true); assert.equal(missing.unresolved[0].code, 'NATIVE_SUPPORT_MISSING')
  assert.equal(missing.unresolved[0].representedUnknownId, null)
  assert.throws(() => createNativeNormalizer({ profile: 'graphify', mappers: noSupport })({ bytes: raw, input: semantic.input }),
    { code: 'NATIVE_HANDOFF_UNRESOLVED' })
  const wrong = ownerMappings()
  wrong.evidence = ({ input }) => [{ reference: { ...input.evidence[0].reference, attemptId: 'other-attempt' }, quote: input.evidence[0].receipt.text }]
  assert.ok(normalizeNativeExtraction({ bytes: raw, input: semantic.input, profile: 'graphify', mappers: wrong })
    .unresolved.every(item => item.code === 'NATIVE_SUPPORT_BINDING'))
})

test('stock LightRAG output never infers direction, negation, modality or time', () => {
  const semantic = semanticFixture()
  const native = { entities: [
    { name: 'Atlas', type: 'organization', source_id: 'invented-span-3' },
    { name: 'Nora', type: 'person', source_id: 'invented-span-3' },
  ], relationships: [{ source: 'Atlas', target: 'Nora', source_id: 'invented-span-3',
    description: 'The Atlas organization funds Nora.', keywords: 'funding' }] }
  const mappers = ownerMappings()
  mappers.predicate = ({ input }) => ({ id: 'funds', approved: true, ownerRef: input.domainRef })
  const handoff = normalizeNativeExtraction({ bytes: Buffer.from(JSON.stringify(native)), input: semantic.input,
    profile: 'lightrag-json', mappers })
  assert.equal(handoff.refused, false); assert.equal(handoff.candidates.assertions.length, 0)
  assert.equal(handoff.unresolved[0].code, 'NATIVE_QUALIFIER_MISSING')
  assert.deepEqual(handoff.unresolved[0].native, native.relationships[0])
  assert.equal(prepareSemanticProposals({ ...semantic, candidates: handoff.candidates }).counts.abstentions, 1)
})

test('installed vanilla composition uses the actual fresh proposal callback and host receipt custody', async () => {
  const host = hostPorts()
  let calls = 0, receiptCalls = 0
  const binding = createVanillaCompositionBinding({ runner: host.runner, captureAttempt: host.captureAttempt,
    now: () => fixture.domain.at, extract: () => { calls++; return { output: JSON.stringify(graphify(host.input)), usage } },
    normalize: createNativeNormalizer({ profile: 'graphify', mappers: ownerMappings() }),
    receiptFor({ operation, operationBinding }) {
      receiptCalls++; assert.deepEqual(operationBinding.completion, host.state.attempt.completion)
      return { operation, attemptId: operationBinding.attemptId, completion: operationBinding.completion }
    } })
  const composition = createComposition({ bindings: { vanilla: binding.bindings }, operationRoles: { vanilla: binding.operationRoles },
    readKnowledgeView: binding.readKnowledgeView,
    invoke: ({ callable, payload, signal }) => callable(payload, { signal }),
    eligible: (reference, { quote, provider, generation }) => {
      const span = host.input.evidence.find(item => item.reference.locator.value === reference.locator.value)
      return { current: reference.revision === span.reference.sourceDigest && reference.representationId === span.reference.attemptId,
        permitted: provider === 'vanilla' && generation === host.input.digest, supported: span.receipt.text.includes(quote) }
    } })
  const route = { profile: 'vanilla', view: 'native-exploration', extractor: { provider: 'vanilla', operation: 'extract' },
    retrievers: [{ provider: 'vanilla', operation: 'retrieve' }] }
  const first = await composition.execute({ route, input: { begin: host.begin, proposalQuery: 'owns' }, question: 'owns' })
  const reopened = await composition.execute({ route, input: { resume: { operationId: host.begin.operationId }, proposalQuery: 'owns' }, question: 'owns' })
  assert.equal(calls, 1); assert.equal(host.counts.capture, 1); assert.equal(receiptCalls, 4)
  assert.equal(first.view.knowledgeView.answerClass, 'pending-proposals')
  assert.equal(first.evidence.hits[0].observations[0].provider, 'vanilla')
  assert.equal(first.evidence.hits[0].observations[0].nativeHit.assertion.negated, true)
  assert.equal(reopened.extraction.cacheReuse, true)
  assert.deepEqual(reopened.extraction.operationBinding.completion, first.extraction.operationBinding.completion)
  assert.equal(first.selectedAnswererCount, 0); assert.equal(first.canonicalMutation, false)
})
