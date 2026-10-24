import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import ts from 'typescript'
import { canonicalJson } from '../src/extensions/contracts.mjs'
import { createChecklistProject } from '../src/extensions/scaffold-checklist.mjs'
import { exportReleaseBundle, scaffoldPostgres, scaffoldSqlProject, scaffoldConvexProject, sealProject, validateProject } from '../src/extensions/project.mjs'
import { digest } from '../src/extensions/server.mjs'

const kitRoot = fileURLToPath(new URL('..', import.meta.url))
const kit = JSON.parse(await readFile(path.join(kitRoot, 'package.json')))
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'atelier-task-rows-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, directory: path.join(root, 'project') }
}
const generate = options => createChecklistProject({ profile: 'postgres-sql', packageVersion: kit.version, sealProject, ...options })

test('explicit checklist project seals provider schemas and declares no host surface or root permission', async t => {
  const { directory } = await fixture(t), created = await generate({ directory })
  assert.equal(created.model, 'checklist'); assert.equal(created.hostBinding, 'unbound'); assert.equal(created.qualified, false)
  assert.equal((await validateProject(directory)).valid, true)
  const bundle = await exportReleaseBundle(directory), manifest = bundle.manifest
  assert.equal(manifest.extensionId, 'sample.tasks'); assert.equal(manifest.deployment.profile, 'postgres-sql')
  assert.deepEqual(manifest.surfaces, []); assert.deepEqual(manifest.compatibility.rootContracts, [])
  assert.deepEqual(manifest.permissions, { rootReads: [], rootWrites: [], egress: [] })
  assert.deepEqual(manifest.actions.map(action => [action.id, action.effect]), [
    ['checklist.add', 'write'], ['checklist.update', 'write'], ['checklist.read', 'read'], ['checklist.export', 'read'], ['checklist.delete', 'write'], ['checklist.lookup', 'read'],
  ])
  assert.equal(manifest.recovery.lookupActionId, 'checklist.lookup')
  assert.equal(Object.keys(bundle.schemaFiles).length, 12)
  const ajv = new Ajv2020({ strict: true })
  for (const bytes of Object.values(bundle.schemaFiles)) ajv.compile(JSON.parse(bytes))
  const add = ajv.compile(JSON.parse(bundle.schemaFiles['schemas/checklist-add-input.json']))
  assert.equal(add({ slot: 32, label: '😀'.repeat(80) }), true)
  for (const input of [{ slot: 0, label: 'Seed' }, { slot: 33, label: 'Seed' }, { slot: 1.5, label: 'Seed' },
    { slot: 1, label: '' }, { slot: 1, label: '😀'.repeat(81) }, { slot: 1, label: 'line\nbreak' }, { slot: 1, label: 'Seed', checked: true }]) assert.equal(add(input), false)
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json')))
  assert.deepEqual(pkg.dependencies, { '@mnstry/atelier': kit.version, postgres: '3.4.7' })
  const sql = await readFile(path.join(directory, 'migrations/001-initial.sql'), 'utf8')
  assert.match(sql, /CHECK\(slot BETWEEN 1 AND 32\)/)
  assert.match(sql, /PRIMARY KEY\(installation_id,tenant_ref,subject_ref,slot\)/)
  assert.equal((sql.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length, 2)
  const backend = await readFile(path.join(directory, 'src/backend.ts'), 'utf8')
  assert.ok(!backend.includes('recordResult')); assert.ok(!backend.includes('.listen('))
  await writeFile(path.join(directory, 'schemas/checklist-add-input.json'), '{}\n')
  await assert.rejects(validateProject(directory), /stale/)
})

test('unsupported profiles and invalid identities refuse before creating a directory; existing data survives', async t => {
  const { root, directory } = await fixture(t)
  for (const profile of ['drizzle-db-first', 'drizzle-code-first', 'prisma-7-postgres', 'convex-native', undefined, 'unknown']) {
    await assert.rejects(generate({ directory, profile }), /unsupported checklist profile/)
  }
  for (const extensionId of [null, '', 'bad', 'sample.too.many', 'mnstry.tasks', 'mnstry-lookalike.tasks', '../sample.tasks']) {
    await assert.rejects(generate({ directory, extensionId }), /invalid extension id/)
  }
  await assert.rejects(readFile(path.join(directory, 'package.json')), { code: 'ENOENT' })
  await mkdir(directory); const sentinel = path.join(directory, 'owner.txt'); await writeFile(sentinel, 'invented owner data')
  await assert.rejects(generate({ directory }), { code: 'EEXIST' })
  assert.equal(await readFile(sentinel, 'utf8'), 'invented owner data')
  const failing = path.join(root, 'failing')
  await assert.rejects(generate({ directory: failing, sealProject: async () => { throw new Error('synthetic seal failure') } }), /synthetic seal failure/)
  await assert.rejects(readFile(path.join(failing, 'package.json')), { code: 'ENOENT' })
  const replaced = path.join(root, 'replaced')
  await assert.rejects(generate({ directory: replaced, sealProject: async target => {
    await rename(target, path.join(root, 'original-reservation'))
    await mkdir(target); await writeFile(path.join(target, 'owner.txt'), 'replacement owner data')
    throw new Error('synthetic replacement')
  } }), /synthetic replacement/)
  assert.equal(await readFile(path.join(replaced, 'owner.txt'), 'utf8'), 'replacement owner data')
})

test('public project API requires explicit model selection and refuses unsupported combinations', async t => {
  const { root } = await fixture(t)
  const checklist = path.join(root, 'checklist')
  assert.equal((await scaffoldPostgres({ directory: checklist, model: 'checklist' })).model, 'checklist')
  const defaultCounter = path.join(root, 'default'), explicitCounter = path.join(root, 'explicit')
  await scaffoldPostgres({ directory: defaultCounter }); await scaffoldPostgres({ directory: explicitCounter, model: 'counter' })
  for (const file of ['src/backend.ts', 'migrations/001-initial.sql', 'extension.manifest.json', 'atelier.extension-pack.json']) {
    assert.deepEqual(await readFile(path.join(defaultCounter, file)), await readFile(path.join(explicitCounter, file)))
  }
  // Exact generated counter bytes at the public source base 574817eba796b2f8a156dc35305c1bb918bc48dc.
  for (const [file, expected] of [
    ['src/backend.ts', '81b9fa587dba5b740d5b85db993846b9d125773da4f875014097f9458223f099'],
    ['migrations/001-initial.sql', '4cb3284bdb8a6f7b40ebbafd75135e14a62ccacbade2f2d3865ff3b6bcc8c2df'],
  ]) assert.equal(createHash('sha256').update(await readFile(path.join(defaultCounter, file))).digest('hex'), expected)
  for (const profile of ['drizzle-db-first', 'drizzle-code-first', 'prisma-7-postgres']) {
    await assert.rejects(scaffoldSqlProject({ directory: path.join(root, profile), profile, model: 'checklist' }), /unsupported checklist profile/)
  }
  await assert.rejects(scaffoldConvexProject({ directory: path.join(root, 'convex'), model: 'checklist' }), /unsupported checklist profile/)
  await assert.rejects(scaffoldPostgres({ directory: path.join(root, 'bad-model'), model: 'unknown' }))
})

test('project declarations expose the existing API and restrict checklist to PostgreSQL', async t => {
  const { root } = await fixture(t), file = path.join(root, 'consumer.mts')
  const target = path.relative(root, path.join(kitRoot, 'src/extensions/project.mjs')).split(path.sep).join('/')
  await writeFile(file, `import { scaffoldPostgres, scaffoldSqlProject, scaffoldConvexProject, sealProject, validateProject, exportReleaseBundle } from ${JSON.stringify(target.startsWith('.') ? target : './' + target)}
scaffoldPostgres({ directory: './tasks', model: 'checklist' }).then(result => { const qualified: false = result.qualified; const digest: string = result.releaseDigest })
scaffoldSqlProject({ directory: './tasks', model: 'checklist', profile: 'postgres-sql' })
scaffoldSqlProject({ directory: './counter', profile: 'drizzle-db-first' })
scaffoldConvexProject({ directory: './counter' })
sealProject('./tasks'); validateProject('./tasks'); exportReleaseBundle('./tasks')
// @ts-expect-error unsupported checklist provider
scaffoldSqlProject({ directory: './tasks', model: 'checklist', profile: 'drizzle-db-first' })
// @ts-expect-error unsupported checklist provider
scaffoldConvexProject({ directory: './tasks', model: 'checklist' })
// @ts-expect-error closed public model selection
scaffoldPostgres({ directory: './tasks', model: 'unknown' })
`)
  const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, types: [], target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: value => value, getNewLine: () => '\n',
  }))
})

