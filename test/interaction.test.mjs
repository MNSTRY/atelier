import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { learningDigest as digest } from '../src/learning/contracts.mjs'
import { qualifyReflection, prepareReflectiveAct, reflectionReference } from '../src/reflection/index.mjs'
import { selectInteractionAct, createInteractionController } from '../src/interaction/index.mjs'
const at = '2026-01-02T10:00:00Z'
const observation = { schema: 'atelier-reflection-observation@v1', id: 'tool-delay', revision: 1, scope: 'workshop', purpose: 'work-quality', subject: { kind: 'system', id: 'editor' }, author: 'participant', occurredAt: at, recordedAt: at, report: 'The editor discarded a draft after a delay.', assistance: 'assisted', status: 'active', source: { ref: 'local-report', digest: `sha256:${'1'.repeat(64)}` } }
const assessment = { schema: 'atelier-reflection-assessment@v1', id: 'friction', revision: 1, scope: 'workshop', purpose: 'work-quality', subject: observation.subject, author: 'reviewer', criterion: 'Work can resume after a delay.', claim: 'The editor needs draft recovery.', evidence: [reflectionReference(observation)], method: { id: 'case-inspection', revision: '1' }, uncertainty: 'material', limits: ['One reported event; cause remains uncertain.'], claimKind: 'system-friction', status: 'active' }
const act = { schema: 'atelier-interaction-act@v1', id: 'repair-offer', scope: 'workshop', purpose: 'work-quality', origin: 'witness', kind: 'propose', meaning: 'Offer recovery of the draft.', text: 'The delay may be a tool problem. We can recover the draft first.', mode: 'reflective', dependencies: [reflectionReference(assessment), reflectionReference(observation)], expiresAt: '2026-01-03T00:00:00Z' }
const policy = { schema: 'atelier-interaction-policy@v1', id: 'work-policy', revision: 1, scope: 'workshop', purpose: 'work-quality', reflectionEnabled: true, coachingEnabled: false, challengeEnabled: true, initiative: 'responsive', pacing: 'one-at-a-time', qualities: ['clarity', 'candor', 'attribution', 'uncertainty', 'repair'] }
const context = { observations: [observation], assessments: [assessment], orientations: [] }
const current = () => ({ policy: structuredClone(policy), context: structuredClone(context), state: { paused: false, busy: false, floor: 'assistant', requestedReflection: true }, at })
function nativeHost(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-interaction-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  let model = current(), sends = 0, started, release
  const begun = new Promise(resolve => { started = resolve })
  const hold = new Promise(resolve => { release = resolve })
  const file = key => path.join(directory, `${key.slice(7)}.json`)
  const read = async key => JSON.parse(fs.readFileSync(file(key), 'utf8'))
  const write = receipt => { fs.writeFileSync(file(receipt.key), JSON.stringify(receipt)); return receipt }
  const host = { authorityId: 'conversation-one', current: async () => structuredClone(model), authorize: async () => true,
    async reserve({ key, actDigest }) {
      try { fs.writeFileSync(file(key), JSON.stringify({ key, actDigest, authorityId: this.authorityId, status: 'reserved', deliveredText: '' }), { flag: 'wx' }); return { created: true } }
      catch (e) { if (e.code === 'EEXIST') return { created: false }; throw e }
    },
    async send({ key, act, signal }) {
      sends++; model.state.busy = true
      let receipt = await read(key)
      write({ ...receipt, status: 'begun', deliveredText: act.text.slice(0, 12) }); started()
      if (host.hold) await Promise.race([hold, new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
      receipt = await read(key)
      if (!signal.aborted && receipt.status !== 'interrupted') write({ ...receipt, status: 'completed', deliveredText: act.text })
      model.state.busy = false
    },
    async interrupt({ key }) { const receipt = await read(key); write({ ...receipt, status: 'interrupted' }); release(); model.state.busy = false }, read,
  }
  return { host, begun, setCurrent(value) { model = value }, sends: () => sends }
}
test('reflection qualifies source revisions and assistance without interpreting a tool problem as personal incapacity', () => {
  assert.equal(qualifyReflection({ assessment, observations: [observation], scope: 'workshop', purpose: 'work-quality' }).current, true)
  assert.equal(prepareReflectiveAct({ assessment, observations: [observation], act }).executionAuthorized, false)
  const personal = { ...assessment, subject: { kind: 'person', id: 'participant' }, claimKind: 'independent-capacity' }
  assert.equal(qualifyReflection({ assessment: personal, observations: [observation], scope: 'workshop', purpose: 'work-quality' }).current, false)
  for (const changed of [{ ...observation, revision: 2, report: 'The draft was recovered.' }, { ...observation, status: 'withdrawn' }]) {
    const result = selectInteractionAct({ act, ...current(), context: { ...context, observations: [changed] } })
    assert.equal(result.selection, 'declined')
  }
  assert.equal(selectInteractionAct({ act, ...current(), policy: { ...policy, purpose: 'another-purpose' } }).selection, 'declined')
  assert.throws(() => prepareReflectiveAct({ assessment, observations: [observation], act: { ...act, mode: 'coaching' } }), /chosen intention/)
})
test('Companion works with Reflection disabled and honors floor, pause, challenge and expiry', () => {
  const work = { ...act, id: 'ordinary-explanation', origin: 'companion', mode: 'ordinary', dependencies: [], kind: 'explain' }
  const disabled = { ...current(), policy: { ...policy, reflectionEnabled: false } }
  assert.equal(selectInteractionAct({ act: work, ...disabled }).selection, 'selected')
  assert.equal(selectInteractionAct({ act, ...disabled }).selection, 'declined')
  assert.equal(selectInteractionAct({ act: work, ...disabled, state: { paused: true, floor: 'assistant' } }).selection, 'deferred')
  assert.equal(selectInteractionAct({ act: work, ...disabled, state: { floor: 'user' } }).selection, 'deferred')
  assert.equal(selectInteractionAct({ act: { ...work, kind: 'challenge' }, ...disabled, policy: { ...disabled.policy, challengeEnabled: false } }).selection, 'declined')
  assert.equal(selectInteractionAct({ act: work, ...disabled, at: '2026-01-04T00:00:00Z' }).selection, 'declined')
})
test('native reservation/readback survives controller restart; interrupted output is partial and repair is a distinct act', async t => {
  const f = nativeHost(t), controller = createInteractionController({ authorityId: f.host.authorityId, host: f.host })
  f.host.hold = true
  const pending = controller.deliver(act); await f.begun
  assert.equal((await controller.interrupt(act, 'User interrupted to correct the premise.')).status, 'interrupted')
  const result = await pending
  assert.equal(result.delivery.deliveredText, act.text.slice(0, 12)); assert.equal(result.delivery.understandingVerified, false)
  f.host.hold = false
  const resumed = createInteractionController({ authorityId: f.host.authorityId, host: f.host })
  assert.equal((await resumed.deliver(act)).replayed, true); assert.equal(f.sends(), 1)
  const repair = { ...act, id: 'repair-after-correction', origin: 'companion', mode: 'ordinary', dependencies: [], kind: 'repair', meaning: 'Acknowledge the correction and ask what to preserve.', text: 'Thanks for the correction. Which part of the draft should we preserve?' }
  assert.equal((await resumed.deliver(repair)).delivery.status, 'completed')
  assert.equal(f.sends(), 2)
})
test('changed evidence during reservation cancels delivery; lost native response does not cause a retry', async t => {
  const f = nativeHost(t), reserve = f.host.reserve.bind(f.host)
  f.host.reserve = async input => { const r = await reserve(input); f.setCurrent({ ...current(), context: { ...context, observations: [{ ...observation, status: 'withdrawn' }] } }); return r }
  const controller = createInteractionController({ authorityId: f.host.authorityId, host: f.host })
  const cancelled = await controller.deliver(act)
  assert.equal(cancelled.delivery.status, 'interrupted'); assert.equal(f.sends(), 0)
  f.host.reserve = reserve; f.setCurrent(current())
  const work = { ...act, id: 'lost-reply', origin: 'work', mode: 'ordinary', dependencies: [] }
  const send = f.host.send.bind(f.host)
  f.host.send = async options => { await send(options); throw new Error('Reply lost after emission.') }
  assert.equal((await controller.deliver(work)).delivery.status, 'completed')
  assert.equal((await controller.deliver(work)).replayed, true); assert.equal(f.sends(), 1)
  assert.throws(() => createInteractionController({ authorityId: 'other-authority', host: f.host }), /one complete/)
  f.host.authorize = async () => false
  await assert.rejects(controller.deliver({ ...work, id: 'not-authorized' }), /authorize/)
})
test('reflective acts need Reflection enabled, an assessment and a request whatever their origin', () => {
  const disabled = { ...current(), policy: { ...policy, reflectionEnabled: false } }
  for (const origin of ['work', 'companion', 'witness']) {
    const off = selectInteractionAct({ act: { ...act, origin }, ...disabled })
    assert.equal(off.selection, 'declined'); assert.ok(off.reasons.includes('reflection-disabled'), JSON.stringify(off.reasons))
    const bare = selectInteractionAct({ act: { ...act, origin, dependencies: act.dependencies.filter(p => p.kind !== 'assessment') }, ...current() })
    assert.ok(bare.reasons.includes('reflective-assessment-missing'), JSON.stringify(bare.reasons))
  }
})
