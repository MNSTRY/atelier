import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'
import { canonicalJson, ExtensionError } from '../src/extensions/contracts.mjs'
import { digest, releaseDigest } from '../src/extensions/server.mjs'
import { assertConvexScope, convexDigest, createRootAdmissionConsumer, createConvexHttpHandler, defineConvexExtension, runConvexInvocation } from '../src/extensions/convex.mjs'
import { scaffoldConvexProject, validateProject, sealProject, exportReleaseBundle } from '../src/extensions/project.mjs'

function fixture({ consume = async () => true, run = async () => ({ value: 4 }), output = value => value } = {}) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const manifest = { schema: 'mnstry.extension-manifest/v1', extensionId: 'sample.counter', releaseVersion: '1.0.0', releaseDigest: '0'.repeat(64),
    protocol: 'mnstry.extension/v1', compatibility: { sdkMajor: 1, rootContracts: [], hosts: ['web'] },
    deployment: { profile: 'convex-native', bundleDigest: '1'.repeat(64), schemaDigest: '2'.repeat(64) },
    actions: [{ id: 'counter.set', effect: 'write', scope: 'member', inputSchemaRef: 'schemas/input.json', outputSchemaRef: 'schemas/output.json', timeoutMs: 10000 }],
    permissions: { rootReads: [], rootWrites: [], egress: [] }, surfaces: [],
    data: { classes: ['sample.counter'], retention: 'until-user-delete', exportVersion: 1, schemaVersion: '1', readableSchemaVersions: ['1'] } }
  manifest.releaseDigest = releaseDigest(manifest)
  const now = Math.floor(Date.now() / 1000)
  const claims = { iss: 'https://root.synthetic.invalid', aud: 'https://backend.synthetic.invalid/invoke', iat: now, nbf: now, exp: now + 60,
    jti: 'invocation_synthetic_1234', purpose: 'extension.invoke/v1', installationId: 'installation_synthetic_123', generation: '1', releaseDigest: manifest.releaseDigest,
    tenantRef: 'studio_synthetic_123456', subjectRef: 'subject_synthetic_12345', operationId: 'operation_synthetic_123', actionId: 'counter.set', payloadDigest: digest({ value: 4 }), rootWrites: [] }
  const verifier = { issuer: claims.iss, audience: claims.aud, installationId: claims.installationId, releaseDigest: manifest.releaseDigest,
    keys: new Map([['synthetic-key', pair.publicKey.export({ format: 'jwk' })]]), consume }
  const extension = defineConvexExtension({ manifest, verifier, actions: { 'counter.set': { input: value => value, output, run } } })
  function mintDelegation(change = {}, key = pair.privateKey) {
    const head = Buffer.from(canonicalJson({ alg: 'ES256', typ: 'JWT', kid: 'synthetic-key' })).toString('base64url')
    const body = Buffer.from(canonicalJson({ ...claims, ...change })).toString('base64url')
    const data = `${head}.${body}`
    return `${data}.${sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
  }
  const request = (handler, change = {}, payload = { value: 4 }) => handler(new Request(claims.aud, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer ${mintDelegation(change)}` }, body: JSON.stringify(payload) }))
  return { extension, verifier, manifest, mintDelegation, request, claims }
}

