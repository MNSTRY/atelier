import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalize } from '../attestation/jcs.mjs';
import { withPrivateLock, publishPrivateFile, createVerifiedFileSequence, isPendingPrivateWrite } from '../project/durable-state.mjs';
import { ensureContainedPrivateDirectory, openRegularFileNoFollow } from '../project/private-state.mjs';
import { learningDigest, boundedLearningValue, validateLearningValue, LEARNING_MAX_BYTES, LEARNING_MAX_EVENTS, LEARNING_MAX_JOURNAL_BYTES, LEARNING_WITHDRAWAL_RESERVE_BYTES, LEARNING_WITHDRAWAL_RESERVE_EVENTS } from './contracts.mjs';
export { learningDigest, validateLearningInput, validateLearningValue } from './contracts.mjs';

const prefix = 'mnstry.atelier-learning-';
const schema = kind => `${prefix}${kind}@v1`;
function refuse(code, message) { throw Object.assign(new Error(message), { code }); }
function valid(definition, value) {
  const errors = validateLearningValue(definition, value);
  if (errors.length) refuse('LEARNING_INVALID', errors[0]);
  return value;
}
function seal(value) { return { ...value, digest: learningDigest(value) }; }
function unsealed(value) { const { digest, ...body } = value; return body; }
function same(left, right) { return canonicalize(left) === canonicalize(right); }
function latestDecision(state, lessonId) { return state.decisions.findLast(record => record.lessonId === lessonId); }
function lessonFor(state, lessonId, digest) {
  const lesson = state.lessons.find(record => record.id === lessonId);
  if (!lesson) refuse('LEARNING_MISSING', 'lesson does not exist');
  if (digest !== undefined && lesson.digest !== digest) refuse('LEARNING_STALE', 'lesson digest changed or does not match');
  return lesson;
}
function activationState(state, id) { return state.activationStates.find(record => record.activationId === id); }
function activeFor(state, lessonId, harnessId) {
  return state.activations.filter(record => record.lessonId === lessonId &&
    (harnessId === undefined || record.harnessId === harnessId) && activationState(state, record.id)?.status === 'active');
}
function initial(workspaceId) {
  return { schema: schema('snapshot'), workspaceId, revision: 0, observations: [], lessons: [], decisions: [], activations: [], withdrawals: [], activationStates: [], events: [], headDigest: null, journalBytes: 0 };
}
function common(state, actor, createdAt, kind, id) {
  return { schema: schema(kind), id, workspaceId: state.workspaceId, revision: state.revision + 1, actor, createdAt };
}
function generatedId(kind, requestId) { return `${kind}:${learningDigest(requestId).slice(7, 39)}`; }
function makeRecord(state, request, actor, createdAt) {
  const input = request.input, operation = request.operation;
  if (request.expectedRevision !== state.revision) refuse('LEARNING_STALE', 'learning revision changed; reload before deciding');
  if (['decide', 'activate', 'withdraw'].includes(operation) && actor.kind !== 'human') refuse('LEARNING_AUTHORITY', 'this operation requires an explicitly asserted local human actor');
  if (operation === 'capture') {
    if (state.observations.some(record => record.id === input.id)) refuse('LEARNING_DUPLICATE', 'observation identifier already exists');
    if (input.lessonId && lessonFor(state, input.lessonId).scope.project !== input.scope.project) refuse('LEARNING_SCOPE', 'observation and lesson projects differ');
    return seal({ ...common(state, actor, createdAt, 'observation', input.id), ...input });
  }
  if (operation === 'propose') {
    if (state.lessons.some(record => record.id === input.id)) refuse('LEARNING_DUPLICATE', 'lesson identifier already exists');
    const evidence = input.evidenceIds.map(id => {
      const record = state.observations.find(item => item.id === id);
      if (!record) refuse('LEARNING_MISSING', 'proposal evidence does not exist');
      if (record.scope.project !== input.scope.project) refuse('LEARNING_SCOPE', 'proposal evidence cannot cross projects');
      return { id: record.id, digest: record.digest };
    });
    if (input.supersedes) {
      const prior = lessonFor(state, input.supersedes);
      if (!same(prior.scope, input.scope) || prior.artifact.kind !== input.artifact.kind || prior.artifact.name !== input.artifact.name) refuse('LEARNING_SCOPE', 'replacement must retain the exact scope and artifact slot');
    }
    return seal({ ...common(state, actor, createdAt, 'lesson', input.id), ...input, artifact: seal(input.artifact), evidence });
  }
  if (operation === 'decide') {
    lessonFor(state, input.lessonId, input.lessonDigest);
    if (activeFor(state, input.lessonId).length) refuse('LEARNING_ACTIVE', 'withdraw active lesson before changing its decision');
    return seal({ ...common(state, actor, createdAt, 'decision', generatedId('decision', request.requestId)), ...input });
  }
  if (operation === 'activate') {
    const lesson = lessonFor(state, input.lessonId, input.lessonDigest);
    const decision = latestDecision(state, lesson.id);
    if (!decision || decision.id !== input.decisionId || decision.verdict !== 'accepted' || decision.lessonDigest !== lesson.digest) refuse('LEARNING_DECISION', 'activation requires the latest exact accepted decision');
    if (state.activations.some(record => record.id === input.id)) refuse('LEARNING_DUPLICATE', 'activation identifier already exists');
    if (activeFor(state, lesson.id, input.harnessId).length) refuse('LEARNING_ACTIVE', 'lesson is already active for this harness');
    if (state.activations.some(record => record.lessonId === lesson.id && record.harnessId === input.harnessId && activationState(state, record.id)?.status === 'superseded')) refuse('LEARNING_SUPERSEDED', 'superseded lesson requires a new reviewed proposal');
    if (lesson.supersedes) {
      const prior = lessonFor(state, lesson.supersedes);
      if (!same(prior.scope, lesson.scope)) refuse('LEARNING_SCOPE', 'replacement scope changed');
    }
    return seal({ ...common(state, actor, createdAt, 'activation', input.id), ...input, artifactDigest: lesson.artifact.digest });
  }
  const activation = state.activations.find(record => record.id === input.activationId);
  if (!activation) refuse('LEARNING_MISSING', 'activation does not exist');
  if (activationState(state, activation.id)?.status !== 'active') refuse('LEARNING_INACTIVE', 'activation is no longer active');
  return seal({ ...common(state, actor, createdAt, 'withdrawal', generatedId('withdrawal', request.requestId)), ...input });
}
function applyEvent(event, state) {
  const operation = event.request.operation, record = event.record;
  const target = { capture: 'observations', propose: 'lessons', decide: 'decisions', activate: 'activations', withdraw: 'withdrawals' }[operation];
  state[target].push(record);
  if (operation === 'activate') {
    const lesson = lessonFor(state, record.lessonId);
    if (lesson.supersedes) {
      for (const prior of activeFor(state, lesson.supersedes, record.harnessId)) {
        Object.assign(activationState(state, prior.id), { status: 'superseded', eventId: event.id });
      }
    }
    state.activationStates.push({ activationId: record.id, status: 'active', eventId: event.id });
  }
  if (operation === 'withdraw') Object.assign(activationState(state, record.activationId), { status: 'withdrawn', eventId: event.id });
  state.events.push(event); state.revision = event.revision; state.headDigest = event.digest;
  return state;
}
function publicSnapshot(state) {
  const { events, headDigest, journalBytes, ...snapshot } = state;
  return structuredClone({ ...snapshot, headDigest });
}
function boundedRead(file) {
  const fd = openRegularFileNoFollow(file);
  try {
    if (fs.fstatSync(fd).size > LEARNING_MAX_BYTES * 3) refuse('LEARNING_LIMIT', 'learning journal byte ceiling exceeded');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > LEARNING_MAX_BYTES * 3) refuse('LEARNING_LIMIT', 'learning journal byte ceiling exceeded');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { fs.closeSync(fd); }
}

