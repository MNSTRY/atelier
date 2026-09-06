import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, transition, replaySession, contentDigest } from '../src/coauthor/session.mjs';

const config = () => ({ id: 'sample-session', fields: [
  { id: 'sample-field', source: { ref: 'sample-document', digest: contentDigest('Original sample') } },
] });
function harness() {
  let state = createSession(config());
  const send = (type, data = {}) => {
    const result = transition(state, { id: `event-${state.revision}`, expectedRevision: state.revision, type, ...data });
    state = result.session;
    return result;
  };
  return { send, get state() { return state; } };
}
function receipt(effect) {
  const { type, text, ...result } = effect;
  return result;
}
test('answer plus continue advances only after matching receipt; originals survive', () => {
  const h = harness();
  h.send('answer', { text: 'A quiet room.', continueAfterSave: true });
  h.send('propose', { text: 'A quiet reading room.' });
  assert.throws(() => h.send('save'), /confirmation/);
  h.send('confirm');
  const write = h.send('save').effects[0];
  assert.equal(h.state.phase, 'saving');
  assert.throws(() => h.send('advance'), /saving/);
  h.send('receipt', { receipt: receipt(write) });
  assert.equal(h.state.phase, 'complete');
  assert.equal(h.state.answers[0].text, 'A quiet room.');
  assert.equal(h.state.saved[0].text, 'A quiet reading room.');
});
test('receipt binds every request and source dimension without optimistic success', () => {
  for (const key of ['requestId', 'sessionId', 'fieldId', 'sourceRef', 'sourceDigest', 'valueDigest']) {
    const h = harness(); h.send('answer', { text: 'A sample answer' });
    const r = receipt(h.send('save').effects[0]);
    r[key] = key.endsWith('Digest') ? contentDigest('wrong') : 'wrong';
    assert.throws(() => h.send('receipt', { receipt: r }), /mismatch/);
    assert.equal(h.state.phase, 'saving');
    assert.equal(h.state.saved.length, 0);
  }
});
test('replay is deterministic and exact duplicates produce no repeated write', () => {
  const h = harness(); h.send('answer', { text: 'Sample' }); h.send('save');
  const last = h.state.events.at(-1).event;
  assert.deepEqual(transition(h.state, last).effects, []);
  assert.throws(() => transition(h.state, { ...last, type: 'failed' }), /conflict/);
  assert.deepEqual(replaySession(config(), h.state.events.map(e => e.event)), h.state);
});
test('stale revisions and unknown authority fields fail without mutation', () => {
  const h = harness(); h.send('answer', { text: 'Sample' });
  const before = structuredClone(h.state);
  assert.throws(() => h.send('save', { expectedRevision: 0 }), /stale/);
  assert.throws(() => h.send('save', { publication: true }), /unknown/);
  assert.deepEqual(h.state, before);
});
test('pause and rejection preserve original text and resume confirmation', () => {
  const h = harness(); h.send('answer', { text: 'Original' }); h.send('propose', { text: 'Suggestion' });
  h.send('pause'); assert.throws(() => h.send('save'), /paused/); h.send('resume');
  assert.equal(h.state.phase, 'confirmation'); h.send('reject');
  assert.equal(h.state.proposal.text, 'Original');
});
test('retry uses same idempotency key and is bounded; late receipt can reconcile', () => {
  const h = harness(); h.send('answer', { text: 'Sample' });
  const first = h.send('save').effects[0]; h.send('failed');
  assert.deepEqual(h.send('retry').effects[0], first);
  h.send('failed'); assert.throws(() => h.send('retry'), /budget/);
  h.send('receipt', { receipt: receipt(first) }); assert.equal(h.state.phase, 'saved');
});
test('configuration refuses duplicates and invalid source binding', () => {
  const c = config(); c.fields.push(c.fields[0]); assert.throws(() => createSession(c), /duplicate/);
  const d = config(); d.fields[0].source.digest = 'unknown'; assert.throws(() => createSession(d), /digest/);
});
