import assert from 'node:assert/strict'
import test from 'node:test'
import { learningDigest } from '../src/learning/store.mjs'
import { planLearningWork, prepareLearningBatch, draftLearningProposals } from '../src/learning/assistance.mjs'
import { skillObservationToLearningInput, legacyLessonToLearningInput } from '../src/learning/adapters.mjs'

const scope = { project: 'sample-project', activity: 'inventory-summary' }
const observation = { id: 'observation-one', signal: 'user-correction',
  text: 'Put shortages first.', interpretation: 'explicit', scope,
  source: { ref: 'manual-user-entry', digest: null } }
const proposal = { id: 'lesson-one', title: 'Lead with shortages', principle: 'Lead with shortages.',
  rationale: 'Replenishment is the next decision.', exceptions: ['Location audits use another order.'],
  evidenceIds: [observation.id], scope,
  artifact: { kind: 'instruction', name: 'inventory-summary', content: 'List shortages before storage locations.' } }
function snapshot() { return { workspaceId: 'sample-workspace', revision: 1, observations: [structuredClone(observation)], lessons: [] } }
function setup() {
  const batch = prepareLearningBatch({ snapshot: snapshot(), observationIds: [observation.id] })
  const calls = [], settlements = []
  const reserved = new Set()
  const adapter = { id: 'fixture-adapter', version: '1', qualification: { task: 'lesson-proposal', evidenceRef: 'synthetic-fixture-only' },
    async draft(payload) { calls.push(payload); return { proposals: [structuredClone(proposal)], usage: { inputTokens: 12, outputTokens: 8 } } } }
  const authorization = { workspaceId: batch.payload.workspaceId, payloadDigest: batch.digest,
    adapterId: adapter.id, adapterVersion: adapter.version, permitted: true }
  const budget = {
    async reserve({ key }) { if (reserved.has(key)) return { status: 'unresolved-or-already-used' }; reserved.add(key); return { status: 'reserved', id: 'reservation-one' } },
    async settle(record) { settlements.push(record) },
  }
  return { batch, adapter, authorization, budget, calls, settlements, reserved }
}

test('mechanical planning retains exceptional and ordinary pending evidence without accepting a lesson', () => {
  const state = snapshot()
  state.observations.push({ ...observation, id: 'exception-one', signal: 'exception' })
  state.observations.push({ ...observation, id: 'other-scope', scope: { ...scope, activity: 'location-audit' } })
  const plan = planLearningWork(state)
  assert.equal(plan.groups.length, 2)
  assert.equal(plan.groups[0].route, 'focused-reasoning-or-human')
  assert.equal(plan.groups[1].route, 'bounded-proposal')
  assert.equal(plan.authority.acceptance, false)
  assert.deepEqual(plan.groups.flatMap(group => group.observationIds), state.observations.map(item => item.id))
  state.lessons.push(proposal)
  assert.ok(!planLearningWork(state).groups[0].observationIds.includes(observation.id))
})

test('bounded batch selection refuses missing, duplicate, oversized and mixed-scope evidence', () => {
  assert.throws(() => prepareLearningBatch({ snapshot: snapshot(), observationIds: ['absent'] }), /unavailable/)
  assert.throws(() => prepareLearningBatch({ snapshot: snapshot(), observationIds: [observation.id, observation.id] }), /bounds/)
  assert.throws(() => prepareLearningBatch({ snapshot: snapshot(), observationIds: [observation.id], maxInputBytes: 1 }), /byte limit/)
  const state = snapshot()
  state.observations.push({ ...observation, id: 'foreign', scope: { ...scope, project: 'other-project' } })
  assert.throws(() => prepareLearningBatch({ snapshot: state, observationIds: [observation.id, 'foreign'] }), /one exact scope/)
})

test('qualified injected adapter returns inert drafts and does not modify input or repeat a reserved attempt', async () => {
  const input = setup()
  const before = JSON.stringify(input.batch)
  const result = await draftLearningProposals(input)
  assert.deepEqual(result.proposals, [proposal])
  assert.deepEqual(result.authority, { stored: false, acceptance: false, activation: false })
  assert.equal(JSON.stringify(input.batch), before)
  assert.equal(input.calls.length, 1)
  assert.equal(input.settlements[0].outcome, 'returned')
  await assert.rejects(draftLearningProposals(input), /already exists/)
  assert.equal(input.calls.length, 1)
})

test('host authorization binds exact payload, provider identity and version before reservation', async () => {
  for (const change of [{ permitted: false }, { payloadDigest: learningDigest('other') },
    { workspaceId: 'foreign' }, { adapterId: 'substitute' }, { adapterVersion: '2' }]) {
    const input = setup()
    Object.assign(input.authorization, change)
    await assert.rejects(draftLearningProposals(input), /authorization/)
    assert.equal(input.reserved.size, 0)
    assert.equal(input.calls.length, 0)
  }
})

test('adapter qualification is explicit and missing durable budget refuses', async () => {
  const input = setup()
  input.adapter.qualification = null
  await assert.rejects(draftLearningProposals(input), /qualified/)
  await assert.rejects(draftLearningProposals({ ...setup(), budget: null }), /durable/)
})

test('payload mutation while waiting for reservation cannot change the authorized bytes', async () => {
  const input = setup()
  const reserve = input.budget.reserve
  input.budget.reserve = async details => {
    input.batch.payload.observations[0].text = 'Replacement was not approved.'
    return reserve(details)
  }
  const result = await draftLearningProposals(input)
  assert.equal(input.calls[0].observations[0].text, observation.text)
  assert.equal(result.batchDigest, learningDigest(input.calls[0]))
})

test('unknown provider completion is settled as unknown and cannot trigger an automatic retry', async () => {
  const input = setup()
  input.adapter.draft = async () => { throw new Error('untrusted provider detail') }
  await assert.rejects(draftLearningProposals(input), /outcome unknown/)
  assert.equal(input.settlements[0].outcome, 'unknown')
  assert.equal(input.settlements[0].usage, null)
  await assert.rejects(draftLearningProposals(input), /already exists/)
})

test('invented evidence, scope expansion, authority fields and oversized responses never become drafts', async () => {
  for (const change of [
    { evidenceIds: ['uncited'] }, { scope: { ...scope, activity: '*' } }, { accepted: true },
    { artifact: { ...proposal.artifact, content: 'x'.repeat(128 * 1024) } },
  ]) {
    const input = setup()
    input.adapter.draft = async () => ({ proposals: [{ ...proposal, ...change }] })
    await assert.rejects(draftLearningProposals(input), /invalid proposals/)
    assert.equal(input.settlements[0].outcome, 'returned')
    assert.equal(input.settlements[0].usage, null)
  }
})

test('skill observation adapter preserves metadata-only provenance and imported status grants no authority', () => {
  const receipt = { schema: 'mnstry.atelier-skill-observation-receipt@v1', ok: true,
    observation: { id: 'event-one', workflowKey: 'sample.inventory', signal: 'user-correction', outcome: 'corrected' } }
  const input = skillObservationToLearningInput({ receipt, scope })
  assert.equal(input.interpretation, 'tool')
  assert.match(input.text, /Original feedback text is unavailable/)
  assert.equal(input.source.digest, learningDigest(receipt))
  const imported = legacyLessonToLearningInput({ legacy: { id: 'old-one', claim: proposal.principle, status: 'promoted' },
    id: 'imported-one', scope, evidenceIds: [observation.id], artifact: proposal.artifact })
  assert.equal(imported.provenance.authorityTransferred, false)
  assert.equal(imported.input.status, undefined)
  assert.match(imported.input.rationale, /prior acceptance and activation are not authority/)
})
