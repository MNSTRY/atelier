import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createIntakeStore, intakeDigest, INTAKE_MAX_BYTES } from '../src/intake/store.mjs';
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-intake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'Invented source');
  return root;
}
test('intake retains original bytes and duplicate provenance, with idempotent attempts', t => {
  const root = workspace(t), store = createIntakeStore({ workspaceRoot: root });
  const expectedDigest = intakeDigest('Invented source');
  const source = store.ingest({ ref: 'source.txt', expectedDigest });
  assert.deepEqual(store.ingest({ ref: 'source.txt', expectedDigest }), source);
  fs.copyFileSync(path.join(root, 'source.txt'), path.join(root, 'second.txt'));
  store.ingest({ ref: 'second.txt', expectedDigest });
  assert.equal(fs.readdirSync(path.join(root, '.atelier-local/intake/sources')).length, 2);
  assert.equal(fs.readdirSync(path.join(root, '.atelier-local/intake/blobs')).length, 1);
  const request = { attemptId: 'first', blobId: expectedDigest, extractorId: 'sample-text', extractorVersion: '1', configurationDigest: intakeDigest('{}') };
  assert.deepEqual(store.beginAttempt(request), store.beginAttempt(request));
  assert.throws(() => store.beginAttempt({ ...request, extractorVersion: '2' }), /EEXIST/);
  const completion = { attemptId: 'first', output: 'Derived text', expectedOutputDigest: intakeDigest('Derived text') };
  const receipt = store.completeAttempt(completion);
  assert.deepEqual(store.completeAttempt(completion), receipt);
  assert.deepEqual(store.readCompletion('first'), receipt);
  assert.equal(receipt.semanticAcceptance, 'pending');
  assert.equal(fs.readFileSync(path.join(root, 'source.txt'), 'utf8'), 'Invented source');
});
test('intake refuses changed, redirected and oversized sources', t => {
  const root = workspace(t), store = createIntakeStore({ workspaceRoot: root });
  assert.throws(() => store.ingest({ ref: 'source.txt', expectedDigest: intakeDigest('Other') }), /digest mismatch/);
  fs.symlinkSync(path.join(root, 'source.txt'), path.join(root, 'redirect.txt'));
  assert.throws(() => store.ingest({ ref: 'redirect.txt', expectedDigest: intakeDigest('Invented source') }), /redirected/);
  assert.throws(() => store.ingest({ ref: '../source.txt', expectedDigest: intakeDigest('Invented source') }), /relative/);
  const fd = fs.openSync(path.join(root, 'large.txt'), 'w');
  fs.ftruncateSync(fd, INTAKE_MAX_BYTES + 1); fs.closeSync(fd);
  assert.throws(() => store.ingest({ ref: 'large.txt', expectedDigest: intakeDigest('') }), /ceiling/);
});
test('completion is absent until output verifies and altered derivatives fail readback', t => {
  const root = workspace(t), store = createIntakeStore({ workspaceRoot: root }), blobId = intakeDigest('Invented source');
  store.ingest({ ref: 'source.txt', expectedDigest: blobId });
  store.beginAttempt({ attemptId: 'sample', blobId, extractorId: 'text', extractorVersion: '1', configurationDigest: intakeDigest('{}') });
  assert.throws(() => store.completeAttempt({ attemptId: 'sample', output: 'Derived', expectedOutputDigest: intakeDigest('Other') }), /digest mismatch/);
  assert.throws(() => store.readCompletion('sample'), /ENOENT/);
  store.completeAttempt({ attemptId: 'sample', output: 'Derived', expectedOutputDigest: intakeDigest('Derived') });
  fs.writeFileSync(path.join(root, '.atelier-local/intake/attempts/sample/output.txt'), 'Changed');
  assert.throws(() => store.readCompletion('sample'), /integrity mismatch/);
  assert.throws(() => store.completeAttempt({ attemptId: 'sample', output: 'Derived', expectedOutputDigest: intakeDigest('Derived') }), /EEXIST/);
});
test('intake refuses unignored state and occupied locks', t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => createIntakeStore({ workspaceRoot: root }), /ignored/);
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  const store = createIntakeStore({ workspaceRoot: root });
  fs.mkdirSync(path.join(root, '.atelier-local/intake'), { recursive: true });
  fs.writeFileSync(path.join(root, '.atelier-local/intake/operation.lock'), '');
  assert.throws(() => store.ingest({ ref: 'source.txt', expectedDigest: intakeDigest('Invented source') }), /EEXIST/);
});
