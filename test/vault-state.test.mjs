import test from 'node:test'
import assert from 'node:assert/strict'
import { createVaultPrivacyState, assessVaultPrivacy } from '../src/vault/index.mjs'
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
  assert.equal(assessVaultPrivacy(await state.refresh(context), context).status, 'exposed')
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
