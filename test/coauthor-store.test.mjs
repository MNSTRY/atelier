import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCoauthorStore } from '../src/coauthor/store.mjs';
import { contentDigest } from '../src/coauthor/session.mjs';
import { createCollaborationEventLedger } from '../src/collaboration/event-ledger.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'coauthor-proof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  fs.writeFileSync(path.join(root, 'packet.md'), 'Invented packet');
  const config = { id: 'sample', fields: [{ id: 'one', source: { ref: 'packet.md', digest: contentDigest('Invented packet') } }] };
  const store = createCoauthorStore({ workspaceRoot: root }); store.start(config);
  return { root, config, store };
}
test('durable draft receipt survives restart without modifying the source', t => {
  const { root, store } = setup(t);
  store.dispatch('sample', { id: 'a', type: 'answer', expectedRevision: 0, text: 'My answer', continueAfterSave: true });
  const done = store.dispatch('sample', { id: 'b', type: 'save', expectedRevision: 1 });
  assert.equal(done.phase, 'complete');
  const restarted = createCoauthorStore({ workspaceRoot: root });
  assert.deepEqual(restarted.read('sample'), done);
  assert.equal(fs.readFileSync(path.join(root, 'packet.md'), 'utf8'), 'Invented packet');
  assert.equal(done.saved[0].text, 'My answer');
  assert.deepEqual(restarted.dispatch('sample', { id: 'b', type: 'save', expectedRevision: 1 }), done);
});
test('source drift and fabricated receipt refuse but history remains readable', t => {
  const { root, store } = setup(t);
  assert.throws(() => store.dispatch('sample', { id: 'x', type: 'receipt', expectedRevision: 0 }), /store-owned/);
  fs.writeFileSync(path.join(root, 'packet.md'), 'Changed');
  assert.throws(() => store.dispatch('sample', { id: 'a', type: 'answer', expectedRevision: 0, text: 'No' }), /source changed/);
  assert.equal(store.read('sample').revision, 0);
});
test('source escape and redirected private state refuse', t => {
  const { root, config, store } = setup(t);
  config.id = 'other'; config.fields[0].source.ref = '../packet.md';
  assert.throws(() => store.start(config), /workspace-relative/);
  const elsewhere = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'coauthor-outside-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.renameSync(path.join(root, '.atelier-local', 'coauthor'), path.join(root, '.atelier-local', 'retained'));
  fs.symlinkSync(elsewhere, path.join(root, '.atelier-local', 'coauthor'), 'dir');
  assert.throws(() => store.read('sample'), /redirected/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
test('removed history and operation lock fail closed', t => {
  const { root, store } = setup(t);
  store.dispatch('sample', { id: 'a', type: 'answer', expectedRevision: 0, text: 'First' });
  store.dispatch('sample', { id: 'b', type: 'propose', expectedRevision: 1, text: 'Next' });
  const file = path.join(root, '.atelier-local', 'coauthor', 'events.ndjson');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  fs.writeFileSync(file, [lines[0], lines[2], ''].join('\n'));
  assert.throws(() => store.read('sample'), /chain/);
  fs.writeFileSync(path.join(root, '.atelier-local', 'coauthor', 'operation.lock'), 'held');
  assert.throws(() => store.recover('sample'), /EEXIST/);
});
test('CLI invocation resumes retained answers in a fresh process', t => {
  const { root } = setup(t);
  const command = path.resolve('src/commands/coauthor.mjs');
  const run = (op, input) => spawnSync(process.execPath, [command, op], { cwd: root, input: JSON.stringify(input), encoding: 'utf8' });
  const answer = run('event', { sessionId: 'sample', event: { id: 'a', type: 'answer', expectedRevision: 0, text: 'Retained answer' } });
  assert.equal(answer.status, 0, answer.stderr);
  const saved = run('event', { sessionId: 'sample', event: { id: 'b', type: 'save', expectedRevision: 1 } });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(run('read', { sessionId: 'sample' }).stdout).state.saved[0].text, 'Retained answer');
});
test('tracked or unignored private state refuses before a new write', t => {
  const { root, store } = setup(t);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => store.dispatch('sample', { id: 'a', type: 'answer', expectedRevision: 0, text: 'No' }), /ignored/);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  spawnSync('git', ['-C', root, 'add', '-f', '.atelier-local/coauthor/events.ndjson']);
  assert.throws(() => createCoauthorStore({ workspaceRoot: root }), /untracked/);
});
test('Git environment cannot redirect the private placement check', t => {
  const { root } = setup(t);
  const saved = process.env.GIT_DIR;
  t.after(() => { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; });
  process.env.GIT_DIR = path.join(root, 'absent-git-dir');
  assert.equal(createCoauthorStore({ workspaceRoot: root }).read('sample').revision, 0);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => createCoauthorStore({ workspaceRoot: root }), /ignored/);
});
test('pending save recovers after restart and does not repeat a verified write', t => {
  const { root, store } = setup(t);
  store.dispatch('sample', { id: 'a', type: 'answer', expectedRevision: 0, text: 'After restart' });
  const ledger = createCollaborationEventLedger({ workspaceRoot: root, ledgerPath: path.join(root, '.atelier-local/coauthor/events.ndjson') });
  const aggregateId = `coauthor-${contentDigest('sample')}`;
  const before = ledger.eventsFor(aggregateId);
  assert.equal(ledger.append({ aggregateId, expectedVersion: before.currentVersion, type: 'coauthor.transition', actor: 'local-harness',
    payload: { previousEventId: before.events.at(-1).id, event: { id: 'b', type: 'save', expectedRevision: 1 } } }).ok, true);
  const restarted = createCoauthorStore({ workspaceRoot: root });
  assert.equal(restarted.read('sample').phase, 'saving');
  const done = restarted.recover('sample');
  assert.equal(done.phase, 'saved');
  assert.deepEqual(restarted.recover('sample'), done);
});
test('failed value write stays visible; pause does not bypass retry budget', t => {
  const { root, store } = setup(t);
  store.dispatch('sample', { id: 'a', type: 'answer', expectedRevision: 0, text: 'Draft' });
  const values = path.join(root, '.atelier-local/coauthor/values', contentDigest('sample'));
  fs.mkdirSync(values, { recursive: true });
  fs.writeFileSync(path.join(values, `${contentDigest('b')}.json`), 'Conflicting value');
  assert.throws(() => store.dispatch('sample', { id: 'b', type: 'save', expectedRevision: 1 }), /differs/);
  let s = store.read('sample'); assert.equal(s.phase, 'recovery');
  s = store.dispatch('sample', { id: 'p', type: 'pause', expectedRevision: s.revision });
  s = store.dispatch('sample', { id: 'r', type: 'resume', expectedRevision: s.revision });
  assert.equal(s.phase, 'recovery');
  assert.throws(() => store.dispatch('sample', { id: 'retry', type: 'retry', expectedRevision: s.revision }), /differs/);
  s = store.read('sample'); assert.equal(s.phase, 'recovery');
  assert.throws(() => store.dispatch('sample', { id: 'retry-again', type: 'retry', expectedRevision: s.revision }), /budget/);
  assert.equal(fs.readFileSync(path.join(values, `${contentDigest('b')}.json`), 'utf8'), 'Conflicting value');
});
