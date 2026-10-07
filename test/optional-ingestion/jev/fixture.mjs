import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {materialDigest, PLACEMENTS, RUBRIC_VERSION} from '../../../src/ingestion/optional/jev/judgments.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const passage = 'The invented Atlas project may report to the invented Vega group during 2040. It does not own Vega.';
const revision = hash(passage);
export function fixture(placements = ['evidence-support']) {
  return {
    operationId: 'invented-ingestion-op-1', scope: {workspaceId: 'invented-workspace', authorizationRef: 'offline-fixture:no-egress'},
    sources: [{id: 'source:invented', revision}],
    subjects: [{id: 'assertion:invented', revision: 'proposal-revision-1', material: {
      id: 'assertion:invented', state: 'proposed', subjectId: 'entity:atlas-project', predicate: 'reports-to', objectId: 'entity:vega-group',
      participantRoles: {subject: 'entity:atlas-project', object: 'entity:vega-group'},
      negated: false, modality: 'possible', validTime: {start: '2040-01-01', end: '2040-12-31'},
      contrastingStatement: {predicate: 'owns', negated: true},
      existingCandidates: [{id: 'atlas-project', label: 'Atlas', kind: 'project'}, {id: 'atlas-org', label: 'Atlas', kind: 'organization'}],
      query: 'Which group may Atlas report to during 2040?', coverage: 'complete-invented-passage',
    }}, {id: 'entity:atlas-project', revision: 'existing-entity-revision-1', material: {label: 'Atlas', kind: 'project', state: 'existing-fixture'}},
      {id: 'entity:atlas-org', revision: 'existing-entity-revision-2', material: {label: 'Atlas', kind: 'organization', state: 'existing-fixture'}}],
    evidence: [{id: 'evidence:invented', sourceId: 'source:invented', revision,
      sourceRef: 'source:invented@' + revision + ':line:1', locator: {kind: 'line', start: 1, end: 1}, text: passage}],
    judgments: placements.map((placement, i) => ({id: 'q' + i, placement,
      subjectIds: ['assertion:invented', 'entity:atlas-project', 'entity:atlas-org'], evidenceIds: ['evidence:invented'],
      ...(['processing-plan', 'candidate-identity', 'assertion-interpretation', 'query-routing'].includes(placement) ? {choices: [
        {id: 'existing-a', subjectId: 'entity:atlas-project', description: 'The supplied existing first candidate with its original identity and qualifiers.'},
        {id: 'existing-b', subjectId: 'entity:atlas-org', description: 'The supplied existing second candidate; a matching label alone does not justify an identity merge.'}]} : {}),
      ...(placement === 'contradiction-review' ? {criterion: 'Same roles, predicate, modality and overlapping valid time, with opposite assertion polarity.', overlap: 'overlapping'} : {}),
    })),
  };
}
export function qualifications() {
  return Object.fromEntries(PLACEMENTS.map(placement => [placement, {
    reference: 'invented-qualification:' + placement, model: 'jev-1.13.0', rubricVersion: RUBRIC_VERSION,
    sourceProfile: 'invented-public-offline', minimumConfidence: 0.8, minimumMargin: 0.2,
    rejectAtOrBelow: 0.2, acceptAtOrAbove: 0.8,
  }]));
}
/** Actual invented host admission in its own in-memory journal, not Consent. */
export function fixtureAdmission(intent, {batches, journal, transport}) {
  assert(journal.has(intent.originalHostReceiptRef), 'original fixture custody must exist');
  const batch = batches.find(b => b.requestDigest === intent.requestDigest);
  assert(batch); assert.equal(intent.phase, 'before-assess');
  assert.equal(intent.operationId, batch.operationId);
  assert.equal(materialDigest(intent.request), materialDigest(batch.request));
  assert.equal(materialDigest(intent.scope), materialDigest(batch.request.scope));
  assert.equal(intent.scope.workspaceId, 'invented-workspace');
  assert.equal(intent.scope.authorizationRef, 'offline-fixture:no-egress');
  assert.equal(intent.model, JSON.parse(batch.nativeBody).model); assert.equal(intent.rubricVersion, RUBRIC_VERSION);
  assert.equal(materialDigest(intent.questionPlacements), materialDigest(batch.questionPlacements));
  assert.equal(materialDigest(intent.bindings), materialDigest(batch.bindings));
  assert.equal(materialDigest(intent.nativeBody), materialDigest(batch.nativeBody));
  assert.equal(intent.preparedNativePayloadDigest, batch.nativePayloadDigest);
  assert.equal(materialDigest(intent.transport), materialDigest(transport));
  assert.equal(intent.transport.kind, 'offline-fixture'); assert.equal(intent.nativeQualified, false);
  const {bindingDigest, ...bound} = intent; assert.equal(bindingDigest, materialDigest(bound));
  const receiptRef = 'fixture-existing-host:admission:' + journal.size;
  journal.set(receiptRef, structuredClone(intent));
  return {allowed: true, receiptRef, bindingDigest};
}
export function nativeResponse(batch) {
  const answers = Object.fromEntries(Object.entries(batch.request.questions).map(([id, q]) => {
    if (q.type === 'boolean') return [id, {type: 'noul', noul: 0.9}];
    if (q.type === 'score') {
      const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === 2 ? 1 : 0]));
      return [id, {type: 'score', score: 2, probabilities, confidence: 0.9}];
    }
    const keys = Object.keys(q.criteria), probabilities = Object.fromEntries(keys.map((key, i) => [key, i === 0 ? 0.9 : 0.1 / (keys.length - 1)]));
    return [id, {type: 'choice', choice: keys[0], probabilities, confidence: 0.9}];
  }));
  return {model: 'jev-1.13.0', answers, usage: {input_tokens: 123, output_tokens: 17}};
}
