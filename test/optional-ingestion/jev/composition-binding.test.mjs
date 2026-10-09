import * as contracts from '../../../src/decisions/contracts.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createComposition, CompositionFailure} from '../../../src/ingestion/optional/composition/index.mjs';
import {createCompositionJudgmentBinding} from '../../../src/ingestion/optional/jev/composition-binding.mjs';
import {prepareIngestionJudgments, byteDigest, materialDigest} from '../../../src/ingestion/optional/jev/judgments.mjs';
import {translateNativeResponse} from '../../../src/ingestion/optional/jev/native-translation.mjs';
import {fixture, fixtureAdmission, qualifications, nativeResponse} from './fixture.mjs';
function host({mode = 'advisory', data = fixture(['candidate-identity', 'evidence-support']), changes = {}} = {}) {
  const counters = {prepare: 0, assess: 0, admit: 0, current: 0, receiptOpen: 0, receiptComplete: 0}, journal = new Map();
  const batches = prepareIngestionJudgments(data, contracts);
  const transport = {kind: 'offline-fixture', reference: 'fixture-existing-host:offline-assess'};
  const options = {contracts, mode, transport, placements: [...new Set(data.judgments.map(j => j.placement))], qualifications: qualifications(),
    admitAssessment: async intent => {counters.admit++; return fixtureAdmission(intent, {batches, journal, transport});},
    prepare: async payload => {counters.prepare++; assert.equal(payload.extraction.receiptRef, 'fixture-existing-host:extraction-1');
      return {judgmentsInput: data, preparationReceiptRef: 'fixture-existing-host:prepare-1',
        attempts: batches.map((b, i) => ({requestDigest: b.requestDigest, attemptId: 'fixture-original-attempt:' + i}))};},
    checkCurrent: async () => {counters.current++; return true;},
    assess: async request => {counters.assess++; const batch = batches.find(b => b.requestDigest === contracts.decisionRequestDigest(request));
      return translateNativeResponse(batch, nativeResponse(batch), contracts, {mode: 'advisory'}).result;},
    receiptCustody: async value => {
      if (value.phase === 'open') counters.receiptOpen++; else counters.receiptComplete++;
      const receiptRef = 'fixture-existing-host:' + value.phase + ':' + journal.size;
      journal.set(receiptRef, structuredClone(value)); return {receiptRef, bindingDigest: value.bindingDigest};
    }, ...changes};
  return {callable: createCompositionJudgmentBinding(options), counters, journal, batches};
}
async function compose(h) {
  const binding = createComposition({bindings: {vanilla: {extract: async () => ({receiptRef: 'fixture-existing-host:extraction-1', candidates: [{id: 'assertion:invented', state: 'proposed'}], usage: null})}, jev: {assess: h.callable}},
    operationRoles: {vanilla: {extract: 'extract'}, jev: {assess: 'assess'}},
    invoke: async ({callable, payload, signal}) => callable(payload, {signal}),
    readKnowledgeView: async ({requestedView, assessments}) => ({kind: requestedView, ownerRef: 'fixture-existing-knowledge-owner', assessments}),
    eligible: async () => ({current: true, permitted: true})});
  return binding.execute({route: {profile: 'jev', extractor: {provider: 'vanilla', operation: 'extract'}, assessors: [{provider: 'jev', operation: 'assess'}],
    retrievers: [], projectors: [], view: 'native-exploration'}, input: {id: 'invented-input'}, question: 'An invented question'});
}
test('actual parent composition receives selected judgments and genuine fixture-host receipt refs with all distributions/usage', async () => {
  const h = host(), result = await compose(h);
  assert.equal(h.counters.assess, 1); assert.equal(h.counters.current, 3);
  assert.equal(h.counters.admit, 1);
  const bundle = result.assessments[0]; assert.equal(bundle.status, 'assessed');
  assert(h.journal.has(bundle.receiptRef)); assert(h.journal.has(bundle.originalHostReceiptRef));
  assert.equal(bundle.assessments[0].result.answers.q0.choice, 'existing-a');
  assert.equal(bundle.assessments[0].dispositions.q0.selection.subjectId, 'entity:atlas-project');
  assert.equal(bundle.assessments[0].result.usage.inputTokens, 123);
  assert.deepEqual(result.receipts[1].usage, {inputTokens: 123, outputTokens: 17});
  assert.equal(result.canonicalMutation, false); assert.equal(result.nativeQualification, false);
});
test('Off adds zero assessment/preparation/source-check effects to the actual vanilla composition', async () => {
  const h = host({mode: 'off'}), result = await compose(h);
  assert.equal(h.counters.prepare, 0); assert.equal(h.counters.assess, 0); assert.equal(h.counters.current, 0); assert.equal(h.counters.admit, 0);
  assert.equal(result.selectedExtractorCount, 1); assert.equal(result.extraction.candidates[0].state, 'proposed');
  assert.equal(result.assessments[0].status, 'off'); assert.equal(result.assessments[0].assessments.length, 0);
  assert(h.journal.has(result.receipts[1].receiptRef), 'Off still has an actual fixture-host invocation receipt');
});
test('unknown first assessment preserves original host custody and does not invoke a second batch', async () => {
  const data = fixture(['evidence-support', 'query-relevance']);
  data.evidence.push({...data.evidence[0], id: 'evidence:second', sourceRef: 'second-invented-locator'});
  data.judgments[1].evidenceIds = ['evidence:second'];
  const h = host({data, changes: {assess: async () => {throw Error('fixture-host-outcome-unknown');}}});
  const result = await compose(h), bundle = result.assessments[0];
  assert.equal(bundle.status, 'execution-unknown'); assert.equal(bundle.assessments.length, 1); assert.equal(bundle.remaining.length, 1);
  assert.equal(bundle.usage, null); assert.equal(bundle.usageAccounting.unknownUsageCount, 1); assert.equal(bundle.usageAccounting.unattemptedBatchCount, 1);
  assert(h.journal.has(bundle.originalHostReceiptRef)); assert.equal(result.receipts[1].usage, null);
  assert.equal(bundle.assessments[0].result.reason, 'provider-unavailable');
});
test('uncertain and abstained assessments are retained by the real parent route', async () => {
  const data = fixture(['evidence-support']), batch = prepareIngestionJudgments(data, contracts)[0];
  const output = structuredClone(translateNativeResponse(batch, nativeResponse(batch), contracts, {mode: 'advisory'}).result);
  output.answers.q0.probability = 0.5;
  const h = host({data, changes: {assess: async () => output}});
  const result = await compose(h); assert.equal(result.assessments[0].assessments[0].dispositions.q0.status, 'abstained');
  assert.equal(result.assessments[0].assessments[0].result.answers.q0.probability, 0.5);
  assert.equal(result.view.assessments[0].assessments[0].result.usage.outputTokens, 17);
});
test('failed completion receipt keeps all responses under the original received host intent reference', async () => {
  const journal = new Map(), data = fixture(['candidate-identity', 'evidence-support']), batches = prepareIngestionJudgments(data, contracts),
    transport = {kind: 'offline-fixture', reference: 'fixture-existing-host:offline-assess'}, h = host({data, changes: {
    admitAssessment: async intent => fixtureAdmission(intent, {batches, journal, transport}), receiptCustody: async value => {
    if (value.phase === 'complete') throw Error('fixture-receipt-write-unknown');
    journal.set('fixture-original-host:intent', structuredClone(value));
    return {receiptRef: 'fixture-original-host:intent', bindingDigest: value.bindingDigest};
  }}});
  const result = await compose(h), bundle = result.assessments[0];
  assert.equal(bundle.receiptUpdateStatus, 'unknown'); assert.equal(bundle.receiptRef, 'fixture-original-host:intent');
  assert.equal(bundle.status, 'receipt-update-unknown'); assert.equal(bundle.assessmentStatus, 'assessed');
  assert(journal.has(bundle.receiptRef)); assert.equal(bundle.assessments[0].result.status, 'assessed');
  assert.equal(bundle.assessments[0].result.usage.inputTokens, 123);
  assert.equal(result.receipts[1].receiptRef, bundle.originalHostReceiptRef);
});
test('actual composition refuses assessment without original host admission even with matching fixture qualification labels', async () => {
  const h = host({changes: {admitAssessment: undefined}}), result = await compose(h), bundle = result.assessments[0];
  assert.equal(h.counters.assess, 0); assert.equal(bundle.status, 'abstained');
  assert.equal(bundle.assessments[0].bridgeReason, 'original-host-admission-and-receipt-required');
  assert(h.journal.has(bundle.originalHostReceiptRef)); assert(h.journal.has(bundle.receiptRef));
});
test('actual composition and original host completion retain all response usage when post-assessment currency check throws', async () => {
  const h = host({changes: {checkCurrent: async i => {
    if (i.phase !== 'before-result-use') return true; throw Error('fixture-sensitive-currency-error');
  }}});
  const result = await compose(h), bundle = result.assessments[0], r = bundle.assessments[0];
  assert.equal(bundle.status, 'abstained'); assert.equal(r.result.status, 'abstained');
  assert.equal(r.originalHostResult.answers.q0.choice, 'existing-a');
  assert.deepEqual(bundle.usage, {inputTokens: 123, outputTokens: 17}); assert.deepEqual(result.receipts[1].usage, bundle.usage);
  assert(h.journal.has(r.hostAdmission.receiptRef)); assert(h.journal.has(bundle.originalHostReceiptRef));
  const retained = h.journal.get(bundle.receiptRef).assessmentBundle.assessments[0];
  assert.equal(materialDigest(retained.originalHostResult.answers), materialDigest(r.originalHostResult.answers));
  assert.equal(materialDigest(retained.originalHostResult.usage), materialDigest(r.originalHostResult.usage));
  assert(Object.values(r.dispositions).every(d => d.status === 'abstained'));
  await assert.rejects(compose(h), /operation-already-observed/); assert.equal(h.counters.assess, 1);
});
test('unreceived or mismatched original receipt refuses before any assessment, and repeated host operation never replays', async () => {
  let effects = 0;
  const bad = host({changes: {assess: async () => {effects++;}, receiptCustody: async () => ({receiptRef: 'fixture-ref', bindingDigest: 'wrong'})}});
  await assert.rejects(compose(bad), /receipt-open-reconciliation/); assert.equal(effects, 0);
  const h = host(); await compose(h); await assert.rejects(compose(h), /operation-already-observed/);
  assert.equal(h.counters.assess, 1); assert.equal(h.counters.receiptOpen, 1);
});
test('preparation cannot add a placement, orphan request digest or unsupported replay attempt', async () => {
  const d = fixture(['evidence-support']);
  const h = host({data: d, changes: {prepare: async () => ({judgmentsInput: d, preparationReceiptRef: 'fixture-host:prepare', attempts: [{requestDigest: 'a'.repeat(64), attemptId: 'fixture-attempt'}]})}});
  await assert.rejects(compose(h), /request-attempt-binding/); assert.equal(h.counters.receiptOpen, 0);
  const added = host({data: d, changes: {prepare: async () => ({judgmentsInput: fixture(['query-relevance']), preparationReceiptRef: 'fixture-host:prepare', attempts: []})}});
  await assert.rejects(compose(added), /placement-mismatch/); assert.equal(added.counters.receiptOpen, 0);
});
test('lost opening receipt stays an original operation obligation; an unchanged retry cannot invoke the provider', async () => {
  let calls = 0;
  const h = host({changes: {assess: async () => {calls++;}, receiptCustody: async () => {throw Error('fixture-opening-write-unknown');}}});
  await assert.rejects(compose(h), error => {
    assert(error instanceof CompositionFailure);
    assert.equal(error.cause.message, 'original-host-receipt-open-reconciliation-required');
    assert.equal(error.cause.originalHostIntent.operationId, 'invented-ingestion-op-1');
    assert(error.cause.intentDigest); assert.equal(error.retryAuthorized, false);
    assert.equal(error.receipts.length, 1); assert.equal(error.receipts[0].provider, 'vanilla');
    assert.equal(error.retainedResults[0].result.receiptRef, 'fixture-existing-host:extraction-1');
    assert.equal(error.failedStep.provider, 'jev'); return true;
  });
  await assert.rejects(compose(h), /operation-already-observed/); assert.equal(calls, 0);
});