test('Web Crypto digests retain the Node protocol byte identity', async () => {
  for (const value of [null, { z: -0, a: ['synthetic', true] }, { value: 4 }]) assert.equal(await convexDigest(value), digest(value))
  await assert.rejects(convexDigest({ get value() { assert.fail('getter must not run') } }), ExtensionError)
})
test('HTTP action consumes once and internal mutation independently verifies the original token', async () => {
  let admissions = 0, effects = 0, captured
  const f = fixture({ consume: async () => { admissions++; return true }, run: async ({ scope }) => { assertConvexScope(scope); captured = scope; effects++; return { value: 4 } } })
  const handler = createConvexHttpHandler(f.extension, args => runConvexInvocation(f.extension, {}, args))
  const response = await f.request(handler)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).result, { value: 4 })
  assert.equal(admissions, 1); assert.equal(effects, 1)
  assert.throws(() => assertConvexScope(captured), ExtensionError)
  assert.throws(() => assertConvexScope({ ...captured }), ExtensionError)
})
test('internal mutation refuses stale scope, altered payload, wrong key and extra authority fields', async () => {
  let effects = 0
  const f = fixture({ run: async () => { effects++; return {} } })
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  for (const args of [
    { delegation: f.mintDelegation(), payload: { value: 5 } },
    { delegation: f.mintDelegation({ exp: f.claims.iat }), payload: { value: 4 } },
    { delegation: f.mintDelegation({ rootWrites: ['undeclared.write'] }), payload: { value: 4 } },
    { delegation: f.mintDelegation({ installationId: 'installation_foreign_123' }), payload: { value: 4 } },
    { delegation: f.mintDelegation({}, other.privateKey), payload: { value: 4 } },
    { delegation: f.mintDelegation(), payload: { value: 4 }, admitted: true },
    { scope: f.claims, payload: { value: 4 } },
  ]) await assert.rejects(runConvexInvocation(f.extension, {}, args), ExtensionError)
  assert.equal(effects, 0)
})
test('Root refusal and malformed payload never dispatch a private mutation', async () => {
  const f = fixture({ consume: async () => false })
  let invocations = 0
  const handler = createConvexHttpHandler(f.extension, async () => { invocations++; assert.fail('must refuse') })
  assert.equal((await f.request(handler)).status, 403)
  assert.equal((await f.request(handler, {}, { value: 5 })).status, 400)
  assert.equal(invocations, 0)
})
test('an uncertain reply performs one mutation and discloses no exception text', async () => {
  const f = fixture()
  let effects = 0
  const handler = createConvexHttpHandler(f.extension, async args => { await runConvexInvocation(f.extension, {}, args); effects++; throw new Error('synthetic-private-detail') })
  const response = await f.request(handler)
  assert.equal(response.status, 409); assert.equal(effects, 1)
  assert.deepEqual(await response.json(), { code: 'operation-unknown' })
})
test('definitions detach public keys and release source from subsequent configuration changes', async () => {
  const f = fixture()
  f.verifier.keys.clear(); f.manifest.permissions.rootWrites.push('later.write')
  const receipt = await runConvexInvocation(f.extension, {}, { delegation: f.mintDelegation(), payload: { value: 4 } })
  assert.equal(receipt.state, 'succeeded')
})
test('runtime bundles for the native browser-like provider without Node imports', async () => {
  const output = await build({ entryPoints: [fileURLToPath(new URL('../src/extensions/convex.mjs', import.meta.url))], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true })
  assert.ok(Object.keys(output.metafile.inputs).every(file => !file.includes('node_modules')))
  assert.ok(!output.outputFiles[0].text.includes('node:'))
})
test('Convex project uses existing sealing and bundle workflow with native source identities', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'atelier-convex-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'app')
  const generated = await scaffoldConvexProject({ directory: project })
  assert.equal(generated.profile, 'convex-native'); assert.equal(generated.qualified, false)
  assert.equal((await validateProject(project)).valid, true)
  const pkg = JSON.parse(await readFile(path.join(project, 'package.json')))
  assert.equal(pkg.dependencies.convex, '1.46.0'); assert.equal(pkg.dependencies.postgres, undefined)
  const source = await readFile(path.join(project, 'convex/backend.ts'), 'utf8')
  assert.match(source, /internalMutation/); assert.doesNotMatch(source, /\bmutation\(/)
  const before = JSON.parse(await readFile(path.join(project, 'extension.manifest.json')))
  await writeFile(path.join(project, 'migrations/001-schema.ts'), (await readFile(path.join(project, 'migrations/001-schema.ts'), 'utf8')) + '\n// synthetic schema revision\n')
  await assert.rejects(validateProject(project))
  await sealProject(project)
  const bundle = await exportReleaseBundle(project)
  assert.equal(bundle.manifest.deployment.profile, 'convex-native')
  assert.ok(Object.hasOwn(bundle.migrationDigests, 'migrations/001-initial.json'))
  assert.ok(Object.hasOwn(bundle.migrationDigests, 'migrations/001-schema.ts'))
  assert.notEqual(bundle.manifest.deployment.schemaDigest, before.deployment.schemaDigest)
})

