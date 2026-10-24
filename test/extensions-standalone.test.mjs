import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { scaffoldStandaloneProject } from '../src/extensions/standalone.mjs'
import { digest, releaseDigest } from '../src/extensions/server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
// Synthetic manifest using only the existing public counter and wire contracts.
function counterManifest() {
  const manifest = { schema: 'mnstry.extension-manifest/v1', extensionId: 'sample.counter', releaseVersion: '1.0.0', releaseDigest: '0'.repeat(64),
    protocol: 'mnstry.extension/v1', compatibility: { sdkMajor: 1, rootContracts: [], hosts: ['web'] },
    deployment: { profile: 'postgres-sql', bundleDigest: '1'.repeat(64), schemaDigest: '2'.repeat(64) },
    actions: ['get', 'set'].map(action => ({ id: `counter.${action}`, effect: action === 'set' ? 'write' : 'read', scope: 'member',
      inputSchemaRef: `schemas/counter-${action}-input.json`, outputSchemaRef: `schemas/counter-${action}-output.json`, timeoutMs: 10000 })),
    permissions: { rootReads: [], rootWrites: [], egress: [] }, surfaces: [],
    data: { classes: ['sample.counter'], retention: 'until-user-delete', exportVersion: 1, schemaVersion: '1', readableSchemaVersions: ['1'] } }
  manifest.releaseDigest = releaseDigest(manifest)
  return manifest
}

test('standalone source runs without dependencies and optional binding retains the existing public client controls', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'atelier-standalone-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const app = path.join(directory, 'app'), result = await scaffoldStandaloneProject({ directory: app })
  assert.equal(result.mode, 'unbound'); assert.equal(result.rootAuthority, false); assert.equal(result.qualified, false)
  const pkg = JSON.parse(await readFile(path.join(app, 'package.json')))
  const kit = JSON.parse(await readFile(path.join(root, 'package.json')))
  assert.deepEqual(pkg.dependencies, { '@mnstry/atelier': kit.version })
  const modules = path.join(app, 'node_modules/@mnstry'); await mkdir(modules, { recursive: true })
  await symlink(root, path.join(modules, 'atelier'), process.platform === 'win32' ? 'junction' : 'dir')
  await mkdir(path.join(app, 'dist'))
  // Native runtime coverage only. Stripping is not a TypeScript compiler verdict
  // or an installed-tarball proof; the release lane verifies those separately.
  for (const name of ['local', 'root', 'main']) {
    const source = await readFile(path.join(app, `src/${name}.ts`), 'utf8')
    await writeFile(path.join(app, `dist/${name}.js`), stripTypeScriptTypes(source))
  }
  const { createLocalCounter } = await import(pathToFileURL(path.join(app, 'dist/local.js')))
  const { bindRootCounter } = await import(pathToFileURL(path.join(app, 'dist/root.js')))
  const manifest = counterManifest()
  const binding = { installationId: 'install_synthetic_12345', generation: '1', releaseDigest: manifest.releaseDigest }

  await t.test('unbound app changes local state and executes without fetching or obtaining Root authority', () => {
    const previous = globalThis.fetch
    globalThis.fetch = () => { throw new Error('unbound network call') }
    try {
      const local = createLocalCounter(); assert.equal(local.mode, 'unbound')
      assert.deepEqual(local.set(43), { value: 43 }); assert.deepEqual(local.get(), { value: 43 })
      assert.throws(() => local.set(-1), { code: 'invalid-input' }); assert.throws(() => local.set(NaN), { code: 'invalid-input' })
    } finally { globalThis.fetch = previous }
    const output = JSON.parse(execFileSync(process.execPath, ['dist/main.js', '19'], { cwd: app, encoding: 'utf8', timeout: 10000 }))
    assert.deepEqual(output, { mode: 'unbound', result: { value: 19 }, rootAuthority: false, storage: 'process-local' })
  })

  await t.test('binding delegates to public SDK transport without uploading local state or creating authority', async () => {
    const calls = [], local = createLocalCounter(88)
    const bound = await bindRootCounter({ manifest, installation: binding, hostFetch: async (url, init) => {
      calls.push({ url, init }); assert.ok(url.startsWith('/api/root-runtime/extensions/'))
      assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store')
      if (init.method === 'GET') return Response.json(binding)
      assert.match(url, /\/actions\/counter\.(get|set)$/)
      const body = JSON.parse(init.body)
      assert.deepEqual(Object.keys(body).sort(), ['generation', 'idempotencyKey', 'input', 'releaseDigest'])
      assert.equal(body.generation, binding.generation); assert.equal(body.releaseDigest, binding.releaseDigest)
      const result = url.endsWith('counter.set') ? body.input : { value: 3 }
      return Response.json({ operationId: 'operation_synthetic_12345', state: 'succeeded', result, resultDigest: digest(result) })
    } })
    assert.equal(calls.length, 1); assert.equal(bound.mode, 'root-bound')
    assert.deepEqual((await bound.get('sample-read')).result, { value: 3 })
    assert.deepEqual((await bound.set(6, 'sample-write')).result, { value: 6 })
    assert.deepEqual(local.get(), { value: 88 })
    assert.equal(calls.length, 5); assert.equal(calls.filter(call => call.init.method === 'POST').length, 2)
  })

  await t.test('stale generation refuses without an action or silent refresh', async () => {
    let calls = 0
    const bound = await bindRootCounter({ manifest, installation: binding, hostFetch: async () => {
      calls++; return Response.json(calls === 1 ? binding : { ...binding, generation: '2' })
    } })
    await assert.rejects(bound.set(6, 'sample-stale'), { code: 'stale-installation' }); assert.equal(calls, 2)
  })

  await t.test('authentication, permission and enablement refusals propagate without retry', async () => {
    for (const [code, status] of [['unauthorized', 401], ['forbidden', 403], ['disabled', 409], ['operation-unknown', 409]]) {
      let calls = 0
      const bound = await bindRootCounter({ manifest, installation: binding, hostFetch: async (url, init) => {
        calls++; return init.method === 'GET' ? Response.json(binding) : Response.json({ code }, { status })
      } })
      await assert.rejects(bound.set(6, 'sample-denied'), { code }); assert.equal(calls, 3)
    }
  })

  await t.test('tampered release or incompatible public action refuses before host access', async () => {
    let calls = 0
    const hostFetch = async () => { calls++; return Response.json(binding) }
    const changed = structuredClone(manifest); changed.releaseVersion = '2.0.0'
    await assert.rejects(bindRootCounter({ manifest: changed, installation: binding, hostFetch }), { code: 'stale-installation' })
    await assert.rejects(bindRootCounter({ manifest, installation: { ...binding, releaseDigest: 'b'.repeat(64) }, hostFetch }), { code: 'stale-installation' })
    const incompatible = structuredClone(manifest); incompatible.actions.find(a => a.id === 'counter.set').scope = 'tenant'
    incompatible.releaseDigest = releaseDigest(incompatible)
    await assert.rejects(bindRootCounter({ manifest: incompatible, installation: { ...binding, releaseDigest: incompatible.releaseDigest }, hostFetch }), { code: 'invalid-input' })
    assert.equal(calls, 0)
  })

  await t.test('existing directories keep their owner data', async () => {
    const sentinel = path.join(app, 'README.md'); await writeFile(sentinel, 'existing owner content')
    await assert.rejects(scaffoldStandaloneProject({ directory: app }))
    assert.equal(await readFile(sentinel, 'utf8'), 'existing owner content')
  })
})
