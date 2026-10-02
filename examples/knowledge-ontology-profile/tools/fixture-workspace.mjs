// Test-only fixture construction through the repository's canonical init CLI.
// No copied workspace, graph builder, context selector, session, or admission engine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { localCliEnvironment } from './local-process.mjs';

export function createFixtureWorkspace(entry) {
  if (!path.isAbsolute(entry) || !fs.statSync(entry).isFile()) throw new Error('Select the repository Atelier CLI entry.');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-ontology-example-'));
  const workspace = path.join(temporary, 'workspace');
  try {
    const initialized = spawnSync(process.execPath, [entry, 'init', '--template', 'knowledge-workspace', '--target', workspace],
      { cwd: temporary, env: localCliEnvironment(), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
    if (initialized.error || initialized.status !== 0) throw new Error('Canonical knowledge-workspace initialization failed.');
    return { workspace, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
}
