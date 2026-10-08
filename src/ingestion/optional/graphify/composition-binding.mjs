/** Private existing-host dispatch receiving; no SDK, process or receipt owner.
 * The dispatcher owns a single selected query, canonical evidence receiving and
 * independently verified host step receipt receiving, including no-hit output.
 */
export class GraphifyCompositionBindingError extends Error {
  constructor(message, received, cause) {
    super(message, { cause })
    this.name = 'GraphifyCompositionBindingError'
    // Native failures and rejected bridges retain actual outputs/costs. A failed
    // snapshot keeps the original producer object explicitly in error custody.
    try { this.supplierResult = structuredClone(received); this.snapshotState = 'received' }
    catch (snapshotError) { this.supplierResult = received; this.snapshotState = 'failed'; this.snapshotError = snapshotError }
    this.retryAuthorized = false
  }
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const artifact = value => object(value) && Object.keys(value).sort().join(',') === 'bytes,path,sha256' &&
  typeof value.path === 'string' && value.path.length > 0 && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes >= 0
const sources = value => object(value) && Object.entries(value).every(([id, source]) => id.length > 0 && object(source) &&
  source.sourceId === id && typeof source.path === 'string' && source.path.length > 0 && /^[a-f0-9]{64}$/.test(source.sourceDigest))
export function createGraphifyCompositionBinding({ dispatch }) {
  if (typeof dispatch !== 'function') throw new TypeError('Existing host Graphify dispatch required')
  const retrieve = async payload => {
    let received
    try { received = await dispatch({ operation: 'retrieve', payload }) }
    catch (cause) { throw new GraphifyCompositionBindingError('Selected Graphify host dispatch failed; reconcile original custody', cause?.supplierResult ?? cause?.receipt ?? null, cause) }
    const envelope = received?.envelope
    const binding = received?.hostVerificationOriginal?.binding
    if (received?.operation !== 'receive-composition' || received.outcome !== 'composition-envelope-received' ||
        !envelope || envelope.provider !== 'graphify' || envelope.nativeOperation !== 'query' ||
        typeof envelope.generation !== 'string' || !envelope.generation || envelope.generation !== received.generationId || !envelope.receiptRef || !envelope.bridgeReceipt ||
        envelope.receiptAssurance !== 'explicit-verified-existing-host-bridge' ||
        !Array.isArray(envelope.hits) || !Array.isArray(envelope.unresolved) ||
        !artifact(envelope.artifactRef) || !artifact(received.compositionArtifact) ||
        !artifact(envelope.supplierQueryReceipt) || !artifact(received.supplierQueryReceipt) ||
        !artifact(envelope.supplierReceivingReceipt) || !artifact(received.supplierReceivingReceipt) ||
        !sources(envelope.sourceBindings) || !sources(binding?.sourceBindings) ||
        !artifact(binding?.queryArtifact) || !artifact(binding?.queryReceiptArtifact) || !artifact(binding?.receivingArtifact) ||
        !same(envelope.supplierQueryReceipt, received.supplierQueryReceipt) ||
        !same(envelope.supplierReceivingReceipt, received.supplierReceivingReceipt) ||
        !same(envelope.receiptRef, received.receiptBridgeOriginal?.receiptRef) ||
        !same(envelope.bridgeReceipt, received.receiptBridgeOriginal?.bridgeReceipt) ||
        received.hostVerificationOriginal?.verified !== true || received.hostVerificationOriginal?.current !== true ||
        binding?.provider !== 'graphify' || binding.generation !== envelope.generation ||
        !same(binding.sourceBindings, envelope.sourceBindings) || !same(binding.queryArtifact, envelope.artifactRef) ||
        !same(binding.queryReceiptArtifact, envelope.supplierQueryReceipt) || !same(binding.receivingArtifact, envelope.supplierReceivingReceipt) ||
        !same(binding.receiptRef, envelope.receiptRef) || !same(binding.bridgeReceipt, envelope.bridgeReceipt) ||
        !Object.hasOwn(binding, 'bridgeUsage') || !Object.hasOwn(received.receiptBridgeOriginal ?? {}, 'usage') ||
        !object(envelope.usage?.bridge) || !Object.hasOwn(envelope.usage.bridge, 'usage') ||
        !same(binding.bridgeUsage, received.receiptBridgeOriginal.usage) || !same(binding.bridgeUsage, envelope.usage.bridge.usage)) {
      throw new GraphifyCompositionBindingError('Original Graphify receiving and actual verified host receipt bridge required', received)
    }
    return structuredClone(envelope)
  }
  return Object.freeze({ bindings: Object.freeze({ retrieve }), operationRoles: Object.freeze({ retrieve: 'retrieve' }),
    hostRequired: Object.freeze(['single-selected-query', 'existing-canonical-evidence-hydration',
      'independent-current-quote-eligibility', 'actual-verified-existing-host-step-receipt']) })
}
