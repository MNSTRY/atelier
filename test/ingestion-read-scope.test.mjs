import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createIngestionStore } from '../src/ingestion/store.mjs';
import { createIntakeStore, intakeDigest } from '../src/intake/store.mjs';
import { withIntakeReadScope } from '../src/intake/read-scope.mjs';

function fixture(t, count = 2) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-read-scope-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  const sources = Array.from({ length: count }, (_, index) => ({ id: `source-${index}`, ref: `source-${index}.md` }));
  for (const source of sources) fs.writeFileSync(path.join(root, source.ref), `Invented evidence for ${source.id} at dawn.\n`);
  const store = createIngestionStore({ workspaceRoot: root, workspaceId: 'invented-read-scope' });
  const input = { sources, scope: { project: 'invented-garden', activity: 'planning' }, purpose: 'Locate invented evidence.',
    budget: { maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxAttempts: 128 } };
  const plan = store.plan(input), reference = { planId: plan.planId, planDigest: plan.planDigest };
  const done = store.run({ ...reference, maxItems: 128 });
  return { root, store, input, reference, done, query: { ...reference, query: 'evidence', limit: 100 } };
}

test('query placement work stays bounded by the operation and is repeated for each call', t => {
  const { store, query } = fixture(t, 12);
  const original = childProcess.execFileSync;
  let calls = 0;
  t.mock.method(childProcess, 'execFileSync', function (...args) {
    if (args[0] === 'git') calls++;
    return original.apply(this, args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let repetition = 0; repetition < 2; repetition++) {
    calls = 0;
    assert.equal(store.query(query).hits.length, 12);
    assert.ok(calls >= 4 && calls <= 8, `query must recheck placement with bounded work, got ${calls} Git calls`);
  }
});

test('ignore and index changes between public operations are refused and restoration is rechecked', t => {
  const { root, store, query } = fixture(t);
  assert.equal(store.query(query).hits.length, 2);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => store.query(query), { code: 'INGESTION_PRIVATE' });
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  assert.equal(store.query(query).hits.length, 2);
  const tracked = '.atelier-local/ingestion/workspace.json';
  execFileSync('git', ['-C', root, 'add', '-f', '--', tracked]);
  assert.throws(() => store.query(query), { code: 'INGESTION_PRIVATE' });
  execFileSync('git', ['-C', root, 'rm', '--cached', '-f', '--', tracked]);
  assert.equal(store.query(query).hits.length, 2);
});

test('a placement change during query prevents results from escaping and does not poison the next call', t => {
  const { root, store, query } = fixture(t);
  const original = fs.openSync;
  let changed = false;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    const fd = original.call(this, file, ...args);
    if (!changed && file === path.join(root, 'source-1.md')) {
      changed = true;
      fs.writeFileSync(path.join(root, '.gitignore'), '');
    }
    return fd;
  });
  assert.throws(() => store.query(query), /ignored, untracked/);
  assert.equal(changed, true);
  t.mock.restoreAll();
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  assert.equal(store.query(query).hits.length, 2);
});

test('query still rereads attempt integrity after the current-source read', t => {
  const { root, store, query, done } = fixture(t);
  const output = path.join(root, '.atelier-local/intake/attempts', done.items[0].attemptId, 'output.txt');
  const original = fs.openSync;
  let changed = false;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    const fd = original.call(this, file, ...args);
    if (!changed && file === path.join(root, 'source-0.md')) {
      changed = true;
      fs.writeFileSync(output, 'Invented corrupted output.');
    }
    return fd;
  });
  const answer = store.query(query);
  assert.equal(changed, true);
  assert.deepEqual(answer.hits.map(hit => hit.sourceId), ['source-1']);
  assert.equal(answer.omissions[0].reason, 'stored-evidence-integrity-refused');
});

