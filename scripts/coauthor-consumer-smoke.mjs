import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function verifyInstalledCoauthor({ installedRoot, consumerRoot }) {
  const workspace = path.join(fs.realpathSync(consumerRoot), 'coauthor-adapter');
  fs.mkdirSync(workspace);
  assert.equal(spawnSync('git', ['init', '--quiet', workspace]).status, 0);
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.atelier-local/\n');
  const skillCommand = args => spawnSync(process.execPath, [path.join(installedRoot, 'bin/atelier.mjs'), 'skills', 'sync', ...args], { cwd: workspace, encoding: 'utf8' });
  const preview = skillCommand(['--json']);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = JSON.parse(preview.stdout);
  const installed = skillCommand(['--apply', '--confirm', plan.planDigest, '--json']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).ok, true);
  const projected = path.join(workspace, '.agents/skills/atelier-guided-coauthor/SKILL.md');
  assert.equal(fs.readFileSync(projected, 'utf8'), fs.readFileSync(path.join(installedRoot, 'skills/codex/atelier-guided-coauthor/SKILL.md'), 'utf8'));
  fs.appendFileSync(projected, '\nLocal owner addition.\n');
  assert.equal(skillCommand(['--json']).status, 1);
  const { createIntakeStore, intakeDigest } = await import(pathToFileURL(path.join(installedRoot, 'src/intake/store.mjs')));
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'Synthetic intake');
  const intake = createIntakeStore({ workspaceRoot: workspace }), blobId = intakeDigest('Synthetic intake');
  intake.ingest({ ref: 'sample.txt', expectedDigest: blobId });
  intake.beginAttempt({ attemptId: 'sample', blobId, extractorId: 'text', extractorVersion: '1', configurationDigest: intakeDigest('{}') });
  intake.completeAttempt({ attemptId: 'sample', output: 'Synthetic derivative', expectedOutputDigest: intakeDigest('Synthetic derivative') });
  assert.equal(intake.readCompletion('sample').semanticAcceptance, 'pending');
  const { createGuideEngagement } = await import(pathToFileURL(path.join(installedRoot, 'src/guides/contracts.mjs')));
  assert.equal(createGuideEngagement({ schema: 'mnstry.atelier-guide-offer@v1', id: 'sample', guideId: 'sample-guide', capabilityIds: ['sample'], deliverableReview: 'required', commercialAuthority: false }).status, 'proposed');
  const source = 'An invented authoring packet.';
  fs.writeFileSync(path.join(workspace, 'packet.md'), source);
  const digest = createHash('sha256').update(source).digest('hex');
  const cli = (op, input, bin = 'atelier.mjs') => spawnSync(process.execPath,
    [path.join(installedRoot, 'bin', bin), 'coauthor', op],
    { cwd: workspace, input: JSON.stringify(input), encoding: 'utf8' });
  const good = (op, input, bin) => {
    const result = cli(op, input, bin);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).state;
  };
  const config = { id: 'sample', fields: [{ id: 'sample-answer', source: { ref: 'packet.md', digest } }] };
  good('start', { config });
  good('event', { sessionId: 'sample', event: { id: 'answer', expectedRevision: 0, type: 'answer', text: 'A retained answer.' } });
  const saved = good('event', { sessionId: 'sample', event: { id: 'save', expectedRevision: 1, type: 'save' } });
  assert.equal(saved.phase, 'saved');
  assert.deepEqual(good('read', { sessionId: 'sample' }, 'mnstry-atelier.mjs'), saved);
  assert.equal(fs.readFileSync(path.join(workspace, 'packet.md'), 'utf8'), source);
  assert.equal(cli('event', { sessionId: 'sample', event: { id: 'stale', expectedRevision: 0, type: 'advance' } }).status, 1);
  fs.writeFileSync(path.join(workspace, 'packet.md'), 'Revised source.');
  assert.equal(cli('event', { sessionId: 'sample', event: { id: 'changed', expectedRevision: saved.revision, type: 'advance' } }).status, 1);
  assert.deepEqual(good('read', { sessionId: 'sample' }), saved);
  assert.ok(fs.readFileSync(path.join(installedRoot, 'skills/codex/atelier-guided-coauthor/SKILL.md'), 'utf8').includes('private draft'));
  console.log('[coauthor:consumer] installed CLI save/reopen, stale/source refusal and skill availability passed');
}
