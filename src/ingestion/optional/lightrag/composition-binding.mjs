import { isDeepStrictEqual } from 'node:util'

const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.length > 0
const artifact = value => object(value) && nonempty(own(value, 'artifactId'))
const sources = value => Array.isArray(value) && value.length > 0 && value.every(source => object(source) &&
  ['sourceId', 'sourceDigest', 'attemptId'].every(key => nonempty(own(source, key))))

export class LightRAGCompositionBindingError extends TypeError {
  constructor(message, returned, { snapshotState = 'received', snapshotError = null } = {}) {
    super(message, snapshotError ? { cause: snapshotError } : undefined)
    this.name = 'LightRAGCompositionBindingError'
    this.retainedReturn = returned
    this.snapshotState = snapshotState
    this.snapshotError = snapshotError
    this.effectUncertain = true
    this.retryAuthorized = false
    // Failure data/costs are custody, never a successful host receipt identity.
    for (const [key, value] of [['usage', own(own(returned, 'envelope'), 'usage') ?? null], ['supplierCosts', own(returned, 'costs') ?? null]]) {
      try { this[key] = structuredClone(value) }
      catch (error) { this[key] = value; this[`${key}SnapshotError`] = error }
    }
  }
}

/** Private host-dispatched binding; no Python/SDK process or receipt principal is
 * constructed here. The actual host owns execution and the verified receipt bridge.
 */
export function createLightRAGCompositionBinding({ dispatch }) {
  if (typeof dispatch !== 'function') throw new TypeError('Existing host supplier dispatch required')
  const run = async (operation, payload) => {
    // The host dispatches exactly one selected supplier query, canonical citation
    // receiving, then receive_composition with its actual verified receipt owner.
    const returned = await dispatch({ operation, payload })
    let received
    try { received = structuredClone(returned) }
    catch (snapshotError) {
      throw new LightRAGCompositionBindingError('Original supplier return could not be snapshotted', returned,
        { snapshotState: 'failed', snapshotError })
    }
    const envelope = received?.envelope
    if (received?.operation !== 'receive-composition' || received.outcome !== 'composition-envelope-received' ||
        !object(envelope) || envelope.provider !== 'lightrag' || !nonempty(received.generationId) || envelope.generation !== received.generationId ||
        envelope.nativeOperation !== operation || !envelope.receiptRef || !envelope.bridgeReceipt ||
        envelope.receiptAssurance !== 'explicit-verified-existing-host-bridge' ||
        !artifact(received.supplierQueryReceipt) || !artifact(received.supplierReceivingReceipt) ||
        !artifact(received.envelopeArtifact) || !artifact(received.artifact) ||
        !artifact(envelope.supplierQueryReceipt) || !artifact(envelope.supplierReceivingReceipt) || !artifact(envelope.artifactRef) ||
        !sources(received.sourceBindings) || !sources(envelope.sourceBindings) ||
        !Array.isArray(envelope.hits) || !Array.isArray(envelope.unresolvedReferences) ||
        !isDeepStrictEqual(envelope.artifactRef, received.supplierReceivingReceipt) ||
        !isDeepStrictEqual(envelope.supplierReceivingReceipt, received.supplierReceivingReceipt) ||
        !isDeepStrictEqual(envelope.supplierQueryReceipt, received.supplierQueryReceipt) ||
        !isDeepStrictEqual(envelope.sourceBindings, received.sourceBindings)) {
      throw new LightRAGCompositionBindingError('Original supplier descriptors, source binding/capture and actual verified host receipt bridge required', received)
    }
    if (operation === 'answer' && !envelope.nativeResult?.llm_response) throw new LightRAGCompositionBindingError('Original coupled native answer required', received)
    return structuredClone(envelope)
  }
  return Object.freeze({
    bindings: Object.freeze({ retrieve: payload => run('retrieve', payload), nativeAnswer: payload => run('answer', payload) }),
    operationRoles: Object.freeze({ retrieve: 'retrieve', nativeAnswer: 'native-answer' }),
    hostRequired: Object.freeze(['single-selected-supplier-query', 'existing-canonical-citation-hydration',
      'existing-current-source-and-quote-support', 'actual-verified-host-receipt-bridge']),
  })
}
