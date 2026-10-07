// Invented descriptor and custody fixtures; dispatch returns only local objects.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createLightRAGCompositionBinding } from '../../src/ingestion/optional/lightrag/composition-binding.mjs'

const artifact = (name) => ({ artifactId: `sha256:${name.repeat(64)}`, kind: 'invented-fixture', bytes: 3, storage: 'host-memory' })
function returned() {
  const query = artifact('a'), receiving = artifact('b'), sourceBindings = [{ sourceId: 'invented-source', sourceDigest: 'c'.repeat(64), attemptId: 'invented-attempt' }]
  return { operation: 'receive-composition', outcome: 'composition-envelope-received', generationId: 'invented-current-generation',
    supplierQueryReceipt: query, supplierReceivingReceipt: receiving, sourceBindings,
    envelopeArtifact: artifact('d'), artifact: artifact('e'), costs: { QUERY: { cost: null, inputTokens: null } },
    envelope: { provider: 'lightrag', generation: 'invented-current-generation', nativeOperation: 'retrieve',
      receiptRef: { id: 'authored-host-receipt', digest: 'sha256:' + 'f'.repeat(64) }, bridgeReceipt: 'authored-host-bridge',
      receiptAssurance: 'explicit-verified-existing-host-bridge', hits: [], unresolvedReferences: [],
      supplierQueryReceipt: query, artifactRef: receiving, supplierReceivingReceipt: receiving, sourceBindings,
      usage: { query: { roles: { QUERY: { cost: null } } }, receiving: { roles: {} }, bridge: { usage: null } },
      nativeResult: { metadata: { original: 'retained' } } } }
}
const run = value => createLightRAGCompositionBinding({ dispatch: async () => value }).bindings.retrieve({ question: 'invented' })

test('complete original descriptors are copied with original unknown usage', async () => {
  const value = returned(), result = await run(value)
  assert.deepEqual(result, value.envelope)
  assert.notEqual(result, value.envelope)
  result.sourceBindings[0].sourceId = 'changed'
  assert.equal(value.sourceBindings[0].sourceId, 'invented-source')
})

test('missing or null top-level original descriptors and capture refuse', async () => {
  for (const key of ['supplierQueryReceipt', 'supplierReceivingReceipt', 'sourceBindings', 'envelopeArtifact', 'artifact']) {
    for (const missing of [true, false]) {
      const value = returned()
      if (missing) delete value[key]; else value[key] = null
      await assert.rejects(run(value), /original.*descriptor|Original supplier/i, `${key}/${missing}`)
    }
  }
})

test('both missing or null compared query descriptors cannot agree by absence', async () => {
  for (const missing of [true, false]) {
    const value = returned()
    if (missing) { delete value.supplierQueryReceipt; delete value.envelope.supplierQueryReceipt }
    else { value.supplierQueryReceipt = null; value.envelope.supplierQueryReceipt = null }
    await assert.rejects(run(value), /original.*descriptor|Original supplier/i)
  }
})

test('both missing artifactRef and receiving descriptors cannot agree by absence', async () => {
  const value = returned()
  delete value.supplierReceivingReceipt; delete value.envelope.supplierReceivingReceipt; delete value.envelope.artifactRef
  await assert.rejects(run(value), /original.*descriptor|Original supplier/i)
})

test('missing/null/empty current source binding or mismatch refuses', async () => {
  for (const sources of [undefined, null, []]) {
    const value = returned()
    value.sourceBindings = sources; value.envelope.sourceBindings = sources
    await assert.rejects(run(value), /original.*descriptor|Original supplier/i)
  }
  const value = returned(); value.envelope.sourceBindings = [{ sourceId: 'another-source' }]
  await assert.rejects(run(value), /Original supplier/i)
})

test('empty artifact descriptor cannot substitute for original retained capture', async () => {
  const value = returned(); value.envelopeArtifact = {}
  await assert.rejects(run(value), /original.*descriptor|Original supplier/i)
})

test('malformed returned output and unknown costs remain detached on refusal', async () => {
  const value = returned(); value.outcome = 'failed-or-partial'
  let error
  try { await run(value) } catch (caught) { error = caught }
  assert.ok(error)
  assert.deepEqual(error.retainedReturn, value)
  assert.deepEqual(error.supplierCosts, value.costs)
  assert.deepEqual(error.usage, value.envelope.usage)
  assert.equal(error.retryAuthorized, false)
  assert.equal(error.snapshotState, 'received')
  value.envelope.usage.query.roles.QUERY.cost = 777
  assert.equal(error.usage.query.roles.QUERY.cost, null)
  assert.equal(error.retainedReturn.envelope.usage.query.roles.QUERY.cost, null)
})

test('coupled answer refusal retains original bridge references and costs', async () => {
  const value = returned(); value.envelope.nativeOperation = 'answer'
  const binding = createLightRAGCompositionBinding({ dispatch: async () => value })
  await assert.rejects(binding.bindings.nativeAnswer({}), error => {
    assert.deepEqual(error.retainedReturn, value)
    assert.deepEqual(error.usage, value.envelope.usage)
    return true
  })
})

test('uncloneable return remains explicit failed-snapshot custody without receipt promotion', async () => {
  const value = returned(); value.nativeCallback = () => 'invented'
  await assert.rejects(run(value), error => {
    assert.equal(error.snapshotState, 'failed')
    assert.equal(error.retainedReturn, value)
    assert.ok(error.snapshotError)
    assert.equal(error.effectUncertain, true)
    assert.equal(error.retryAuthorized, false)
    assert.equal(Object.hasOwn(error, 'receiptRef'), false)
    return true
  })
})
