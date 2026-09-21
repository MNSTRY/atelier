import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createLearningStore, learningDigest, validateLearningInput } from '../src/learning/store.mjs';
import { acquirePrivateLock } from '../src/project/durable-state.mjs';

const human = { id: 'owner', kind: 'human' };
const agent = { id: 'assistant', kind: 'agent' };
const scope = { project: 'invented-garden', activity: 'weekly-review' };
function workspace(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-learning-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  return root;
}
function fixture(t) {
  const root = workspace(t), options = { workspaceRoot: root, workspaceId: 'garden-workspace' };
  return { root, options, store: createLearningStore(options) };
}
function observation(id = 'o1', overrides = {}) {
  return { id, signal: 'user-correction', text: 'Please state the gardening decision before discussing the tools.', interpretation: 'explicit', scope, source: { ref: 'manual-user-entry', digest: null }, ...overrides };
}
function proposal(id = 'l1', overrides = {}) {
  return { id, title: 'Decision first in weekly reviews', principle: 'Lead with the decision.', rationale: 'The review should help the reader decide what to do.', exceptions: ['Provide context first when the reader cannot interpret the decision.'], evidenceIds: ['o1'], scope, artifact: { kind: 'instruction', name: 'decision-first', content: 'In weekly garden reviews, begin with the decision, then explain supporting details.' }, ...overrides };
}
function run(store, operation, input, actor = human, requestId = `request-${store.snapshot().revision + 1}`) {
  return store.execute({ requestId, expectedRevision: store.snapshot().revision, operation, input }, { actor });
}
function accepted(store, id = 'l1', overrides = {}) {
  const lesson = run(store, 'propose', proposal(id, overrides), agent).record;
  const decision = run(store, 'decide', { lessonId: id, lessonDigest: lesson.digest, verdict: 'accepted', reason: 'Useful for this activity.' }).record;
  return { lesson, decision };
}
function activate(store, pair, id = 'a1', harnessId = 'local-editor') {
  return run(store, 'activate', { id, lessonId: pair.lesson.id, lessonDigest: pair.lesson.digest, decisionId: pair.decision.id, harnessId }).record;
}
function context(store, harnessId = 'local-editor', requestedScope = scope) { return store.context({ scope: requestedScope, harnessId }); }

test('correction, exact acceptance, rendering, activation, outcome feedback, withdrawal and restart', t => {
  const { store, options, root } = fixture(t);
  const observed = run(store, 'capture', observation(), agent).record;
  assert.equal(observed.source.digest, null);
  const lesson = run(store, 'propose', proposal(), agent).record;
  assert.deepEqual(lesson.evidence, [{ id: observed.id, digest: observed.digest }]);
  assert.equal(store.render({ lessonId: lesson.id, lessonDigest: lesson.digest }).status, 'proposed');
  assert.deepEqual(context(store).lessons, []);
  const decision = run(store, 'decide', { lessonId: lesson.id, lessonDigest: lesson.digest, verdict: 'accepted', reason: 'Accept this exact text and scope.' }).record;
  assert.deepEqual(context(store).lessons, []);
  const artifact = store.render({ lessonId: lesson.id, lessonDigest: lesson.digest });
  assert.equal(artifact.executable, false); assert.equal(artifact.status, 'accepted');
  assert.equal(artifact.artifact.content, proposal().artifact.content);
  const activation = activate(store, { lesson, decision });
  assert.deepEqual(context(store).lessons.map(item => item.id), ['l1']);
  assert.equal(context(store).lessons[0].evidence[0].source.ref, 'manual-user-entry');
  assert.equal(context(store, 'other-editor').lessons.length, 0);
  assert.equal(context(store, 'local-editor', { ...scope, project: 'another-garden' }).lessons.length, 0);
  assert.equal(context(store, 'local-editor', { ...scope, activity: 'harvest' }).lessons.length, 0);
  assert.equal(context(store).authority.grantsToolPermissions, false);
  const before = store.snapshot();
  const restarted = createLearningStore(options); assert.deepEqual(restarted.snapshot(), before);
  run(restarted, 'capture', observation('o2', { signal: 'successful-run', interpretation: 'inferred', text: 'The next review required fewer clarification questions.', lessonId: 'l1' }), agent);
  run(restarted, 'withdraw', { activationId: activation.id, reason: 'Reconsider this preference for the next season.' });
  assert.equal(context(restarted).lessons.length, 0);
  assert.equal(restarted.snapshot().activationStates[0].status, 'withdrawn');
  assert.deepEqual(restarted.snapshot().activations[0], activation);
  const again = createLearningStore(options); assert.equal(context(again).lessons.length, 0);
  assert.ok(again.graph().edges.some(edge => edge.type === 'application-feedback'));
  assert.equal(again.graph().authority.canonicalGraphMutation, false);
  const archive = again.export();
  assert.equal(archive.visibility, 'private'); assert.equal(archive.authority.importedActivation, false);
  const { digest, ...body } = archive; assert.equal(digest, learningDigest(body));
  assert.equal(archive.history.length, 6);
  assert.equal(fs.statSync(path.join(root, '.atelier-local', 'learning')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, '.atelier-local', 'learning', 'events', '0000000001.json')).mode & 0o777, 0o600);
});

