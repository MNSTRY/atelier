import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { canonicalJson, ExtensionError, parseInstallationBinding, parseManifest, parseOperationReceipt } from '../src/extensions/contracts.mjs'
import { createExtensionClient, createExtensionAdminClient, createHttpHostTransport } from '../src/extensions/client.mjs'
import { assertVerifiedScope, createExtensionHandler, createRootAdmissionConsumer, defineAction, defineExtension, digest, releaseDigest } from '../src/extensions/server.mjs'

const binding = { installationId: 'installation_synthetic_123', generation: '1', releaseDigest: 'a'.repeat(64) }
function manifest() {
  const value = { schema: 'mnstry.extension-manifest/v1', extensionId: 'sample.counter', releaseVersion: '1.0.0', releaseDigest: '0'.repeat(64),
    protocol: 'mnstry.extension/v1', compatibility: { sdkMajor: 1, rootContracts: [], hosts: ['web'] },
    deployment: { profile: 'postgres-sql', bundleDigest: '1'.repeat(64), schemaDigest: '2'.repeat(64) },
    actions: [{ id: 'counter.set', effect: 'write', scope: 'member', inputSchemaRef: 'schemas/input.json', outputSchemaRef: 'schemas/output.json', timeoutMs: 10000 }],
    permissions: { rootReads: [], rootWrites: [], egress: [] }, surfaces: [],
    data: { classes: ['sample.counter'], retention: 'until-user-delete', exportVersion: 1, schemaVersion: '1', readableSchemaVersions: ['1'] } }
  value.releaseDigest = releaseDigest(value)
  return value
}
function signed(claims, key, kid = 'synthetic-key') {
  const header = Buffer.from(canonicalJson({ alg: 'ES256', typ: 'JWT', kid })).toString('base64url')
  const body = Buffer.from(canonicalJson(claims)).toString('base64url')
  const data = `${header}.${body}`
  return `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}
function runtime({ consume, run, timeoutMs = 10000 } = {}) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const m = manifest(); m.actions[0].timeoutMs = timeoutMs; m.releaseDigest = releaseDigest(m)
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: 'https://host.synthetic.invalid', aud: 'https://backend.synthetic.invalid', iat: now, nbf: now, exp: now + 60,
    jti: 'invocation_synthetic_1234', purpose: 'extension.invoke/v1', ...binding, releaseDigest: m.releaseDigest,
    tenantRef: 'studio_synthetic_123456', subjectRef: 'subject_synthetic_12345', operationId: 'operation_synthetic_123',
    actionId: 'counter.set', payloadDigest: digest({ value: 4 }), rootWrites: [] }
  let calls = 0
  const extension = defineExtension({ manifest: m, verifier: { issuer: claims.iss, audience: claims.aud, keys: new Map([['synthetic-key', keys.publicKey]]),
    installationId: binding.installationId, releaseDigest: m.releaseDigest, consume: consume ?? (async () => { calls++; return true }) },
    actions: { 'counter.set': defineAction({ input: value => { assert.deepEqual(value, { value: 4 }); return value }, output: value => value,
      run: run ?? (async ({ scope }) => { assertVerifiedScope(scope); return { accepted: true } }) }) } })
  const handler = createExtensionHandler(extension)
  const request = (change = {}, input = { value: 4 }) => handler(new Request(claims.aud, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${signed({ ...claims, ...change }, keys.privateKey)}` }, body: JSON.stringify(input) }))
  return { request, calls: () => calls, claims }
}

