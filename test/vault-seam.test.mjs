import { evidenceStore } from './vault-store-fixture.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createVaultService, preparePublication, createVaultPrivacyProbe, createVaultPrivacyState, createVaultContext } from '../src/vault/index.mjs'
import { assessVaultPrivacy, vaultObjects } from '../src/vault/privacy.mjs'
import { protectionEvidence, deployment } from './vault-privacy-fixture.mjs'
const owner = { issuer: 'https://identity.example', subject: 'synthetic-author' }
const input = revision => ({ schema: 'atelier-vault-publication/v1', expectedRevision: revision, files: [{ path: 'empty.txt', base64: '' }, { path: 'report.html', base64: Buffer.from(`Revision ${revision}`).toString('base64') }, { path: 'style.css', base64: Buffer.from('body { color: green }').toString('base64') }] })
test('real service and denial collector publish zero-byte artifacts without alarms or recursion; activation covers every staged key', async () => {
  let record = { owner, revision: 0, manifest: [], publication: null }, inspections = 0, collections = 0
  const bytes = new Map(), store = evidenceStore()
  let handle, omitStorage = false
  const probe = createVaultPrivacyProbe({
    inspect: async context => {
      inspections++
      const evidence = protectionEvidence(context)
      if (context.phase === 'before-activation') for (const object of context.objects) assert.equal(bytes.get(object.key)?.length, object.size)
      return { configuration: evidence.configuration, policyRevision: evidence.policyRevision, targets: omitStorage ? evidence.targets.filter(t => t.kind !== 'storage') : evidence.targets }
    },
    request: async ({ url, identity }) => {
      assert.notEqual(identity, 'owner')
      if (new URL(url).hostname === 'storage.example') return new Response(null, { status: 403 })
      return handle(new Request(url, { headers: identity === 'otherUser' ? { 'x-test-person': 'other' } : {} }))
    },
  })
  const privacy = createVaultPrivacyState({ probe: { async verify(context) { collections++; return probe.verify(context) } }, load: store.load, compareAndSet: store.compareAndSet })
  handle = createVaultService({ deployment, privacy, identity: { read: async req => req.headers.get('x-test-person') === 'owner' ? owner : req.headers.has('x-test-person') ? { ...owner, subject: 'other' } : null, publish: async () => owner }, metadata: { get: async () => record, commit: async (_, value) => { if (value.expectedRevision !== record.revision) return false; record = { ...value, revision: record.revision + 1 }; return true } }, storage: { put: async (key, value) => bytes.set(key, value), get: async key => bytes.get(key) } })
  const publish = revision => handle(new Request('https://artifacts.example/_publish/sample-vault', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(input(revision)) }))
  const read = (path, method = 'GET') => handle(new Request(`https://artifacts.example/sample-vault/${path}`, { method, headers: { 'x-test-person': 'owner' } }))
  assert.equal((await publish(0)).status, 201)
  // Activation evidence is not silently promoted to read evidence. The explicit
  // host refresher verifies committed routes before owner delivery is enabled.
  assert.equal((await read('report.html')).status, 503)
  const context = createVaultContext({ vault: 'sample-vault', record, deployment })
  assert.equal(assessVaultPrivacy(await privacy.refresh(context), { ...context, phase: 'read' }).status, 'verified')
  const counts = [collections, inspections]
  assert.equal((await read('report.html')).status, 200)
  assert.equal((await read('style.css?v=1')).status, 200)
  const head = await read('report.html', 'HEAD')
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '')
  assert.deepEqual([collections, inspections], counts)
  assert.equal((await publish(1)).status, 201)
  omitStorage = true
  assert.equal((await publish(2)).status, 503)
  assert.equal(record.revision, 2)
})
test('binding refuses missing origins, requested paths, manifest digests and staged object coverage', async () => {
  const prepared = await preparePublication(input(0))
  const context = { vault: 'sample-vault', publication: prepared.publication, phase: 'before-activation', revision: 1, owner, deployment, manifest: prepared.manifest, objects: vaultObjects('sample-vault', prepared.manifest) }
  for (const change of [e => { e.deployment = { ...deployment, id: 'other' } }, e => { e.targets[0].url = 'https://other.example/sample-vault' }, e => { e.targets.splice(2, 1) }, e => { e.targets[2].sha256 = 'f'.repeat(64) }, e => { e.targets.pop() }]) {
    const evidence = protectionEvidence(context); change(evidence)
    assert.equal(assessVaultPrivacy(evidence, context).status, 'unknown')
  }
  assert.equal(assessVaultPrivacy(protectionEvidence({ ...context, phase: 'read' }), { ...context, phase: 'read', revision: 1, request: { origin: deployment.origins[0], path: '/sample-vault/missing.html' } }).status, 'unknown')
})
test('exposure survives stale metadata and failed notification; cached alarm cannot be cleared by refresh', async () => {
  let calls = 0, notifications = 0, inspections = 0
  const store = evidenceStore()
  const canary = 'synthetic-canary-marker-01234567890123456789'
  const context = { vault: 'sample-vault', publication: 'synthetic', phase: 'before-upload', revision: 1, owner, deployment, manifest: [], objects: [] }
  const probe = createVaultPrivacyProbe({ timeoutMs: 50, inspect: async () => { inspections++; if (inspections > 1) return new Promise(() => {}); return { ...protectionEvidence(context), targets: [{ kind: 'route', url: 'https://artifacts.example/sample-vault', sha256: '0'.repeat(64), canary }] } }, request: async () => { calls++; return new Response(`prefix ${canary} suffix`, { status: 403 }) }, onExposure: () => { notifications++; throw new Error('notification unavailable') } })
  const state = createVaultPrivacyState({ probe, load: store.load, compareAndSet: store.compareAndSet })
  const result = await state.verify(context)
  assert.equal(assessVaultPrivacy({ ...result, validUntil: 0, publication: 'old' }, context).status, 'exposed')
  assert.equal(assessVaultPrivacy(await state.refresh(context), { ...context, phase: 'read' }).status, 'exposed')
  assert.equal(calls, 1); assert.equal(inspections, 1); assert.equal(notifications, 1)
})
test('missing privacy bindings refuse authorized publication and artifact delivery', async () => {
  const prepared = await preparePublication(input(0)); let puts = 0
  const service = createVaultService({ deployment, identity: { read: () => owner, publish: () => owner }, metadata: { get: () => ({ owner, revision: 0, publication: prepared.publication, manifest: prepared.manifest }), commit() { assert.fail('must not activate') } }, storage: { put() { puts++ }, get() { assert.fail('must not read') } } })
  assert.equal((await service(new Request('https://artifacts.example/_publish/sample-vault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input(0)) }))).status, 503)
  assert.equal((await service(new Request('https://artifacts.example/sample-vault/report.html'))).status, 503)
  assert.equal(puts, 0)
})
test('public refresh context builder matches the actual service read context', async () => {
  const prepared = await preparePublication(input(0))
  const record = { ...prepared, owner, revision: 1 }; let observed
  const handle = createVaultService({ deployment, identity: { read: () => owner, publish: () => owner }, metadata: { get: () => record, commit() {} }, storage: { get() {}, put() {} }, privacy: { current(ctx) { observed = ctx; return null } } })
  await handle(new Request('https://artifacts.example/sample-vault/report.html'))
  assert.deepEqual(observed, createVaultContext({ vault: 'sample-vault', record, deployment, request: { origin: 'https://artifacts.example', path: '/sample-vault/report.html' } }))
  assert.equal(createVaultContext({ vault: 'sample-vault', record: { owner, revision: 0, manifest: [] }, deployment }).publication, null)
})
