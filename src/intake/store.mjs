import { withPrivateLock, publishPrivateFile, isPendingPrivateWrite } from '../project/durable-state.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalize } from '../attestation/jcs.mjs';
import { validateJsonSchema } from '../export/atelier-export-contract.mjs';
import { ensureContainedPrivateDirectory, openRegularFileNoFollow } from '../project/private-state.mjs';
import { registerIntakeReadScope } from './read-scope.mjs';

export const INTAKE_MAX_BYTES = 16 * 1024 * 1024;
const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-intake.v1.schema.json', import.meta.url), 'utf8'));
export function validateIntakeDocument(value) { return validateJsonSchema(schema, value); }
function valid(value) { if (validateIntakeDocument(value).length) throw new Error('invalid intake document'); return value; }
export function intakeDigest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
const digestPattern = /^[0-9a-f]{64}$/;
function digest(value) { if (!digestPattern.test(value ?? '')) throw new Error('invalid content digest'); return value; }
function id(value) { if (!idPattern.test(value ?? '')) throw new Error('invalid intake identifier'); return value; }
function read(file) {
  const fd = openRegularFileNoFollow(file);
  try {
    if (fs.fstatSync(fd).size > INTAKE_MAX_BYTES) throw new Error('intake byte ceiling exceeded');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > INTAKE_MAX_BYTES) throw new Error('intake byte ceiling exceeded');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function immutable(file, bytes) {
  publishPrivateFile(file, bytes);
  if (!read(file).equals(Buffer.from(bytes))) throw new Error('immutable intake readback mismatch');
}

// Local integrity storage, not a worker, semantic acceptance service, or import
// authority. Callers retain their source trees and choose their existing extractor.
export function createIntakeStore({ workspaceRoot = process.cwd() } = {}) {
  const root = fs.realpathSync(workspaceRoot);
  let readScopeActive = false, placementChecked = false;
  function placement(force = false) {
    if (readScopeActive && placementChecked && !force) return;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    try {
      if (execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '.atelier-local'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) throw new Error('tracked state');
      execFileSync('git', ['-C', root, 'check-ignore', '--quiet', '.atelier-local/'], { env, stdio: 'ignore' });
    } catch { throw new Error('intake requires ignored, untracked .atelier-local/ in a Git workspace'); }
    placementChecked = readScopeActive;
  }
  placement();
  function readScope(read) {
    const active = readScopeActive;
    readScopeActive = true; placementChecked = false;
    try {
      placement();
      const result = read();
      // Result inspection must not pass admission to a thenable's accessor,
      // and asynchronous work must obtain fresh admission after it resumes.
      readScopeActive = false; placementChecked = false;
      if (typeof result?.then === 'function') throw new Error('intake read scope requires a synchronous result');
      // No result escapes if placement changed during the read-only operation.
      placement(true);
      return result;
    } finally { readScopeActive = active; placementChecked = false; }
  }
  function directory(...parts) {
    return ensureContainedPrivateDirectory({ workspaceRoot: root, directory: path.join(root, '.atelier-local', 'intake', ...parts), label: 'intake state' });
  }
  function locked(fn) {
    // A mutation cannot inherit or leave behind read-scope admission.
    const active = readScopeActive;
    readScopeActive = false; placementChecked = false;
    try {
      placement();
      const file = path.join(directory(), 'operation.lock');
      return withPrivateLock(file, fn);
    } finally { readScopeActive = active; placementChecked = false; }
  }
  function sourceFile(ref) {
    if (typeof ref !== 'string' || !ref || path.isAbsolute(ref) || ref.includes('\\') ||
      ref.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error('source must be a visible workspace-relative file');
    let file = root;
    for (const part of ref.split('/')) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('redirected intake source refused');
    }
    return file;
  }
  function blob(blobId) {
    const bytes = read(path.join(directory('blobs'), digest(blobId)));
    if (intakeDigest(bytes) !== blobId) throw new Error('stored blob digest mismatch');
    return bytes;
  }
  function record(dir, name, value) { valid(value); immutable(path.join(dir, name), canonicalize(value) + '\n'); return value; }
  const store = Object.freeze({
    // Explicit current-source reads stay behind intake's containment and byte
    // checks. They do not enroll a source or interpret its contents.
    readSource({ ref, expectedDigest } = {}) {
      placement();
      if (expectedDigest !== undefined) digest(expectedDigest);
      const bytes = read(sourceFile(ref)), actual = intakeDigest(bytes);
      if (expectedDigest !== undefined && actual !== expectedDigest) throw Object.assign(new Error('current source digest differs'), { code: 'INTAKE_SOURCE_CHANGED' });
      return { ref, digest: actual, bytes };
    },
    // A missing directory is a cache miss. A broken committed attempt is an
    // integrity failure, never permission to overwrite or retry it silently.
    readAttempt(attemptId) {
      placement(); id(attemptId);
      const dir = path.join(directory('attempts'), attemptId);
      try { fs.lstatSync(dir); }
      catch (error) { if (error.code === 'ENOENT') return { status: 'absent', attempt: null, completion: null, output: null }; throw error; }
      directory('attempts', attemptId);
      try {
        const names = fs.readdirSync(dir).filter(name => !isPendingPrivateWrite(name));
        if (names.some(name => !['attempt.json', 'completion.json', 'output.txt'].includes(name))) throw new Error('unknown attempt file');
        if (!names.includes('attempt.json')) {
          if (names.length) throw new Error('orphaned attempt bytes');
          return { status: 'absent', attempt: null, completion: null, output: null };
        }
        const attemptBytes = read(path.join(dir, 'attempt.json')), attempt = valid(JSON.parse(attemptBytes));
        if (attempt.schema !== 'mnstry.atelier-intake-attempt@v1' || attempt.attemptId !== attemptId) throw new Error('attempt identity differs');
        blob(attempt.blobId);
        const outputBytes = names.includes('output.txt') ? read(path.join(dir, 'output.txt')) : null;
        const output = outputBytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(outputBytes);
        if (!names.includes('completion.json')) return { status: output === null ? 'begun' : 'partial', attempt, completion: null, output };
        const completion = valid(JSON.parse(read(path.join(dir, 'completion.json'))));
        if (completion.schema !== 'mnstry.atelier-intake-completion@v1' || completion.attemptId !== attemptId ||
          completion.integrity !== 'verified' || completion.semanticAcceptance !== 'pending' || outputBytes === null ||
          completion.attemptDigest !== intakeDigest(attemptBytes) || completion.outputDigest !== intakeDigest(outputBytes) || completion.bytes !== outputBytes.length) throw new Error('completion integrity differs');
        return { status: 'complete', attempt, completion, output };
      } catch { throw Object.assign(new Error('intake attempt integrity refused'), { code: 'INTAKE_INTEGRITY' }); }
    },
    ingest({ ref, expectedDigest }) {
      return locked(() => {
        digest(expectedDigest);
        const file = sourceFile(ref), bytes = read(file);
        if (intakeDigest(bytes) !== expectedDigest) throw new Error('source digest mismatch');
        immutable(path.join(directory('blobs'), expectedDigest), bytes);
        if (intakeDigest(read(sourceFile(ref))) !== expectedDigest) throw new Error('source changed during intake');
        const manifest = { schema: 'mnstry.atelier-intake-source@v1', sourceRef: ref, blobId: expectedDigest, bytes: bytes.length, originalMutation: false };
        return record(directory('sources'), intakeDigest(canonicalize(manifest)) + '.json', manifest);
      });
    },
    beginAttempt({ attemptId, blobId, extractorId, extractorVersion, configurationDigest }) {
      return locked(() => {
        id(attemptId); id(extractorId); digest(configurationDigest); blob(blobId);
        if (typeof extractorVersion !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(extractorVersion)) throw new Error('invalid extractor version');
        const manifest = { schema: 'mnstry.atelier-intake-attempt@v1', attemptId, blobId, extractorId, extractorVersion, configurationDigest };
        return record(directory('attempts', attemptId), 'attempt.json', manifest);
      });
    },
    completeAttempt({ attemptId, output, expectedOutputDigest }) {
      return locked(() => {
        id(attemptId); digest(expectedOutputDigest);
        if (typeof output !== 'string' || Buffer.byteLength(output) > INTAKE_MAX_BYTES) throw new Error('output must be bounded UTF-8 text');
        if (intakeDigest(output) !== expectedOutputDigest) throw new Error('output digest mismatch');
        const dir = directory('attempts', attemptId);
        const attemptBytes = read(path.join(dir, 'attempt.json'));
        const attempt = valid(JSON.parse(attemptBytes));
        if (attempt.attemptId !== attemptId || attempt.schema !== 'mnstry.atelier-intake-attempt@v1') throw new Error('attempt identity mismatch');
        blob(attempt.blobId);
        immutable(path.join(dir, 'output.txt'), output);
        // Completion is written last. A crash before it is incomplete, not success.
        return record(dir, 'completion.json', { schema: 'mnstry.atelier-intake-completion@v1', attemptId,
          attemptDigest: intakeDigest(attemptBytes), outputDigest: expectedOutputDigest, bytes: Buffer.byteLength(output),
          integrity: 'verified', semanticAcceptance: 'pending' });
      });
    },
    readCompletion(attemptId) {
      placement(); id(attemptId);
      const dir = directory('attempts', attemptId), receipt = valid(JSON.parse(read(path.join(dir, 'completion.json'))));
      if (receipt.schema !== 'mnstry.atelier-intake-completion@v1' || receipt.attemptId !== attemptId ||
        receipt.integrity !== 'verified' || receipt.semanticAcceptance !== 'pending') throw new Error('invalid completion receipt');
      const attemptBytes = read(path.join(dir, 'attempt.json')), output = read(path.join(dir, 'output.txt'));
      if (intakeDigest(attemptBytes) !== receipt.attemptDigest || intakeDigest(output) !== receipt.outputDigest || output.length !== receipt.bytes) throw new Error('completion integrity mismatch');
      const attempt = valid(JSON.parse(attemptBytes));
      if (attempt.attemptId !== attemptId || attempt.schema !== 'mnstry.atelier-intake-attempt@v1') throw new Error('attempt identity mismatch');
      blob(attempt.blobId);
      return receipt;
    },
  });
  registerIntakeReadScope(store, readScope);
  return store;
}
