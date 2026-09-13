import test from 'node:test'
import assert from 'node:assert/strict'
import { createVaultPrivacyProbe } from '../src/vault/probe.mjs'
import { assessVaultPrivacy, verifyVaultPrivacy } from '../src/vault/privacy.mjs'
import { digest } from '../src/vault/service.mjs'
const bytes = new TextEncoder().encode('Synthetic private canary')
const context = { vault: 'sample-vault', publication: 'synthetic', phase: 'before-upload', owner: { issuer: 'https://identity.example', subject: 'synthetic-owner' } }
async function fixture(changeResponse) {
  const sha256 = await digest(bytes)
  const inventory = { policyRevision: 'policy-one', configuration: { ownerOnly: true, privateStorage: true, completeInventory: true }, loginUrls: ['https://login.example/sign-in'], targets: ['artifact', 'asset', 'alias', 'origin', 'storage'].map(kind => ({ kind, url: `https://${kind}.example/canary`, sha256 })) }
  const calls = []
  const request = async input => {
    calls.push(input)
    assert.equal(input.redirect, 'manual')
    const changed = changeResponse?.(input)
    if (changed) return changed
    return input.identity === 'owner' && !input.url.includes('storage.example') ? new Response(bytes) : new Response(null, { status: 403 })
  }
  return { inventory, calls, request, probe: createVaultPrivacyProbe({ inspect: async () => inventory, request }) }
}
test('probe reads every configured surface as three distinct identities and verifies exact bytes', async () => {
  const f = await fixture()
  const result = await f.probe.verify(context)
  assert.equal(assessVaultPrivacy(result, context).status, 'verified')
  assert.equal(f.calls.length, 15)
  assert.equal(f.calls.filter(x => x.identity === 'anonymous').length, 5)
})
test('public canary content produces exposure rather than a status-only success', async () => {
  const f = await fixture(input => input.identity === 'anonymous' ? new Response(bytes) : null)
  assert.equal((await verifyVaultPrivacy(f.probe, context)).status, 'exposed')
})
test('login HTML, server errors and unexpected redirects remain unknown', async () => {
  for (const response of [() => new Response('Sign in'), () => new Response(null, { status: 500 }), () => new Response(null, { status: 302, headers: { location: 'https://unexpected.example/' } })]) {
    const f = await fixture(input => input.identity === 'anonymous' ? response() : null)
    assert.equal((await verifyVaultPrivacy(f.probe, context)).status, 'unknown')
  }
})
test('only exact provider-declared login redirect is a refusal; redirects are never followed', async () => {
  const f = await fixture(input => input.identity === 'anonymous' ? new Response(null, { status: 302, headers: { location: 'https://login.example/sign-in' } }) : null)
  assert.equal((await verifyVaultPrivacy(f.probe, context)).status, 'verified')
})
test('policy change and timeout prevent a verified result', async () => {
  const f = await fixture()
  let count = 0
  const changing = createVaultPrivacyProbe({ inspect: async () => ({ ...f.inventory, policyRevision: String(count++) }), request: f.request })
  assert.equal((await verifyVaultPrivacy(changing, context)).status, 'unknown')
  const stalled = createVaultPrivacyProbe({ inspect: async () => new Promise(() => {}), request: f.request, timeoutMs: 5 })
  assert.equal((await verifyVaultPrivacy(stalled, context)).status, 'unknown')
})
test('unsafe inventory URLs are refused without sending a request', async () => {
  for (const url of ['http://127.0.0.1/canary', 'https://example.test/?query=value', 'https://person:password@example.test/']) {
    const f = await fixture(); f.inventory.targets[0].url = url
    assert.equal((await verifyVaultPrivacy(f.probe, context)).status, 'unknown')
    assert.equal(f.calls.length, 0)
  }
})
test('private bytes in an error response are still an exposure', async () => {
  const f = await fixture(input => input.identity === 'anonymous' ? new Response(bytes, { status: 403 }) : null)
  assert.equal((await verifyVaultPrivacy(f.probe, context)).status, 'exposed')
})