// Offline native-tag double: tests actual SDK admission, scoped transaction and
// receipt helpers. It does not implement PostgreSQL or prove its RLS behavior.
function databaseDouble() {
  let state = { tasks: new Map(), operations: new Map() }
  const trace = []
  const flags = { unsafeRole: false, failTaskWrite: false }
  const key = values => JSON.stringify(values)
  const scoped = (values, scope) => assert.deepEqual(values, scope)
  const database = { begin: async run => {
    const working = structuredClone(state); let scope
    trace.push('begin')
    const sql = async (parts, ...values) => {
      const query = parts.join(' ? ').replace(/\s+/g, ' ').trim(); trace.push(query)
      if (query.includes('FROM pg_roles r')) return [{ rolsuper: flags.unsafeRole, rolbypassrls: false, unsafe_membership: false, unsafe_tables: false }]
      if (query.startsWith("SELECT set_config('extension.installation_id'")) { scope = values; return [] }
      if (query.startsWith("SELECT set_config('statement_timeout'")) return []
      if (query === 'SHOW server_version_num') return [{ server_version_num: '170000' }]
      if (query.includes('LIMIT 0')) return []
      assert.ok(scope, 'scope settings must precede application SQL')
      if (query.startsWith('INSERT INTO extension_data.operations')) {
        scoped(values.slice(0, 3), scope)
        const id = key(values.slice(0, 4))
        if (!working.operations.has(id)) working.operations.set(id, { operation_id: values[3], action_id: values[4], generation: values[5],
          release_digest: values[6], payload_digest: values[7], completed: false, result: null })
        return []
      }
      if (query.startsWith('SELECT action_id') || query.startsWith('SELECT operation_id')) {
        scoped(values.slice(0, 3), scope)
        const row = working.operations.get(key(values))
        return row && (!query.includes('completed=true') || row.completed) ? [structuredClone(row)] : []
      }
      if (query.startsWith('UPDATE extension_data.operations')) {
        scoped(values.slice(1, 4), scope)
        Object.assign(working.operations.get(key(values.slice(1))), { completed: true, result: structuredClone(values[0]) }); return []
      }
      if (query.startsWith('INSERT INTO extension_data.tasks')) {
        scoped(values.slice(0, 3), scope)
        const id = key(values.slice(0, 4)), exists = working.tasks.has(id)
        if (!exists) working.tasks.set(id, { scope, slot: values[3], label: values[4], checked: false })
        if (flags.failTaskWrite) { flags.failTaskWrite = false; throw new Error('synthetic task failure') }
        return exists ? [] : [{ slot: values[3] }]
      }
      if (query.startsWith('UPDATE extension_data.tasks')) {
        scoped(values.slice(1, 4), scope)
        const row = working.tasks.get(key(values.slice(1)))
        if (row) row.checked = values[0]
        if (flags.failTaskWrite) { flags.failTaskWrite = false; throw new Error('synthetic task failure') }
        return row ? [{ slot: row.slot }] : []
      }
      if (query.startsWith('SELECT slot,label,checked')) {
        scoped(values, scope)
        return [...working.tasks.values()].filter(row => key(row.scope) === key(scope)).sort((a, b) => a.slot - b.slot)
          .map(({ slot, label, checked }) => ({ slot, label, checked }))
      }
      if (query.startsWith('DELETE FROM extension_data.tasks')) {
        scoped(values, scope); const removed = []
        for (const [id, row] of working.tasks) if (key(row.scope) === key(scope)) { working.tasks.delete(id); removed.push({ slot: row.slot }) }
        return removed
      }
      if (query.startsWith('DELETE FROM extension_data.operations')) {
        scoped(values.slice(0, 3), scope)
        for (const id of working.operations.keys()) {
          const parts = JSON.parse(id)
          if (key(parts.slice(0, 3)) === key(scope) && parts[3] !== values[3]) working.operations.delete(id)
        }
        return []
      }
      assert.fail(`unexpected test SQL: ${query}`)
    }
    sql.json = value => value
    try { const result = await run(sql); state = working; trace.push('commit'); return result }
    catch (error) { trace.push('rollback'); throw error }
  } }
  return { database, flags, trace, snapshot: () => structuredClone(state) }
}

