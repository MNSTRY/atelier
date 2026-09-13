import { createHash } from 'node:crypto';
import { canonicalize } from '../attestation/jcs.mjs';

// Experimental adapter seam. This reducer performs no storage or authorization.
export const COAUTHOR_SESSION_VERSION = 'atelier-coauthor-session/experimental-v1';
export function contentDigest(text) {
  if (typeof text !== 'string') throw new TypeError('text required');
  if (Buffer.from(text, 'utf8').toString('utf8') !== text) throw new TypeError('text must be lossless UTF-8');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
const digestPattern = /^[a-f0-9]{64}$/;
function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100000) {
    throw new TypeError(`${label} required and bounded`);
  }
}
function sourceCheck(source) {
  if (!source || typeof source !== 'object') throw new TypeError('source required');
  requireText(source.ref, 'source ref');
  if (!digestPattern.test(source.digest)) throw new TypeError('source digest required');
}
export function createSession({ id, fields }) {
  requireText(id, 'session id');
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 1000) throw new TypeError('fields required');
  const ids = new Set();
  const targets = fields.map(({ id: fieldId, source }) => {
    requireText(fieldId, 'field id');
    if (ids.has(fieldId)) throw new Error('duplicate field');
    ids.add(fieldId);
    sourceCheck(source);
    return { id: fieldId, source: { ref: source.ref, digest: source.digest } };
  });
  return { version: COAUTHOR_SESSION_VERSION, id, revision: 0, phase: 'input', index: 0,
    fields: targets, answers: [], proposal: null, saved: [], pending: null, events: [] };
}
function checkEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('event required');
  requireText(event.id, 'event id');
  if (!Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 0) throw new TypeError('revision required');
  const keys = {
    answer: ['text', 'continueAfterSave'], propose: ['text'], confirm: [], reject: [],
    save: [], receipt: ['receipt'], failed: [], retry: [], advance: [], pause: [], resume: [],
  }[event.type];
  if (!keys || Object.keys(event).some(key => !['id', 'type', 'expectedRevision', ...keys].includes(key))) {
    throw new TypeError('unknown event or field');
  }
  if (['answer', 'propose'].includes(event.type)) requireText(event.text, 'answer text');
  if (event.continueAfterSave !== undefined && typeof event.continueAfterSave !== 'boolean') throw new TypeError('continue must be boolean');
  if (event.type === 'receipt') {
    const r = event.receipt;
    if (!r || Object.keys(r).sort().join(',') !== 'fieldId,requestId,sessionId,sourceDigest,sourceRef,valueDigest') throw new TypeError('invalid receipt shape');
    for (const key of ['requestId', 'sessionId', 'fieldId', 'sourceRef']) requireText(r[key], key);
    for (const key of ['sourceDigest', 'valueDigest']) if (!digestPattern.test(r[key])) throw new TypeError('invalid receipt digest');
  }
}
function need(state, phases) {
  if (!phases.includes(state.phase)) throw new Error(`event refused in ${state.phase}`);
}
function writeEffect(state) {
  const field = state.fields[state.index];
  return { type: 'write-field', requestId: state.pending.requestId, sessionId: state.id,
    fieldId: field.id, sourceRef: field.source.ref, sourceDigest: field.source.digest,
    text: state.proposal.text, valueDigest: contentDigest(state.proposal.text) };
}
function advance(state) {
  state.index += 1;
  state.phase = state.index === state.fields.length ? 'complete' : 'input';
  state.proposal = null;
  state.pending = null;
}
export function transition(session, event) {
  // State is trusted adapter-owned memory. Rehydrate by replaying validated events,
  // not by accepting an arbitrary caller-supplied session snapshot.
  if (session?.version !== COAUTHOR_SESSION_VERSION) throw new Error('unsupported session');
  checkEvent(event);
  const fingerprint = contentDigest(canonicalize(event));
  const prior = session.events.find(item => item.id === event.id);
  if (prior) {
    if (prior.fingerprint !== fingerprint) throw new Error('event id conflict');
    return { session: structuredClone(session), effects: [], duplicate: true };
  }
  if (event.expectedRevision !== session.revision) throw new Error('stale revision');
  const state = structuredClone(session);
  const effects = [];
  switch (event.type) {
    case 'answer':
      need(state, ['input', 'draft']);
      state.answers.push({ eventId: event.id, fieldId: state.fields[state.index].id, text: event.text });
      state.proposal = { text: event.text, originalEventId: event.id, confirmed: true,
        continueAfterSave: event.continueAfterSave ?? false };
      state.phase = 'draft';
      break;
    case 'propose':
      need(state, ['draft']);
      // Every machine revision requires confirmation; no heuristic decides meaning.
      state.proposal.text = event.text;
      state.proposal.confirmed = false;
      state.phase = 'confirmation';
      break;
    case 'confirm':
      need(state, ['confirmation']);
      state.proposal.confirmed = true;
      state.phase = 'draft';
      break;
    case 'reject':
      need(state, ['confirmation']);
      state.proposal.text = state.answers.find(answer => answer.eventId === state.proposal.originalEventId).text;
      state.proposal.confirmed = true;
      state.phase = 'draft';
      break;
    case 'save':
      need(state, ['draft']);
      state.pending = { requestId: event.id, retries: 0 };
      state.phase = 'saving';
      effects.push(writeEffect(state));
      break;
    case 'failed':
      need(state, ['saving']);
      state.phase = 'recovery';
      break;
    case 'retry':
      need(state, ['recovery']);
      if (state.pending.retries >= 1) throw new Error('retry budget exhausted; adapter reconciliation required');
      state.pending.retries += 1;
      state.phase = 'saving';
      effects.push(writeEffect(state));
      break;
    case 'receipt': {
      need(state, ['saving', 'recovery']);
      const expected = writeEffect(state);
      for (const key of ['requestId', 'sessionId', 'fieldId', 'sourceRef', 'sourceDigest', 'valueDigest']) {
        if (event.receipt[key] !== expected[key]) throw new Error(`receipt mismatch: ${key}`);
      }
      state.saved.push({ fieldId: expected.fieldId, text: state.proposal.text, receipt: structuredClone(event.receipt) });
      state.phase = 'saved';
      state.pending = null;
      if (state.proposal.continueAfterSave) advance(state);
      break;
    }
    case 'advance':
      need(state, ['saved']);
      advance(state);
      break;
    case 'pause':
      need(state, ['input', 'draft', 'confirmation', 'saved', 'recovery']);
      state.resumePhase = state.phase;
      state.phase = 'paused';
      break;
    case 'resume':
      need(state, ['paused']);
      state.phase = state.resumePhase;
      delete state.resumePhase;
      break;
  }
  state.revision += 1;
  state.events.push({ id: event.id, fingerprint, event: structuredClone(event) });
  return { session: state, effects, duplicate: false };
}
export function replaySession(config, events) {
  return events.reduce((session, event) => transition(session, event).session, createSession(config));
}