test('canonical JSON refuses non-JSON values without invoking accessors', () => {
  assert.equal(canonicalJson({ z: -0, a: [true, null] }), '{"a":[true,null],"z":0}')
  let accessed = false
  const getter = { get x() { accessed = true; return 1 } }
  for (const value of [NaN, undefined, '\ud800', getter, new Date(), [, 1], { [Symbol('x')]: 1 }]) assert.throws(() => canonicalJson(value), ExtensionError)
  assert.equal(accessed, false)
})
test('manifest is detached and rejects undeclared fields, paths, profiles and invalid recovery', () => {
  const m = manifest(); const detached = parseManifest(m); m.permissions.rootWrites.push('later')
  assert.deepEqual(detached.permissions.rootWrites, [])
  for (const change of [m => m.unexpectedField = 'extra', m => m.deployment.profile = 'unknown', m => m.actions[0].inputSchemaRef = '../input.json',
    m => m.actions[0].id = 'extension.disable', m => m.recovery = { lookupActionId: 'counter.set' }, m => m.releaseVersion = '1.0.0-01']) {
    const invalid = manifest(); change(invalid); assert.throws(() => parseManifest(invalid), ExtensionError)
  }
})
test('binding and receipt parsers refuse invalid generations and success without durable result', () => {
  assert.deepEqual(parseInstallationBinding(binding), binding)
  assert.throws(() => parseInstallationBinding({ ...binding, generation: '9223372036854775808' }))
  assert.throws(() => parseOperationReceipt({ operationId: 'operation_synthetic_123', state: 'succeeded' }))
  assert.throws(() => parseOperationReceipt({ operationId: 'operation_synthetic_123', state: 'unknown', result: {} }))
  assert.equal(parseOperationReceipt({ operationId: 'operation_synthetic_123', state: 'failed' }).state, 'failed')
})
test('member transport performs one write, retains uncertainty and uses explicit lookup/recovery', async () => {
  const seen = []
  const transport = createHttpHostTransport(async (path, options) => {
    seen.push({ path, options })
    if (path.includes('/actions/')) throw new Error('synthetic lost acknowledgement')
    return Response.json(path.endsWith('/lookup') ? null : { operationId: 'operation_synthetic_123', state: 'unknown' })
  })
  const client = createExtensionClient(transport)
  await assert.rejects(client.invoke(binding, 'counter.set', { value: 4 }, 'same-key'))
  assert.equal(seen.length, 1)
  assert.equal(await client.lookupOperation(binding.installationId, 'same-key', 'counter.set'), null)
  assert.equal((await client.recoverOperation(binding, 'same-key', 'counter.set')).state, 'unknown')
  assert.equal(seen.filter(x => x.path.includes('/actions/')).length, 1)
  assert.ok(seen.every(x => x.options.redirect === 'error' && x.options.cache === 'no-store'))
})
test('admin client sends pinned release and rejects invalid transitions before host access', async () => {
  let called = 0
  const admin = createExtensionAdminClient({ configure: async (m, ref, env) => { called++; assert.equal(ref, 'existing-connection'); assert.equal(env, 'development'); return { ...binding, releaseDigest: m.releaseDigest } } })
  assert.equal((await admin.configure(manifest(), 'existing-connection')).generation, '1')
  await assert.rejects(admin.transition(binding, 'arbitrary'), ExtensionError)
  assert.equal(called, 1)
})
test('invalid client input rejects asynchronously and performs no host operation', async () => {
  const client = createExtensionClient({ invoke() { assert.fail('must not invoke') } })
  const promise = client.invoke({ ...binding, generation: '0' }, 'counter.set', {}, 'key')
  assert.ok(promise instanceof Promise); await assert.rejects(promise, ExtensionError)
})
test('signed admission binds scope and revokes the in-process effect capability on completion', async () => {
  let captured
  const r = runtime({ run: async ({ scope }) => { captured = scope; assertVerifiedScope(scope); return { accepted: true } } })
  const response = await r.request(); assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).result, { accepted: true }); assert.equal(r.calls(), 1)
  assert.throws(() => assertVerifiedScope(captured), ExtensionError)
  assert.throws(() => assertVerifiedScope({ ...captured }), ExtensionError)
})
test('wrong scope, audience, expiry and body refuse before durable admission', async () => {
  const r = runtime()
  for (const change of [{ aud: 'https://other.synthetic.invalid' }, { installationId: 'other_installation_1234' }, { exp: 1 }, { rootWrites: ['unexpected'] }]) {
    assert.equal((await r.request(change)).status, 401)
  }
  assert.equal((await r.request({}, { value: 5 })).status, 400); assert.equal(r.calls(), 0)
})
test('root refusal never reaches the extension effect', async () => {
  const r = runtime({ consume: async () => false, run: async () => assert.fail('not admitted') })
  assert.equal((await r.request()).status, 403)
})
test('deadline returns uncertainty and invalidates scope even when a handler ignores abort', async () => {
  let captured
  const r = runtime({ timeoutMs: 10, run: async ({ scope }) => { captured = scope; return new Promise(() => {}) } })
  assert.equal((await r.request()).status, 409)
  assert.throws(() => assertVerifiedScope(captured), ExtensionError)
})
test('admission consumer binds one HTTPS destination and refuses redirects and oversized replies', async () => {
  let seen
  const consume = createRootAdmissionConsumer({ origin: 'https://host.synthetic.invalid', fetch: async (url, options) => {
    seen = { url, options }; return Response.json({ admitted: true })
  } })
  assert.equal(await consume({}, 'signed-delegation'), true)
  assert.equal(String(seen.url), 'https://host.synthetic.invalid/api/root-runtime/extensions/admissions/consume')
  assert.equal(seen.options.redirect, 'error'); assert.deepEqual(JSON.parse(seen.options.body), { delegation: 'signed-delegation' })
  assert.throws(() => createRootAdmissionConsumer({ origin: 'https://host.synthetic.invalid/path' }))
  const large = createRootAdmissionConsumer({ origin: 'https://host.synthetic.invalid', fetch: async () => new Response(' '.repeat(1025), { headers: { 'content-type': 'application/json' } }) })
  await assert.rejects(large({}, 'signed-delegation'), { code: 'unavailable' })
})

test('handler construction requires a defined extension rather than a plain claim object', () => {
  assert.throws(() => createExtensionHandler({ manifest: manifest() }), ExtensionError)
})

test('client transport refuses an oversized host response', async () => {
  const client = createExtensionClient(createHttpHostTransport(async () => new Response(' '.repeat(131073))))
  await assert.rejects(client.getInstallation(binding.installationId), { code: 'unavailable' })
})