async function runtime(t) {
  const { directory } = await fixture(t); await generate({ directory })
  const manifest = JSON.parse(await readFile(path.join(directory, 'extension.manifest.json')))
  const modules = path.join(directory, 'node_modules/@mnstry'); await mkdir(modules, { recursive: true })
  await symlink(kitRoot, path.join(modules, 'atelier'), process.platform === 'win32' ? 'junction' : 'dir')
  // Runtime-only coverage: stripping is not a TypeScript compiler verdict or
  // an installed-tarball/native-driver proof. The receiving lane owns those.
  const source = await readFile(path.join(directory, 'src/backend.ts'), 'utf8')
  const output = path.join(directory, 'backend.js'); await writeFile(output, stripTypeScriptTypes(source))
  const { createBackend } = await import(pathToFileURL(output))
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), db = databaseDouble()
  const binding = { installationId: 'installation_task_sample', generation: '1', releaseDigest: manifest.releaseDigest }
  const base = { ...binding, iss: 'https://host.synthetic.invalid', aud: 'https://provider.synthetic.invalid', purpose: 'extension.invoke/v1',
    tenantRef: 'tenant_task_sample_12345', subjectRef: 'subject_task_sample_1234', rootWrites: [] }
  let admitted = true, admissions = 0, sequence = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://host.synthetic.invalid/api/root-runtime/extensions/admissions/consume')
    admissions++; return admitted ? Response.json({ admitted: true }) : new Response(null, { status: 403 })
  }
  let backend
  try { backend = createBackend({ database: db.database, manifest, rootOrigin: base.iss,
    verifier: { issuer: base.iss, audience: base.aud, installationId: binding.installationId, releaseDigest: binding.releaseDigest, keys: new Map([['sample-key', keys.publicKey]]) } }) }
  finally { globalThis.fetch = previousFetch }
  const invoke = async (actionId, input, changes = {}) => {
    const now = Math.floor(Date.now() / 1000)
    const claims = { ...base, actionId, operationId: `operation_task_${String(++sequence).padStart(8, '0')}`, payloadDigest: digest(input),
      jti: `invocation_task_${String(sequence).padStart(8, '0')}`, iat: now, nbf: now, exp: now + 60, ...changes }
    const header = Buffer.from(canonicalJson({ alg: 'ES256', typ: 'JWT', kid: 'sample-key' })).toString('base64url')
    const body = Buffer.from(canonicalJson(claims)).toString('base64url'), signed = `${header}.${body}`
    const delegationJwt = `${signed}.${sign('sha256', Buffer.from(signed), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
    const response = await backend.handler(new Request(base.aud, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${delegationJwt}` }, body: canonicalJson(input) }))
    return { status: response.status, body: await response.json(), claims }
  }
  return { ...db, invoke, manifest, base, backend, deny: () => { admitted = false }, admissions: () => admissions }
}

