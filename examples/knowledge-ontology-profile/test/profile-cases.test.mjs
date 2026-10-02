import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { evaluateProfileCases } from '../tools/profile-cases.mjs';
import { createFixtureWorkspace } from '../tools/fixture-workspace.mjs';

const bundle = JSON.parse(fs.readFileSync(new URL('../profiles/equipment-loans-reference/cases.json', import.meta.url)));
const observations = () => bundle.cases.map(c => ({ id: c.id, profileId: bundle.profileId, profileVersion: bundle.profileVersion, value: structuredClone(c.expected) }));
const mutate = (id, fn) => { const values = observations(); fn(values.find(o => o.id === id).value); return evaluateProfileCases(bundle, values).results.find(r => r.id === id); };

test('source anchors bind canonical starter bytes and profile schema', t => {
  const fixture = createFixtureWorkspace(fileURLToPath(new URL('../../../bin/atelier.mjs', import.meta.url)));
  t.after(fixture.cleanup);
  const schema = JSON.parse(fs.readFileSync(new URL('../profiles/equipment-loans-reference/profile.schema.json', import.meta.url)));
  const profile = JSON.parse(fs.readFileSync(new URL('../profiles/equipment-loans-reference/profile.json', import.meta.url)));
  const valid = new Ajv({ strict: false, allErrors: true }).compile(schema);
  assert.equal(valid(profile), true, JSON.stringify(valid.errors));
  for (const c of bundle.cases.filter(c => c.expected.evidence)) {
    const e = c.expected.evidence;
    const bytes = fs.readFileSync(path.join(fixture.workspace, e.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), e.sha256);
    assert.equal(bytes.subarray(e.byteStart, e.byteEnd).toString('utf8'), e.quote);
  }
});
test('loss of negation, unary form, scope, source revision, or proposal state fails', () => {
  for (const fn of [v => { v.polarity = 'positive'; }, v => { v.object = 'approved-loan'; }, v => { v.scope.item = 'all-items'; },
    v => { v.evidence.sha256 = '0'.repeat(64); }, v => { v.reviewState = 'accepted'; }])
    assert.equal(mutate('negative-unary', fn).status, 'fail');
});
test('possible arrival cannot become completed arrival or a normalized invented date', () => {
  assert.equal(mutate('possible-arrival', v => { v.modality = 'completed'; }).status, 'fail');
  assert.equal(mutate('possible-arrival', v => { v.time.date = '2026-10-02'; }).status, 'fail');
  assert.equal(mutate('possible-arrival', v => { v.nativeProjection.emitted = true; }).status, 'fail');
});
test('a source dependency cannot reverse or claim a successful inspection', () => {
  assert.equal(mutate('dependency-direction', v => { [v.source, v.target] = [v.target, v.source]; }).status, 'fail');
  assert.equal(mutate('dependency-direction', v => { v.predicate = 'inspectionPassed'; }).status, 'fail');
});
test('matching labels and cross-inventory aliases cannot grant entity identity', () => {
  assert.equal(mutate('identity-false-merge', v => { v.assessment = 'same'; }).status, 'fail');
  assert.equal(mutate('alias-not-identity', v => { v.assessment = 'same'; }).status, 'fail');
});
test('unmodeled meaning and missing evidence cannot fabricate a native edge or approval', () => {
  assert.equal(mutate('unmodeled-predicate', v => { v.nativeProjection.emitted = true; }).status, 'fail');
  assert.equal(mutate('missing-evidence', v => { v.sourceEditsApplied = true; }).status, 'fail');
  assert.equal(mutate('missing-evidence', v => { v.semanticAnswerCorrectness = true; }).status, 'fail');
});
test('version changes, duplicates, omissions, and unknown fields remain explicit', () => {
  const values = observations(); values[0].profileVersion = '2.0.0';
  assert.equal(evaluateProfileCases(bundle, values).results[0].status, 'fail');
  assert.throws(() => evaluateProfileCases(bundle, [...values, values[0]]), /unique/);
  assert.equal(evaluateProfileCases(bundle, []).counts.unknown, bundle.cases.length);
  assert.equal(mutate('negative-unary', v => { v.authority = 'approved'; }).status, 'fail');
  const r = evaluateProfileCases(bundle, observations());
  assert.equal(r.counts.pass, 8); assert.equal(r.semanticExtractionQualified, false); assert.equal(r.completeTaskCost, null);
});
