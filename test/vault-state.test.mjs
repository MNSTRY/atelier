import test from 'node:test'
import assert from 'node:assert/strict'
import { createVaultPrivacyState, assessVaultPrivacy, VaultAlarmPersistenceError } from '../src/vault/index.mjs'
import { protectionEvidence, deployment } from './vault-privacy-fixture.mjs'
import { evidenceStore } from './vault-store-fixture.mjs'
const context = { vault: 'sample-vault', publication: 'synthetic', revision: 1, phase: 'read', owner: { issuer: 'https://identity.example', subject: 'synthetic-owner' }, deployment, manifest: [], objects: [] }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const exposure = ctx => { const value = protectionEvidence(ctx); value.targets[0].anonymous = 'content'; return value }
test('overlapping collections cannot replace a stored alarm, even across wrapper instances', async () => {
  for (const shared of [true, false]) {
    const store = evidenceStore(), started = deferred(), resume = deferred()
    let calls = 0
    const probe = { async verify(ctx) { if (++calls === 1) { started.resolve(); await resume.promise; return protectionEvidence(ctx) } return exposure(ctx) } }
    const a = createVaultPrivacyState({ probe, ...store }), b = shared ? a : createVaultPrivacyState({ probe, ...store })
    const pending = a.refresh(context); await started.promise
    assert.equal(assessVaultPrivacy(await b.refresh(context), context).status, 'exposed')
    resume.resolve()
    assert.equal(assessVaultPrivacy(await pending, context).status, 'exposed')
    assert.equal(assessVaultPrivacy(await a.current(context), context).status, 'exposed')
    assert.equal([...store.values.values()][0].evidence.targets[0].anonymous, 'content')
  }
})
test('late old-publication refresh cannot replace a newer revision; conflicts refuse stale verdict', async () => {
  const store = evidenceStore(), started = deferred(), resume = deferred()
  const next = { ...context, revision: 2, publication: 'new' }
  const state = createVaultPrivacyState({ ...store, probe: { async verify(ctx) { if (ctx.revision === 1) { started.resolve(); await resume.promise } return protectionEvidence(ctx) } } })
  const old = state.refresh(context); await started.promise
  assert.equal(assessVaultPrivacy(await state.refresh(next), next).status, 'verified')
  resume.resolve()
  assert.equal(await old, null)
  assert.equal((await state.current(next)).revision, 2)
  assert.equal(await state.refresh(context), null)
})
test('failed alarm persistence still blocks this process from reusing its green evidence', async () => {
  const store = evidenceStore(); let alarm = false
  const state = createVaultPrivacyState({ ...store, probe: { verify: async ctx => alarm ? exposure(ctx) : protectionEvidence(ctx) } })
  await state.refresh(context)
  alarm = true; store.failWrites()
  await assert.rejects(state.refresh(context), VaultAlarmPersistenceError)
  assert.equal(assessVaultPrivacy(await state.current(context), context).status, 'exposed')
  assert.equal([...store.values.values()][0].evidence.targets[0].anonymous, 'denied')
})
test('versioned store refuses stale versions and existing alarm replacement', async () => {
  const store = evidenceStore()
  assert.equal(await store.compareAndSet('vault', protectionEvidence(context), { expectedVersion: 0 }), true)
  assert.equal(await store.compareAndSet('vault', protectionEvidence(context), { expectedVersion: 0 }), false)
  assert.equal(await store.compareAndSet('vault', exposure(context), { expectedVersion: 1 }), true)
  assert.equal(await store.compareAndSet('vault', protectionEvidence(context), { expectedVersion: 2 }), false)
})
test('green-first race persists a later alarm across instances, including staged-only activation', async () => {
  for (const phase of ['read', 'before-activation']) {
    const store = evidenceStore(), started = deferred(), resume = deferred()
    const pendingContext = { ...context, phase, publication: 'staged-only', revision: 1 }
    const greenContext = { ...context, publication: 'current', revision: 2 }
    const a = createVaultPrivacyState({ ...store, probe: { async verify(ctx) { started.resolve(); await resume.promise; const alarm = exposure(ctx); alarm.targets = [{ kind: 'storage', key: 'sample-vault/staged-only', anonymous: 'content' }]; return alarm } } })
    const b = createVaultPrivacyState({ ...store, probe: { verify: async ctx => protectionEvidence(ctx) } })
    const pending = a.verify(pendingContext); await started.promise
    assert.equal(assessVaultPrivacy(await b.refresh(greenContext), greenContext).status, 'verified')
    resume.resolve()
    assert.equal(assessVaultPrivacy(await pending, pendingContext).status, 'exposed')
    assert.equal(assessVaultPrivacy(await b.current(greenContext), greenContext).status, 'exposed')
    const replacement = createVaultPrivacyState({ ...store, probe: { verify() { assert.fail('stored alarm needs no probe') } } })
    assert.equal(assessVaultPrivacy(await replacement.current(greenContext), greenContext).status, 'exposed')
    assert.equal([...store.values.values()][0].evidence.targets[0].key, 'sample-vault/staged-only')
  }
})
test('an unpersisted latch retries after recovery without losing the original exposure', async () => {
  const store = evidenceStore(); let alarm = false, calls = 0
  const state = createVaultPrivacyState({ ...store, probe: { verify: async ctx => { calls++; return alarm ? exposure(ctx) : protectionEvidence(ctx) } } })
  await state.refresh(context); alarm = true; store.failWrites()
  await assert.rejects(state.refresh(context), error => error instanceof VaultAlarmPersistenceError && error.code === 'VAULT_ALARM_NOT_PERSISTED' && assessVaultPrivacy(error.evidence, context).status === 'exposed')
  assert.equal(assessVaultPrivacy(await state.current(context), context).status, 'exposed')
  store.recoverWrites()
  assert.equal(assessVaultPrivacy(await state.refresh(context), context).status, 'exposed')
  assert.equal(calls, 2)
  const replacement = createVaultPrivacyState({ ...store, probe: { verify() { assert.fail('must load incident') } } })
  assert.equal(assessVaultPrivacy(await replacement.current(context), context).status, 'exposed')
})
test('alarm contention has a bounded retry and explicit failure; green failures reject', async () => {
  const store = evidenceStore(); let writes = 0
  const state = createVaultPrivacyState({ load: store.load, compareAndSet: async () => { writes++; return false }, probe: { verify: async ctx => exposure(ctx) } })
  await assert.rejects(state.refresh(context), VaultAlarmPersistenceError)
  assert.equal(writes, 3)
  assert.equal(assessVaultPrivacy(await state.current(context), context).status, 'exposed')
  const failing = createVaultPrivacyState({ ...store, probe: { verify: async ctx => protectionEvidence(ctx) } })
  store.failWrites()
  await assert.rejects(failing.refresh(context), /store unavailable/)
})
test('activation observes an alarm recorded locally or by another wrapper while probing', async () => {
  for (const same of [true, false]) {
    const store = evidenceStore(), started = deferred(), resume = deferred()
    let calls = 0
    const probe = { async verify(ctx) { if (++calls === 1) { started.resolve(); await resume.promise; return protectionEvidence(ctx) } return exposure(ctx) } }
    const a = createVaultPrivacyState({ ...store, probe }), b = same ? a : createVaultPrivacyState({ ...store, probe })
    const activating = a.verify({ ...context, phase: 'before-activation' }); await started.promise
    await b.refresh(context); resume.resolve()
    assert.equal(assessVaultPrivacy(await activating, { ...context, phase: 'before-activation' }).status, 'exposed')
  }
})
test('invalid refresh revisions fail before any store read or write', async () => {
  const state = createVaultPrivacyState({ load() { assert.fail('invalid context must not read') }, compareAndSet() { assert.fail('invalid context must not write') }, probe: { verify() { assert.fail('must not probe') } } })
  for (const revision of [undefined, null, -1, 0.5, '1', NaN]) await assert.rejects(state.refresh({ ...context, revision }), TypeError)
})
test('green evidence uses its original version even when a store checks only versions', async () => {
  let record = { version: 0, evidence: null }; const versions = [], started = deferred(), resume = deferred(); let calls = 0
  const state = createVaultPrivacyState({
    load: async () => structuredClone(record),
    compareAndSet: async (_, evidence, { expectedVersion }) => { versions.push(expectedVersion); if (expectedVersion !== record.version) return false; record = { version: record.version + 1, evidence }; return true },
    probe: { async verify(ctx) { if (++calls === 1) { started.resolve(); await resume.promise } return protectionEvidence(ctx) } },
  })
  const old = state.refresh(context); await started.promise
  await state.refresh(context); resume.resolve()
  assert.equal(await old, null)
  assert.deepEqual(versions, [0, 0])
  assert.equal(record.version, 1)
})
test('alarm persistence retries a stale CAS version after a green write wins', async () => {
  const store = evidenceStore(); let writes = 0
  const state = createVaultPrivacyState({ load: store.load, probe: { verify: async ctx => exposure(ctx) }, compareAndSet: async (key, evidence, expected) => {
    if (++writes === 1) await store.compareAndSet(key, protectionEvidence({ ...context, revision: 2 }), expected)
    return store.compareAndSet(key, evidence, expected)
  } })
  assert.equal(assessVaultPrivacy(await state.refresh(context), context).status, 'exposed')
  assert.equal(writes, 2)
  assert.equal([...store.values.values()][0].evidence.targets[0].anonymous, 'content')
})