test('Convex loopback admission requires an explicit test option and both local deployment URLs', async () => {
  const original = Object.fromEntries(['CONVEX_CLOUD_URL', 'CONVEX_SITE_URL'].map(key => [key, process.env[key]]))
  const options = { origin: 'http://127.0.0.1:8999', allowLocalTesting: true, fetch: async () => Response.json({ admitted: true }) }
  try {
    delete process.env.CONVEX_CLOUD_URL; delete process.env.CONVEX_SITE_URL
    assert.throws(() => createRootAdmissionConsumer(options), ExtensionError)
    process.env.CONVEX_CLOUD_URL = 'http://127.0.0.1:8888'
    process.env.CONVEX_SITE_URL = 'https://deployment.synthetic.invalid'
    assert.throws(() => createRootAdmissionConsumer(options), ExtensionError)
    process.env.CONVEX_SITE_URL = 'http://127.0.0.1:8889'
    assert.throws(() => createRootAdmissionConsumer({ ...options, allowLocalTesting: false }), ExtensionError)
    assert.equal(await createRootAdmissionConsumer(options)({}, 'synthetic'), true)
  } finally {
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('admission transport works without AbortSignal.timeout', async () => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
  const env = Object.fromEntries(['CONVEX_CLOUD_URL', 'CONVEX_SITE_URL'].map(key => [key, process.env[key]]))
  try {
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
    process.env.CONVEX_CLOUD_URL = 'http://127.0.0.1:8888'; process.env.CONVEX_SITE_URL = 'http://127.0.0.1:8889'
    const consume = createRootAdmissionConsumer({ origin: 'http://127.0.0.1:8999', allowLocalTesting: true,
      fetch: async (_url, options) => { assert.ok(options.signal instanceof AbortSignal); return Response.json({ admitted: true }) } })
    assert.equal(await consume({}, 'synthetic'), true)
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', original)
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})

test('native output validators cannot diverge from the durable canonical result', async () => {
  for (const output of [value => ({ value: value.value + 1 }), value => { value.value++; return value }]) {
    const f = fixture({ output })
    await assert.rejects(runConvexInvocation(f.extension, {}, { delegation: f.mintDelegation(), payload: { value: 4 } }), ExtensionError)
  }
})

for (const [status, contentType] of [[401, 'application/json'], [403, 'application/json'], [500, 'application/json'], [200, 'text/plain']]) {
  test(`admission ${status}/${contentType} aborts and bounds cancellation of a pending response body`, async () => {
    let signal, cancelled = 0
    const body = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}) } })
    const consume = createRootAdmissionConsumer({ origin: 'https://root.synthetic.invalid', fetch: async (_url, options) => {
      signal = options.signal
      return new Response(body, { status, headers: { 'content-type': contentType } })
    } })
    const started = Date.now()
    if (status === 401 || status === 403) assert.equal(await consume({}, 'synthetic'), false)
    else await assert.rejects(consume({}, 'synthetic'), error => error instanceof ExtensionError && error.code === 'unavailable')
    assert.equal(signal.aborted, true); assert.equal(cancelled, 1)
    assert.ok(Date.now() - started < 2500, 'a refusal must not await an uncooperative body indefinitely')
  })
}
test('admission deadline covers a pending successful response body and aborts before bounded cleanup', async () => {
  let signal, cancelled = 0
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) },
    cancel() { cancelled++; return new Promise(() => {}) } })
  const consume = createRootAdmissionConsumer({ origin: 'https://root.synthetic.invalid', fetch: async (_url, options) => {
    signal = options.signal
    return new Response(body, { headers: { 'content-type': 'application/json' } })
  } })
  const started = Date.now()
  await assert.rejects(consume({}, 'synthetic'), error => error instanceof ExtensionError && error.code === 'unavailable')
  assert.equal(signal.aborted, true); assert.equal(cancelled, 1)
  assert.ok(Date.now() - started >= 4500)
  assert.ok(Date.now() - started < 12000, 'the full-response deadline and cleanup must stay bounded')
})