function readWorkspaceIdentity(file) {
  const text = boundedRead(file);
  let document;
  try { document = JSON.parse(text); } catch { refuse('LEARNING_HISTORY', 'learning workspace identity contains invalid JSON'); }
  return valid('workspace', document);
}

// Local integrity and lifecycle, not remote authentication, semantic truth,
// executable installation, or an authority to read provenance locations.
export function createLearningStore({ workspaceRoot = process.cwd(), workspaceId } = {}) {
  valid('id', workspaceId);
  const root = fs.realpathSync(workspaceRoot);
  function placement() {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    try {
      if (execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '.atelier-local'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) throw new Error('tracked');
      execFileSync('git', ['-C', root, 'check-ignore', '--quiet', '.atelier-local/'], { env, stdio: 'ignore' });
    } catch { refuse('LEARNING_PRIVATE', 'learning requires ignored, untracked .atelier-local/ in a Git workspace'); }
  }
  placement();
  function directory(...parts) {
    return ensureContainedPrivateDirectory({ workspaceRoot: root, directory: path.join(root, '.atelier-local', 'learning', ...parts), label: 'learning state' });
  }
  const stateDir = directory(), eventDir = directory('events');
  const identityPath = path.join(stateDir, 'workspace.json');
  const identity = { schema: schema('workspace'), workspaceId };
  withPrivateLock(path.join(stateDir, 'operation.lock'), () => {
    if (fs.existsSync(identityPath)) {
      const stored = readWorkspaceIdentity(identityPath);
      if (!same(stored, identity)) refuse('LEARNING_WORKSPACE', 'learning workspace identity differs');
    } else {
      if (fs.readdirSync(eventDir).filter(name => !isPendingPrivateWrite(name)).length) refuse('LEARNING_HISTORY', 'learning workspace identity is missing');
      publishPrivateFile(identityPath, canonicalize(identity) + '\n');
    }
  });
  const readSequence = createVerifiedFileSequence({
    directory: eventDir,
    initial: () => initial(workspaceId),
    apply(text, state, index, name) {
      if (name !== `${String(index).padStart(10, '0')}.json`) refuse('LEARNING_HISTORY', 'learning history is not contiguous');
      if (Buffer.byteLength(text) > LEARNING_MAX_BYTES * 3) refuse('LEARNING_LIMIT', 'learning journal byte ceiling exceeded');
      let event;
      try { event = JSON.parse(text); } catch { refuse('LEARNING_HISTORY', 'learning history contains invalid JSON'); }
      valid('event', event);
      if (event.workspaceId !== workspaceId || event.revision !== index || event.previousDigest !== state.headDigest || event.id !== `event:${index}` || event.digest !== learningDigest(unsealed(event))) refuse('LEARNING_HISTORY', 'learning history integrity mismatch');
      if (event.requestDigest !== learningDigest({ request: event.request, actor: event.actor })) refuse('LEARNING_HISTORY', 'learning request integrity mismatch');
      if (state.events.some(item => item.request.requestId === event.request.requestId)) refuse('LEARNING_HISTORY', 'learning history repeats a request');
      const expected = makeRecord(state, event.request, event.actor, event.createdAt);
      if (!same(expected, event.record)) refuse('LEARNING_HISTORY', 'learning record integrity mismatch');
      state.journalBytes += Buffer.byteLength(text);
      return applyEvent(event, state);
    },
  });
  function readState() {
    placement(); directory(); directory('events');
    if (!same(readWorkspaceIdentity(identityPath), identity)) refuse('LEARNING_WORKSPACE', 'learning workspace identity differs');
    const entries = fs.readdirSync(eventDir).filter(name => !isPendingPrivateWrite(name));
    if (entries.length > LEARNING_MAX_EVENTS) refuse('LEARNING_LIMIT', 'learning journal event ceiling exceeded');
    let totalBytes = 0;
    for (const name of entries) {
      const stat = fs.lstatSync(path.join(eventDir, name));
      if (stat.size > LEARNING_MAX_BYTES * 3) refuse('LEARNING_LIMIT', 'learning journal byte ceiling exceeded');
      totalBytes += stat.size;
      if (totalBytes > LEARNING_MAX_JOURNAL_BYTES) refuse('LEARNING_LIMIT', 'learning journal aggregate byte ceiling exceeded');
    }
    return readSequence();
  }
  readState();
  function snapshot() { return publicSnapshot(readState()); }
  function render({ lessonId, lessonDigest } = {}) {
    valid('id', lessonId); valid('digest', lessonDigest);
    const state = readState(), lesson = lessonFor(state, lessonId, lessonDigest);
    return { schema: schema('render'), lessonId, lessonDigest, artifact: structuredClone(lesson.artifact), status: latestDecision(state, lessonId)?.verdict ?? 'proposed', executable: false };
  }
  function context({ scope, harnessId } = {}) {
    valid('scope', scope); valid('id', harnessId);
    if (scope.activity === '*') refuse('LEARNING_SCOPE', 'context requires a concrete activity');
    const state = readState();
    const candidates = state.activations.filter(activation => activation.harnessId === harnessId && activationState(state, activation.id)?.status === 'active').flatMap(activation => {
      const lesson = lessonFor(state, activation.lessonId, activation.lessonDigest);
      const decision = latestDecision(state, lesson.id);
      if (!decision || decision.verdict !== 'accepted' || decision.id !== activation.decisionId || lesson.artifact.digest !== activation.artifactDigest) return [];
      if (lesson.scope.project !== scope.project || (lesson.scope.activity !== '*' && lesson.scope.activity !== scope.activity)) return [];
      return [{ id: lesson.id, lessonDigest: lesson.digest, scope: lesson.scope, artifact: lesson.artifact, activationId: activation.id, decisionId: decision.id, principle: lesson.principle, exceptions: lesson.exceptions, evidence: lesson.evidence.map(item => ({ ...item, source: state.observations.find(record => record.id === item.id).source })) }];
    });
    const groups = new Map();
    for (const item of candidates) {
      const slot = canonicalize([item.artifact.kind, item.artifact.name]);
      if (!groups.has(slot)) groups.set(slot, []);
      groups.get(slot).push(item);
    }
    const conflicts = [], withheld = new Set();
    for (const group of groups.values()) {
      if (new Set(group.map(item => item.artifact.digest)).size < 2) continue;
      const lessonIds = group.map(item => item.id).sort();
      for (const id of lessonIds) withheld.add(id);
      conflicts.push({ kind: group[0].artifact.kind, name: group[0].artifact.name, lessonIds, reason: 'overlapping-artifact-slot' });
    }
    return { schema: schema('context'), workspaceId, revision: state.revision, scope: structuredClone(scope), harnessId, lessons: structuredClone(candidates.filter(item => !withheld.has(item.id))), conflicts, authority: { grantsToolPermissions: false, authenticated: false } };
  }
  function graph() {
    const state = readState(), nodes = [], edges = [];
    for (const [collection, type] of [['observations', 'observation'], ['lessons', 'lesson-proposal'], ['decisions', 'decision'], ['activations', 'activation'], ['withdrawals', 'withdrawal']]) {
      for (const record of state[collection]) nodes.push({ id: `${type}:${record.id}`, type, record: structuredClone(record) });
    }
    const edge = (from, to, type) => edges.push({ from, to, type });
    for (const record of state.observations) if (record.lessonId) edge(`observation:${record.id}`, `lesson-proposal:${record.lessonId}`, 'application-feedback');
    for (const record of state.lessons) {
      for (const evidence of record.evidence) edge(`lesson-proposal:${record.id}`, `observation:${evidence.id}`, 'supported-by');
      if (record.supersedes) edge(`lesson-proposal:${record.id}`, `lesson-proposal:${record.supersedes}`, 'proposes-replacement');
    }
    for (const record of state.decisions) edge(`decision:${record.id}`, `lesson-proposal:${record.lessonId}`, record.verdict);
    for (const record of state.activations) { edge(`activation:${record.id}`, `lesson-proposal:${record.lessonId}`, 'activates'); edge(`activation:${record.id}`, `decision:${record.decisionId}`, 'authorized-by-local-assertion'); }
    for (const record of state.withdrawals) edge(`withdrawal:${record.id}`, `activation:${record.activationId}`, 'withdraws');
    return { schema: schema('graph'), workspaceId, revision: state.revision, nodes, edges, activationStates: structuredClone(state.activationStates), authority: { visibility: 'private', canonicalGraphMutation: false, authenticated: false } };
  }
  return Object.freeze({
    execute(request, { actor } = {}) {
      request = boundedLearningValue(request); actor = boundedLearningValue(actor);
      valid('request', request); valid('actor', actor);
      return withPrivateLock(path.join(directory(), 'operation.lock'), () => {
        const state = readState(), requestDigest = learningDigest({ request, actor });
        const prior = state.events.find(event => event.request.requestId === request.requestId);
        if (prior) {
          if (prior.requestDigest !== requestDigest) refuse('LEARNING_REQUEST_REUSE', 'request identifier was reused with different input or actor');
          return { schema: schema('result'), ok: true, duplicate: true, revision: prior.revision, eventId: prior.id, record: structuredClone(prior.record) };
        }
        const withdrawing = request.operation === 'withdraw';
        const createdAt = new Date().toISOString(), record = makeRecord(state, request, actor, createdAt);
        const event = seal({ schema: schema('event'), workspaceId, id: `event:${state.revision + 1}`, revision: state.revision + 1, previousDigest: state.headDigest, requestDigest, request, actor, createdAt, record });
        valid('event', event);
        const eventBytes = canonicalize(event) + '\n';
        // readState returns a private clone, so prospective lifecycle changes
        // cannot affect the verified committed projection when admission fails.
        const prospective = applyEvent(event, state);
        const remainingActive = prospective.activationStates.filter(binding => binding.status === 'active').length;
        // Every committed event passes the canonical LEARNING_MAX_BYTES bound.
        // Account for its final newline as well, so each remaining binding has
        // room for any valid withdrawal, even after the last ordinary write.
        const reserveBytes = Math.max(remainingActive * (LEARNING_MAX_BYTES + 1), withdrawing ? 0 : LEARNING_WITHDRAWAL_RESERVE_BYTES);
        const reserveEvents = Math.max(remainingActive, withdrawing ? 0 : LEARNING_WITHDRAWAL_RESERVE_EVENTS);
        if (prospective.revision + reserveEvents > LEARNING_MAX_EVENTS) refuse('LEARNING_LIMIT', 'learning journal event ceiling exceeded; withdrawal reservations retained');
        if (prospective.journalBytes + Buffer.byteLength(eventBytes) + reserveBytes > LEARNING_MAX_JOURNAL_BYTES) refuse('LEARNING_LIMIT', 'learning journal aggregate byte ceiling exceeded; withdrawal reservations retained');
        publishPrivateFile(path.join(eventDir, `${String(event.revision).padStart(10, '0')}.json`), eventBytes);
        const committed = readState().events.at(-1);
        if (committed.digest !== event.digest) refuse('LEARNING_HISTORY', 'learning journal readback mismatch');
        return { schema: schema('result'), ok: true, duplicate: false, revision: event.revision, eventId: event.id, record: structuredClone(record) };
      });
    },
    snapshot, render, context, graph,
    export() {
      const state = readState();
      return seal({ schema: schema('export'), workspaceId, revision: state.revision, visibility: 'private', authority: { authenticated: false, importedActivation: false, automaticPublication: false }, history: state.events, snapshot: publicSnapshot(state) });
    },
  });
}
