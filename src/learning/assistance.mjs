import { learningDigest, validateLearningInput } from './store.mjs'

function requireSnapshot(snapshot) {
  if (!snapshot || typeof snapshot.workspaceId !== 'string'
    || !Array.isArray(snapshot.observations) || !Array.isArray(snapshot.lessons)
    || !Number.isSafeInteger(snapshot.revision)) throw new Error('invalid learning snapshot')
}

// Group metadata first. The plan never interprets a correction as accepted
// guidance, and repeated observations are not independent corroboration.
export function planLearningWork(snapshot) {
  requireSnapshot(snapshot)
  const groups = new Map()
  const addressed = new Set(snapshot.lessons.flatMap(lesson => lesson.evidenceIds))
  for (const observation of snapshot.observations) {
    if (addressed.has(observation.id)) continue
    const key = learningDigest(observation.scope)
    if (!groups.has(key)) groups.set(key, { scope: observation.scope, observationIds: [], signals: new Set() })
    const group = groups.get(key)
    group.observationIds.push(observation.id)
    group.signals.add(observation.signal)
  }
  return {
    schema: 'atelier-learning-plan@v1', workspaceId: snapshot.workspaceId, revision: snapshot.revision,
    groups: [...groups.values()].map(group => ({ scope: group.scope,
      observationIds: group.observationIds,
      route: group.signals.has('exception') ? 'focused-reasoning-or-human' : 'bounded-proposal',
      reason: group.signals.has('exception') ? 'exception-needs-context' : 'unaddressed-observations',
    })),
    authority: { execution: false, acceptance: false, activation: false },
  }
}

export function prepareLearningBatch({ snapshot, observationIds, maxInputBytes = 32 * 1024 }) {
  requireSnapshot(snapshot)
  if (!Array.isArray(observationIds) || !observationIds.length || observationIds.length > 32
    || new Set(observationIds).size !== observationIds.length
    || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 128 * 1024) {
    throw new Error('invalid learning batch bounds')
  }
  const observations = observationIds.map(id => snapshot.observations.find(item => item.id === id))
  if (observations.some(item => !item)) throw new Error('learning batch has unavailable evidence')
  if (new Set(observations.map(item => learningDigest(item.scope))).size !== 1) throw new Error('learning batch must have one exact scope')
  const payload = { schema: 'atelier-learning-batch@v1', workspaceId: snapshot.workspaceId,
    revision: snapshot.revision, scope: observations[0].scope, observations: structuredClone(observations),
    authority: { inputIsEvidence: true, acceptance: false, activation: false },
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload))
  if (bytes > maxInputBytes) throw new Error('learning batch exceeds input byte limit')
  return { payload, digest: learningDigest(payload), bytes }
}

// A host supplies qualified execution, exact-payload authorization and a durable
// reservation implementation. No provider, network transport or credential is
// embedded here. Callers receive inert proposals, never implicit store writes.
export async function draftLearningProposals({ batch, adapter, authorization, budget,
  maxOutputBytes = 32 * 1024, maxProposals = 8 }) {
  // Retain the exact authorized bytes across asynchronous host calls.
  try { batch = structuredClone(batch) }
  catch { throw new Error('invalid learning batch') }
  if (!batch?.payload || batch.digest !== learningDigest(batch.payload)
    || batch.bytes !== Buffer.byteLength(JSON.stringify(batch.payload))
    || batch.bytes > 128 * 1024 || batch.payload.schema !== 'atelier-learning-batch@v1'
    || !Array.isArray(batch.payload.observations) || !batch.payload.observations.length
    || batch.payload.observations.length > 32) throw new Error('invalid learning batch')
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id || typeof adapter.version !== 'string'
    || !adapter.version || typeof adapter.draft !== 'function'
    || adapter.qualification?.task !== 'lesson-proposal' || !adapter.qualification?.evidenceRef) {
    throw new Error('qualified lesson proposal adapter required')
  }
  if (authorization?.workspaceId !== batch.payload.workspaceId || authorization?.payloadDigest !== batch.digest
    || authorization?.adapterId !== adapter.id || authorization?.adapterVersion !== adapter.version
    || authorization?.permitted !== true) throw new Error('exact host authorization required')
  if (typeof budget?.reserve !== 'function' || typeof budget?.settle !== 'function') throw new Error('durable host budget required')
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 128 * 1024
    || !Number.isSafeInteger(maxProposals) || maxProposals < 1 || maxProposals > 16) throw new Error('invalid learning output bounds')
  const key = learningDigest({ batch: batch.digest, adapter: adapter.id, version: adapter.version,
    qualification: adapter.qualification, maxOutputBytes, maxProposals })
  const adapterId = adapter.id, adapterVersion = adapter.version
  const qualificationRef = adapter.qualification.evidenceRef
  const draft = adapter.draft.bind(adapter)
  const reservation = await budget.reserve({ key, calls: 1, inputBytes: batch.bytes, maxOutputBytes })
  if (reservation?.status !== 'reserved' || typeof reservation.id !== 'string' || !reservation.id) {
    throw new Error('learning budget unavailable or attempt already exists')
  }
  let response
  try {
    response = await draft(structuredClone(batch.payload), { maxOutputBytes, maxProposals })
  } catch {
    await budget.settle({ reservationId: reservation.id, key, outcome: 'unknown', usage: null })
    throw new Error('learning adapter outcome unknown; reconcile before retry')
  }
  // Reconcile a returned attempt even if its proposed content fails validation.
  const usage = measuredUsage(response?.usage)
  await budget.settle({ reservationId: reservation.id, key, outcome: 'returned', usage })
  let proposals
  try {
    const bytes = Buffer.byteLength(JSON.stringify(response?.proposals))
    if (bytes > maxOutputBytes || !Array.isArray(response?.proposals)
      || response.proposals.length > maxProposals) throw new Error()
    const known = new Set(batch.payload.observations.map(item => item.id))
    const ids = new Set()
    proposals = response.proposals.map(proposal => {
      if (validateLearningInput('propose', proposal).length || ids.has(proposal.id)
        || learningDigest(proposal.scope) !== learningDigest(batch.payload.scope)
        || proposal.evidenceIds.some(id => !known.has(id))) throw new Error()
      ids.add(proposal.id)
      return structuredClone(proposal)
    })
  } catch { throw new Error('learning adapter returned invalid proposals') }
  return { schema: 'atelier-learning-drafts@v1', batchDigest: batch.digest, adapterId,
    adapterVersion, qualificationRef,
    reservationId: reservation.id, proposals, usage,
    authority: { stored: false, acceptance: false, activation: false },
  }
}

function measuredUsage(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const result = {}
  for (const key of ['inputTokens', 'outputTokens', 'durationMs']) {
    result[key] = Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null
  }
  // No price estimate or quota-percentage conversion is invented here.
  return result
}