test('generated backend uses independent row actions and immutable scoped operation recovery', async t => {
  const r = await runtime(t), original = 'operation_original_task_123'
  const add = await r.invoke('checklist.add', { slot: 2, label: 'Water the invented fern' }, { operationId: original })
  assert.equal(add.status, 200); assert.deepEqual(add.body.result, { created: true })
  const writes = () => r.trace.filter(query => query.startsWith('INSERT INTO extension_data.tasks')).length
  assert.deepEqual((await r.invoke('checklist.add', { slot: 2, label: 'Water the invented fern' }, { operationId: original })).body.result, { created: true })
  assert.equal(writes(), 1)
  assert.deepEqual((await r.invoke('checklist.add', { slot: 2, label: 'Different label' })).body.result, { created: false })
  assert.deepEqual((await r.invoke('checklist.update', { slot: 2, checked: true })).body.result, { matched: true })
  assert.deepEqual((await r.invoke('checklist.update', { slot: 1, checked: true })).body.result, { matched: false })
  const rows = [{ slot: 2, label: 'Water the invented fern', checked: true }]
  assert.deepEqual((await r.invoke('checklist.read', {})).body.result, { tasks: rows })
  assert.deepEqual((await r.invoke('checklist.export', {})).body.result, { format: 'sample.task-rows/v1', rows })
  const recovered = await r.invoke('checklist.lookup', { operationId: original }, { generation: '2' })
  assert.equal(recovered.status, 200)
  assert.deepEqual(recovered.body.result, { schema: 'mnstry.extension-provider-operation/v1', installationId: r.base.installationId,
    operationId: original, actionId: 'checklist.add', generation: '1', releaseDigest: r.manifest.releaseDigest,
    payloadDigest: digest({ slot: 2, label: 'Water the invented fern' }), resultDigest: digest({ created: true }), result: { created: true } })
  for (const changes of [{ generation: '2' }, {}]) {
    const input = changes.generation ? { slot: 2, label: 'Water the invented fern' } : { slot: 2, label: 'Changed payload' }
    assert.equal((await r.invoke('checklist.add', input, { operationId: original, ...changes })).status, 409)
  }
  assert.equal((await r.invoke('checklist.update', { slot: 2, checked: false }, { operationId: original })).status, 409)
  const otherSubject = { subjectRef: 'subject_other_sample_123' }
  assert.equal((await r.invoke('checklist.lookup', { operationId: original }, otherSubject)).body.result, null)
  assert.deepEqual((await r.invoke('checklist.read', {}, otherSubject)).body.result, { tasks: [] })
  assert.deepEqual((await r.invoke('checklist.read', {}, { tenantRef: 'tenant_other_sample_1234' })).body.result, { tasks: [] })
  await r.invoke('checklist.add', { slot: 2, label: 'Another subject row' }, otherSubject)
  const deletion = await r.invoke('checklist.delete', {})
  assert.deepEqual(deletion.body.result, { deleted: 1, retention: 'provider-live-rows-deleted', backups: 'operator-policy' })
  assert.equal((await r.invoke('checklist.lookup', { operationId: original })).body.result, null)
  assert.deepEqual((await r.invoke('checklist.lookup', { operationId: deletion.claims.operationId })).body.result.result, deletion.body.result)
  assert.deepEqual((await r.invoke('checklist.read', {}, otherSubject)).body.result.tasks, [{ slot: 2, label: 'Another subject row', checked: false }])
  assert.deepEqual((await r.invoke('checklist.delete', {}, { operationId: deletion.claims.operationId })).body.result, deletion.body.result)
  assert.deepEqual(await r.backend.health(), { ready: true, profile: 'postgres-sql', postgresMajor: 17 })
})