test('lost replies retry exactly across restart; changed actor and bytes refuse reuse', t => {
  const { store, options } = fixture(t);
  const request = { requestId: 'lost-reply', expectedRevision: 0, operation: 'capture', input: observation() };
  const result = store.execute(request, { actor: agent });
  const replay = createLearningStore(options).execute(request, { actor: agent });
  assert.deepEqual(replay, { ...result, duplicate: true });
  assert.throws(() => store.execute({ ...request, expectedRevision: 1 }, { actor: agent }), { code: 'LEARNING_REQUEST_REUSE' });
  assert.throws(() => store.execute(request, { actor: human }), { code: 'LEARNING_REQUEST_REUSE' });
  assert.equal(store.snapshot().revision, 1);
});

test('stale decisions, rejected versions and non-human mutation refuse without consuming revision', t => {
  const { store } = fixture(t); run(store, 'capture', observation());
  const lesson = run(store, 'propose', proposal()).record;
  const decisionInput = { lessonId: lesson.id, lessonDigest: lesson.digest, verdict: 'accepted', reason: 'Reviewed.' };
  assert.throws(() => run(store, 'decide', decisionInput, agent), { code: 'LEARNING_AUTHORITY' });
  assert.throws(() => store.execute({ requestId: 'stale', expectedRevision: 1, operation: 'decide', input: decisionInput }, { actor: human }), { code: 'LEARNING_STALE' });
  assert.throws(() => run(store, 'decide', { ...decisionInput, lessonDigest: learningDigest('other') }), { code: 'LEARNING_STALE' });
  const first = run(store, 'decide', decisionInput).record;
  run(store, 'decide', { ...decisionInput, verdict: 'rejected' });
  assert.throws(() => activate(store, { lesson, decision: first }), { code: 'LEARNING_DECISION' });
  const current = run(store, 'decide', decisionInput).record;
  const activationInput = { id: 'a1', lessonId: lesson.id, lessonDigest: lesson.digest, decisionId: current.id, harnessId: 'local-editor' };
  assert.throws(() => run(store, 'activate', activationInput, agent), { code: 'LEARNING_AUTHORITY' });
  run(store, 'activate', activationInput);
  assert.throws(() => run(store, 'decide', { ...decisionInput, verdict: 'deferred' }), { code: 'LEARNING_ACTIVE' });
  assert.throws(() => run(store, 'withdraw', { activationId: 'a1', reason: 'Change.' }, agent), { code: 'LEARNING_AUTHORITY' });
  assert.equal(context(store).lessons.length, 1);
});

test('validation refuses unknown fields, malformed input, excessive values and implicit scope expansion', t => {
  const { store } = fixture(t);
  assert.ok(validateLearningInput('capture', { ...observation(), authority: 'accept-all' }).length);
  assert.ok(validateLearningInput('anything', {}).length);
  assert.throws(() => run(store, 'capture', observation('o1', { text: 'a'.repeat(16385) })), { code: 'LEARNING_INVALID' });
  assert.throws(() => run(store, 'capture', observation('o1', { source: { ref: 'manual-user-entry', digest: 'not-a-digest' } })), { code: 'LEARNING_INVALID' });
  assert.throws(() => run(store, 'capture', observation('o1', { scope: { project: '*', activity: '*' } })), { code: 'LEARNING_INVALID' });
  const nested = {}; nested.self = nested;
  assert.throws(() => store.execute(nested, { actor: human }), /must be JSON/);
  let getterCalled = false;
  const getter = { get requestId() { getterCalled = true; return 'request'; } };
  assert.throws(() => store.execute(getter, { actor: human }), /plain JSON/); assert.equal(getterCalled, false);
  run(store, 'capture', observation());
  assert.throws(() => run(store, 'capture', observation()), { code: 'LEARNING_DUPLICATE' });
  assert.throws(() => run(store, 'propose', proposal('l1', { evidenceIds: ['missing'] })), { code: 'LEARNING_MISSING' });
  assert.throws(() => run(store, 'propose', proposal('l1', { scope: { ...scope, project: 'elsewhere' } })), { code: 'LEARNING_SCOPE' });
  const pair = accepted(store, 'l1', { scope: { ...scope, activity: '*' } }); activate(store, pair);
  assert.equal(context(store, 'local-editor', { ...scope, activity: 'harvest' }).lessons.length, 1);
  assert.throws(() => context(store, 'local-editor', { ...scope, activity: '*' }), { code: 'LEARNING_SCOPE' });
  assert.throws(() => run(store, 'capture', observation('o2', { lessonId: 'l1', scope: { ...scope, project: 'elsewhere' } })), { code: 'LEARNING_SCOPE' });
});

