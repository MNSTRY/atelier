import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canonicalJson } from '../src/extensions/contracts.mjs'
import { parseAdoptionRequest, planPostgresAdoption } from '../src/extensions/adoption.mjs'

const columns = [
  { name: 'installation_id', type: 'text', nullable: false },
  { name: 'tenant_ref', type: 'text', nullable: false },
  { name: 'subject_ref', type: 'text', nullable: false },
  { name: 'value', type: 'integer', nullable: false },
]
const request = () => ({ profile: 'postgres-sql', database: 'sample_store', schemaVersion: '1',
  source: { reference: 'schema.sql', digest: 'a'.repeat(64) }, schemas: ['sample_data'], tables: [{ schema: 'sample_data', table: 'counters',
    owner: { role: 'sample_owner', reference: 'owner-selected-local-label' },
    scope: { installationId: 'installation_id', tenantRef: 'tenant_ref', subjectRef: 'subject_ref' }, columns: structuredClone(columns) }] })
const row = () => ({ schema: 'sample_data', table: 'counters', relationOid: '18472', ownerRole: 'sample_owner', kind: 'r',
  rlsEnabled: true, rlsForced: true, policyCount: 1, primaryKey: ['installation_id', 'tenant_ref', 'subject_ref'], columns: structuredClone(columns) })
const identity = () => ({ database: 'sample_store', serverVersion: '170011', readOnly: 'on', isolation: 'repeatable read' })
function nativeResult(rows) { return Object.assign(rows, { count: rows.length, command: 'SELECT', columns: [], state: {} }) }
function driver({ rows = [row()], meta = identity(), error } = {}) {
  const calls = []
  const state = { data: [{ value: 29 }], grants: ['unchanged'], rows: structuredClone(rows) }
  const sql = async (parts, ...parameters) => {
    const query = parts.join('?'); calls.push({ query, parameters })
    assert.match(query, /^SELECT /)
    assert.doesNotMatch(query, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|DROP|TRUNCATE)\b/i)
    if (error) throw error
    if (query.includes('current_database()')) return nativeResult([structuredClone(meta)])
    assert.match(query, /FROM pg_catalog\.pg_class/)
    assert.match(query, /JOIN jsonb_to_recordset\(\?::jsonb\)/)
    assert.deepEqual(parameters[0], [{ schema_name: 'sample_data', table_name: 'counters' }])
    return nativeResult(structuredClone(state.rows))
  }
  sql.json = value => structuredClone(value)
  return { calls, state, begin: async (mode, run) => {
    assert.equal(mode, 'isolation level repeatable read read only')
    return run(sql)
  } }
}

test('inspection pins selected source and catalog, maps ownership, and leaves rows and grants untouched', async () => {
  const database = driver(), before = canonicalJson(database.state), input = request()
  const plan = await planPostgresAdoption(database, input)
  assert.equal(plan.status, 'owner-review-required')
  assert.deepEqual(plan.differences, [])
  assert.equal(plan.ownershipMap[0].owner.reference, 'owner-selected-local-label')
  assert.equal(plan.ownershipMap[0].ownership, 'role-matched-owner-reference-unverified')
  assert.deepEqual(plan.ownershipMap[0].scope, input.tables[0].scope)
  assert.equal(plan.readOnly, true); assert.equal(plan.runtimeBound, false); assert.equal(plan.accepted, false); assert.equal(plan.qualified, false)
  assert.equal(plan.requestDigest, createHash('sha256').update(canonicalJson(parseAdoptionRequest(input))).digest('hex'))
  assert.equal(plan.catalogDigest, createHash('sha256').update(canonicalJson(plan.catalog)).digest('hex'))
  assert.equal(canonicalJson(database.state), before)
  assert.equal(database.calls.length, 2)
  assert.ok(database.calls.every(call => !call.query.includes('sample_data.counters')))
  assert.equal(input.tables[0].columns[0].name, 'installation_id')
})

