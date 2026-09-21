import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonicalize } from '../attestation/jcs.mjs';
import { createIntakeStore, intakeDigest, INTAKE_MAX_BYTES } from '../intake/store.mjs';
import { ensureContainedPrivateDirectory, openRegularFileNoFollow } from '../project/private-state.mjs';
import { withPrivateLock, publishPrivateFile, createVerifiedFileSequence, isPendingPrivateWrite } from '../project/durable-state.mjs';
import { describeIngestionProcessor, extractIngestionEvidence } from './processors.mjs';
import { ingestionDigest, ingestionJson, validateIngestionValue, INGESTION_MAX_PLAN_BYTES, INGESTION_MAX_EVIDENCE_ITEMS } from './contracts.mjs';
export { ingestionDigest, validateIngestionValue } from './contracts.mjs';

const schema = kind => `mnstry.atelier-ingestion-${kind}@v1`;
const STATUS_NAMES = ['pending', 'complete', 'unsupported', 'unavailable', 'failed', 'budget-blocked', 'stale'];
function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
function valid(definition, value) {
  if (validateIngestionValue(definition, value).length) refuse('INGESTION_INVALID', 'ingestion document does not match its contract');
  return value;
}
function exactRequest(input, keys) {
  try { input = ingestionJson(input); } catch { refuse('INGESTION_INVALID', 'request must be bounded plain JSON'); }
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !keys.includes(key))) refuse('INGESTION_INVALID', 'request contains unknown fields');
  return input;
}
function same(left, right) { return canonicalize(left) === canonicalize(right); }
function seal(value) { return { ...value, digest: ingestionDigest(value) }; }
function readJson(file) {
  const fd = openRegularFileNoFollow(file);
  try {
    if (fs.fstatSync(fd).size > INGESTION_MAX_PLAN_BYTES) refuse('INGESTION_LIMIT', 'ingestion state byte ceiling exceeded');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > INGESTION_MAX_PLAN_BYTES) refuse('INGESTION_LIMIT', 'ingestion state byte ceiling exceeded');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { refuse('INGESTION_INTEGRITY', 'ingestion state contains invalid JSON'); }
  } finally { fs.closeSync(fd); }
}
function sourceReason(error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 'source-unavailable';
  if (error.code === 'INTAKE_SOURCE_CHANGED') return 'source-digest-changed';
  if (/ceiling/.test(error.message)) return 'source-byte-limit';
  if (/redirected|regular|relative/.test(error.message)) return 'source-reference-refused';
  return 'source-read-refused';
}
function failureReason(error) {
  if (error.code === 'INGESTION_LIMIT') return `processor-limit-${error.limitKind ?? 'output'}`;
  if (['INGESTION_INVALID_UTF8', 'INGESTION_INVALID_CSV', 'INGESTION_INVALID_JSON'].includes(error.code)) return error.code.toLowerCase().replaceAll('_', '-');
  if (['INTAKE_INTEGRITY', 'INGESTION_INTEGRITY'].includes(error.code)) return 'attempt-integrity-refused';
  return 'local-processing-refused';
}
function configuration(item, limits) { return { schema: schema('configuration'), processor: item.processor, limits }; }
function attemptIdentity(item, limits) {
  const configurationDigest = intakeDigest(canonicalize(configuration(item, limits)));
  const key = { sourceDigest: item.sourceDigest, configurationDigest };
  return { attemptId: `extract-${ingestionDigest(key).slice(7, 47)}`, configurationDigest };
}
function attemptInput(item, reservation) {
  return { attemptId: reservation.attemptId, blobId: item.sourceDigest, extractorId: item.processor.id, extractorVersion: item.processor.version, configurationDigest: reservation.configurationDigest };
}
function verifyAttempt(item, reservation, inspected) {
  if (inspected.status === 'absent') return;
  if (!same(inspected.attempt, { schema: 'mnstry.atelier-intake-attempt@v1', ...attemptInput(item, reservation) })) refuse('INGESTION_INTEGRITY', 'cached attempt identity differs');
}
function extractionFor(item, reservation, inspected) {
  verifyAttempt(item, reservation, inspected);
  if (inspected.status !== 'complete') refuse('INGESTION_INTEGRITY', 'attempt has no verified completion');
  let extraction;
  try { extraction = JSON.parse(inspected.output); } catch { refuse('INGESTION_INTEGRITY', 'cached extraction contains invalid JSON'); }
  valid('extraction', extraction);
  if (extraction.processor.id !== item.processor.id || extraction.processor.version !== item.processor.version || extraction.format !== item.processor.format || extraction.modality !== item.processor.modality ||
    extraction.coverage.total !== extraction.coverage.processed + extraction.coverage.omitted ||
    extraction.coverage.processed !== extraction.evidence.length || !extraction.coverage.complete || extraction.coverage.omitted !== 0 ||
    inspected.completion.bytes > reservation.limits.maxOutputBytes || extraction.evidence.length > reservation.limits.maxEvidenceItems) refuse('INGESTION_INTEGRITY', 'cached extraction bounds or coverage differ');
  return extraction;
}
function usageOf(state) {
  const reservations = [...state.reservations.values()], results = [...state.results.values()];
  return {
    inputBytes: reservations.reduce((sum, item) => sum + item.inputBytes, 0),
    outputBytes: results.reduce((sum, item) => sum + (item.outputBytes ?? 0), 0),
    attempts: reservations.length,
    failedAttempts: results.filter(item => state.reservations.get(item.sourceId) && ['failed', 'stale', 'budget-blocked'].includes(item.status)).length,
    cacheHits: results.filter(item => item.cacheReuse).length,
    unknownOutputItems: results.filter(item => item.outputBytes === null).length,
    pendingAttempts: reservations.filter(item => !state.results.get(item.sourceId)).length,
  };
}
function progressOf(items) {
  const byStatus = Object.fromEntries(STATUS_NAMES.map(status => [status, 0]));
  for (const item of items) byStatus[item.status]++;
  return { selected: items.length, settled: items.length - byStatus.pending, remaining: byStatus.pending, byStatus };
}
function disposition(item, status, reason, details = {}) {
  return { sourceId: item.id, status, reason, attemptId: null, cacheReuse: false, reconciled: false, outputBytes: 0, coverage: null, semanticAcceptance: 'pending', ...details };
}

