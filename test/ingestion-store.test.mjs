import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createIngestionStore } from '../src/ingestion/store.mjs';
import { createIntakeStore, intakeDigest } from '../src/intake/store.mjs';
import { acquirePrivateLock } from '../src/project/durable-state.mjs';

const scope = { project: 'invented-garden', activity: 'planning' };
const budget = { maxInputBytes: 1024 * 1024, maxOutputBytes: 1024 * 1024, maxAttempts: 128 };
function fixture(t, files = { 'notes.md': 'Garden decisions\nWater the basil at dawn.\n', 'table.csv': 'plant,action\nbasil,water\n', 'tree.json': '{"herbs":{"basil":"water at dawn"}}', 'image.png': 'Invented unsupported bytes' }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ingestion-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  for (const [ref, text] of Object.entries(files)) fs.writeFileSync(path.join(root, ref), text);
  const options = { workspaceRoot: root, workspaceId: 'garden-workspace' };
  return { root, options, store: createIngestionStore(options) };
}
function plan(store, refs = ['notes.md', 'table.csv', 'tree.json', 'image.png', 'missing.txt'], overrides = {}) {
  return store.plan({ sources: refs.map((ref, i) => ({ id: `source-${i + 1}`, ref })), scope, purpose: 'Find evidence for the garden plan.', budget, ...overrides });
}
function reference(p) { return { planId: p.planId, planDigest: p.planDigest }; }
function events(root, p) { return path.join(root, '.atelier-local/ingestion/plans', p.planId, 'events'); }

test('mixed explicit selection binds bytes, resumes and yields locatable evidence with omissions', t => {
  const { store, root, options } = fixture(t), p = plan(store);
  assert.equal(p.census, 'explicit-selection-only'); assert.equal(p.items.length, 5);
  assert.equal(p.items.at(-1).initialStatus, 'unavailable');
  assert.equal(fs.existsSync(path.join(root, '.atelier-local/intake/blobs')), false);
  const partial = store.run({ ...reference(p), maxItems: 2 });
  assert.equal(partial.progress.byStatus.complete, 2); assert.equal(partial.progress.remaining, 2);
  const resumed = createIngestionStore(options), done = resumed.run(reference(p));
  assert.equal(done.settled, true); assert.equal(done.complete, false);
  assert.deepEqual(done.items.map(item => item.status), ['complete', 'complete', 'complete', 'unsupported', 'unavailable']);
  assert.equal(done.usage.attempts, 4); assert.equal(done.semanticAcceptance, 'pending');
  const query = resumed.query({ ...reference(p), query: 'basil' });
  assert.equal(query.synthesized, false); assert.ok(query.hits.length >= 2);
  assert.equal(query.hits[0].locator.kind, 'line'); assert.equal(query.hits[0].locator.value, '2');
  assert.equal(query.hits[0].sourceDigest, intakeDigest(fs.readFileSync(path.join(root, 'notes.md'))));
  assert.ok(query.hits.some(hit => hit.locator.kind === 'csv-cell'));
  assert.equal(query.omissions.length, 2);
  const blob = path.join(root, '.atelier-local/intake/blobs', p.items[3].sourceDigest);
  assert.equal(fs.readFileSync(blob, 'utf8'), 'Invented unsupported bytes');
  assert.equal(fs.existsSync(path.join(root, '.atelier-local/ingestion/blobs')), false);
  assert.deepEqual(resumed.run(reference(p)), resumed.status(reference(p)));
});

test('validated unchanged attempts reuse across explicitly new plans and retain original provenance', t => {
  const { store, root } = fixture(t);
  const first = plan(store, ['notes.md', 'table.csv']); const completed = store.run(reference(first));
  const next = plan(store, ['notes.md', 'table.csv']); assert.notEqual(next.planId, first.planId);
  const reused = store.run(reference(next));
  assert.equal(reused.usage.cacheHits, 2); assert.equal(reused.usage.attempts, 2);
  assert.deepEqual(reused.items.map(item => item.attemptId), completed.items.map(item => item.attemptId));
  assert.equal(reused.usage.outputBytes, completed.usage.outputBytes);
  const count = fs.readdirSync(path.join(root, '.atelier-local/intake/attempts')).length;
  assert.equal(count, 2);
});

test('stale source refuses one item while unrelated selected files continue', t => {
  const { store, root } = fixture(t), p = plan(store, ['notes.md', 'table.csv']);
  fs.writeFileSync(path.join(root, 'notes.md'), 'Different gardening advice.');
  const result = store.run(reference(p));
  assert.deepEqual(result.items.map(item => item.status), ['stale', 'complete']);
  assert.equal(result.usage.attempts, 1);
  assert.equal(result.items[0].reason, 'source-digest-changed');
});