test('table/schema allowlists and one explicit owner are required before connecting', async () => {
  for (const change of [
    r => r.schemas.push('*'), r => r.schemas.push('unselected'), r => r.tables.push(structuredClone(r.tables[0])),
    r => r.tables[0].schema = 'unselected', r => r.tables[0].table = 'counters; drop table x',
    r => delete r.tables[0].owner, r => r.tables[0].owner = [{ role: 'one' }, { role: 'two' }],
    r => r.tables[0].owner.role = '', r => r.tables[0].owner.roles = ['extra'],
    r => r.tables[0].scope.subjectRef = 'tenant_ref', r => r.tables[0].columns[0].nullable = true,
  ]) {
    const input = request(); change(input); const database = driver()
    await assert.rejects(planPostgresAdoption(database, input), { code: 'invalid-input' })
    assert.equal(database.calls.length, 0)
  }
})

test('owner mismatch, duplicate metadata and an out-of-allowlist response refuse without a partial plan', async () => {
  const mismatch = row(); mismatch.ownerRole = 'other_owner'
  await assert.rejects(planPostgresAdoption(driver({ rows: [mismatch] }), request()), { code: 'adoption-ownership-ambiguous' })
  const outside = row(); outside.schema = 'other_data'
  for (const rows of [[outside], [row(), row()]])
    await assert.rejects(planPostgresAdoption(driver({ rows }), request()), { code: 'adoption-catalog-invalid' })
})

test('shape, scope-key and RLS differences are proposals only; no repair statements are generated', async () => {
  const observed = row(); observed.columns = observed.columns.filter(c => c.name !== 'subject_ref')
  observed.columns.find(c => c.name === 'value').type = 'bigint'
  observed.columns.push({ name: 'note', type: 'text', nullable: true })
  observed.primaryKey = ['installation_id', 'tenant_ref']; observed.rlsForced = false
  const database = driver({ rows: [observed] })
  const plan = await planPostgresAdoption(database, request())
  assert.equal(plan.status, 'mapping-changes-required')
  assert.deepEqual(new Set(plan.differences.map(d => d.kind)), new Set([
    'missing-column', 'column-shape', 'unmapped-column', 'row-policy-review-required', 'scope-key-review-required',
  ]))
  assert.equal(plan.accepted, false)
  assert.ok(!Object.hasOwn(plan, 'sql'))
  const missing = await planPostgresAdoption(driver({ rows: [] }), request())
  assert.deepEqual(missing.ownershipMap, [])
  assert.deepEqual(missing.differences, [{ table: 'sample_data.counters', kind: 'missing-table' }])
})

test('wrong database, writable or weak snapshot and unsupported server refuse before catalog inspection', async () => {
  for (const change of [m => m.database = 'other_store', m => m.readOnly = 'off', m => m.isolation = 'read committed']) {
    const meta = identity(); change(meta); const database = driver({ meta })
    await assert.rejects(planPostgresAdoption(database, request()), { code: 'forbidden' })
    assert.equal(database.calls.length, 1)
  }
  const meta = identity(); meta.serverVersion = '160000'
  await assert.rejects(planPostgresAdoption(driver({ meta }), request()), { code: 'adoption-profile-unsupported' })
  const unsupported = request(); unsupported.profile = 'convex-native'
  await assert.rejects(planPostgresAdoption(driver(), unsupported), { code: 'adoption-profile-unsupported' })
})

test('driver errors and accessor input never disclose their contents or evaluate the accessor', async () => {
  const error = await planPostgresAdoption(driver({ error: new Error('invented private driver detail') }), request()).catch(e => e)
  assert.equal(error.message, 'unavailable'); assert.equal(error.code, 'unavailable')
  let reads = 0; const input = request()
  Object.defineProperty(input.tables[0].owner, 'role', { enumerable: true, get() { reads++; return 'sample_owner' } })
  await assert.rejects(planPostgresAdoption(driver(), input), { code: 'invalid-input' })
  assert.equal(reads, 0)
})

test('Postgres-family profile labels share one metadata inspection without ORM generators or schema push', async () => {
  for (const profile of ['postgres-sql', 'drizzle-db-first', 'drizzle-code-first', 'prisma-7-postgres']) {
    const input = request(); input.profile = profile
    assert.equal((await planPostgresAdoption(driver(), input)).profile, profile)
  }
})