test('replacement only retires previous context at explicit activation in the chosen harness', t => {
  const { store, options } = fixture(t); run(store, 'capture', observation());
  const first = accepted(store); activate(store, first); activate(store, first, 'a-other', 'other-editor');
  const revised = accepted(store, 'l2', { supersedes: 'l1', artifact: { ...proposal().artifact, content: 'Lead with a decision and an explicit next step.' } });
  assert.deepEqual(context(store).lessons.map(item => item.id), ['l1']);
  activate(store, revised, 'a2');
  assert.deepEqual(context(createLearningStore(options)).lessons.map(item => item.id), ['l2']);
  assert.deepEqual(context(store, 'other-editor').lessons.map(item => item.id), ['l1']);
  assert.throws(() => activate(store, first, 'revive'), { code: 'LEARNING_SUPERSEDED' });
  assert.throws(() => run(store, 'propose', proposal('l3', { supersedes: 'l2', scope: { ...scope, activity: '*' } })), { code: 'LEARNING_SCOPE' });
  assert.throws(() => run(store, 'propose', proposal('l3', { supersedes: 'l2', artifact: { ...proposal().artifact, name: 'other-slot' } })), { code: 'LEARNING_SCOPE' });
  run(store, 'withdraw', { activationId: 'a2', reason: 'Retire the replacement.' });
  assert.equal(context(store).lessons.length, 0);
});

test('overlapping slot conflicts are withheld without claiming semantic contradiction detection', t => {
  const { store } = fixture(t); run(store, 'capture', observation());
  activate(store, accepted(store));
  activate(store, accepted(store, 'l2', { scope: { ...scope, activity: '*' }, artifact: { ...proposal().artifact, content: 'Open with historical background.' } }), 'a2');
  const selected = context(store); assert.equal(selected.lessons.length, 0);
  assert.deepEqual(selected.conflicts[0].lessonIds, ['l1', 'l2']);
  run(store, 'withdraw', { activationId: 'a2', reason: 'Resolve conflicting guidance.' });
  assert.deepEqual(context(store).lessons.map(item => item.id), ['l1']);
  activate(store, accepted(store, 'l3', { artifact: { kind: 'check', name: 'count-steps', content: 'A review should identify one next step.' } }), 'a3');
  const check = context(store).lessons.find(item => item.id === 'l3'); assert.equal(check.artifact.kind, 'check');
  assert.equal(store.render({ lessonId: 'l3', lessonDigest: check.lessonDigest }).executable, false);
});

test('workspace binding and ignored untracked storage are rechecked on each operation', t => {
  const { store, root, options } = fixture(t);
  assert.throws(() => createLearningStore({ ...options, workspaceId: 'different' }), { code: 'LEARNING_WORKSPACE' });
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  assert.throws(() => store.snapshot(), { code: 'LEARNING_PRIVATE' });
  fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n');
  execFileSync('git', ['-C', root, 'add', '-f', '.atelier-local/learning/workspace.json']);
  assert.throws(() => store.snapshot(), { code: 'LEARNING_PRIVATE' });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-plain-')); t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => createLearningStore({ workspaceRoot: empty, workspaceId: 'plain' }), { code: 'LEARNING_PRIVATE' });
});

test('redirected directories and history leaves refuse without following them', t => {
  const root = workspace(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(root, '.atelier-local'));
  assert.throws(() => createLearningStore({ workspaceRoot: root, workspaceId: 'redirected' }), /redirected|ignored, untracked/);
  assert.equal(fs.readdirSync(outside).length, 0);
  fs.unlinkSync(path.join(root, '.atelier-local'));
  const store = createLearningStore({ workspaceRoot: root, workspaceId: 'local' }); run(store, 'capture', observation());
  const eventFile = path.join(root, '.atelier-local', 'learning', 'events', '0000000001.json');
  const saved = path.join(outside, 'event.json'); fs.renameSync(eventFile, saved); fs.symlinkSync(saved, eventFile);
  assert.throws(() => store.snapshot(), /non-regular/);
});

