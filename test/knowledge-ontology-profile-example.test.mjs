// Keep the example's cases in the root CI discovery path.
import '../examples/knowledge-ontology-profile/test/assessment.test.mjs';
import '../examples/knowledge-ontology-profile/test/profile-cases.test.mjs';
import '../examples/knowledge-ontology-profile/test/cli-reader.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createFixtureWorkspace } from '../examples/knowledge-ontology-profile/tools/fixture-workspace.mjs';
import { createCliReader } from '../examples/knowledge-ontology-profile/tools/cli-reader.mjs';
import { assessCapture } from '../examples/knowledge-ontology-profile/tools/assessment-core.mjs';
import { summarizeMeasurements } from '../examples/knowledge-ontology-profile/tools/measurements.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(root, 'bin/atelier.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function cli(workspace, words, input) {
  const run = spawnSync(process.execPath, [entry, ...words], { cwd: workspace,
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}
function fileDigests(workspace) {
  const files = {};
  function visit(rel) {
    const file = path.join(workspace, rel), stat = fs.lstatSync(file);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(rel, name));
    else { assert.equal(stat.isFile(), true); files[rel] = digest(fs.readFileSync(file)); }
  }
  for (const name of fs.readdirSync(workspace).sort()) if (name !== '.git') visit(name);
  return files;
}
function repositoryBinding() {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'bin', 'src', 'package.json', 'contracts', 'templates'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return { schema: 'atelier-profile-repository-binding/local-v1', sourceCommit: git(['rev-parse', 'HEAD']),
    sourceTree: git(['rev-parse', 'HEAD^{tree}']), tarballSha256: null,
    files: Object.fromEntries(paths.map(rel => [rel, digest(fs.readFileSync(path.join(root, rel)))])) };
}

test('the generated canonical consumer preserves evidence, draft readback, and read-only assessment', t => {
  const fixture = createFixtureWorkspace(entry);
  t.after(fixture.cleanup);
  const workspace = fixture.workspace;
  const initialized = spawnSync('git', ['init', '--quiet'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(initialized.status, 0, initialized.stderr);
  const canonicalBefore = fileDigests(workspace);
  const dashboard = cli(workspace, ['knowledge', 'dashboard']);
  let session = cli(workspace, ['knowledge', 'session', 'start'], { requestId: randomUUID(), flow: 'apply',
    questionId: 'loan', snapshot: dashboard.snapshot, author: 'Invented example test; no human acceptance' });
  const id = session.record.id;
  for (const [type, extra] of [['answer', { text: 'The inspection has not passed. Obtain the cap and record a new check.' }],
    ['propose', { text: 'This telescope has not passed its inspection. Obtain the cap and record a new inspection before deciding on a loan.' }],
    ['confirm', {}], ['save', {}]]) {
    session = cli(workspace, ['knowledge', 'session', 'event'], { sessionId: id,
      event: { id: randomUUID(), expectedRevision: session.state.revision, type, ...extra } });
  }
  assert.equal(session.state.saved.length, 1);
  const beforeAssessment = fileDigests(workspace);
  for (const [file, sha] of Object.entries(canonicalBefore)) assert.equal(beforeAssessment[file], sha, file);
  const binding = repositoryBinding();
  const reader = createCliReader({ entry, binding });
  const capture = reader.collect(workspace);
  const report = assessCapture(capture, summarizeMeasurements([]));
  assert.equal(report.summary.fail, 0);
  assert.equal(capture.packageBinding.kind, 'repository');
  assert.equal(capture.packageBinding.tarballSha256, null);
  assert.equal(capture.sessions.complete, true);
  assert.equal(capture.sessions.items.length, 1);
  assert.equal(capture.sessions.items[0].receiptMatches, true);
  assert.equal(capture.sessions.items[0].sourceEditsApplied, false);
  assert.equal(capture.sessions.items[0].current, true);
  for (const code of ['LOCAL.SEMANTIC_QUALITY', 'LOCAL.TASK_COST', 'LOCAL.HOST_PERMISSIONS'])
    assert.equal(report.findings.find(f => f.code === code).status, 'unknown');
  const bindingPath = path.join(path.dirname(workspace), 'receiving-binding.json');
  fs.writeFileSync(bindingPath, JSON.stringify(binding));
  const assessed = spawnSync(process.execPath, [path.join(root, 'examples/knowledge-ontology-profile/tools/assess.mjs'),
    '--atelier-entry', entry, '--binding', bindingPath, '--workspace', workspace],
    { cwd: workspace, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(assessed.status, 0, assessed.stderr);
  const toolOutput = JSON.parse(assessed.stdout);
  assert.equal(toolOutput.report.summary.fail, 0);
  assert.equal(toolOutput.capture.packageBinding.kind, 'repository');
  assert.equal(toolOutput.capture.sessions.items[0].receiptMatches, true);
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'examples/knowledge-ontology-profile/profiles/equipment-loans-reference/profile.json')));
  const pins = JSON.parse(fs.readFileSync(path.join(root, 'examples/knowledge-ontology-profile/profiles/equipment-loans-reference/sources.json'))).sourceDigests;
  const ordinary = reader.read(workspace, ['knowledge', 'context', '--question', profile.questions[0].question, '--mode', 'graph']);
  assert.equal(ordinary.status, 'evidence-selected');
  assert.deepEqual(ordinary.sources.map(s => s.id), profile.questions[0].expectedSourceIds);
  for (const s of ordinary.sources) {
    assert.equal(digest(Buffer.from(s.text)), s.sha256);
    assert.equal(s.sha256, pins[`${s.repo}/${s.path}`]);
  }
  assert.match(ordinary.sources.find(s => s.id === 'loan:inspection').text, /\*\*not\*\* passed/);
  assert.deepEqual(ordinary.relations, [{ source: 'loan:blue-telescope', predicate: 'depends_on', target: 'loan:inspection' }]);
  const missing = reader.read(workspace, ['knowledge', 'context', '--question', profile.questions[1].question, '--mode', 'graph']);
  assert.equal(missing.status, 'needs-evidence');
  assert.deepEqual(missing.sources, []);
  assert.deepEqual(missing.relations, []);
  assert.equal(missing.budget.providerCalls, 0);
  assert.deepEqual(fileDigests(workspace), beforeAssessment);
  createCliReader({ entry, binding }); // Reverify the selected CLI closure after reads.
  assert.equal(fs.existsSync(path.join(root, 'examples/knowledge-ontology-profile/workspace')), false);
});
