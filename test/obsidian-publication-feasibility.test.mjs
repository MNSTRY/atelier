import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildEvalCode, validatePayload } from '../experiments/obsidian-publication/lib/bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = 'a'.repeat(64);
const publish = (overrides = {}) => ({ op: 'publish', path: 'notes/Example.md', baseSha256: digest, candidateSha256: digest,
  stagedPath: '/tmp/staged.md', recoveryLinkPath: '/tmp/prev.md', guardMs: 100, haltAt: 'none', exchange: 'atomic-swap', ...overrides });

test('bridge payload accepts only the closed publish and inspect shapes', () => {
  assert.doesNotThrow(() => validatePayload(publish()));
  assert.doesNotThrow(() => validatePayload({ op: 'inspect', path: 'notes/Example.md' }));
  for (const bad of [
    publish({ code: 'app.vault.delete()' }),
    publish({ op: 'eval' }),
    publish({ path: '../outside.md' }),
    publish({ path: '/absolute.md' }),
    publish({ path: '.obsidian/app.md' }),
    publish({ path: 'notes/Example.txt' }),
    publish({ baseSha256: 'not-a-digest' }),
    publish({ stagedPath: 'relative/staged.md' }),
    publish({ guardMs: 60000 }),
    publish({ haltAt: 'whenever' }),
    publish({ exchange: 'overwrite-in-place' }),
    { op: 'inspect', path: 'notes/Example.md', stagedPath: '/tmp/x' },
  ]) assert.throws(() => validatePayload(bad), TypeError);
});

test('note-controlled text can never become bridge code', () => {
  const hostile = "notes/');process.exit(1);('.md";
  const code = buildEvalCode({ op: 'inspect', path: hostile });
  assert.ok(!code.includes('process.exit(1)'), 'payload text must not appear in executable position');
  const encoded = /atob\('([A-Za-z0-9+/=]+)'\)/.exec(code);
  assert.ok(encoded, 'payload travels as one base64 literal');
  assert.deepEqual(JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')), { op: 'inspect', path: hostile });
  const fixed = (payload) => buildEvalCode(payload).replace(/atob\('[A-Za-z0-9+/=]+'\)/, 'atob()');
  assert.equal(fixed({ op: 'inspect', path: 'notes/A.md' }), fixed(publish()), 'script body is constant across payloads');
});

// The real-app proof is opt-in: it opens a desktop application. Skipping it
// leaves G00 open; only a receipt from an actual run can close the gate.
test('real isolated Obsidian instance preserves every supported interleaving', { skip: process.env.ATELIER_OBSIDIAN_G00 !== '1' && 'set ATELIER_OBSIDIAN_G00=1 on a desktop host with Obsidian installed', timeout: 1800000 }, () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-g00-receipt-')), 'G00.json');
  const run = spawnSync(process.execPath, [path.join(root, 'experiments/obsidian-publication/run-g00.mjs'), '--out', out, '--races', process.env.ATELIER_OBSIDIAN_G00_RACES || '20'], { encoding: 'utf8' });
  const receipt = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(receipt.fatal, null, receipt.fatal || '');
  assert.deepEqual(receipt.results.filter((result) => !result.pass).map((result) => result.id), [], run.stdout);
  assert.deepEqual(receipt.notCovered, [], 'every architecture interleaving must be exercised before G00 can close');
});