test('tampering, missing records and unknown committed filenames fail closed; pending writes are preserved', t => {
  const { store, root, options } = fixture(t); run(store, 'capture', observation());
  const events = path.join(root, '.atelier-local', 'learning', 'events'), file = path.join(events, '0000000001.json');
  const original = fs.readFileSync(file), modified = JSON.parse(original); modified.record.text = 'Changed after acceptance.';
  fs.writeFileSync(file, JSON.stringify(modified));
  assert.throws(() => createLearningStore(options), { code: 'LEARNING_HISTORY' });
  fs.writeFileSync(file, original);
  const pending = path.join(events, '.atelier-write-11111111-1111-4111-8111-111111111111.tmp');
  fs.writeFileSync(pending, 'interrupted bytes'); assert.equal(store.snapshot().revision, 1);
  assert.equal(fs.readFileSync(pending, 'utf8'), 'interrupted bytes');
  const unknown = path.join(events, 'unknown.json'); fs.writeFileSync(unknown, '{}'); assert.throws(() => store.snapshot(), { code: 'LEARNING_HISTORY' }); fs.unlinkSync(unknown);
  run(store, 'capture', observation('o2')); fs.unlinkSync(path.join(events, '0000000002.json'));
  assert.throws(() => store.snapshot(), /shortened/);
});

test('live writer lock refuses mutation and preserves history', t => {
  const { root, store } = fixture(t);
  const release = acquirePrivateLock(path.join(root, '.atelier-local', 'learning', 'operation.lock'));
  try { assert.throws(() => run(store, 'capture', observation()), /locked/); }
  finally { release(); }
  assert.equal(store.snapshot().revision, 0); run(store, 'capture', observation());
  assert.equal(store.snapshot().revision, 1);
});

test('interrupted publication has no partial event and resumes with the same request', t => {
  const { root, options } = fixture(t);
  const module = new URL('../src/learning/store.mjs', import.meta.url).href;
  const request = { requestId: 'interrupted', expectedRevision: 0, operation: 'capture', input: observation() };
  const script = `import fs from 'node:fs'; import { createLearningStore } from ${JSON.stringify(module)};
    const store = createLearningStore(JSON.parse(process.argv[1])); const link = fs.linkSync;
    fs.linkSync = (source, target) => target.includes('/events/') ? process.exit(73) : link(source, target);
    store.execute(JSON.parse(process.argv[2]), { actor: { id: 'owner', kind: 'human' } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options), JSON.stringify(request)]);
  assert.equal(child.status, 73, child.stderr.toString());
  const events = path.join(root, '.atelier-local', 'learning', 'events');
  assert.ok(fs.readdirSync(events).some(name => name.endsWith('.tmp')));
  const resumed = createLearningStore(options); assert.equal(resumed.snapshot().revision, 0);
  assert.equal(resumed.execute(request, { actor: human }).revision, 1);
  assert.equal(resumed.execute(request, { actor: human }).duplicate, true);
});

test('independent processes race on one revision and at most one commits', async t => {
  const { options } = fixture(t);
  const module = new URL('../src/learning/store.mjs', import.meta.url).href;
  const script = `import { createLearningStore } from ${JSON.stringify(module)};
    let store; process.on('message', message => {
      if (message === 'start') { try { store.execute(JSON.parse(process.argv[2]), { actor: { id: 'owner', kind: 'human' } }); process.exit(0); }
        catch (error) { process.exit(['EEXIST', 'LEARNING_STALE'].includes(error.code) ? 23 : 24); } }
    });
    store = createLearningStore(JSON.parse(process.argv[1])); process.send('ready');`;
  const children = [];
  const completions = [];
  // Initialize sequentially; the race being tested is the two writes.
  for (const number of [1, 2]) {
    const request = { requestId: `racer-${number}`, expectedRevision: 0, operation: 'capture', input: observation(`o${number}`) };
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options), JSON.stringify(request)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    children.push(child); completions.push(new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }));
    await new Promise(resolve => child.once('message', resolve));
  }
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  children.forEach(child => child.send('start'));
  assert.deepEqual((await Promise.all(completions)).sort((a, b) => a - b), [0, 23]);
  assert.equal(createLearningStore(options).snapshot().revision, 1);
});

test('lost reply after final publication retries the committed event without duplicating it', t => {
  const { options } = fixture(t);
  const module = new URL('../src/learning/store.mjs', import.meta.url).href;
  const request = { requestId: 'committed-no-reply', expectedRevision: 0, operation: 'capture', input: observation() };
  const script = `import fs from 'node:fs'; import { createLearningStore } from ${JSON.stringify(module)};
    const store = createLearningStore(JSON.parse(process.argv[1])); const link = fs.linkSync;
    fs.linkSync = (source, target) => { link(source, target); if (target.includes('/events/')) process.exit(74); };
    store.execute(JSON.parse(process.argv[2]), { actor: { id: 'owner', kind: 'human' } });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(options), JSON.stringify(request)]);
  assert.equal(child.status, 74, child.stderr.toString());
  const resumed = createLearningStore(options); assert.equal(resumed.snapshot().revision, 1);
  assert.equal(resumed.execute(request, { actor: human }).duplicate, true);
  assert.equal(resumed.snapshot().revision, 1);
});

