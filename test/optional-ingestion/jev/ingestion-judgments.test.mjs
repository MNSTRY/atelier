import * as contracts from '../../../src/decisions/contracts.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareIngestionJudgments, PLACEMENTS, byteDigest, materialDigest} from '../../../src/ingestion/optional/jev/judgments.mjs';
import {translateNativeResponse} from '../../../src/ingestion/optional/jev/native-translation.mjs';
import {createIngestionJudgmentBridge} from '../../../src/ingestion/optional/jev/bridge.mjs';
import {fixture, fixtureAdmission, nativeResponse, qualifications} from './fixture.mjs';

// Read-only use of the actual existing public contract, not a copied canonical.
const prepare = (data = fixture(), options) => prepareIngestionJudgments(data, contracts, options);
const hostResult = batch => translateNativeResponse(batch, nativeResponse(batch), contracts, {mode: 'advisory', elapsedMs: 3}).result;
function bridge(batch, changes = {}) {
  const originalHostReceiptRef = 'fixture-existing-host:intent', journal = new Map([[originalHostReceiptRef, {requestDigest: batch.requestDigest}]]),
    transport = {kind: 'offline-fixture', reference: 'fixture-existing-host:offline-assess'};
  const instance = createIngestionJudgmentBridge({contracts, model: 'jev-1.13.0', mode: 'advisory', transport,
    admitAssessment: async intent => fixtureAdmission(intent, {batches: [batch], journal, transport}),
    qualifications: qualifications(), checkCurrent: async () => true, assess: async () => hostResult(batch), ...changes});
  return {assess: (b, options) => instance.assess(b, {originalHostReceiptRef, ...options}),
    inspect: attemptId => instance.inspect(attemptId), journal};
}