test('plan rechecks placement after its read census and before publishing a new plan', t => {
  const { root, store, input } = fixture(t);
  const plans = path.join(root, '.atelier-local/ingestion/plans');
  const before = fs.readdirSync(plans);
  const original = fs.openSync;
  let changed = false;
  t.mock.method(fs, 'openSync', function (file, ...args) {
    const fd = original.call(this, file, ...args);
    if (!changed && file === path.join(root, 'source-1.md')) {
      changed = true;
      fs.writeFileSync(path.join(root, '.gitignore'), '');
    }
    return fd;
  });
  assert.throws(() => store.plan(input), /ignored, untracked/);
  assert.deepEqual(fs.readdirSync(plans), before);
});

test('mutations suspend read admission and subsequent reads recheck placement', t => {
  const { root } = fixture(t);
  const intake = createIntakeStore({ workspaceRoot: root });
  withIntakeReadScope(intake, () => {
    const source = intake.readSource({ ref: 'source-0.md' });
    fs.writeFileSync(path.join(root, '.gitignore'), '');
    assert.throws(() => intake.ingest({ ref: source.ref, expectedDigest: source.digest }), /ignored, untracked/);
    assert.throws(() => intake.readSource({ ref: source.ref }), /ignored, untracked/);
    fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
    intake.ingest({ ref: source.ref, expectedDigest: source.digest });
    fs.writeFileSync(path.join(root, '.gitignore'), '');
    assert.throws(() => intake.readSource({ ref: source.ref }), /ignored, untracked/);
    fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  });
});

test('exceptions and nested boundaries discard admission without caching source bytes', t => {
  const { root } = fixture(t);
  const intake = createIntakeStore({ workspaceRoot: root });
  assert.throws(() => withIntakeReadScope(intake, () => {
    intake.readSource({ ref: 'source-0.md' });
    throw new Error('invented interruption');
  }), /invented interruption/);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => intake.readSource({ ref: 'source-0.md' }), /ignored, untracked/);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  withIntakeReadScope(intake, () => {
    intake.readSource({ ref: 'source-0.md' });
    fs.writeFileSync(path.join(root, '.gitignore'), '');
    assert.throws(() => withIntakeReadScope(intake, () => intake.readSource({ ref: 'source-0.md' })), /ignored, untracked/);
    fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
    fs.writeFileSync(path.join(root, 'source-0.md'), 'A revised invented source.');
    assert.equal(intake.readSource({ ref: 'source-0.md' }).digest, intakeDigest('A revised invented source.'));
  });
});

test('thenable results are refused and result accessors cannot inherit admission', t => {
  const { root } = fixture(t);
  const intake = createIntakeStore({ workspaceRoot: root });
  let called = false, inspected = false;
  assert.throws(() => withIntakeReadScope(intake, () => {
    intake.readSource({ ref: 'source-0.md' });
    return { get then() {
      inspected = true;
      fs.writeFileSync(path.join(root, '.gitignore'), '');
      assert.throws(() => intake.readSource({ ref: 'source-0.md' }), /ignored, untracked/);
      return () => { called = true; };
    } };
  }), /requires a synchronous result/);
  assert.equal(inspected, true); assert.equal(called, false);
  assert.throws(() => intake.readSource({ ref: 'source-0.md' }), /ignored, untracked/);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  assert.doesNotThrow(() => intake.readSource({ ref: 'source-0.md' }));
});

test('async results are refused and resumed work receives no cached admission', async t => {
  const { root } = fixture(t);
  const intake = createIntakeStore({ workspaceRoot: root });
  let resume, pending;
  const boundary = new Promise(resolve => { resume = resolve; });
  assert.throws(() => withIntakeReadScope(intake, () => {
    pending = (async () => {
      intake.readSource({ ref: 'source-0.md' });
      await boundary;
      return intake.readSource({ ref: 'source-0.md' });
    })();
    return pending;
  }), /requires a synchronous result/);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  const refused = assert.rejects(pending, /ignored, untracked/);
  resume();
  await refused;
  assert.throws(() => intake.readSource({ ref: 'source-0.md' }), /ignored, untracked/);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  assert.doesNotThrow(() => intake.readSource({ ref: 'source-0.md' }));
});