test('corrupted workspace identity diagnostics never echo private text', t => {
  const { store, root, options } = fixture(t);
  const privateMarker = 'invented-confidential-identity-text';
  fs.writeFileSync(path.join(root, '.atelier-local', 'learning', 'workspace.json'), privateMarker);
  for (const read of [() => store.snapshot(), () => createLearningStore(options)]) {
    assert.throws(read, error => error.code === 'LEARNING_HISTORY' && !error.message.includes(privateMarker));
  }
});

test('aggregate journal bound refuses before replay and preserves withdrawal headroom', t => {
  const { store, root, options } = fixture(t);
  run(store, 'capture', observation()); const pair = accepted(store); activate(store, pair);
  for (let i = 2; i <= 40; i++) run(store, 'capture', observation(`o${i}`));
  const events = path.join(root, '.atelier-local', 'learning', 'events');
  // Valid insignificant JSON whitespace exercises byte accounting without
  // generating an oversized record or weakening the production ceiling.
  for (const name of fs.readdirSync(events)) {
    const file = path.join(events, name), bytes = fs.readFileSync(file);
    fs.appendFileSync(file, ' '.repeat(768000 - bytes.length));
  }
  const resumed = createLearningStore(options);
  assert.equal(resumed.snapshot().revision, 43);
  assert.throws(() => run(resumed, 'capture', observation('over-budget')), error => error.code === 'LEARNING_LIMIT' && /aggregate/.test(error.message));
  assert.equal(resumed.snapshot().revision, 43);
  run(resumed, 'withdraw', { activationId: 'a1', reason: 'Use reserved withdrawal capacity.' });
  assert.equal(context(resumed).lessons.length, 0);
  const tail = path.join(events, '0000000044.json');
  fs.appendFileSync(tail, ' '.repeat(768000 - fs.statSync(tail).size));
  assert.throws(() => createLearningStore(options), error => error.code === 'LEARNING_LIMIT' && /aggregate/.test(error.message));
  assert.equal(fs.readdirSync(events).length, 44);
});

test('admission reserves withdrawal capacity for every active binding, beyond fixed headroom', t => {
  const { store, root, options } = fixture(t);
  run(store, 'capture', observation()); const pair = accepted(store);
  for (let i = 1; i <= 5; i++) activate(store, pair, `active-${i}`, `editor-${i}`);
  for (let i = 2; i <= 37; i++) run(store, 'capture', observation(`o${i}`));
  const events = path.join(root, '.atelier-local', 'learning', 'events');
  const names = fs.readdirSync(events).sort();
  const withdrawalBytes = 256 * 1024 + 1;
  // Preserve enough capacity for all five withdrawals, but not a sixth
  // activation. The old fixed 1 MiB reserve would incorrectly admit it.
  const totalBytes = 32 * 1024 * 1024 - 5 * withdrawalBytes - 4096;
  const perFile = Math.floor(totalBytes / names.length);
  for (let i = 0; i < names.length; i++) {
    const file = path.join(events, names[i]);
    const desired = perFile + (i === 0 ? totalBytes % names.length : 0);
    fs.appendFileSync(file, ' '.repeat(desired - fs.statSync(file).size));
  }
  const resumed = createLearningStore(options), before = resumed.snapshot();
  assert.equal(before.activationStates.filter(binding => binding.status === 'active').length, 5);
  assert.throws(() => activate(resumed, pair, 'active-6', 'editor-6'), error => error.code === 'LEARNING_LIMIT' && /withdrawal reservations/.test(error.message));
  assert.deepEqual(resumed.snapshot(), before);
  for (let i = 1; i <= 5; i++) {
    run(resumed, 'withdraw', { activationId: `active-${i}`, reason: 'r'.repeat(8192) });
    assert.equal(context(resumed, `editor-${i}`).lessons.length, 0);
  }
  assert.equal(createLearningStore(options).snapshot().activationStates.filter(binding => binding.status === 'active').length, 0);
});
