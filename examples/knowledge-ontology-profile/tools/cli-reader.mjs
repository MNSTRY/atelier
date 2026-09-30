// Uses a selected installed or repository entry point only. No unpublished imports, CLI
// discovery, runtime copies, session writes, provider calls, or source fixes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { summarizeSession } from './assessment-core.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function createCliReader({ entry, binding }) {
  const repository = binding?.schema === 'atelier-profile-repository-binding/local-v1';
  const installed = binding?.schema === 'atelier-profile-install-binding/local-v1';
  if (!path.isAbsolute(entry) || !(repository || installed) ||
      !/^[a-f0-9]{40}$/.test(binding.sourceCommit ?? '') || !/^[a-f0-9]{40}$/.test(binding.sourceTree ?? '') ||
      !(repository ? binding.tarballSha256 === null : sha(binding.tarballSha256)) || !binding.files || !Object.hasOwn(binding.files, 'bin/atelier.mjs') ||
      !Object.hasOwn(binding.files, 'package.json')) throw new Error('An explicit Atelier entry and declared source/package binding are required.');
  const root = fs.realpathSync(path.dirname(path.dirname(entry)));
  if (fs.realpathSync(entry) !== path.join(root, 'bin', 'atelier.mjs')) throw new Error('Entry must be the selected Atelier bin.');
  for (const [rel, expected] of Object.entries(binding.files)) {
    if (!sha(expected) || path.isAbsolute(rel) || rel.split(/[\\/]/).some(p => !p || p === '..' || p === '.')) throw new Error('Invalid installed-file binding.');
    const file = path.join(root, rel);
    if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile() || digest(fs.readFileSync(file)) !== expected)
      throw new Error(`CLI file differs from receiving binding: ${rel}`);
  }
  function read(workspace, words, input) {
    const key = JSON.stringify(words);
    const fixed = ['check', 'dashboard', 'evaluate'].some(op => key === JSON.stringify(['knowledge', op]));
    const list = key === JSON.stringify(['knowledge', 'session', 'list']);
    const session = key === JSON.stringify(['knowledge', 'session', 'read']);
    const context = words.length === 6 && words[0] === 'knowledge' && words[1] === 'context' && words[2] === '--question' &&
      typeof words[3] === 'string' && words[3].length > 0 && words[3].length <= 2000 && words[4] === '--mode' && ['graph', 'lexical'].includes(words[5]);
    if (!(fixed || list || session || context) || (!session && input !== undefined) ||
        (session && (!input || Object.keys(input).length !== 1 || !/^[A-Za-z0-9._-]{1,128}$/.test(input.sessionId ?? ''))))
      throw new Error('Only the declared read operations and bounded session identity are supported.');
    const result = spawnSync(process.execPath, [entry, ...words], { cwd: workspace, input: input === undefined ? undefined : JSON.stringify(input),
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Atelier read unavailable: ${(result.stderr || result.stdout).trim().slice(0, 1000)}`);
    return JSON.parse(result.stdout);
  }
  function collect(workspace) {
    const dashboard = read(workspace, ['knowledge', 'dashboard']);
    const sessions = { listed: 0, descriptorCount: 0, complete: false, items: [], error: null, truncated: null };
    try {
      const list = read(workspace, ['knowledge', 'session', 'list']);
      if (list?.ok !== true || !Array.isArray(list.sessions)) throw new Error('Invalid session list.');
      sessions.descriptorCount = list.sessions.length;
      sessions.listed = Number.isSafeInteger(list.total) && list.total >= list.sessions.length ? list.total : list.sessions.length;
      sessions.truncated = typeof list.truncated === 'boolean' ? list.truncated : null;
      for (const s of list.sessions.slice(0, 20)) {
        try { sessions.items.push(summarizeSession(read(workspace, ['knowledge', 'session', 'read'], { sessionId: s.id }))); }
        catch { sessions.error = 'An exact session was unavailable; inspect through its owner.'; }
      }
      sessions.complete = sessions.truncated === false && Number.isSafeInteger(list.total) &&
        list.total === sessions.items.length && !sessions.error;
      if (sessions.truncated === null) sessions.error = 'This package does not declare list truncation; coverage remains unknown.';
    } catch { sessions.error = 'Session history could not be inspected; it is not an empty success.'; }
    const final = read(workspace, ['knowledge', 'dashboard']);
    return { schema: 'atelier-enablement-capture/local-v1', observedAt: new Date().toISOString(), runtimeCandidate: binding.sourceCommit,
      packageBinding: { kind: repository ? 'repository' : 'installed-package', sourceCommit: binding.sourceCommit, sourceTree: binding.sourceTree, tarballSha256: binding.tarballSha256,
        installedFilesVerified: Object.keys(binding.files).length, authority: 'Receiving-owner supplied binding and local file verification; not authenticated host authority.' },
      dashboard, finalSnapshot: final.snapshot, consistent: final.snapshot === dashboard.snapshot, sessions,
      source: 'Selected Atelier CLI reads; no unpublished imports; saved wording omitted, receipt digests retained.' };
  }
  return { read, collect };
}
