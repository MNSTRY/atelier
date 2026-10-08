import {closed, freeze, materialDigest, requireContracts, requirePrepared, requireThat, snapshot, text, validId, RUBRIC_VERSION} from './judgments.mjs';

function abstention(batch, model, mode, reason, elapsedMs, usage = null) {
  return freeze({schema: 'atelier-decision-result@v1', requestId: batch.request.id,
    requestDigest: batch.requestDigest, task: batch.request.task, rubricVersion: batch.request.rubricVersion,
    scope: batch.request.scope, provider: {id: 'jev', model}, authority: 'proposal-only',
    mode, status: 'abstained', reason, answers: {}, usage, elapsedMs});
}
function qualified(batch, qualifications, model) {
  return Object.entries(batch.questionPlacements).every(([id, placement]) => {
    const q = qualifications[placement], type = batch.request.questions[id].type;
    return q && q.model === model && q.rubricVersion === RUBRIC_VERSION && validId(q.reference) &&
      q.sourceProfile === 'invented-public-offline' &&
      (type !== 'boolean' || Number.isFinite(q.rejectAtOrBelow) && Number.isFinite(q.acceptAtOrAbove) &&
        q.rejectAtOrBelow >= 0 && q.acceptAtOrAbove <= 1 && q.rejectAtOrBelow < q.acceptAtOrAbove) &&
      (type !== 'choice' || Number.isFinite(q.minimumConfidence) && q.minimumConfidence >= 0 && q.minimumConfidence <= 1 &&
        Number.isFinite(q.minimumMargin) && q.minimumMargin > 0 && q.minimumMargin <= 1) &&
      (type !== 'score' || Number.isFinite(q.minimumConfidence) && q.minimumConfidence >= 0 && q.minimumConfidence <= 1);
  });
}
function dispositions(batch, result, qualifications) {
  if (result.status === 'abstained') return Object.fromEntries(Object.keys(batch.request.questions).map(id => [id, {status: 'abstained', reason: result.reason}]));
  return Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => {
    const placement = batch.questionPlacements[id], q = qualifications[placement]; let ambiguous = false;
    if (answer.type === 'choice') {
      const values = Object.values(answer.probabilities).sort((a, b) => b - a);
      ambiguous = ['uncertain', 'unmodeled'].includes(answer.choice) || answer.confidence < q.minimumConfidence || values[0] - values[1] < q.minimumMargin;
    } else if (answer.type === 'boolean') ambiguous = answer.probability > q.rejectAtOrBelow && answer.probability < q.acceptAtOrAbove;
    else if (answer.type === 'score') ambiguous = answer.confidence < q.minimumConfidence;
    return [id, {placement, status: ambiguous ? 'abstained' : 'proposal', ...(ambiguous ? {reason: 'ambiguous'} : {}),
      answerRef: {requestId: result.requestId, requestDigest: result.requestDigest, questionId: id},
      ...(answer.type === 'choice' && batch.choiceBindings[id]?.[answer.choice] ? {selection: batch.choiceBindings[id][answer.choice]} : {}),
      qualificationRef: q.reference, authority: 'proposal-only'}];
  }));
}
/**
 * An offline supplier around the existing assess(request, options) host port.
 * No HTTP, credentials, Consent implementation, cache, budget or executor.
 * This packet profile deliberately refuses native activation; the transport
 * owner must receive the narrow compatibility proposal before native use.
 */
