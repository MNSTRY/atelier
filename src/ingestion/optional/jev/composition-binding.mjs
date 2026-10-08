import {createIngestionJudgmentBridge} from './bridge.mjs';
import {closed, freeze, materialDigest, PLACEMENTS, prepareIngestionJudgments, requireThat, snapshot, text, validId} from './judgments.mjs';

function receipt(value, expectedDigest) {
  const v = snapshot(value); closed(v, ['receiptRef', 'bindingDigest']);
  requireThat(text(v.receiptRef, 2048) && v.bindingDigest === expectedDigest, 'host-receipt-custody-unreceived');
  // Integrity binding only: the injected existing host owns receipt authenticity.
  return v.receiptRef;
}
function accounting(assessments, remaining) {
  const known = assessments.map(a => a.result.usage).filter(Boolean);
  const subtotal = known.reduce((sum, u) => ({inputTokens: sum.inputTokens + u.inputTokens,
    outputTokens: sum.outputTokens + u.outputTokens}), {inputTokens: 0, outputTokens: 0});
  requireThat(Object.values(subtotal).every(Number.isSafeInteger), 'aggregate-token-count-overflow');
  const unknown = assessments.length - known.length;
  return {usage: unknown || remaining ? null : subtotal,
    usageAccounting: {knownSubtotal: subtotal, unknownUsageCount: unknown,
      unattemptedBatchCount: remaining, providerCost: null, providerExecutionSettled: 'not-observed-by-binding'}};
}

/** The actual parent composition calls this through its existing invocation owner.
 * Preparation, current-source checks and receipt writes remain injected host ports.
 * This supplier never constructs a host receipt reference or authenticates one.
 */
