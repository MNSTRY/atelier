import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createTrackableStore, releaseTrackable, previewTrackable, reduceTrackables, initialTrackables, trackableView, trackableOccurrence, validateTrackable } from '../src/trackables/store.mjs'
const at = '2026-01-02T15:00:00Z', pin = `sha256:${'a'.repeat(64)}`
const definition = (profile = 'recurring-practice') => ({ schema: 'atelier-trackable-definition@v1', id: profile, revision: 1, purpose: 'Follow an invented workshop practice.', profile, schedule: profile === 'recurring-practice' ? { cadence: 'daily', timezone: 'America/New_York' } : null, interpretationLimits: ['Recorded participation does not establish independent ability.'] })
const evidence = (id, occurredAt = at, kind = 'manual', result = 'completed', value = true) => ({ id, source: { kind, ref: `source:${id}`, digest: pin }, occurredAt, assistance: kind === 'session' ? 'assisted' : 'independent', result, value })
function fixture(t, scope = 'workshop') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-trackable-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root]); fs.writeFileSync(path.join(root, '.gitignore'), '.atelier-local/\n')
  const options = { workspaceRoot: root, scope, actor: 'local-owner' }, store = createTrackableStore(options)
  let serial = 0
  const command = (operation, input) => ({ schema: 'atelier-trackable-command@v1', requestId: `request-${++serial}`, expectedRevision: store.snapshot().revision, operation, input })
  const apply = (operation, input) => store.execute(command(operation, input))
  return { root, options, store, command, apply }
}
function instantiate(f, id, d = definition()) {
  if (!f.store.snapshot().definitions.some(r => r.digest === releaseTrackable(d).digest)) f.apply('release', { definition: d })
  f.apply('instantiate', { instanceId: id, subject: 'participant', definitionDigest: releaseTrackable(d).digest, effectiveAt: '2026-01-01T00:00:00Z' })
}
test('durable daily occurrences distinguish instances and days, reconcile manual/session reports, and replay once', t => {
  const f = fixture(t); instantiate(f, 'one'); instantiate(f, 'two')
  const command = f.command('record', { instanceId: 'one', evidence: evidence('first') })
  assert.equal(f.store.execute(command).persisted, true)
  assert.equal(createTrackableStore(f.options).execute(command).duplicate, true)
  f.apply('record', { instanceId: 'two', evidence: evidence('second') })
  f.apply('record', { instanceId: 'one', evidence: evidence('session', at, 'session') })
  f.apply('record', { instanceId: 'one', evidence: evidence('next-day', '2026-01-03T15:00:00Z') })
  let view = createTrackableStore(f.options).view({ instanceId: 'one', at })
  assert.equal(view.completedOccurrences, 1); assert.equal(view.occurrences[0].evidenceIds.length, 2)
  assert.equal(view.lifecycle, 'active'); assert.equal(view.disposition, null); assert.equal(view.abilityAssessed, false)
  assert.equal(f.store.view({ instanceId: 'two', at }).completedOccurrences, 1)
  view = f.store.view({ instanceId: 'one', at: '2026-01-04T15:00:00Z' })
  assert.equal(view.completedOccurrences, 2); assert.equal(view.evidenceQuality, 'missing')
  assert.throws(() => f.apply('record', { instanceId: 'one', evidence: { ...evidence('duplicate'), source: evidence('first').source } }), /source event already/)
  f.apply('correct', { evidenceId: 'first', reason: 'Report was mistaken.', replacement: null })
  f.apply('correct', { evidenceId: 'session', reason: 'Session was partial.', replacement: { result: 'partial', value: null } })
  assert.equal(f.store.view({ instanceId: 'one', at }).occurrences[0].result, 'partial')
  f.apply('lifecycle', { instanceId: 'one', status: 'paused' })
  assert.throws(() => f.apply('record', { instanceId: 'one', evidence: evidence('paused') }), /active tracking/)
  assert.equal(f.store.view({ instanceId: 'one', at }).disposition, null)
  const isolated = createTrackableStore({ ...f.options, scope: 'another-context' })
  assert.equal(isolated.snapshot().instances.length, 0)
  assert.throws(() => isolated.view({ instanceId: 'one', at }), /not found/)
})
test('milestone fulfillment, qualitative observations, correction and missingness stay independent', t => {
  const f = fixture(t); instantiate(f, 'milestone', definition('milestone')); instantiate(f, 'journal', definition('qualitative-series'))
  assert.equal(f.store.view({ instanceId: 'milestone', at }).occurrences[0].result, 'unobserved')
  f.apply('record', { instanceId: 'milestone', evidence: evidence('milestone-complete') })
  assert.equal(f.store.view({ instanceId: 'milestone', at }).disposition, 'open')
  f.apply('disposition', { instanceId: 'milestone', status: 'fulfilled', basisEvidenceIds: ['milestone-complete'] })
  f.apply('correct', { evidenceId: 'milestone-complete', reason: 'Evidence withdrawn.', replacement: null })
  assert.equal(f.store.view({ instanceId: 'milestone', at }).dispositionEvidence, 'needs-reconsideration')
  f.apply('record', { instanceId: 'journal', evidence: evidence('reflection', at, 'manual', 'observed', 'The tool was slow; the task needed assistance.') })
  const view = f.store.view({ instanceId: 'journal', at })
  assert.equal(view.progressPercent, null); assert.equal(view.occurrences[0].result, 'observed'); assert.equal(view.completedOccurrences, 0)
  assert.throws(() => f.apply('disposition', { instanceId: 'journal', status: 'fulfilled', basisEvidenceIds: [] }), /milestone/)
})
test('exact definition adoption preserves DST, travel, late evidence and historical meaning', t => {
  const f = fixture(t); instantiate(f, 'practice')
  const before = trackableOccurrence(f.store.snapshot(), 'practice', '2026-03-08T06:30:00Z')
  const after = trackableOccurrence(f.store.snapshot(), 'practice', '2026-03-08T07:30:00Z')
  assert.equal(before.id, after.id); assert.equal(before.localDate, '2026-03-08')
  const next = { ...definition(), revision: 2, schedule: { cadence: 'daily', timezone: 'Asia/Tokyo' } }
  f.apply('release', { definition: next })
  assert.equal(f.store.view({ instanceId: 'practice', at }).definitionDigest, releaseTrackable(definition()).digest)
  f.apply('adopt', { instanceId: 'practice', definitionDigest: releaseTrackable(next).digest, effectiveAt: '2026-03-10T00:00:00Z' })
  f.apply('record', { instanceId: 'practice', evidence: evidence('late', '2026-03-08T07:30:00Z') })
  assert.equal(f.store.snapshot().evidence[0].occurrence.id, before.id)
  const traveled = trackableOccurrence(f.store.snapshot(), 'practice', '2026-03-10T16:00:00Z')
  assert.equal(traveled.localDate, '2026-03-11'); assert.notEqual(traveled.definitionDigest, before.definitionDigest)
  assert.throws(() => f.apply('release', { definition: { ...definition(), purpose: 'Changed same revision.' } }), /already exists/)
  assert.ok(validateTrackable({ ...definition(), schedule: { cadence: 'hourly', timezone: 'UTC' } }).length)
})
test('preview and runtime execute shared rules; stale commands and tampered history refuse', t => {
  const d = definition(), e = evidence('preview')
  const preview = previewTrackable({ definition: d, at, evidence: [e] })
  let state = initialTrackables('test')
  for (const [operation, input] of [['release', { definition: d }], ['instantiate', { instanceId: 'preview', subject: 'preview-subject', definitionDigest: releaseTrackable(d).digest, effectiveAt: at }], ['record', { instanceId: 'preview', evidence: e }]]) {
    state = reduceTrackables(state, { schema: 'atelier-trackable-command@v1', requestId: `step-${state.revision}`, expectedRevision: state.revision, operation, input }, { actor: 'test', recordedAt: at })
  }
  const runtime = trackableView(state, { instanceId: 'preview', at })
  assert.equal(preview.completedOccurrences, runtime.completedOccurrences); assert.equal(preview.engine, runtime.engine)
  const f = fixture(t); instantiate(f, 'practice')
  const stale = f.command('lifecycle', { instanceId: 'practice', status: 'paused' })
  f.apply('record', { instanceId: 'practice', evidence: evidence('recorded') })
  assert.throws(() => f.store.execute(stale), /revision changed/)
  const directories = fs.readdirSync(path.join(f.root, '.atelier-local', 'trackables'))
  const event = path.join(f.root, '.atelier-local', 'trackables', directories[0], 'events', '0000000001.json')
  const original = fs.readFileSync(event, 'utf8'); fs.writeFileSync(event, original.replace('invented workshop', 'different workshop'))
  assert.throws(() => f.store.snapshot(), /integrity/)
  assert.throws(() => createTrackableStore(f.options), /integrity/)
})
test('a terminated local caller retains its committed occurrence and a retry does not duplicate it', t => {
  const f = fixture(t); instantiate(f, 'practice')
  const command = f.command('record', { instanceId: 'practice', evidence: evidence('lost-response') })
  const source = `import {createTrackableStore} from ${JSON.stringify(new URL('../src/trackables/store.mjs', import.meta.url).href)}; const s=createTrackableStore(${JSON.stringify(f.options)}); s.execute(${JSON.stringify(command)}); process.exit(73)`
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', source]), e => e.status === 73)
  const reopened = createTrackableStore(f.options)
  assert.equal(reopened.execute(command).duplicate, true)
  assert.equal(reopened.view({ instanceId: 'practice', at }).completedOccurrences, 1)
  assert.equal(reopened.snapshot().evidence.length, 1)
})
test('explicit skip, waiver, inapplicability and empty qualitative evidence do not become zero or completion', t => {
  const f = fixture(t); instantiate(f, 'practice'); instantiate(f, 'journal', definition('qualitative-series'))
  assert.equal(f.store.view({ instanceId: 'journal', at }).evidenceQuality, 'missing')
  for (const [day, result] of [[2, 'skipped'], [3, 'waived'], [4, 'not-applicable']]) f.apply('record', { instanceId: 'practice', evidence: evidence(result, `2026-01-0${day}T15:00:00Z`, 'manual', result, null) })
  const view = f.store.view({ instanceId: 'practice', at: '2026-01-04T15:00:00Z' })
  assert.deepEqual(view.occurrences.map(o => o.result), ['skipped', 'waived', 'not-applicable'])
  assert.equal(view.completedOccurrences, 0); assert.equal(view.progressPercent, null)
})