// Intake owns all source and derived bytes. This coordinator persists only
// exact plans, charged reservations and item dispositions in private state.
export function createIngestionStore({ workspaceRoot = process.cwd(), workspaceId } = {}) {
  valid('id', workspaceId);
  const root = fs.realpathSync(workspaceRoot), intake = createIntakeStore({ workspaceRoot: root });
  function placement() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
    try {
      if (execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '.atelier-local'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) throw new Error('tracked');
      execFileSync('git', ['-C', root, 'check-ignore', '--quiet', '.atelier-local/'], { env, stdio: 'ignore' });
    } catch { refuse('INGESTION_PRIVATE', 'ingestion requires ignored, untracked .atelier-local/ in a Git workspace'); }
  }
  function directory(...parts) { return ensureContainedPrivateDirectory({ workspaceRoot: root, directory: path.join(root, '.atelier-local', 'ingestion', ...parts), label: 'ingestion state' }); }
  function existingDirectory(...parts) {
    const candidate = path.join(root, '.atelier-local', 'ingestion', ...parts);
    try { fs.lstatSync(candidate); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') refuse('INGESTION_MISSING', 'ingestion plan state is unavailable'); throw error; }
    return directory(...parts);
  }
  placement();
  const identityPath = path.join(directory(), 'workspace.json'), identity = { schema: schema('workspace'), workspaceId };
  withPrivateLock(path.join(directory(), 'operation.lock'), () => {
    if (fs.existsSync(identityPath)) {
      if (!same(valid('workspace', readJson(identityPath)), identity)) refuse('INGESTION_WORKSPACE', 'ingestion workspace identity differs');
    } else {
      const plans = path.join(directory(), 'plans');
      if (fs.existsSync(plans) && fs.readdirSync(plans).length) refuse('INGESTION_INTEGRITY', 'ingestion workspace identity is missing');
      publishPrivateFile(identityPath, canonicalize(identity) + '\n');
    }
  });
  function checkIdentity() {
    placement(); directory();
    if (!same(valid('workspace', readJson(identityPath)), identity)) refuse('INGESTION_WORKSPACE', 'ingestion workspace identity differs');
  }
  const readers = new Map();
  function load({ planId, planDigest } = {}) {
    checkIdentity(); valid('id', planId); valid('digest', planDigest);
    const planDir = existingDirectory('plans', planId), plan = valid('plan', readJson(path.join(planDir, 'plan.json')));
    const { planDigest: actualDigest, planId: actualId, ...body } = plan;
    if (actualId !== `plan-${ingestionDigest(body).slice(7, 47)}` || actualId !== planId || actualDigest !== ingestionDigest({ ...body, planId: actualId }) || actualDigest !== planDigest || plan.workspaceId !== workspaceId) refuse('INGESTION_STALE', 'plan identity or digest differs');
    const eventDir = existingDirectory('plans', planId, 'events');
    const names = fs.readdirSync(eventDir).filter(name => !isPendingPrivateWrite(name));
    if (names.length > plan.items.length * 2) refuse('INGESTION_INTEGRITY', 'ingestion journal exceeds its event bound');
    let totalBytes = 0;
    for (const name of names) {
      const size = fs.lstatSync(path.join(eventDir, name)).size;
      if (size > INGESTION_MAX_PLAN_BYTES) refuse('INGESTION_LIMIT', 'ingestion event byte ceiling exceeded');
      totalBytes += size;
    }
    if (totalBytes > 8 * 1024 * 1024) refuse('INGESTION_LIMIT', 'ingestion journal aggregate byte ceiling exceeded');
    if (!readers.has(planId)) readers.set(planId, createVerifiedFileSequence({ directory: eventDir,
      initial: () => ({ revision: 0, headDigest: null, reservations: new Map(), results: new Map() }),
      apply(text, state, index, name) {
        if (name !== `${String(index).padStart(4, '0')}.json`) refuse('INGESTION_INTEGRITY', 'ingestion history is not contiguous');
        let event; try { event = JSON.parse(text); } catch { refuse('INGESTION_INTEGRITY', 'ingestion history contains invalid JSON'); }
        valid('event', event);
        const { digest, ...eventBody } = event;
        if (event.planId !== planId || event.planDigest !== planDigest || event.revision !== index || event.previousDigest !== state.headDigest || digest !== ingestionDigest(eventBody)) refuse('INGESTION_INTEGRITY', 'ingestion history integrity differs');
        const record = event.record, item = plan.items.find(candidate => candidate.id === record.sourceId);
        if (!item || item.initialStatus !== 'pending' || state.results.get(item.id)) refuse('INGESTION_INTEGRITY', 'ingestion history has an invalid item transition');
        const usage = usageOf(state);
        if (event.type === 'reservation') {
          if (state.reservations.get(item.id) || usage.pendingAttempts || usage.unknownOutputItems || record.inputBytes !== item.inputBytes || usage.attempts >= plan.budget.maxAttempts || usage.inputBytes + record.inputBytes > plan.budget.maxInputBytes || record.limits.maxOutputBytes !== Math.min(INTAKE_MAX_BYTES, plan.budget.maxOutputBytes) || record.outputAllowance !== Math.min(INTAKE_MAX_BYTES, plan.budget.maxOutputBytes - usage.outputBytes)) refuse('INGESTION_INTEGRITY', 'ingestion reservation exceeds its plan');
          if (item.processor.supported) {
            if (!same(attemptIdentity(item, record.limits), { attemptId: record.attemptId, configurationDigest: record.configurationDigest }) || record.cacheState === 'unsupported') refuse('INGESTION_INTEGRITY', 'ingestion reservation identity differs');
          } else if (record.attemptId !== null || record.configurationDigest !== null || record.cacheState !== 'unsupported') refuse('INGESTION_INTEGRITY', 'unsupported reservation differs');
          state.reservations.set(item.id, record);
        } else {
          const reservation = state.reservations.get(item.id);
          if (['complete', 'unsupported', 'failed'].includes(record.status) && !reservation) refuse('INGESTION_INTEGRITY', 'disposition has no charged reservation');
          if (record.attemptId !== (reservation?.attemptId ?? null) || (!reservation && record.outputBytes !== 0) || (record.outputBytes !== null && record.outputBytes > (reservation?.outputAllowance ?? 0)) || (record.status === 'complete' && !item.processor.supported) || (record.status === 'unsupported' && item.processor.supported)) refuse('INGESTION_INTEGRITY', 'ingestion disposition differs from reservation');
          state.results.set(item.id, record);
        }
        state.revision = index; state.headDigest = event.digest; return state;
      },
    }));
    return { plan, state: readers.get(planId)(), eventDir };
  }
  function append(handle, type, record) {
    const event = seal({ schema: schema('event'), planId: handle.plan.planId, planDigest: handle.plan.planDigest, revision: handle.state.revision + 1, previousDigest: handle.state.headDigest, type, record });
    valid('event', event);
    const bytes = canonicalize(event) + '\n';
    if (Buffer.byteLength(bytes) > INGESTION_MAX_PLAN_BYTES) refuse('INGESTION_LIMIT', 'ingestion event byte ceiling exceeded');
    publishPrivateFile(path.join(handle.eventDir, `${String(event.revision).padStart(4, '0')}.json`), bytes);
    return load(handle.plan);
  }
  function statusFrom(handle) {
    const { plan, state } = handle;
    const items = plan.items.map(item => {
      const result = state.results.get(item.id) ?? disposition(item, item.initialStatus, state.reservations.get(item.id) ? 'reserved-awaiting-resume' : item.reason);
      const view = { ...item, ...result, integrity: 'not-checked', freshness: 'not-checked' };
      if (result.status === 'complete') {
        try {
          const inspected = intake.readAttempt(result.attemptId);
          const extracted = extractionFor(item, state.reservations.get(item.id), inspected);
          if (!same(extracted.coverage, result.coverage) || inspected.completion.bytes !== result.outputBytes) refuse('INGESTION_INTEGRITY', 'completed coverage differs');
          view.integrity = 'verified';
        } catch { view.status = 'failed'; view.reason = 'stored-evidence-integrity-refused'; view.integrity = 'refused'; }
      }
      return view;
    });
    const progress = progressOf(items);
    return { schema: schema('status'), plan, items, progress, usage: usageOf(state), complete: progress.byStatus.complete === items.length, settled: progress.remaining === 0, semanticAcceptance: 'pending', census: 'explicit-selection-only', accounting: 'reserved-processing-input-and-materialized-output; preflight-reads-excluded' };
  }
  function inspect(item, reservation) {
    const inspected = intake.readAttempt(reservation.attemptId); verifyAttempt(item, reservation, inspected); return inspected;
  }
  function outputAccounting(item, reservation) {
    if (reservation.attemptId === null) return 0;
    try {
      const inspected = inspect(item, reservation);
      const bytes = inspected.output === null ? 0 : Buffer.byteLength(inspected.output);
      return bytes <= reservation.outputAllowance ? bytes : null;
    } catch { return null; }
  }
  function processItem(handle, item) {
    let reservation = handle.state.reservations.get(item.id);
    let current;
    try { current = intake.readSource({ ref: item.ref, expectedDigest: item.sourceDigest }); }
    catch (error) { return append(handle, 'disposition', disposition(item, 'stale', sourceReason(error), { attemptId: reservation?.attemptId ?? null, outputBytes: reservation ? outputAccounting(item, reservation) : 0 })); }
    if (!same(describeIngestionProcessor(item.ref), item.processor)) return append(handle, 'disposition', disposition(item, 'stale', 'processor-version-changed', { attemptId: reservation?.attemptId ?? null, outputBytes: reservation ? outputAccounting(item, reservation) : 0 }));
    if (!reservation) {
      const usage = usageOf(handle.state);
      const blocked = usage.unknownOutputItems ? 'output-accounting-uncertain' : usage.pendingAttempts ? 'prior-reservation-unsettled' : usage.attempts >= handle.plan.budget.maxAttempts ? 'attempt-budget' : usage.inputBytes + item.inputBytes > handle.plan.budget.maxInputBytes ? 'input-byte-budget' : item.processor.supported && usage.outputBytes >= handle.plan.budget.maxOutputBytes ? 'output-byte-budget' : null;
      if (blocked) return append(handle, 'disposition', disposition(item, 'budget-blocked', blocked));
      const limits = { maxOutputBytes: Math.min(INTAKE_MAX_BYTES, handle.plan.budget.maxOutputBytes), maxEvidenceItems: INGESTION_MAX_EVIDENCE_ITEMS };
      const outputAllowance = Math.min(INTAKE_MAX_BYTES, handle.plan.budget.maxOutputBytes - usage.outputBytes);
      const attempt = item.processor.supported ? attemptIdentity(item, limits) : { attemptId: null, configurationDigest: null };
      let cacheState = 'unsupported';
      if (item.processor.supported) {
        try { const inspected = intake.readAttempt(attempt.attemptId); verifyAttempt(item, { ...attempt, limits }, inspected); cacheState = inspected.status; }
        catch { cacheState = 'corrupt'; }
      }
      reservation = { sourceId: item.id, inputBytes: item.inputBytes, ...attempt, limits, outputAllowance, cacheState };
      handle = append(handle, 'reservation', reservation);
    }
    if (reservation.cacheState === 'corrupt') return append(handle, 'disposition', disposition(item, 'failed', 'attempt-integrity-refused', { attemptId: reservation.attemptId, outputBytes: null }));
    try {
      intake.ingest({ ref: item.ref, expectedDigest: item.sourceDigest });
      if (!item.processor.supported) return append(handle, 'disposition', disposition(item, 'unsupported', 'unsupported-source-preserved', { coverage: { unit: 'source', total: 1, processed: 0, omitted: 1, complete: false, limitations: item.processor.limitations } }));
      let inspected = inspect(item, reservation);
      const reconciled = inspected.status !== 'absent' && reservation.cacheState !== 'complete';
      if (inspected.status !== 'complete') {
        intake.beginAttempt(attemptInput(item, reservation));
        const extraction = valid('extraction', extractIngestionEvidence({ ref: item.ref, bytes: current.bytes, limits: reservation.limits }));
        const output = canonicalize(extraction);
        if (Buffer.byteLength(output) > reservation.limits.maxOutputBytes) refuse('INGESTION_LIMIT', 'output budget exceeded');
        if (Buffer.byteLength(output) > reservation.outputAllowance) return append(handle, 'disposition', disposition(item, 'budget-blocked', 'output-byte-budget', { attemptId: reservation.attemptId }));
        if (inspected.output !== null && inspected.output !== output) refuse('INGESTION_INTEGRITY', 'interrupted output differs from deterministic extraction');
        intake.completeAttempt({ attemptId: reservation.attemptId, output, expectedOutputDigest: intakeDigest(output) });
        inspected = inspect(item, reservation);
      }
      const extraction = extractionFor(item, reservation, inspected);
      if (inspected.completion.bytes > reservation.outputAllowance) return append(handle, 'disposition', disposition(item, 'budget-blocked', 'output-byte-budget', { attemptId: reservation.attemptId }));
      try { intake.readSource({ ref: item.ref, expectedDigest: item.sourceDigest }); }
      catch (error) { return append(handle, 'disposition', disposition(item, 'stale', sourceReason(error), { attemptId: reservation.attemptId, outputBytes: inspected.completion.bytes })); }
      return append(handle, 'disposition', disposition(item, 'complete', 'structural-extraction-complete', { attemptId: reservation.attemptId, outputBytes: inspected.completion.bytes, cacheReuse: reservation.cacheState === 'complete', reconciled, coverage: extraction.coverage }));
    } catch (error) {
      // An uncertain final publication must be reconciled on the next call;
      // never append a contradictory failure over a possibly committed result.
      const recovered = load(handle.plan);
      if (recovered.state.results.get(item.id)) return recovered;
      try { intake.readSource({ ref: item.ref, expectedDigest: item.sourceDigest }); }
      catch (sourceError) { return append(recovered, 'disposition', disposition(item, 'stale', sourceReason(sourceError), { attemptId: reservation.attemptId, outputBytes: outputAccounting(item, reservation) })); }
      if (!['INGESTION_LIMIT', 'INGESTION_INVALID_UTF8', 'INGESTION_INVALID_CSV', 'INGESTION_INVALID_JSON', 'INGESTION_INVALID', 'INGESTION_INTEGRITY', 'INTAKE_INTEGRITY'].includes(error.code)) refuse('INGESTION_RETRY_REQUIRED', 'local publication was interrupted; charged reservation retained for explicit resume');
      return append(recovered, 'disposition', disposition(item, 'failed', failureReason(error), { attemptId: reservation.attemptId, outputBytes: outputAccounting(item, reservation) }));
    }
  }
  return Object.freeze({
    plan(input) {
      input = ingestionJson(input); valid('planInput', input);
      if (new Set(input.sources.map(source => source.id)).size !== input.sources.length) refuse('INGESTION_INVALID', 'source identifiers must be unique');
      return withPrivateLock(path.join(directory(), 'operation.lock'), () => {
        checkIdentity();
        const items = input.sources.map(source => {
          const processor = valid('processor', describeIngestionProcessor(source.ref));
          try {
            const current = intake.readSource({ ref: source.ref });
            return { ...source, sourceDigest: current.digest, inputBytes: current.bytes.length, processor, initialStatus: 'pending', reason: 'awaiting-explicit-run' };
          } catch (error) { return { ...source, sourceDigest: null, inputBytes: null, processor, initialStatus: 'unavailable', reason: sourceReason(error) }; }
        });
        const body = { schema: schema('plan'), workspaceId, createdAt: new Date().toISOString(), nonce: randomUUID(), scope: input.scope, purpose: input.purpose, budget: input.budget, items, census: 'explicit-selection-only', semanticAcceptance: 'pending' };
        const planId = `plan-${ingestionDigest(body).slice(7, 47)}`;
        const plan = valid('plan', { ...body, planId, planDigest: ingestionDigest({ ...body, planId }) });
        const bytes = canonicalize(plan) + '\n';
        if (Buffer.byteLength(bytes) > INGESTION_MAX_PLAN_BYTES) refuse('INGESTION_LIMIT', 'ingestion plan byte ceiling exceeded');
        directory('plans', planId, 'events');
        publishPrivateFile(path.join(directory('plans', planId), 'plan.json'), bytes);
        return plan;
      });
    },
    run(input = {}) {
      const { planId, planDigest, maxItems = 8 } = exactRequest(input, ['planId', 'planDigest', 'maxItems']);
      if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 128) refuse('INGESTION_INVALID', 'maxItems must be an integer from 1 to 128');
      return withPrivateLock(path.join(directory(), 'operation.lock'), () => {
        let handle = load({ planId, planDigest }), processed = 0;
        for (const item of handle.plan.items) {
          if (item.initialStatus !== 'pending' || handle.state.results.get(item.id)) continue;
          if (processed++ >= maxItems) break;
          handle = processItem(handle, item);
        }
        return statusFrom(handle);
      });
    },
    status(reference) { return statusFrom(load(exactRequest(reference, ['planId', 'planDigest']))); },
    query(input = {}) {
      const { planId, planDigest, query, limit = 20 } = exactRequest(input, ['planId', 'planDigest', 'query', 'limit']);
      if (typeof query !== 'string' || !query.trim() || query.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 100) refuse('INGESTION_INVALID', 'query requires bounded text and a limit from 1 to 100');
      const terms = query.toLowerCase().trim().split(/\s+/u);
      if (terms.length > 32) refuse('INGESTION_INVALID', 'query has too many terms');
      const handle = load({ planId, planDigest }), status = statusFrom(handle), hits = [], omissions = [];
      let matched = 0;
      for (const item of status.items) {
        if (item.status === 'complete') {
          try { intake.readSource({ ref: item.ref, expectedDigest: item.sourceDigest }); item.freshness = 'current'; }
          catch (error) { item.status = 'stale'; item.reason = sourceReason(error); item.freshness = 'stale'; }
        }
        if (item.status !== 'complete') { omissions.push({ sourceId: item.id, status: item.status, reason: item.reason }); continue; }
        try {
          const extraction = extractionFor(item, handle.state.reservations.get(item.id), intake.readAttempt(item.attemptId));
          for (const evidence of extraction.evidence) {
            if (!terms.every(term => evidence.text.toLowerCase().includes(term))) continue;
            matched++;
            if (hits.length < limit) hits.push({ sourceId: item.id, ref: item.ref, sourceDigest: item.sourceDigest, attemptId: item.attemptId, locator: evidence.locator, text: evidence.text });
          }
        } catch { item.status = 'failed'; item.reason = 'stored-evidence-integrity-refused'; omissions.push({ sourceId: item.id, status: item.status, reason: item.reason }); }
      }
      status.progress = progressOf(status.items); status.complete = status.progress.byStatus.complete === status.items.length; status.settled = status.progress.remaining === 0;
      return { schema: schema('query'), planId, planDigest, query, hits, matched, truncated: matched > hits.length, omissions, status, semanticAcceptance: 'pending', synthesized: false };
    },
  });
}
