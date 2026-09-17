import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { publishPrivateFile, acquirePrivateLock, createVerifiedFileSequence } from '../src/project/durable-state.mjs';
import { createCollaborationEventLedger } from '../src/collaboration/event-ledger.mjs';

function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-fixture-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return fs.realpathSync(dir); }
test('immutable publication preserves old file and binary readback', t => {
  const dir = fixture(t), file = path.join(dir, 'value');
  const bytes = Buffer.from([0, 255, 128, 42]);
  publishPrivateFile(file, bytes); publishPrivateFile(file, bytes);
  assert.throws(() => publishPrivateFile(file, 'different'));
  assert.deepEqual(fs.readFileSync(file), bytes);
});
test('interruption before final publication leaves no partial committed file', t => {
  const dir = fixture(t), file = path.join(dir, 'value');
  const module = new URL('../src/project/durable-state.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { publishPrivateFile } from ${JSON.stringify(module)};
    fs.linkSync = () => process.exit(73);
    publishPrivateFile(process.argv[1], 'invented complete value');
  `, file]);
  assert.equal(child.status, 73); assert.equal(fs.existsSync(file), false);
  publishPrivateFile(file, 'continued'); assert.equal(fs.readFileSync(file, 'utf8'), 'continued');
});
test('crashed owner is bypassed without deleting evidence; live owners still refuse', t => {
  const dir = fixture(t), lock = path.join(dir, 'operation.lock');
  const module = new URL('../src/project/durable-state.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquirePrivateLock } from ${JSON.stringify(module)};
    acquirePrivateLock(process.argv[1]); process.exit(74);
  `, lock]);
  assert.equal(child.status, 74);
  const owners = `${lock}.owners`, old = fs.readdirSync(owners), evidence = fs.readFileSync(path.join(owners, old[0]));
  const release = acquirePrivateLock(lock);
  assert.throws(() => acquirePrivateLock(lock), /locked/);
  release(); release();
  assert.deepEqual(fs.readFileSync(path.join(owners, old[0])), evidence);
  const again = acquirePrivateLock(lock); again();
});
test('unknown legacy owner is retained and blocks', t => {
  const dir = fixture(t), lock = path.join(dir, 'operation.lock');
  fs.writeFileSync(lock, 'unidentified'); assert.throws(() => acquirePrivateLock(lock), /locked/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'unidentified');
});
test('verified sequence only decodes tail, detects changed and shortened history', t => {
  const dir = fixture(t); let reads = 0;
  const current = createVerifiedFileSequence({ directory: dir, initial: () => 0,
    apply: (text, state) => { reads++; return state + JSON.parse(text); } });
  publishPrivateFile(path.join(dir, '01.json'), '2'); assert.equal(current(), 2);
  assert.equal(current(), 2); assert.equal(reads, 1);
  publishPrivateFile(path.join(dir, '02.json'), '3'); assert.equal(current(), 5); assert.equal(reads, 2);
  fs.writeFileSync(path.join(dir, '01.json'), '4'); assert.equal(current(), 7); assert.equal(reads, 4);
  fs.unlinkSync(path.join(dir, '02.json')); assert.throws(current, /shortened/);
});
test('interrupted ledger replacement preserves the entire committed prefix', t => {
  const root = fixture(t), ledger = createCollaborationEventLedger({ workspaceRoot: root });
  const input = { aggregateId: 'invented', type: 'draft.changed', actor: 'local', payload: { text: 'one' } };
  assert.equal(ledger.append(input).ok, true); const prior = fs.readFileSync(ledger.ledgerPath);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('synthetic interruption'); };
  try { assert.equal(ledger.append({ ...input, expectedVersion: 1 }).ok, false); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(ledger.ledgerPath), prior);
  assert.equal(ledger.append({ ...input, expectedVersion: 1 }).ok, true);
});

test('failed owner-ticket directory sync permits a later valid acquisition', t => {
  const dir = fixture(t), lock = path.join(dir, 'operation.lock');
  const sync = fs.fsyncSync;
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory sync failure'); return sync(fd); };
  try { assert.throws(() => acquirePrivateLock(lock), /sync failure/); }
  finally { fs.fsyncSync = sync; }
  const release = acquirePrivateLock(lock); release();
});

