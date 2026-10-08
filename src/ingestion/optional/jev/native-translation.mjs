import {closed, freeze, requireThat, requireContracts, snapshot} from './judgments.mjs';

/** Data-only translation for the EXISTING transport's future compatible seam. */
export function translateNativeResponse(batch, input, contracts, {mode = 'shadow', elapsedMs = 0} = {}) {
  requireContracts(contracts); const raw = snapshot(input);
  requireThat(['shadow', 'advisory'].includes(mode), 'invalid-decision-mode');
  closed(raw, ['model', 'answers', 'usage']);
  requireThat(raw.model === batch.nativePayload.model, 'native-model-mismatch');
  closed(raw.answers, Object.keys(batch.request.questions)); closed(raw.usage, ['input_tokens', 'output_tokens']);
  const answers = Object.fromEntries(Object.entries(batch.request.questions).map(([id, q]) => {
    const a = raw.answers[id];
    if (q.type === 'boolean') {
      closed(a, ['type', 'noul']); requireThat(a.type === 'noul', 'native-question-type-mismatch');
      return [id, {type: 'boolean', probability: a.noul}];
    }
    if (q.type === 'score') {
      closed(a, ['type', 'score', 'probabilities', 'confidence']);
      requireThat(a.type === 'score', 'native-question-type-mismatch');
      closed(a.probabilities, q.criteria.map((_, i) => String(i)));
      return [id, {type: 'score', score: a.score, probabilities: q.criteria.map((_, i) => a.probabilities[String(i)]), confidence: a.confidence}];
    }
    closed(a, ['type', 'choice', 'probabilities', 'confidence']);
    requireThat(a.type === 'choice', 'native-question-type-mismatch'); return [id, a];
  }));
  const result = {schema: 'atelier-decision-result@v1', contractVersion: '1.0.0',
    requestId: batch.request.id, requestDigest: batch.requestDigest, task: batch.request.task,
    rubricVersion: batch.request.rubricVersion, scope: batch.request.scope,
    provider: {id: 'jev', model: raw.model}, authority: 'proposal-only', mode,
    status: 'assessed', answers, usage: {inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens}, elapsedMs};
  requireThat(contracts.validateDecisionResult(batch.request, result).ok, 'canonical-result-refused');
  return freeze({result, originalNativeResponse: raw, nativePayloadDigest: batch.nativePayloadDigest});
}