export function createCompositionJudgmentBinding({contracts, prepare, checkCurrent,
  receiptCustody, admitAssessment, transport, assess, placements, model = 'jev-1.13.0', mode = 'off',
  qualifications = {}, deadlineMs = 15000, maxBatches = 8}) {
  requireThat([prepare, checkCurrent, receiptCustody].every(fn => typeof fn === 'function'), 'existing-host-preparation-source-and-receipt-ports-required');
  requireThat(Array.isArray(placements) && placements.length >= 1 && placements.length <= PLACEMENTS.length &&
    new Set(placements).size === placements.length && placements.every(p => PLACEMENTS.includes(p)), 'explicit-selected-placements-required');
  requireThat(Number.isInteger(maxBatches) && maxBatches >= 1 && maxBatches <= 16, 'finite-batch-bound-required');
  const selected = freeze([...placements]), bridge = createIngestionJudgmentBridge({contracts, assess,
    checkCurrent, admitAssessment, transport, model, mode, qualifications, deadlineMs});
  const operations = new Set();
  return async function ingestionJudgments(payload, {signal} = {}) {
    const input = snapshot(payload); closed(input, ['input', 'extraction']);
    let batches = [], attempts = [], preparationRef = null, operationId = null;
    if (mode !== 'off') {
      requireThat(!signal?.aborted, 'host-cancelled-before-preparation');
      const supplied = snapshot(await prepare({input: input.input, extraction: input.extraction, placements: selected}, {signal}));
      closed(supplied, ['judgmentsInput', 'attempts', 'preparationReceiptRef']);
      requireThat(text(supplied.preparationReceiptRef, 2048), 'existing-host-preparation-receipt-required');
      const actualPlacements = supplied.judgmentsInput.judgments?.map(j => j.placement);
      requireThat(Array.isArray(actualPlacements) && actualPlacements.length >= 1 &&
        actualPlacements.every(p => selected.includes(p)) && selected.every(p => actualPlacements.includes(p)), 'host-preparation-placement-mismatch');
      batches = prepareIngestionJudgments(supplied.judgmentsInput, contracts, {model});
      requireThat(batches.length <= maxBatches, 'selected-batch-limit-exceeded');
      operationId = supplied.judgmentsInput.operationId; preparationRef = supplied.preparationReceiptRef;
      requireThat(!operations.has(operationId), 'host-operation-already-observed-no-replay');
      requireThat(Array.isArray(supplied.attempts) && supplied.attempts.length === batches.length, 'existing-host-attempt-bindings-required');
      const seen = new Set();
      attempts = batches.map(batch => {
        const rows = supplied.attempts.filter(a => a.requestDigest === batch.requestDigest);
        requireThat(rows.length === 1, 'original-host-request-attempt-binding-required');
        const row = rows[0]; closed(row, ['requestDigest', 'attemptId']);
        requireThat(validId(row.attemptId) && !seen.has(row.attemptId), 'distinct-original-host-attempts-required');
        seen.add(row.attemptId); return row.attemptId;
      });
      requireThat(attempts.every(id => bridge.inspect(id) === null), 'original-host-attempt-already-observed-no-replay');
    }
    const intent = freeze({operationId, mode, model, placements: selected, preparationReceiptRef: preparationRef,
      inputDigest: materialDigest(input), extractionReceiptRef: input.extraction?.receiptRef ?? null,
      requests: batches.map((b, i) => ({attemptId: attempts[i], requestId: b.request.id,
        requestDigest: b.requestDigest, preparedNativePayloadDigest: b.nativePayloadDigest,
        bindings: b.bindings, questionPlacements: b.questionPlacements})), authority: 'proposal-only'});
    const intentDigest = materialDigest(intent);
    // Obtain actual original host custody BEFORE any selected assessment port.
    // A failed/lost opening write is also an original host custody obligation.
    if (operationId) operations.add(operationId);
    let originalHostReceiptRef;
    try {originalHostReceiptRef = receipt(await receiptCustody({phase: 'open', bindingDigest: intentDigest,
      intent, assessments: [], remaining: intent.requests}, {signal}), intentDigest);}
    catch {
      const error = new Error('original-host-receipt-open-reconciliation-required');
      error.originalHostIntent = intent; error.intentDigest = intentDigest;
      throw error;
    }
    const assessments = [], unreturnedObservations = []; let reason = null;
    for (let i = 0; i < batches.length; i++) {
      if (signal?.aborted) {reason = 'host-cancelled-between-batches'; break;}
      let result;
      try {result = await bridge.assess(batches[i], {attemptId: attempts[i], signal, originalHostReceiptRef});}
      catch {
        unreturnedObservations.push({request: intent.requests[i], observation: bridge.inspect(attempts[i])});
        reason = 'original-bridge-call-reconciliation-required'; break;
      }
      assessments.push(result);
      // Unknown/abstained work returns to its original owner. It never fans out
      // into additional selected effects, retries or another provider.
      if (result.result.status === 'abstained') {reason = result.bridgeReason ?? result.result.reason; break;}
    }
    const remaining = intent.requests.slice(assessments.length);
    const counts = accounting(assessments, remaining.length);
    const hasUnknown = assessments.some(a => a.execution === 'unknown') || unreturnedObservations.length > 0;
    const status = mode === 'off' ? 'off' : hasUnknown ? 'execution-unknown' : remaining.length ? 'partial' :
      assessments.every(a => a.result.status === 'assessed') ? 'assessed' : 'abstained';
    const bundle = freeze({provider: 'jev', operationId, mode, status, ...(reason ? {reason} : {}),
      placements: selected, preparationReceiptRef: preparationRef, originalHostReceiptRef, intentDigest,
      assessments, remaining, unreturnedObservations, ...counts, authority: 'proposal-only', canonicalMutation: false,
      nativeQualification: false, actualProviderPayloadVerified: false});
    const completionDigest = materialDigest(bundle);
    let receiptRef, receiptUpdateStatus;
    try {
      receiptRef = receipt(await receiptCustody({phase: 'complete', bindingDigest: completionDigest,
        intent, originalHostReceiptRef, assessmentBundle: bundle}, {signal}), completionDigest);
      receiptUpdateStatus = 'host-received';
    } catch {
      // The original host intent receipt still exists. Keep every returned
      // answer/usage and unknown obligation in the value returned to composition.
      receiptRef = originalHostReceiptRef; receiptUpdateStatus = 'unknown';
    }
    return freeze({...bundle, status: receiptUpdateStatus === 'unknown' ? 'receipt-update-unknown' : status,
      assessmentStatus: status, receiptRef, receiptUpdateStatus, completionDigest,
      custody: 'existing-injected-host; reference/digest do not authenticate a principal'});
  };
}
