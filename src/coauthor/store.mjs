import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalize } from '../attestation/jcs.mjs';
import { createCollaborationEventLedger } from '../collaboration/event-ledger.mjs';
import { ensureContainedPrivateDirectory, openRegularFileNoFollow, atomicReplacePrivateText } from '../project/private-state.mjs';
import { createSession, transition, contentDigest } from './session.mjs';
import { validateJsonSchema } from '../export/atelier-export-contract.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../../contracts/atelier-coauthor.v1.schema.json', import.meta.url), 'utf8'));
function validate(value, kind) {
  const errors = validateJsonSchema({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${kind}` }, value);
  if (errors.length) throw new Error(`invalid coauthor ${kind}`);
}

const MAX_SOURCE_BYTES = 1024 * 1024;
function readText(file) {
  const fd = openRegularFileNoFollow(file);
  try {
    if (fs.fstatSync(fd).size > MAX_SOURCE_BYTES) throw new Error('coauthor file exceeds byte limit');
    return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}
function sourcePath(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.includes('\\') || path.isAbsolute(ref) || ref.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) {
    throw new Error('source must be a visible workspace-relative file');
  }
  let current = root;
  for (const part of ref.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('redirected source refused');
  }
  return current;
}

// Local CLI boundary, not an authenticated multi-user service. Responses remain
// private drafts; this store never modifies a canonical source file.
export function createCoauthorStore({ workspaceRoot = process.cwd() } = {}) {
  const root = fs.realpathSync(workspaceRoot);
  function privatePlacement() {
    const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    try {
      const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '.atelier-local'], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (tracked) throw new Error('tracked private state');
      execFileSync('git', ['-C', root, 'check-ignore', '--quiet', '.atelier-local/'], { env: gitEnv, stdio: 'ignore' });
    } catch { throw new Error('coauthor requires a Git workspace with untracked, ignored .atelier-local/ state'); }
  }
  privatePlacement();
  const directory = () => ensureContainedPrivateDirectory({ workspaceRoot: root,
    directory: path.join(root, '.atelier-local', 'coauthor'), label: 'coauthor state' });
  const ledger = () => createCollaborationEventLedger({ workspaceRoot: root,
    ledgerPath: path.join(directory(), 'events.ndjson') });
  const aggregate = id => `coauthor-${contentDigest(id)}`;
  function locked(operation) {
    privatePlacement();
    const lockPath = path.join(directory(), 'operation.lock');
    const fd = openRegularFileNoFollow(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try { return operation(); }
    finally { fs.closeSync(fd); fs.unlinkSync(lockPath); }
  }
  function load(id) {
    const result = ledger().eventsFor(aggregate(id));
    if (!result.ok) throw new Error(result.error);
    if (!result.events.length) throw new Error('coauthor session not found');
    let state;
    let previous = null;
    let version = 0;
    let config;
    for (const record of result.events) {
      if (record.version !== ++version || record.payload.previousEventId !== previous) throw new Error('coauthor event chain is incomplete');
      if (version === 1) {
        if (record.type !== 'coauthor.started') throw new Error('coauthor start missing');
        config = record.payload.config;
        validate(config, 'config');
        if (config.id !== id) throw new Error('coauthor identity mismatch');
        state = createSession(config);
      } else {
        if (record.type !== 'coauthor.transition') throw new Error('unknown coauthor record');
        const next = transition(state, record.payload.event);
        if (next.duplicate) throw new Error('duplicate persisted transition');
        state = next.session;
      }
      previous = record.id;
    }
    return { state, config, version, previous };
  }
  function verifySources(config) {
    for (const field of config.fields) {
      if (contentDigest(readText(sourcePath(root, field.source.ref))) !== field.source.digest) throw new Error('source changed; preserve history and start a newly bound session');
    }
  }
  function append(id, current, event) {
    const next = transition(current.state, event);
    if (next.duplicate) return current;
    const result = ledger().append({ aggregateId: aggregate(id), expectedVersion: current.version,
      type: 'coauthor.transition', actor: 'local-harness', payload: { previousEventId: current.previous, event } });
    if (!result.ok) throw new Error(result.error);
    return { ...current, state: next.session, version: result.event.version, previous: result.event.id };
  }
  function reconcile(id, current) {
    if (!['saving', 'recovery'].includes(current.state.phase)) return current;
    verifySources(current.config);
    const state = current.state;
    const field = state.fields[state.index];
    const requestId = state.pending.requestId;
    const values = ensureContainedPrivateDirectory({ workspaceRoot: root,
      directory: path.join(directory(), 'values', contentDigest(id)), label: 'coauthor values' });
    const target = path.join(values, `${contentDigest(requestId)}.json`);
    const receipt = { sessionId: id, requestId, fieldId: field.id, sourceRef: field.source.ref,
      sourceDigest: field.source.digest, valueDigest: contentDigest(state.proposal.text) };
    const saved = { schema: 'atelier-coauthor-draft@v1', status: 'draft', text: state.proposal.text, receipt };
    validate(saved, 'draft');
    const bytes = canonicalize(saved);
    try {
      // Existing values are immutable. A retry only verifies identical bytes.
      try {
        fs.lstatSync(target);
        if (readText(target) !== bytes) throw new Error('saved draft differs from pending value');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        atomicReplacePrivateText(target, bytes);
      }
      if (readText(target) !== bytes) throw new Error('saved draft readback mismatch');
      verifySources(current.config);
    } catch (error) {
      if (state.phase === 'saving') append(id, current, {
        id: `failure-${contentDigest(requestId)}-${state.revision}`, expectedRevision: state.revision, type: 'failed',
      });
      throw error;
    }
    return append(id, current, { id: `receipt-${contentDigest(requestId)}`,
      expectedRevision: state.revision, type: 'receipt', receipt });
  }
  return {
    start(config) {
      return locked(() => {
        validate(config, 'config');
        const clean = createSession(config);
        const canonicalConfig = { id: clean.id, fields: clean.fields };
        verifySources(canonicalConfig);
        const current = ledger().eventsFor(aggregate(clean.id));
        if (!current.ok) throw new Error(current.error);
        if (current.events.length) {
          const existing = load(clean.id);
          if (canonicalize(existing.config) !== canonicalize(canonicalConfig)) throw new Error('session id already bound to another configuration');
          return existing.state;
        }
        const result = ledger().append({ aggregateId: aggregate(clean.id), expectedVersion: 0,
          type: 'coauthor.started', actor: 'local-harness', payload: { previousEventId: null, config: canonicalConfig } });
        if (!result.ok) throw new Error(result.error);
        return load(clean.id).state;
      });
    },
    read(id) { return load(id).state; },
    dispatch(id, event) {
      return locked(() => {
        if (['receipt', 'failed'].includes(event?.type)) throw new Error('receipt and failure events are store-owned');
        const current = load(id);
        verifySources(current.config);
        const next = append(id, current, event);
        // Duplicate historical events never cause repeated effects.
        if (next === current) return next.state;
        return ['save', 'retry'].includes(event.type) ? reconcile(id, next).state : next.state;
      });
    },
    recover(id) { return locked(() => {
      const current = load(id);
      // Paused and exhausted sessions require an explicit resume or operator
      // reconciliation. Never turn a read into another automatic write attempt.
      if (current.state.phase !== 'saving') return current.state;
      return reconcile(id, current).state;
    }); },
  };
}
