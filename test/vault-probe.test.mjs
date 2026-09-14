import { protectionEvidence, deployment } from './vault-privacy-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createVaultPrivacyProbe } from '../src/vault/probe.mjs'
import { assessVaultPrivacy, verifyVaultPrivacy } from '../src/vault/privacy.mjs'
import { digest } from '../src/vault/service.mjs'
const bytes = new TextEncoder().encode('Synthetic private canary')
const context = { vault: 'sample-vault', publication: 'synthetic', phase: 'before-upload', revision: 1, deployment, manifest: [], objects: [], owner: { issuer: 'https://identity.example', subject: 'synthetic-owner' } }
async function fixture(changeResponse) {
  const sha256 = await digest(bytes)
  const inventory = { ...protectionEvidence(context), loginEndpoints: [{ url: 'https://login.example/sign-in', queryKeys: ['redirect_url', 'state'] }] }
  inventory.targets = inventory.targets.map(t => ({ ...t, sha256 }))
  const calls = []
  const request = async input => {
    calls.push(input)
    assert.equal(input.redirect, 'manual')
    const changed = changeResponse?.(input)
    if (changed) return changed
    return new Response(null, { status: 403 })
  }
  return { inventory, calls, request, probe: createVaultPrivacyProbe({ inspect: async () => inventory, request }) }
}
test('probe reads every configured surface as two unauthorized identities and verifies exact bytes', async () => {
  const f = await fixture()
  const result = await f.probe.verify(context)
  assert.equal(assessVaultPrivacy(result, context).status, 'verified')
  assert.equal(f.calls.length, 4)
  assert.equal(f.calls.filter(x => x.identity === 'anonymous').length, 2)
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
test('declared login endpoints permit only explicit non-credential query keys', async () => {
  for (const [location, status] of [['https://login.example/sign-in?redirect_url=%2Fsample-vault%2F&state=synthetic', 'verified'], ['https://login.example/other?state=synthetic', 'unknown'], ['https://elsewhere.example/sign-in?state=synthetic', 'unknown'], ['https://login.example/sign-in?access_token=synthetic', 'unknown']]) {
    const f = await fixture(() => new Response(null, { status: 302, headers: { location } }))
    assert.equal((await verifyVaultPrivacy(f.probe, context)).status, status)
  }
})
test('nonempty denial bodies are inconclusive and inventory object key order is irrelevant', async () => {
  const f = await fixture(() => new Response('unclassified response fragment', { status: 403 }))
  assert.equal((await verifyVaultPrivacy(f.probe, context)).status, 'unknown')
  const good = await fixture(); let count = 0
  const probe = createVaultPrivacyProbe({ inspect: async () => ++count === 1 ? good.inventory : Object.fromEntries(Object.entries(good.inventory).reverse()), request: good.request })
  assert.equal((await verifyVaultPrivacy(probe, context)).status, 'verified')
})
test('empty denial bodies are not disclosed content even for an empty-file digest', async () => {
  const f = await fixture()
  for (const target of f.inventory.targets) target.sha256 = await digest(new Uint8Array())
  assert.equal((await verifyVaultPrivacy(f.probe, context)).status, 'verified')
})
test('followed redirects still report observed bytes, but cannot establish denial', async () => {
  for (const [body, status] of [[bytes, 'exposed'], [null, 'unknown']]) {
    const f = await fixture(() => { const response = new Response(body, { status: 403 }); Object.defineProperty(response, 'redirected', { value: true }); return response })
    assert.equal((await verifyVaultPrivacy(f.probe, context)).status, status)
  }
})