export function createIngestionJudgmentBridge({contracts, assess, checkCurrent, admitAssessment, transport,
  model = 'jev-1.13.0', mode = 'off', qualifications = {}, deadlineMs = 15000, now = Date.now}) {
  requireContracts(contracts);
  requireThat(['off', 'shadow', 'advisory'].includes(mode) && /^jev-\d+\.\d+\.\d+$/.test(model) &&
    Number.isInteger(deadlineMs) && deadlineMs >= 1 && deadlineMs <= 30000 && typeof now === 'function', 'invalid-bridge-configuration');
  const qualificationSnapshot = freeze(snapshot(qualifications)),
    transportSnapshot = transport === undefined ? null : freeze(snapshot(transport)),
    attempts = new Map(), observedRequests = new Set();
  async function run(batch, {attemptId, signal, originalHostReceiptRef} = {}) {
    requirePrepared(batch, model); requireThat(validId(attemptId), 'original-attempt-identity-required');
    requireThat(!attempts.has(attemptId), 'attempt-already-observed-no-replay');
    const originalRequestKey = batch.operationId + ':' + batch.requestDigest;
    requireThat(!observedRequests.has(originalRequestKey), 'request-already-observed-no-replay');
    const started = now(), elapsed = () => Math.max(0, now() - started), resultMode = mode === 'off' ? 'shadow' : mode;
    const record = {attemptId, requestId: batch.request.id, requestDigest: batch.requestDigest, execution: 'not-invoked', transportInvoked: false,
      hostAdmission: {status: 'not-requested', authenticity: 'owned-by-existing-host-not-observed-by-bridge'}};
    attempts.set(attemptId, record);
    observedRequests.add(originalRequestKey);
    const finish = (result, reason, originalResult = null) => {
      requireThat(contracts.validateDecisionResult(batch.request, result).ok, 'canonical-result-refused');
      const receipt = freeze({attemptId, operationId: batch.operationId, requestId: batch.request.id,
        requestDigest: batch.requestDigest, nativePayloadDigest: batch.nativePayloadDigest,
        nativePayloadDigestKind: 'prepared-body-only', actualProviderPayloadDigest: null,
        bindings: batch.bindings, questionPlacements: batch.questionPlacements,
        model, rubricVersion: RUBRIC_VERSION, execution: record.execution,
        transportInvoked: record.transportInvoked, providerInvocation: 'not-observed-by-bridge',
        authority: 'proposal-only', nativeQualified: false,
        hostAdmission: record.hostAdmission,
        result, originalHostResult: originalResult, dispositions: dispositions(batch, result, qualificationSnapshot),
        ...(reason ? {bridgeReason: reason} : {})});
      record.returnedReceipt = receipt; return receipt;
    };
    const stop = (reason, bridgeReason = reason, usage = null, original = null) => finish(abstention(batch, model, resultMode, reason, elapsed(), usage), bridgeReason, original);
    if (mode === 'off') return stop('unauthorized', 'off');
    if (signal?.aborted) return stop('timeout', 'cancelled-before-invocation');
    if (!qualified(batch, qualificationSnapshot, model)) return stop('unauthorized', 'placement-profile-unqualified');
    if (typeof assess !== 'function' || typeof checkCurrent !== 'function') return stop('provider-unavailable', 'existing-assess-and-current-source-ports-required');
    // Fixture qualification labels and integrity digests are never admission.
    // Native transport is still outside this supplier's received profile.
    if (!transportSnapshot || transportSnapshot.kind !== 'offline-fixture' || !validId(transportSnapshot.reference) ||
        Object.keys(transportSnapshot).length !== 2) return stop('unauthorized', 'offline-host-transport-required');
    if (typeof admitAssessment !== 'function' || !text(originalHostReceiptRef, 2048))
      return stop('unauthorized', 'original-host-admission-and-receipt-required');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(abort, deadlineMs);
    async function bounded(promise) {
      if (controller.signal.aborted) throw Error('bounded-abort');
      return new Promise((resolve, reject) => {
        const cancel = () => reject(Error('bounded-abort'));
        controller.signal.addEventListener('abort', cancel, {once: true});
        Promise.resolve(promise).then(value => {controller.signal.removeEventListener('abort', cancel); resolve(value);}, error => {
          controller.signal.removeEventListener('abort', cancel); reject(error);
        });
      });
    }
    const current = phase => checkCurrent(freeze({phase, attemptId, operationId: batch.operationId,
      requestDigest: batch.requestDigest, nativePayloadDigest: batch.nativePayloadDigest, bindings: batch.bindings}), controller.signal);
    let stage = 'source-check', receivedHostResult = null, validatedHostResult = null;
    try {
      if (await bounded(Promise.resolve().then(() => current('before-assess'))) !== true) return stop('insufficient-evidence', 'source-stale-or-withdrawn');
      if (controller.signal.aborted) return stop('timeout', 'cancelled-before-invocation');
      const intent = freeze({phase: 'before-assess', attemptId, operationId: batch.operationId,
        originalHostReceiptRef, request: batch.request, requestDigest: batch.requestDigest,
        scope: batch.request.scope, model, mode, rubricVersion: RUBRIC_VERSION,
        questionPlacements: batch.questionPlacements, bindings: batch.bindings,
        placementQualifications: Object.fromEntries([...new Set(Object.values(batch.questionPlacements))].map(p => [p, qualificationSnapshot[p]])),
        transport: transportSnapshot, nativeBody: batch.nativeBody,
        preparedNativePayloadDigest: batch.nativePayloadDigest, actualProviderPayloadDigest: null,
        authority: 'proposal-only', nativeQualified: false});
      const bindingDigest = materialDigest(intent);
      stage = 'admission';
      record.hostAdmission = {status: 'unknown', intent, bindingDigest,
        authenticity: 'owned-by-existing-host-not-observed-by-bridge'};
      const admitted = snapshot(await bounded(Promise.resolve().then(() => admitAssessment(freeze({...intent, bindingDigest}), {signal: controller.signal}))));
      closed(admitted, ['allowed', 'receiptRef', 'bindingDigest']);
      if (admitted.allowed !== true || !text(admitted.receiptRef, 2048) || admitted.bindingDigest !== bindingDigest) {
        record.hostAdmission = {...record.hostAdmission, status: 'refused', originalHostReply: freeze(admitted)};
        return stop('unauthorized', 'original-host-admission-refused');
      }
      record.hostAdmission = {...record.hostAdmission, status: 'host-received', receiptRef: admitted.receiptRef};
      stage = 'source-check';
      if (await bounded(Promise.resolve().then(() => current('after-admission-before-assess'))) !== true)
        return stop('insufficient-evidence', 'source-stale-or-withdrawn-after-admission');
      if (controller.signal.aborted) return stop('timeout', 'cancelled-before-invocation');
      stage = 'assessment';
      const hostPromise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw Error('bounded-abort');
        record.transportInvoked = true; record.execution = 'unknown';
        return assess(batch.request, {
          attemptId, operationId: batch.operationId, model, mode, rubricVersion: RUBRIC_VERSION,
          signal: controller.signal, nativePayloadDigest: batch.nativePayloadDigest,
          nativeBody: batch.nativeBody, bindings: batch.bindings, qualificationProfile: 'invented-public-offline',
          originalHostReceiptRef, hostAdmissionReceiptRef: admitted.receiptRef,
          admissionBindingDigest: bindingDigest, transport: transportSnapshot});
      });
      hostPromise.then(value => {record.hostReturned = true; try {record.originalHostResult = freeze(snapshot(value));} catch {record.invalidHostResult = true;}},
        () => {record.hostReturned = true; record.hostError = 'host-assessment-failed';});
      const output = snapshot(await bounded(hostPromise));
      receivedHostResult = output;
      // Return of this port does not independently settle the underlying provider.
      record.execution = 'host-returned';
      if (!contracts.validateDecisionResult(batch.request, output).ok || output.provider.id !== 'jev' || output.provider.model !== model || output.mode !== resultMode)
        return stop('invalid-response', 'unbound-or-invalid-host-result', null, output);
      validatedHostResult = output; stage = 'result-check';
      if (await bounded(Promise.resolve().then(() => current('before-result-use'))) !== true)
        return stop('insufficient-evidence', 'source-stale-or-withdrawn-after-assess', output.usage, output);
      return finish(freeze(output), null, output);
    } catch {
      return stop(controller.signal.aborted ? 'timeout' : validatedHostResult ? 'insufficient-evidence' : 'provider-unavailable',
        stage === 'result-check' ? 'post-assessment-currency-check-unavailable' :
        stage === 'admission' ? 'original-host-admission-unavailable' :
        record.transportInvoked ? 'host-outcome-requires-original-transport-reconciliation' : 'pre-invocation-check-unavailable',
        validatedHostResult?.usage ?? null, receivedHostResult ?? record.originalHostResult ?? null);
    } finally {clearTimeout(timer); signal?.removeEventListener('abort', abort);}
  }
  return Object.freeze({assess: run, inspect(attemptId) {
    const record = attempts.get(attemptId); if (!record) return null;
    return freeze(snapshot({attemptId: record.attemptId, requestId: record.requestId,
      requestDigest: record.requestDigest, execution: record.execution, transportInvoked: record.transportInvoked,
      hostReturned: record.hostReturned ?? false, originalHostResult: record.originalHostResult ?? null,
      hostAdmission: record.hostAdmission,
      providerExecutionSettled: 'not-observed-by-bridge', hostError: record.hostError ?? null}));
  }});
}