test('fresh queries suppress changed and deleted evidence without writes or silent reprocessing', t => {
  const { store, root, options } = fixture(t), p = plan(store, ['notes.md', 'table.csv', 'tree.json']); store.run(reference(p));
  const before = fs.readdirSync(events(root, p));
  fs.writeFileSync(path.join(root, 'notes.md'), 'Unrelated replacement.'); fs.unlinkSync(path.join(root, 'tree.json'));
  const answer = createIngestionStore(options).query({ ...reference(p), query: 'basil' });
  assert.deepEqual(answer.hits.map(hit => hit.ref), ['table.csv']);
  assert.deepEqual(answer.omissions.map(item => item.status), ['stale', 'stale']);
  assert.equal(answer.status.complete, false);
  assert.deepEqual(fs.readdirSync(events(root, p)), before);
  assert.equal(store.status(reference(p)).items[0].status, 'complete');
});

test('malformed attempts remain counted; all input/output/attempt budgets yield visible dispositions', t => {
  const { store } = fixture(t, { 'bad.json': '{"unfinished":', 'notes.md': 'Basil water' });
  const failed = plan(store, ['bad.json', 'notes.md'], { budget: { ...budget, maxAttempts: 1 } });
  const first = store.run(reference(failed));
  assert.deepEqual(first.items.map(item => item.status), ['failed', 'budget-blocked']);
  assert.equal(first.items[0].reason, 'ingestion-invalid-json');
  assert.equal(first.usage.attempts, 1); assert.equal(first.usage.failedAttempts, 1); assert.equal(first.usage.outputBytes, 0);
  assert.equal(first.usage.inputBytes, Buffer.byteLength('{"unfinished":'));
  assert.deepEqual(store.run(reference(failed)), first);
  const noInput = store.run(reference(plan(store, ['notes.md'], { budget: { ...budget, maxInputBytes: 0 } })));
  assert.equal(noInput.items[0].reason, 'input-byte-budget'); assert.equal(noInput.usage.attempts, 0);
  const noOutput = store.run(reference(plan(store, ['notes.md'], { budget: { ...budget, maxOutputBytes: 0 } })));
  assert.equal(noOutput.items[0].reason, 'output-byte-budget');
  const tinyOutput = store.run(reference(plan(store, ['notes.md'], { budget: { ...budget, maxOutputBytes: 50 } })));
  assert.equal(tinyOutput.items[0].status, 'failed'); assert.match(tinyOutput.items[0].reason, /processor-limit-output/);
  assert.equal(tinyOutput.usage.attempts, 1);
});

test('corrupt completed evidence is a visible refusal and never a cache miss', t => {
  const { store, root } = fixture(t), first = plan(store, ['notes.md', 'table.csv']), done = store.run(reference(first));
  const target = path.join(root, '.atelier-local/intake/attempts', done.items[0].attemptId, 'output.txt');
  fs.writeFileSync(target, 'invented-corrupted-derived-bytes');
  const view = store.status(reference(first)); assert.equal(view.items[0].status, 'failed'); assert.equal(view.items[0].reason, 'stored-evidence-integrity-refused');
  assert.deepEqual(store.query({ ...reference(first), query: 'basil' }).hits.map(hit => hit.ref), ['table.csv']);
  const fresh = store.run(reference(plan(store, ['notes.md', 'table.csv'])));
  assert.deepEqual(fresh.items.map(item => item.status), ['failed', 'budget-blocked']);
  assert.equal(fresh.items[0].reason, 'attempt-integrity-refused'); assert.equal(fresh.items[0].outputBytes, null);
  assert.equal(fresh.items[1].reason, 'output-accounting-uncertain'); assert.equal(fresh.usage.unknownOutputItems, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'invented-corrupted-derived-bytes');
});

