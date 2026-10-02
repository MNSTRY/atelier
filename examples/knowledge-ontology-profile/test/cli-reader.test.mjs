import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCliReader } from '../tools/cli-reader.mjs';
import { localCliEnvironment } from '../tools/local-process.mjs';
const digest = data => createHash('sha256').update(data).digest('hex');
const base = JSON.parse(fs.readFileSync(new URL('./fixtures/capture.json', import.meta.url))).dashboard;

test('local CLI environments drop enclosing Git-hook redirects', () => {
  assert.deepEqual(localCliEnvironment({ GIT_DIR: 'outer', GIT_WORK_TREE: 'outer', GIT_INDEX_FILE: 'outer', git_config: 'outer', PATH: 'invented-path' }),
    { PATH: 'invented-path' });
});

function installed(list, reads = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-reader-fixture-'));
  fs.mkdirSync(path.join(root, 'bin'));
  const code = `import fs from 'node:fs'; const words=process.argv.slice(2); const reads=${JSON.stringify(reads)}; const value=words[1]==='dashboard'?${JSON.stringify(base)}:words[2]==='read'?reads[JSON.parse(fs.readFileSync(0,'utf8')).sessionId]:${JSON.stringify(list)}; console.log(JSON.stringify(value));`;
  const entry = path.join(root, 'bin/atelier.mjs');
  fs.writeFileSync(entry, code); fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const binding = { schema: 'atelier-profile-install-binding/local-v1', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), tarballSha256: 'c'.repeat(64), files: { 'bin/atelier.mjs': digest(code), 'package.json': digest('{}') } };
  return { root, entry, binding, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('truncated and legacy lists never become complete inspection', () => {
  for (const list of [{ ok: true, sessions: [], total: 201, truncated: true }, { ok: true, sessions: [] }]) {
    const fixture = installed(list);
    try {
      const capture = createCliReader(fixture).collect(fixture.root);
      assert.equal(capture.sessions.complete, false);
      if (list.total) assert.equal(capture.sessions.listed, 201);
    } finally { fixture.remove(); }
  }
});
test('the 20-session inspection bound does not claim complete returned history', () => {
  const sessions = Array.from({ length: 21 }, (_, i) => ({ id: `known-${i}` }));
  const reads = Object.fromEntries(sessions.map(({ id }) => [id, { ok: true, current: true,
    record: { flow: 'apply', author: 'Invented test', question: { question: 'Known test' } },
    state: { id, revision: 0, phase: 'drafting', saved: [], fields: [], pending: null },
    savedMeaning: 'private-draft-only', sourceEditsApplied: false }]));
  const fixture = installed({ ok: true, sessions, total: 21, truncated: false }, reads);
  try {
    const capture = createCliReader(fixture).collect(fixture.root);
    assert.equal(capture.sessions.listed, 21);
    assert.equal(capture.sessions.descriptorCount, 21);
    assert.equal(capture.sessions.items.length, 20);
    assert.equal(capture.sessions.truncated, false);
    assert.equal(capture.sessions.complete, false);
  } finally { fixture.remove(); }
});

test('inconsistent totals, duplicate descriptors, and a wrong readback identity stay incomplete', () => {
  const read = id => ({ ok: true, current: true,
    record: { flow: 'apply', author: 'Invented test', question: { question: 'Known test' } },
    state: { id, revision: 0, phase: 'drafting', saved: [], fields: [], pending: null },
    savedMeaning: 'private-draft-only', sourceEditsApplied: false });
  const many = Array.from({ length: 21 }, (_, i) => ({ id: `known-${i}` }));
  const cases = [
    [{ ok: true, sessions: many, total: 20, truncated: false }, Object.fromEntries(many.map(s => [s.id, read(s.id)]))],
    [{ ok: true, sessions: [{ id: 'known-0' }, { id: 'known-0' }], total: 2, truncated: false }, { 'known-0': read('known-0') }],
    [{ ok: true, sessions: [{ id: 'known-0' }], total: 1, truncated: false }, { 'known-0': read('different-session') }],
  ];
  for (const [list, reads] of cases) {
    const fixture = installed(list, reads);
    try {
      const capture = createCliReader(fixture).collect(fixture.root);
      assert.equal(capture.sessions.complete, false);
      assert.equal(typeof capture.sessions.error, 'string');
    } finally { fixture.remove(); }
  }
});

test('binding paths, nonregular files, symlink parents, and malformed read arguments are refused', () => {
  const fixture = installed({ ok: true, sessions: [], total: 0, truncated: false });
  try {
    for (const rel of ['../outside', './bin/atelier.mjs', 'bin//atelier.mjs'])
      assert.throws(() => createCliReader({ ...fixture, binding: { ...fixture.binding, files: { ...fixture.binding.files, [rel]: 'd'.repeat(64) } } }));
    fs.mkdirSync(path.join(fixture.root, 'directory'));
    assert.throws(() => createCliReader({ ...fixture, binding: { ...fixture.binding, files: { ...fixture.binding.files, directory: 'd'.repeat(64) } } }));
    fs.writeFileSync(path.join(fixture.root, 'directory', 'value'), 'invented');
    fs.symlinkSync(path.join(fixture.root, 'directory'), path.join(fixture.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => createCliReader({ ...fixture, binding: { ...fixture.binding, files: { ...fixture.binding.files, 'linked/value': digest('invented') } } }));
    const reader = createCliReader(fixture);
    for (const [words, input] of [
      [['knowledge', 'context', '--question', '--workspace', '--mode', 'graph']],
      [['knowledge', 'context', '--question', 'Known question', '--mode', 'other']],
      [['knowledge', 'session', 'read'], { sessionId: '../outside' }],
      [['knowledge', 'session', 'read'], { sessionId: 12 }],
      [['knowledge', 'session', 'read'], { sessionId: 'known-0', unexpected: true }],
    ]) assert.throws(() => reader.read(fixture.root, words, input), /Only the declared read/);
  } finally { fixture.remove(); }
});
test('the reader refuses mutation verbs and changed installed files', () => {
  const fixture = installed({ ok: true, sessions: [], total: 0, truncated: false });
  try {
    const reader = createCliReader(fixture);
    assert.throws(() => reader.read(fixture.root, ['knowledge', 'session', 'event'], {}), /Only the declared read/);
    fs.appendFileSync(fixture.entry, '\n// changed package');
    assert.throws(() => createCliReader(fixture), /differs from receiving binding/);
  } finally { fixture.remove(); }
});
