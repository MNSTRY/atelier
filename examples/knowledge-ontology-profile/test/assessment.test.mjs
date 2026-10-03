import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessCapture, renderAssessment, summarizeSession, digest } from '../tools/assessment-core.mjs';
import { ratio, deriveMeasurement, measurementErrors, summarizeMeasurements, assessQuality } from '../tools/measurements.mjs';

const capture = JSON.parse(fs.readFileSync(new URL('./fixtures/capture.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const experiment = { sourceSetSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), questionSetSha256: 'c'.repeat(64), procedureSha256: 'd'.repeat(64), cohort: 'held-out', runKind: 'cold' };
const record = () => ({
  schema: 'atelier-enablement-measurement/local-v1', id: 'synthetic-test-baseline',
  observedAt: '2026-09-30T02:00:00Z', reportedBy: 'Unit test; no real measurements or acceptance',
  method: 'direct-source-search', experiment: clone(experiment), evidenceRefs: ['synthetic-unit-test'],
  ingestion: { sourcesSelected: 10, sourcesParsed: 9, sourcesFailed: 1, sourcesOmitted: 0, proposedNodes: 20, proposedEdges: 12, proposedAssertions: 20, admittedAssertions: 18, verifiedReadbacks: 18 },
  quality: { reviewedAssertions: 20, supportedAssertions: 19, wrongMerges: 0, qualificationErrors: 0, evaluatedQuestions: 10, supportedAnswers: 8, correctAbstentions: 2 },
  time: { ingestionMs: 1000, reviewMinutes: 5, correctionMinutes: 2, totalElapsedMs: 600000, firstSupportedResultMs: 300000 },
  usage: { providerCalls: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 0, accountingNote: 'Synthetic provider input may include cache reads; do not sum buckets.' },
  cost: { currency: 'USD', providerAmount: 1, computeAmount: 1, humanAmount: 10, totalAmount: 12 },
  outcome: { userAccepted: null, observedUsefulResult: null, laterAppropriateReuse: null, evidenceRef: null },
  notes: 'Synthetic test data, excluded from delivered measurements.',
});
const floor = () => ({ schema: 'atelier-enablement-quality-floor/local-v1', declaredAt: '2026-09-29T00:00:00Z', declaredBy: 'Synthetic unit test',
  experiment: clone(experiment), minReviewedAssertions: 20, minEvaluatedQuestions: 10, minSupportedPrecision: 0.95, minTaskSuccessRatio: 1, maxWrongMerges: 0, maxQualificationErrors: 0 });

test('a structurally valid fixture retains unknown meaning, economics, and permissions', () => {
  const r = assessCapture(clone(capture));
  assert.equal(r.summary.fail, 0);
  assert.equal(r.retrieval.filter(c => c.checksPass).length, 3);
  for (const code of ['SEMANTIC_QUALITY', 'TASK_COST', 'HOST_PERMISSIONS'])
    assert.equal(r.findings.find(f => f.code === `LOCAL.${code}`).status, 'unknown');
  assert.match(r.summary.meaning, /No overall/);
  assert.equal(r.declaredDirectAssessmentProviderCalls, 0);
  for (const f of r.findings) for (const ref of f.evidenceRefs) {
    if (ref.startsWith('capture.json#')) {
      const value = ref.split('#')[1].slice(1).split('/').reduce((v, k) => v?.[k.replaceAll('~1', '/').replaceAll('~0', '~')], capture);
      assert.notEqual(value, undefined, `Evidence locator must resolve: ${ref}`);
    }
  }
});

test('changed evidence pins fail even when the expected source IDs are present', () => {
  const c = clone(capture);
  c.dashboard.evaluation.cases[0].runs.graph.stale = ['loan:inspection'];
  const r = assessCapture(c);
  assert.equal(r.findings.find(f => f.code === 'LOCAL.EVIDENCE.loan').status, 'fail');
  assert.equal(r.retrieval[0].checksPass, false);
  assert.match(r.findings.find(f => f.code === 'LOCAL.EVIDENCE.loan').nextAction.label, /before revising/);
});

test('reported provider calls stay distinct from the example declaration and unknown usage', () => {
  const c = clone(capture); c.dashboard.providerCalls = 3;
  let r = assessCapture(c);
  assert.equal(r.declaredDirectAssessmentProviderCalls, 0);
  assert.equal(r.reportedDashboardProviderCalls, 3);
  delete c.dashboard.providerCalls; r = assessCapture(c);
  assert.equal(r.reportedDashboardProviderCalls, null);
});

test('a directed relation gap fails a question even with its source documents selected', () => {
  const c = clone(capture), run = c.dashboard.evaluation.cases[0].runs.graph;
  // An optimistic flag cannot override a concrete missing directed relation.
  run.missingRelations = ['loan-check']; run.expectedEvidencePresent = true;
  assert.equal(assessCapture(c).findings.find(f => f.code === 'LOCAL.EVIDENCE.loan').status, 'fail');
});

test('source changes during a run and stale authoring sessions remain actionable', () => {
  const c = clone(capture);
  c.consistent = false; c.finalSnapshot = 'f'.repeat(64); c.sessions.items[0].current = false;
  const r = assessCapture(c);
  assert.equal(r.findings.find(f => f.code === 'LOCAL.SNAPSHOT').status, 'fail');
  assert(r.findings.some(f => f.code.startsWith('LOCAL.STALE_SESSION.') && f.status === 'fail'));
  assert.match(renderAssessment(r), /Inputs changed during assessment/);
});

test('missing evaluation, uninspected sessions, and empty draft saves are never passed', () => {
  const c = clone(capture);
  c.dashboard.evaluation = null; c.sessions.complete = false; c.sessions.items[0].savedFields = 0;
  const r = assessCapture(c);
  assert.equal(r.findings.find(f => f.code === 'LOCAL.NO_EVALUATION').status, 'unknown');
  assert.equal(r.findings.find(f => f.code === 'LOCAL.SESSION_COVERAGE').status, 'unknown');
  assert(r.findings.some(f => f.code.startsWith('LOCAL.DRAFT.') && f.status === 'unknown'));
  assert.throws(() => assessCapture({ ...c, dashboard: {} }), /Invalid or unsupported/);
});

test('evaluation gaps and duplicates use planned denominators and changed expectations fail', () => {
  for (const change of [
    c => c.dashboard.evaluation.cases.pop(),
    c => c.dashboard.evaluation.cases.push(clone(c.dashboard.evaluation.cases[0])),
    c => { c.dashboard.evaluation.cases[0].id = 'unplanned-question'; },
  ]) {
    const c = clone(capture); change(c);
    const r = assessCapture(c);
    assert.equal(r.findings.find(f => f.code === 'LOCAL.EVALUATION_COVERAGE').status, 'unknown');
    assert.equal(r.evaluation.plannedQuestions, c.dashboard.questions.length);
    assert.equal(new Set(r.findings.map(f => f.code)).size, r.findings.length);
    assert(renderAssessment(r).includes(`/${c.dashboard.questions.length}</span><span class="label">Planned graph retrieval checks`));
  }
  const c = clone(capture); c.dashboard.evaluation.cases[0].expect = 'abstain';
  const r = assessCapture(c);
  assert.equal(r.findings.find(f => f.code === 'LOCAL.EVALUATION_EXPECTATION').status, 'fail');
  assert.equal(r.retrieval.some(item => item.id === c.dashboard.evaluation.cases[0].id), false);
});

test('a contradictory complete flag cannot hide an unread session', () => {
  const c = clone(capture); c.sessions.listed = c.sessions.items.length + 1; c.sessions.complete = true;
  assert.equal(assessCapture(c).findings.find(f => f.code === 'LOCAL.SESSION_COVERAGE').status, 'unknown');
});

test('receipt projection drops saved wording and unknown fields', () => {
  const text = 'Invented private wording absent from the assessment.';
  const read = { ok: true, record: { flow: 'apply' }, current: true,
    state: { id: 'kg-example', revision: 1, phase: 'saved', pending: null, fields: [{}], saved: [{ fieldId: 'answer', text,
      receipt: { sessionId: 'kg-example', fieldId: 'answer', valueDigest: digest(text), text, preview: text, nested: { text } } }] },
    savedMeaning: 'private-draft-only', sourceEditsApplied: false };
  const s = summarizeSession(read);
  assert.equal(s.receiptMatches, true);
  assert.deepEqual(Object.keys(s.receipts[0]).sort(), ['fieldId', 'readbackValueSha256', 'sessionId', 'valueDigest']);
  assert.equal(JSON.stringify(s).includes(text), false);
});

test('receipt mismatches and unresolved saves do not imply successful authoring', () => {
  const text = 'Saved wording';
  const read = { ok: true, record: { flow: 'apply', question: { question: 'Useful work?' } },
    state: { id: 'kg-test', revision: 1, phase: 'saved', pending: null, fields: [{}], saved: [{ fieldId: 'answer', text, receipt: { sessionId: 'kg-test', fieldId: 'answer', valueDigest: digest(text) } }] },
    current: true, savedMeaning: 'private-draft-only', sourceEditsApplied: false };
  assert.equal(summarizeSession(read).receiptMatches, true);
  read.state.saved[0].text = 'Different wording';
  const c = clone(capture); c.sessions.items = [summarizeSession(read)];
  assert(assessCapture(c).findings.some(f => f.code.startsWith('LOCAL.DRAFT.') && f.status === 'fail'));
  c.sessions.items[0].pending = true; c.sessions.items[0].phase = 'recovery';
  assert(assessCapture(c).findings.some(f => f.code.startsWith('LOCAL.RECOVERY.') && f.status === 'warning'));
});

test('reports escape source wording and refuse remote or executable workspace links', () => {
  const c = clone(capture); c.dashboard.purpose = '<script>untrusted()</script>';
  const r = assessCapture(c), html = renderAssessment(r);
  assert(!html.includes('<script>')); assert(html.includes('&lt;script&gt;'));
  assert.throws(() => renderAssessment(r, { studioUrl: 'javascript:alert(1)' }));
  assert.throws(() => renderAssessment(r, { studioUrl: 'https://example.com/knowledge' }));
  assert.throws(() => renderAssessment(r, { studioUrl: 'http://127.0.0.1:1234/knowledge?mode=example' }));
});

test('unknown and empty denominators remain null, including quality ratios', () => {
  assert.equal(ratio(null, 10), null); assert.equal(ratio(0, 0), null); assert.equal(ratio(0, 10), 0);
  const r = record();
  r.quality.reviewedAssertions = 0; r.quality.supportedAssertions = 0;
  const m = deriveMeasurement(r);
  assert.equal(m.supportedPrecision, null);
  assert.equal(assessQuality(r, floor()).status, 'unknown');
});

test('impossible counts, partial task cost, unknown fields, and unsupported outcome claims are refused', () => {
  const cases = [
    r => { r.quality.supportedAssertions = 21; },
    r => { r.ingestion.sourcesParsed = 8; },
    r => { r.cost.humanAmount = null; },
    r => { r.cost.totalAmount = 1; },
    r => { r.quality.answerApproval = true; },
    r => { r.outcome.userAccepted = true; },
    r => { r.time.firstSupportedResultMs = 700000; },
  ];
  for (const mutate of cases) { const r = record(); mutate(r); assert(measurementErrors(r).length > 0); }
});

test('known observations produce scoped comparisons only after the same prespecified floor passes', () => {
  const a = record(), b = record(); b.id = 'synthetic-test-extractor'; b.method = 'structured-extractor';
  b.cost.humanAmount = 5; b.cost.totalAmount = 7;
  const summary = summarizeMeasurements([a, b], floor());
  assert.equal(summary.comparisons[0].eligible, true);
  assert.equal(summary.comparisons[0].rightMinusLeftTaskCost, -5);
  assert.equal(summary.aggregateProviderTokens, null);
  assert.match(summary.comparisons[0].scope, /Recorded trials only/);
});

test('cheap but poorly qualified output never earns a cost comparison', () => {
  const a = record(), b = record(); b.id = 'synthetic-test-bad'; b.quality.qualificationErrors = 1;
  b.cost.humanAmount = 0; b.cost.totalAmount = 2;
  assert.equal(assessQuality(b, floor()).status, 'fail');
  const s = summarizeMeasurements([a, b], floor());
  assert.equal(s.comparisons[0].eligible, false); assert.equal(s.comparisons[0].rightMinusLeftTaskCost, null);
});

test('changed pins, cold/warm modes, currencies, fixtures, or retrospective floors invalidate comparisons', () => {
  const mutators = [
    b => { b.experiment.sourceSetSha256 = 'e'.repeat(64); },
    b => { b.experiment.modelSha256 = 'e'.repeat(64); },
    b => { b.experiment.questionSetSha256 = 'e'.repeat(64); },
    b => { b.experiment.procedureSha256 = 'e'.repeat(64); },
    b => { b.experiment.runKind = 'warm'; },
    b => { b.cost.currency = 'EUR'; },
    b => { b.experiment.cohort = 'worked-example'; },
  ];
  for (const mutate of mutators) {
    const a = record(), b = record(); b.id = 'synthetic-test-other'; mutate(b);
    assert.equal(summarizeMeasurements([a, b], floor()).comparisons[0].eligible, false);
  }
  const a = record(), f = floor(); f.declaredAt = '2026-10-01T00:00:00Z';
  assert.equal(assessQuality(a, f).status, 'unknown');
  assert.equal(assessQuality(a, null).status, 'unknown');
  assert.throws(() => summarizeMeasurements([a, a]), /Duplicate/);
});
