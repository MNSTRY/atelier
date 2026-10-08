import { createVanillaIngestionBridge, normalizeCandidateJson, readVanillaCapture, VanillaIngestionError } from './index.mjs'

const check = (value, message) => { if (!value) throw new VanillaIngestionError('VANILLA_COMPOSITION_BINDING', message) }

/** Private host adapter for the parent's createComposition callable interface.
 * Receipt references come from the host, not from a new supplier receipt owner.
 */
export function createVanillaCompositionBinding({ runner, captureAttempt, extract,
  normalize = normalizeCandidateJson, receiptFor, now, monotonic }) {
  check(typeof extract === 'function' && typeof receiptFor === 'function', 'Existing host extractor and receipt-reference callback are required')
  check(typeof runner?.context === 'function', 'The existing fresh knowledge context owner is required')
  const bridge = createVanillaIngestionBridge({ runner, captureAttempt, now, monotonic })

  async function bound(operationId) {
    const status = await runner.status({ operationId })
    check(status.phase === 'completed' && status.freshness === 'current', 'Current completed semantic operation is required')
    const saved = readVanillaCapture(status)
    return { status, operationBinding: {
      operationId: status.operationId,
      attemptId: status.attempt.attempt.attemptId,
      inputDigest: status.input.digest,
      domainRef: structuredClone(status.input.domainRef),
      configurationDigest: status.extractor.configurationDigest,
      completion: structuredClone(status.attempt.completion),
      rawOutputDigest: saved.capture.raw.sha256,
      historyDigest: status.head,
      sourceReferences: status.input.evidence.map(span => structuredClone(span.reference)),
    } }
  }
  async function receipt(operation, current, extra = {}) {
    const receiptRef = await receiptFor({ operation, operationBinding: structuredClone(current.operationBinding),
      usageAssurance: 'host-reported', authority: 'none', ...extra })
    check(receiptRef !== undefined && receiptRef !== null && receiptRef !== '', 'Host must return its actual receipt/state reference')
    return receiptRef
  }
  function operationId(input, extraction) {
    const id = extraction?.operationBinding?.operationId ?? input?.resume?.operationId
    check(typeof id === 'string' && id.length > 0, 'Use the actual extraction operation or an explicit saved operation')
    return id
  }
  function query(input) {
    check(typeof input?.proposalQuery === 'string' && input.proposalQuery.trim().length > 0, 'Explicit proposal query is required for the current knowledge view')
    return input.proposalQuery
  }

  const extractOperation = async ({ input }, { signal } = {}) => {
    check(Boolean(input?.begin) !== Boolean(input?.resume), 'Select one new reservation or one explicit saved-operation recovery')
    const result = input.begin
      ? await bridge.execute({ begin: input.begin, extract, normalize, signal })
      : await bridge.resume({ operationId: input.resume.operationId, normalize, signal })
    // A cache hit can return an older operation ID than the requested new one.
    // Bind the actual runner result, never the caller's requested reservation.
    const current = await bound(result.status.operationId)
    return { result, operationBinding: current.operationBinding,
      receiptRef: await receipt('extract', current, { cacheReuse: result.cacheReuse }),
      usage: result.cacheReuse ? null : current.status.usage,
      captureUsage: current.status.usage, cacheReuse: result.cacheReuse,
      receiptAssurance: 'host-reference-to-existing-state', authority: 'none', semanticAcceptance: 'pending' }
  }

  const readKnowledgeView = async ({ requestedView, input, extraction }) => {
    check(['native-exploration', 'accepted-knowledge'].includes(requestedView), 'Select an existing knowledge view')
    const current = await bound(operationId(input, extraction)), selectedQuery = query(input)
    // A domain reference identifies existing ledger/domain custody. It does not
    // authenticate a human receiver or assert that any candidate was admitted.
    const knowledgeView = requestedView === 'native-exploration'
      ? await runner.proposals({ operationId: current.status.operationId, query: selectedQuery })
      : await runner.context({ query: selectedQuery })
    return { kind: requestedView, ownerRef: current.status.input.domainRef,
      ownerRefSemantics: 'existing-knowledge-domain-reference', operationBinding: current.operationBinding,
      knowledgeView, authority: 'none', canonicalMutation: false }
  }

  const retrieveOperation = async ({ input, question, view }) => {
    check(view?.kind === 'native-exploration', 'This located proposal retriever serves native exploration only; accepted context stays with its receiver')
    const current = await bound(view.operationBinding?.operationId)
    // Revalidate evidence at retrieval, rather than serving a captured view object.
    const proposalView = await runner.proposals({ operationId: current.status.operationId,
      query: typeof question === 'string' && question.trim() ? question : query(input) })
    const hits = proposalView.assertions.flatMap(assertion => assertion.evidence.map(citation => ({
      evidenceRef: { sourceId: citation.sourceId, revision: citation.sourceDigest,
        representationId: citation.attemptId, locator: structuredClone(citation.locator) },
      quote: citation.quote, assertion: structuredClone(assertion),
      score: null, scoreSemantics: 'literal-pending-proposal-match', semanticAcceptance: 'pending',
    })))
    return { hits, proposalView, operationBinding: current.operationBinding,
      generation: proposalView.inputDigest,
      artifactRef: { attemptId: current.operationBinding.attemptId,
        outputDigest: current.operationBinding.completion.outputDigest },
      receiptRef: await receipt('retrieve', current, { viewBinding: {
        inputDigest: proposalView.inputDigest, domainRef: proposalView.domainRef,
        answerClass: proposalView.answerClass, query: question ?? input.proposalQuery,
      } }),
      usage: null, receiptAssurance: 'host-reference-to-existing-state',
      coverage: proposalView.coverage, readScope: proposalView.readScope,
      authority: 'none', canonicalMutation: false, semanticAcceptance: 'pending' }
  }
  return Object.freeze({ bindings: Object.freeze({ extract: extractOperation, retrieve: retrieveOperation }),
    // Private execution declaration for the receiver's own-property role checks.
    // This does not register a capability or establish admission authority.
    operationRoles: Object.freeze({ extract: 'extract', retrieve: 'retrieve' }), readKnowledgeView })
}