test('concurrent recoverers cannot both own the next generation', async t => {
  const dir = fixture(t), lock = path.join(dir, 'operation.lock');
  const module = new URL('../src/project/durable-state.mjs', import.meta.url).href;
  const script = `import { acquirePrivateLock } from ${JSON.stringify(module)};
    process.on('message', () => { try { const release = acquirePrivateLock(process.argv[1]);
      setTimeout(() => { release(); process.exit(0); }, 250);
    } catch (error) { process.exit(error.code === 'EEXIST' ? 23 : 24); } });
    process.send('ready');`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, lock], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const exited = children.map(child => new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }));
  await Promise.all(children.map(child => new Promise(resolve => child.once('message', resolve))));
  for (const child of children) child.send('go');
  assert.deepEqual((await Promise.all(exited)).sort((a, b) => a - b), [0, 23]);
});

test('released successor does not resurrect an obsolete reused PID or host', t => {
  const dir = fixture(t), lock = path.join(dir, 'operation.lock');
  const module = new URL('../src/project/durable-state.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { acquirePrivateLock } from ${JSON.stringify(module)};
    acquirePrivateLock(process.argv[1]); process.exit(74);
  `, lock]);
  assert.equal(child.status, 74);
  acquirePrivateLock(lock)();
  const first = path.join(`${lock}.owners`, '000000000001.json');
  const old = JSON.parse(fs.readFileSync(first));
  // Synthetic PID reuse of an already superseded ticket, then hostname drift.
  fs.writeFileSync(first, JSON.stringify({ ...old, pid: process.pid }));
  acquirePrivateLock(lock)();
  fs.writeFileSync(first, JSON.stringify({ ...old, host: 'f'.repeat(64) }));
  acquirePrivateLock(lock)();
  // Completed current ownership also survives host drift without querying PID.
  const current = path.join(`${lock}.owners`, '000000000004.json');
  const changed = JSON.stringify({ ...JSON.parse(fs.readFileSync(current)), host: 'f'.repeat(64) });
  fs.writeFileSync(current, changed); fs.writeFileSync(current.replace('.json', '.released'), changed);
  acquirePrivateLock(lock)();
});

test('newest unresolved foreign owner and forged release fail closed with diagnostics', t => {
  const lock = path.join(fixture(t), 'operation.lock');
  const release = acquirePrivateLock(lock);
  const ticket = path.join(`${lock}.owners`, '000000000001.json');
  const original = fs.readFileSync(ticket, 'utf8');
  fs.writeFileSync(ticket, JSON.stringify({ ...JSON.parse(original), host: 'f'.repeat(64) }));
  assert.throws(() => acquirePrivateLock(lock), /host identity differs/);
  fs.writeFileSync(ticket, original); fs.writeFileSync(ticket.replace('.json', '.released'), '{}');
  assert.throws(() => acquirePrivateLock(lock), /release identity differs/);
  fs.unlinkSync(ticket.replace('.json', '.released')); release();
});

test('explicit metadata exception preserves indexes but never hides symlinks or other names', t => {
  const dir = fixture(t), current = createVerifiedFileSequence({ directory: dir, ignoreFiles: ['.DS_Store'], initial: () => 0,
    apply(text, value, index, file) { assert.equal(file, `${index}.json`); return value + JSON.parse(text); } });
  publishPrivateFile(path.join(dir, '1.json'), '2'); fs.writeFileSync(path.join(dir, '.DS_Store'), 'metadata');
  assert.equal(current(), 2); publishPrivateFile(path.join(dir, '2.json'), '3'); assert.equal(current(), 5);
  fs.writeFileSync(path.join(dir, '.unknown'), 'data'); assert.throws(current);
  fs.unlinkSync(path.join(dir, '.unknown')); fs.unlinkSync(path.join(dir, '.DS_Store'));
  fs.symlinkSync(path.join(dir, '1.json'), path.join(dir, '.DS_Store')); assert.throws(current, /non-regular/);
});

test('legacy succession binds exact bytes and refuses a newly created legacy writer', t => {
  const lock = path.join(fixture(t), 'operation.lock');
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(lock, JSON.stringify({ pid: dead.pid }));
  acquirePrivateLock(lock)();
  const kill = process.kill;
  process.kill = (pid, signal) => pid === dead.pid ? true : kill(pid, signal);
  try { acquirePrivateLock(lock)(); } finally { process.kill = kill; }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  assert.throws(() => acquirePrivateLock(lock), /legacy process exists/);
});