for (const point of ['reservation', 'before-output', 'output', 'completion', 'disposition']) {
  test(`process interruption at ${point} resumes without a duplicate budget charge`, t => {
    const { store, root, options } = fixture(t, { 'notes.md': 'Basil at dawn.' }), p = plan(store, ['notes.md']);
    const module = new URL('../src/ingestion/store.mjs', import.meta.url).href;
    const script = `import fs from 'node:fs'; import path from 'node:path'; import { createIngestionStore } from ${JSON.stringify(module)};
      const store = createIngestionStore(JSON.parse(process.argv[1])); const link = fs.linkSync;
      const point = process.argv[3]; fs.linkSync = (from, to) => {
        if (point === 'before-output' && path.basename(to) === 'output.txt') process.exit(73);
        link(from, to);
        if ((point === 'reservation' && path.basename(to) === '0001.json' && path.basename(path.dirname(to)) === 'events') ||
            (point === 'output' && path.basename(to) === 'output.txt') ||
            (point === 'completion' && path.basename(to) === 'completion.json') ||
            (point === 'disposition' && path.basename(to) === '0002.json' && path.basename(path.dirname(to)) === 'events')) process.exit(73);
      }; store.run(JSON.parse(process.argv[2]));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options), JSON.stringify(reference(p)), point]);
    assert.equal(child.status, 73, child.stderr.toString());
    const resumed = createIngestionStore(options), done = resumed.run(reference(p));
    assert.equal(done.items[0].status, 'complete'); assert.equal(done.usage.attempts, 1); assert.equal(done.usage.cacheHits, 0);
    assert.equal(done.usage.pendingAttempts, 0); assert.equal(done.usage.outputBytes, done.items[0].outputBytes);
    assert.equal(resumed.query({ ...reference(p), query: 'basil' }).hits.length, 1);
    assert.equal(fs.readdirSync(events(root, p)).filter(name => name.endsWith('.json')).length, 2);
  });
}

test('a thrown output-publication failure keeps the reservation resumable', t => {
  const { store } = fixture(t, { 'notes.md': 'Water basil.' }), p = plan(store, ['notes.md']);
  const link = fs.linkSync;
  fs.linkSync = (from, to) => { if (path.basename(to) === 'output.txt') throw Object.assign(new Error('synthetic local write interruption'), { code: 'EIO' }); return link(from, to); };
  try { assert.throws(() => store.run(reference(p)), { code: 'INGESTION_RETRY_REQUIRED' }); }
  finally { fs.linkSync = link; }
  const pending = store.status(reference(p)); assert.equal(pending.usage.attempts, 1); assert.equal(pending.usage.pendingAttempts, 1);
  const done = store.run(reference(p)); assert.equal(done.items[0].status, 'complete'); assert.equal(done.usage.attempts, 1);
});

test('source references, private placement, exact plans and writer ownership fail closed', t => {
  const { store, root, options } = fixture(t);
  fs.symlinkSync(path.join(root, 'notes.md'), path.join(root, 'redirect.md'));
  const p = plan(store, ['../outside.md', 'redirect.md', 'notes.md']);
  assert.deepEqual(p.items.map(item => item.initialStatus), ['unavailable', 'unavailable', 'pending']);
  assert.throws(() => store.run({ ...reference(p), planDigest: `sha256:${'0'.repeat(64)}` }), { code: 'INGESTION_STALE' });
  const another = createIngestionStore({ ...options, workspaceId: 'another' });
  assert.throws(() => another.status(reference(p)), { code: 'INGESTION_WORKSPACE' });
  assert.throws(() => another.plan({ scope, purpose: 'Refuse another workspace.', budget, sources: [{ id: 'notes', ref: 'notes.md' }] }), { code: 'INGESTION_WORKSPACE' });
  const release = acquirePrivateLock(path.join(root, '.atelier-local/ingestion/operation.lock'));
  // A writer holding the operation lock refuses another writer, never a reader.
  try { assert.throws(() => store.run(reference(p)), /locked/); assert.equal(store.status(reference(p)).usage.attempts, 0); } finally { release(); }
  assert.equal(store.status(reference(p)).usage.attempts, 0);
  const file = path.join(root, '.atelier-local/ingestion/plans', p.planId, 'plan.json');
  const body = JSON.parse(fs.readFileSync(file)); body.purpose = 'Modified after planning.'; fs.writeFileSync(file, JSON.stringify(body));
  assert.throws(() => store.status(reference(p)), { code: 'INGESTION_STALE' });
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => store.status(reference(p)), { code: 'INGESTION_PRIVATE' });
});

test('source identifiers cannot collide with object prototypes; invalid request shapes refuse', t => {
  const { store } = fixture(t, { 'notes.md': 'Basil.' });
  const input = { sources: [{ id: 'constructor', ref: 'notes.md' }], scope, purpose: 'Explicit selection.', budget };
  const p = store.plan(input); const done = store.run(reference(p)); assert.equal(done.items[0].status, 'complete');
  assert.equal(store.query({ ...reference(p), query: 'basil' }).hits[0].sourceId, 'constructor');
  assert.throws(() => store.plan({ ...input, sources: [...input.sources, ...input.sources] }), { code: 'INGESTION_INVALID' });
  assert.throws(() => store.plan({ ...input, scope: { ...scope, activity: '*' } }), { code: 'INGESTION_INVALID' });
  assert.throws(() => store.run({ ...reference(p), maxItems: 129 }), { code: 'INGESTION_INVALID' });
  assert.throws(() => store.query({ ...reference(p), query: '' }), { code: 'INGESTION_INVALID' });
});

test('a localized first-source change reuses the other two stable processor attempts', t => {
  const { store, root } = fixture(t), refs = ['notes.md', 'table.csv', 'tree.json'];
  const cold = store.run(reference(plan(store, refs))); assert.equal(cold.usage.cacheHits, 0);
  const warm = store.run(reference(plan(store, refs))); assert.equal(warm.usage.cacheHits, 3);
  fs.writeFileSync(path.join(root, 'notes.md'), 'Basil: a substantially longer and genuinely different invented gardening observation.\n'.repeat(20));
  const changed = store.run(reference(plan(store, refs)));
  assert.equal(changed.usage.cacheHits, 2);
  assert.notEqual(changed.items[0].attemptId, warm.items[0].attemptId);
  assert.deepEqual(changed.items.slice(1).map(item => item.attemptId), warm.items.slice(1).map(item => item.attemptId));
});

test('stable cache configuration cannot admit cached output beyond remaining plan budget', t => {
  const { store, root } = fixture(t, { 'a.txt': 'Basil.', 'b.txt': 'Basil.' });
  const measured = store.run(reference(plan(store, ['a.txt']))).usage.outputBytes;
  const smallBudget = { ...budget, maxOutputBytes: measured + 20 };
  const warm = store.run(reference(plan(store, ['b.txt'], { budget: smallBudget })));
  const receiptFile = path.join(root, '.atelier-local/intake/attempts', warm.items[0].attemptId, 'completion.json');
  const receipt = fs.readFileSync(receiptFile);
  const combined = store.run(reference(plan(store, ['a.txt', 'b.txt'], { budget: smallBudget })));
  assert.deepEqual(combined.items.map(item => item.status), ['complete', 'budget-blocked']);
  assert.equal(combined.items[1].reason, 'output-byte-budget');
  assert.equal(combined.items[1].attemptId, warm.items[0].attemptId);
  assert.equal(combined.items[1].outputBytes, 0);
  assert.equal(combined.usage.outputBytes, measured); assert.ok(combined.usage.outputBytes <= smallBudget.maxOutputBytes);
  assert.equal(combined.usage.attempts, 2);
  assert.deepEqual(fs.readFileSync(receiptFile), receipt);
});

test('external operation envelopes reject unknown keys and missing reads create no plan directories', t => {
  const { store, root } = fixture(t), p = plan(store, ['notes.md']);
  assert.throws(() => store.run({ ...reference(p), workers: 2 }), { code: 'INGESTION_INVALID' });
  assert.throws(() => store.status({ ...reference(p), repair: true }), { code: 'INGESTION_INVALID' });
  assert.throws(() => store.query({ ...reference(p), query: 'basil', synthesize: true }), { code: 'INGESTION_INVALID' });
  assert.throws(() => store.run(p), { code: 'INGESTION_INVALID' });
  const missing = { planId: 'plan-missing', planDigest: `sha256:${'a'.repeat(64)}` };
  assert.throws(() => store.status(missing), { code: 'INGESTION_MISSING' });
  assert.equal(fs.existsSync(path.join(root, '.atelier-local/ingestion/plans/plan-missing')), false);
});

test('reads neither bind a workspace identity nor create private state', t => {
  const { root, options } = fixture(t);
  const typo = createIngestionStore({ ...options, workspaceId: 'garden-workspce' });
  const missing = { planId: `plan-${'a'.repeat(40)}`, planDigest: `sha256:${'0'.repeat(64)}` };
  assert.throws(() => typo.status(missing), { code: 'INGESTION_MISSING' });
  assert.throws(() => typo.query({ ...missing, query: 'garden' }), { code: 'INGESTION_MISSING' });
  assert.equal(fs.existsSync(path.join(root, '.atelier-local/ingestion/workspace.json')), false);
  const p = plan(createIngestionStore(options));
  assert.equal(p.workspaceId, options.workspaceId);
});