test('all eight placements are selectable; query routing and relevance are distinct questions', () => {
  const batches = prepare(fixture(PLACEMENTS));
  assert.equal(batches.length, 2); assert.equal(Object.keys(batches[0].request.questions).length, 8);
  assert.equal(Object.keys(batches[1].request.questions).length, 1);
  for (const b of batches) assert(contracts.validateDecisionRequest(b.request).ok);
  assert.equal(prepare(fixture(['candidate-identity']))[0].questionPlacements.q0, 'candidate-identity');
  assert.equal(Object.keys(prepare()[0].request.questions).length, 1, 'installation does not run all placements');
});
test('only exact relevant states batch; unrelated evidence never enters a question body', () => {
  const data = fixture(['evidence-support', 'query-relevance']);
  data.sources.push({id: 'source:second', revision: 'b'.repeat(64)});
  data.evidence.push({...data.evidence[0], id: 'evidence:second', sourceId: 'source:second', revision: 'b'.repeat(64), sourceRef: 'second-origin:line:1', text: 'Separate invented material.'});
  data.judgments[1].evidenceIds = ['evidence:second'];
  const batches = prepare(data); assert.equal(batches.length, 2);
  assert(!batches[0].nativeBody.includes('Separate invented material.'));
  assert(!batches[1].nativeBody.includes('It does not own Vega.'));
});
test('identity origin, negation, modality, roles and valid time survive the state projection', () => {
  const data = fixture(['candidate-identity', 'assertion-interpretation']); const b = prepare(data)[0];
  assert.deepEqual(JSON.parse(b.request.state).subjects[0].material, data.subjects[0].material);
  assert(Object.hasOwn(b.request.questions.q0.criteria, 'distinct'));
  assert(Object.hasOwn(b.request.questions.q1.criteria, 'unmodeled'));
  assert.equal(b.bindings.sources[0].revision, data.sources[0].revision);
  assert.equal(b.choiceBindings.q0['existing-a'].subjectId, 'entity:atlas-project');
  assert.equal(b.choiceBindings.q0['existing-b'].subjectId, 'entity:atlas-org');
  assert(b.nativePayload.questions.q0.criteria['existing-a'].includes('Existing supplied subject entity:atlas-project:'));
  assert(b.nativePayload.questions.q0.criteria['existing-b'].includes('Existing supplied subject entity:atlas-org:'));
});
test('equal passage bytes from different source origins remain differently bound', () => {
  const a = fixture(), b = fixture(); b.sources[0].id = 'source:copy'; b.evidence[0].sourceId = 'source:copy'; b.evidence[0].sourceRef = 'source:copy:line:1';
  const left = prepare(a)[0], right = prepare(b)[0];
  assert.notEqual(left.requestDigest, right.requestDigest); assert.notEqual(left.nativePayloadDigest, right.nativePayloadDigest);
});
test('source, assertion, locator, rubric choices and scope changes invalidate the binding', () => {
  const data = fixture(['candidate-identity']), original = prepare(data)[0];
  const changes = [d => {d.subjects[0].revision = 'proposal-revision-2';}, d => {d.evidence[0].locator.end = 2;},
    d => {d.scope.authorizationRef = 'different-ref';}, d => {d.judgments[0].choices[0].description += ' revised';},
    d => {d.sources[0].revision = d.evidence[0].revision = 'a'.repeat(64);}];
  for (const change of changes) {const d = structuredClone(data); change(d); assert.notEqual(prepare(d)[0].requestDigest, original.requestDigest);}
  assert.equal(original.nativePayloadDigest, byteDigest(original.nativeBody));
  assert(Object.isFrozen(original.request.questions.q0.criteria));
});
test('stale or unresolved evidence and dangling subject references refuse before host calls', () => {
  for (const change of [d => {d.evidence[0].revision = 'a'.repeat(64);}, d => {d.judgments[0].subjectIds = ['missing'];}, d => {d.judgments[0].evidenceIds = ['missing'];}]) {
    const d = fixture(); change(d); assert.throws(() => prepare(d));
  }
});
test('unresolved contradiction overlap or absent explicit criterion cannot become a model judgment', () => {
  const d = fixture(['contradiction-review']); d.judgments[0].overlap = 'unknown'; assert.throws(() => prepare(d), /deterministic-overlap/);
  d.judgments[0].overlap = 'overlapping'; delete d.judgments[0].criterion; assert.throws(() => prepare(d), /criterion/);
});
test('unsafe in-process objects refuse without invoking accessors; oversized states are not silently truncated', () => {
  let read = 0; const d = fixture(); Object.defineProperty(d, 'operationId', {enumerable: true, get() {read++; return 'bad';}});
  assert.throws(() => prepare(d)); assert.equal(read, 0);
  const large = fixture(); large.subjects[0].material.description = 'a'.repeat(33000); assert.throws(() => prepare(large), /too-large/);
});
test('duplicate/reserved choices and unsupported placements never reach the provider', () => {
  const a = fixture(['candidate-identity']); a.judgments[0].choices[1].id = a.judgments[0].choices[0].id;
  assert.throws(() => prepare(a));
  a.judgments[0].choices[1].id = 'constructor'; assert.throws(() => prepare(a));
  const b = fixture(); b.judgments[0].placement = 'execute-shell'; assert.throws(() => prepare(b));
  const c = fixture(['candidate-identity']); c.judgments[0].choices[0].subjectId = 'entity:missing';
  assert.throws(() => prepare(c), /subject-binding/);
  c.judgments[0].choices[0].subjectId = c.judgments[0].choices[1].subjectId;
  assert.throws(() => prepare(c), /subject-binding/);
});
test('native Boolean/Score/Choice translation validates against the actual canonical contract', () => {
  const b = prepare(fixture(['evidence-support', 'query-relevance', 'candidate-identity']))[0];
  assert.equal(b.nativePayload.questions.q0.type, 'noul');
  const raw = nativeResponse(b), translated = translateNativeResponse(b, raw, contracts);
  assert(contracts.validateDecisionResult(b.request, translated.result).ok);
  assert.equal(translated.result.answers.q0.probability, 0.9);
  assert.deepEqual(translated.result.answers.q1.probabilities, [0, 0, 1, 0]);
  assert.equal(translated.result.usage.inputTokens, 123);
  assert.deepEqual(JSON.parse(JSON.stringify(translated.originalNativeResponse)), raw);
});
test('native score probability order is numeric, never insertion or lexical order', () => {
  const b = prepare(fixture(['outcome-evaluation']))[0], raw = nativeResponse(b);
  raw.answers.q0.probabilities = {'4': 0.4, '2': 0.3, '0': 0.1, '3': 0.1, '1': 0.1}; raw.answers.q0.score = 2.6;
  const output = translateNativeResponse(b, raw, contracts).result;
  assert.deepEqual(output.answers.q0.probabilities, [0.1, 0.1, 0.3, 0.1, 0.4]);
});
test('wrong models, question types, missing/extra answers, distributions and usage are refused', () => {
  const b = prepare(fixture(['evidence-support', 'query-relevance']))[0];
  const changes = [r => {r.model = 'jev-1.12.0';}, r => {r.answers.q0.type = 'boolean';}, r => {delete r.answers.q0;},
    r => {r.answers.extra = r.answers.q0;}, r => {r.answers.q1.probabilities['4'] = 0;},
    r => {r.answers.q1.score = 1;}, r => {r.usage.input_tokens = -1;}, r => {r.answers.q0.noul = NaN;}];
  for (const change of changes) {const raw = nativeResponse(b); change(raw); assert.throws(() => translateNativeResponse(b, raw, contracts));}
});
test('default Off never calls assessment or freshness ports', async () => {
  const b = prepare()[0]; let calls = 0;
  const p = createIngestionJudgmentBridge({contracts, assess() {calls++;}, checkCurrent() {calls++;}});
  const r = await p.assess(b, {attemptId: 'off-1'});
  assert.equal(r.bridgeReason, 'off'); assert.equal(calls, 0); assert.equal(r.transportInvoked, false);
  assert(contracts.validateDecisionResult(b.request, r.result).ok);
});
test('each placement requires its own model/rubric/profile qualification', async () => {
  const b = prepare()[0]; let calls = 0; const qs = qualifications(); qs['evidence-support'].model = 'jev-1.12.0';
  const p = bridge(b, {qualifications: qs, assess() {calls++;}});
  assert.equal((await p.assess(b, {attemptId: 'unqualified-1'})).bridgeReason, 'placement-profile-unqualified'); assert.equal(calls, 0);
});
test('a host result preserves full answers/usage and individual proposal references', async () => {
  const b = prepare(fixture(['evidence-support', 'query-relevance']))[0]; const phases = [];
  const p = bridge(b, {checkCurrent: async binding => {phases.push(binding.phase); assert.equal(binding.nativePayloadDigest, b.nativePayloadDigest); return true;},
    assess: async (request, options) => {assert.equal(request, b.request); assert.equal(options.nativeBody, b.nativeBody); return hostResult(b);}});
  const r = await p.assess(b, {attemptId: 'ok-1'});
  assert.deepEqual(phases, ['before-assess', 'after-admission-before-assess', 'before-result-use']); assert.equal(r.result.status, 'assessed');
  assert.equal(r.dispositions.q0.status, 'proposal'); assert.equal(r.result.usage.outputTokens, 17);
  assert.equal(r.nativeQualified, false); assert.equal(r.authority, 'proposal-only');
});
test('freshness refusal before invocation does not start the assessment', async () => {
  const b = prepare()[0]; let calls = 0; const p = bridge(b, {checkCurrent: async () => false, assess() {calls++;}});
  const r = await p.assess(b, {attemptId: 'withdrawn-1'}); assert.equal(calls, 0);
  assert.equal(r.result.reason, 'insufficient-evidence'); assert.equal(r.transportInvoked, false);
});
test('withdrawal after assessment retains original result and incurred usage, but refuses result use', async () => {
  const b = prepare()[0]; const p = bridge(b, {checkCurrent: async i => i.phase !== 'before-result-use'});
  const r = await p.assess(b, {attemptId: 'withdrawn-2'});
  assert.equal(r.result.status, 'abstained'); assert.equal(r.result.usage.inputTokens, 123);
  assert.equal(r.originalHostResult.status, 'assessed'); assert.equal(r.transportInvoked, true);
});
test('host admission is required despite matching qualification labels and cannot activate native transport', async () => {
  const b = prepare()[0]; let calls = 0, admissions = 0;
  for (const changes of [{admitAssessment: undefined}, {transport: undefined},
    {transport: {kind: 'native', reference: 'fixture-existing-host:native'}}]) {
    const p = bridge(b, {assess() {calls++;}, ...changes});
    const r = await p.assess(b, {attemptId: 'not-admitted'});
    assert.equal(r.result.reason, 'unauthorized'); assert.equal(r.transportInvoked, false);
  }
  const p = bridge(b, {admitAssessment() {admissions++;}, assess() {calls++;}});
  const r = await p.assess(b, {attemptId: 'missing-original-receipt', originalHostReceiptRef: null});
  assert.equal(r.bridgeReason, 'original-host-admission-and-receipt-required');
  assert.equal(calls, 0); assert.equal(admissions, 0);
});
test('host admission binds exact request scope model rubric body transport and original receipt; its digest is not authentication', async () => {
  const b = prepare()[0], p = bridge(b); const r = await p.assess(b, {attemptId: 'admission-bound'});
  const a = r.hostAdmission; assert.equal(a.status, 'host-received'); assert(p.journal.has(a.receiptRef));
  assert.equal(a.intent.attemptId, 'admission-bound'); assert.equal(a.intent.originalHostReceiptRef, 'fixture-existing-host:intent');
  assert.deepEqual(a.intent.request, b.request); assert.deepEqual(a.intent.scope, b.request.scope);
  assert.deepEqual(a.intent.nativeBody, b.nativeBody); assert.equal(a.intent.model, 'jev-1.13.0');
  assert.equal(a.intent.rubricVersion, b.request.rubricVersion); assert.equal(a.bindingDigest, materialDigest(a.intent));
  assert.equal(a.authenticity, 'owned-by-existing-host-not-observed-by-bridge'); assert.equal(r.nativeQualified, false);
  for (const reply of [i => ({allowed: false, receiptRef: 'fixture-ref', bindingDigest: i.bindingDigest}),
    () => ({allowed: true, receiptRef: 'fixture-ref', bindingDigest: 'a'.repeat(64)}),
    i => ({allowed: true, receiptRef: '', bindingDigest: i.bindingDigest})]) {
    let calls = 0; const refused = bridge(b, {admitAssessment: async i => reply(i), assess() {calls++;}});
    const receipt = await refused.assess(b, {attemptId: 'admission-refused'});
    assert.equal(receipt.bridgeReason, 'original-host-admission-refused'); assert.equal(calls, 0);
  }
  const changed = fixture(); changed.scope.authorizationRef = 'not-the-offline-host-grant';
  let calls = 0; const other = prepare(changed)[0], denied = bridge(other, {assess() {calls++;}});
  const stopped = await denied.assess(other, {attemptId: 'scope-not-admitted'});
  assert.equal(stopped.bridgeReason, 'original-host-admission-unavailable'); assert.equal(calls, 0);
});
test('currency check false or throw retains complete returned distributions and usage under the original attempt without use or replay', async () => {
  for (const throws of [false, true]) {
    const b = prepare(fixture(['candidate-identity', 'evidence-support', 'query-relevance']))[0]; let calls = 0;
    const p = bridge(b, {checkCurrent: async i => {
      if (i.phase !== 'before-result-use') return true;
      if (throws) throw Error('fixture-sensitive-currency-failure'); return false;
    }, assess: async () => {calls++; return hostResult(b);}});
    const r = await p.assess(b, {attemptId: 'post-check-original'});
    assert.equal(r.result.status, 'abstained'); assert.deepEqual({...r.result.usage}, {inputTokens: 123, outputTokens: 17});
    assert.equal(materialDigest(r.originalHostResult.answers), materialDigest(hostResult(b).answers)); assert.equal(r.execution, 'host-returned');
    assert(Object.values(r.dispositions).every(d => d.status === 'abstained'));
    assert.deepEqual(p.inspect('post-check-original').originalHostResult.answers, r.originalHostResult.answers);
    assert(!JSON.stringify(r).includes('fixture-sensitive-currency-failure'));
    await assert.rejects(p.assess(b, {attemptId: 'post-check-original'}), /no-replay/);
    await assert.rejects(p.assess(b, {attemptId: 'changed-id-same-request'}), /no-replay/); assert.equal(calls, 1);
  }
});
test('currency check timeout after a returned result also retains known usage and refuses use', async () => {
  const b = prepare()[0], p = bridge(b, {deadlineMs: 20, checkCurrent: async i => i.phase !== 'before-result-use' ? true : new Promise(() => {})});
  const r = await p.assess(b, {attemptId: 'post-check-timeout'});
  assert.equal(r.result.reason, 'timeout'); assert.equal(r.bridgeReason, 'post-assessment-currency-check-unavailable');
  assert.deepEqual({...r.result.usage}, {inputTokens: 123, outputTokens: 17}); assert.equal(r.originalHostResult.status, 'assessed');
  assert.equal(r.execution, 'host-returned'); assert.equal(r.dispositions.q0.status, 'abstained');
});
test('host admission cannot hide source withdrawal during admission or authorize an assessment afterward', async () => {
  const b = prepare()[0]; let current = true, calls = 0;
  const p = bridge(b, {checkCurrent: async () => current,
    admitAssessment: async intent => {
      const receiptRef = 'fixture-existing-host:admission-withdrawal'; p.journal.set(receiptRef, structuredClone(intent));
      current = false; return {allowed: true, receiptRef, bindingDigest: intent.bindingDigest};
    }, assess() {calls++;}});
  const r = await p.assess(b, {attemptId: 'withdrawn-during-admission'});
  assert.equal(r.bridgeReason, 'source-stale-or-withdrawn-after-admission'); assert.equal(r.hostAdmission.status, 'host-received');
  assert.equal(r.transportInvoked, false); assert.equal(calls, 0); assert(p.journal.has(r.hostAdmission.receiptRef));
  await assert.rejects(p.assess(b, {attemptId: 'new-attempt-after-withdrawal'}), /no-replay/);
});
test('an answer bound to another request or mode is not accepted', async () => {
  const b = prepare()[0];
  for (const change of [r => {r.requestDigest = 'a'.repeat(64);}, r => {r.scope.authorizationRef = 'another';}, r => {r.provider.model = 'jev-1.12.0';}, r => {r.mode = 'shadow';}]) {
    const p = bridge(b, {assess: async () => {const result = structuredClone(hostResult(b)); change(result); return result;}});
    assert.equal((await p.assess(b, {attemptId: 'invalid-1'})).result.reason, 'invalid-response');
  }
});
test('uncertain choice/Boolean scores retain original distributions and abstain by task-specific bars', async () => {
  const b = prepare(fixture(['candidate-identity', 'evidence-support']))[0];
  const output = structuredClone(hostResult(b)); output.answers.q0.choice = 'uncertain';
  for (const key of Object.keys(output.answers.q0.probabilities)) output.answers.q0.probabilities[key] = key === 'uncertain' ? 0.9 : 0.1 / 3;
  output.answers.q1.probability = 0.5;
  const r = await bridge(b, {assess: async () => output}).assess(b, {attemptId: 'ambiguous-1'});
  assert.equal(r.result.status, 'assessed'); assert.equal(r.dispositions.q0.status, 'abstained'); assert.equal(r.dispositions.q1.status, 'abstained');
  assert.equal(r.result.answers.q1.probability, 0.5); assert.equal(r.result.answers.q0.probabilities.uncertain, 0.9);
});
test('distinct and unmodeled identity/interpretation remain proposals; no admission or graph mutation', async () => {
  const b = prepare(fixture(['assertion-interpretation']))[0], output = structuredClone(hostResult(b));
  output.answers.q0.choice = 'unmodeled';
  for (const key of Object.keys(output.answers.q0.probabilities)) output.answers.q0.probabilities[key] = key === 'unmodeled' ? 0.9 : 0.1 / 3;
  const r = await bridge(b, {assess: async () => output}).assess(b, {attemptId: 'unmodeled-1'});
  assert.equal(r.dispositions.q0.status, 'abstained'); assert.equal(r.result.authority, 'proposal-only');
});
test('uncertain scores and host abstention preserve accounting and remain separate from acceptance', async () => {
  const b = prepare(fixture(['query-relevance']))[0], output = structuredClone(hostResult(b));
  output.answers.q0.confidence = 0.1;
  const r = await bridge(b, {assess: async () => output}).assess(b, {attemptId: 'uncertain-score-1'});
  assert.equal(r.dispositions.q0.status, 'abstained'); assert.deepEqual(r.result.answers.q0.probabilities, [0, 0, 1, 0]);
  const noMatch = structuredClone(hostResult(b)); noMatch.status = 'abstained'; noMatch.reason = 'no-match'; noMatch.answers = {}; noMatch.usage = null;
  const stopped = await bridge(b, {assess: async () => noMatch}).assess(b, {attemptId: 'host-abstained-1'});
  assert.equal(stopped.result.reason, 'no-match'); assert.equal(stopped.dispositions.q0.status, 'abstained'); assert.equal(stopped.result.usage, null);
});
test('original attempt cannot be duplicated while pending or after return', async () => {
  const b = prepare()[0]; let resolve, calls = 0;
  const p = bridge(b, {assess: () => {calls++; return new Promise(r => {resolve = r;});}});
  const first = p.assess(b, {attemptId: 'once-1'}); await delay(1);
  await assert.rejects(p.assess(b, {attemptId: 'once-1'}), /no-replay/);
  await assert.rejects(p.assess(b, {attemptId: 'different-id-same-request'}), /request-already-observed/);
  resolve(hostResult(b)); await first;
  await assert.rejects(p.assess(b, {attemptId: 'once-1'}), /no-replay/); assert.equal(calls, 1);
});
test('cancelled-before-invocation reports zero host calls', async () => {
  const b = prepare()[0], controller = new AbortController(); controller.abort(); let calls = 0;
  const r = await bridge(b, {assess() {calls++;}}).assess(b, {attemptId: 'cancel-1', signal: controller.signal});
  assert.equal(r.transportInvoked, false); assert.equal(calls, 0); assert.equal(r.result.reason, 'timeout');
});
test('timeout remains unknown, retains a late original result for inspection and never retries', async () => {
  const b = prepare()[0]; let resolve, calls = 0;
  const p = bridge(b, {deadlineMs: 5, assess: () => {calls++; return new Promise(r => {resolve = r;});}});
  const r = await p.assess(b, {attemptId: 'timeout-1'});
  assert.equal(r.result.reason, 'timeout'); assert.equal(r.execution, 'unknown'); assert.equal(r.result.usage, null);
  resolve(hostResult(b)); await delay(1); const seen = p.inspect('timeout-1');
  assert.equal(seen.hostReturned, true); assert.equal(seen.originalHostResult.usage.inputTokens, 123);
  assert.equal(seen.providerExecutionSettled, 'not-observed-by-bridge');
  await assert.rejects(p.assess(b, {attemptId: 'timeout-1'}), /no-replay/); assert.equal(calls, 1);
});
test('port errors are bounded and cannot become a provider refusal verdict or reveal exception content', async () => {
  const b = prepare()[0]; const p = bridge(b, {assess: async () => {throw Error('fixture-sensitive-error-do-not-echo');}});
  const r = await p.assess(b, {attemptId: 'error-1'}); assert.equal(r.execution, 'unknown');
  assert.equal(r.result.reason, 'provider-unavailable'); assert(!JSON.stringify(r).includes('fixture-sensitive-error'));
  assert(!JSON.stringify(p.inspect('error-1')).includes('fixture-sensitive-error'));
});
test('serialized artifacts or a different prepared model cannot masquerade as the live local handle', async () => {
  const b = prepare()[0], p = bridge(b);
  await assert.rejects(p.assess(JSON.parse(JSON.stringify(b)), {attemptId: 'copy-1'}), /fresh-prepared/);
  const other = prepare(fixture(), {model: 'jev-1.14.0'})[0];
  await assert.rejects(p.assess(other, {attemptId: 'model-1'}), /fresh-prepared/);
});