test('input/admission/role refusal and transactional failure leave task effects uncommitted', async t => {
  const r = await runtime(t)
  for (const input of [{ slot: 33, label: 'No row' }, { slot: 1, label: '😀'.repeat(81) }, { slot: 1, label: 'No\nrow' }, { slot: 1, label: 'No row', extra: true }]) {
    assert.equal((await r.invoke('checklist.add', input)).status, 400)
  }
  assert.equal(r.admissions(), 0); assert.equal(r.trace.length, 0)
  assert.equal((await r.invoke('checklist.update', { slot: 1, checked: 'yes' })).status, 400)
  assert.equal((await r.invoke('checklist.lookup', { operationId: 'invalid' })).status, 400)
  assert.equal((await r.invoke('checklist.read', { extra: true })).status, 400)
  assert.equal((await r.invoke('checklist.read', {}, { installationId: 'installation_other_12345' })).status, 401)
  assert.equal(r.admissions(), 0); assert.equal(r.trace.length, 0)
  const added = await r.invoke('checklist.add', { slot: 32, label: '😀'.repeat(80) }); assert.equal(added.status, 200)
  r.flags.failTaskWrite = true
  const failed = await r.invoke('checklist.update', { slot: 32, checked: true })
  assert.equal(failed.status, 409); assert.equal(r.trace.at(-1), 'rollback')
  assert.equal([...r.snapshot().tasks.values()][0].checked, false)
  assert.equal([...r.snapshot().operations.values()].some(row => row.operation_id === failed.claims.operationId), false)
  r.flags.unsafeRole = true
  assert.equal((await r.invoke('checklist.update', { slot: 32, checked: true })).status, 409)
  assert.equal([...r.snapshot().tasks.values()][0].checked, false)
  r.flags.unsafeRole = false; r.deny()
  const before = r.trace.length
  assert.equal((await r.invoke('checklist.update', { slot: 32, checked: true })).status, 403)
  assert.equal(r.trace.length, before)
})
