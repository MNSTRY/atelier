import { createHash } from 'node:crypto'
import { canonicalJson, exact, ExtensionError, text } from './contracts.mjs'

const fail = (code = 'invalid-input', status = 400) => { throw new ExtensionError(code, status) }
const clone = value => JSON.parse(canonicalJson(value))
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const identifier = value => /^[a-z_][a-z0-9_]{0,62}$/.test(text(value, 63)) ? value : fail()
const profiles = ['postgres-sql', 'drizzle-db-first', 'drizzle-code-first', 'prisma-7-postgres']
const scopeKeys = ['installationId', 'tenantRef', 'subjectRef']
const key = value => `${value.schema}.${value.table}`

function column(value) {
  exact(value, ['name', 'type', 'nullable'])
  identifier(value.name); text(value.type, 128)
  if (typeof value.nullable !== 'boolean') fail()
  return value
}

/** A caller-owned proposed mapping, never a grant, migration or accepted schema. */
export function parseAdoptionRequest(value) {
  const request = clone(value)
  exact(request, ['profile', 'database', 'schemaVersion', 'source', 'schemas', 'tables'])
  if (!profiles.includes(request.profile)) fail('adoption-profile-unsupported')
  text(request.database, 63); text(request.schemaVersion)
  exact(request.source, ['reference', 'digest'])
  if (!/^[A-Za-z0-9_-]+(?:[./-][A-Za-z0-9_-]+)*$/.test(text(request.source.reference, 256)) ||
      !/^[a-f0-9]{64}$/.test(request.source.digest)) fail()
  if (!Array.isArray(request.schemas) || !request.schemas.length || request.schemas.length > 16 ||
      new Set(request.schemas).size !== request.schemas.length) fail()
  request.schemas.forEach(identifier)
  if (!Array.isArray(request.tables) || !request.tables.length || request.tables.length > 64) fail()
  const seen = new Set()
  for (const table of request.tables) {
    exact(table, ['schema', 'table', 'owner', 'scope', 'columns'])
    identifier(table.schema); identifier(table.table)
    if (!request.schemas.includes(table.schema) || seen.has(key(table))) fail()
    seen.add(key(table))
    // Exactly one owner is required for each table; no inferred or wildcard owner.
    exact(table.owner, ['role', 'reference'])
    identifier(table.owner.role); text(table.owner.reference)
    exact(table.scope, scopeKeys)
    scopeKeys.forEach(name => identifier(table.scope[name]))
    if (new Set(Object.values(table.scope)).size !== scopeKeys.length) fail()
    if (!Array.isArray(table.columns) || !table.columns.length || table.columns.length > 128) fail()
    table.columns.forEach(column)
    if (new Set(table.columns.map(c => c.name)).size !== table.columns.length ||
        scopeKeys.some(name => !table.columns.some(c => c.name === table.scope[name] && c.type === 'text' && c.nullable === false))) fail()
  }
  // Every schema is intentionally selected; unused broader schema grants refuse.
  if (request.schemas.some(schema => !request.tables.some(table => table.schema === schema))) fail()
  request.schemas.sort(); request.tables.sort((a, b) => key(a).localeCompare(key(b), 'en'))
  for (const table of request.tables) table.columns.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  return request
}

function inspectCatalog(value, request) {
  if (!Array.isArray(value) || value.length > request.tables.length) fail('adoption-catalog-invalid')
  // Native postgres-js Result arrays carry driver metadata outside their rows.
  const rows = clone(Array.from(value))
  const seen = new Set()
  for (const row of rows) {
    exact(row, ['schema', 'table', 'relationOid', 'ownerRole', 'kind', 'rlsEnabled', 'rlsForced', 'policyCount', 'primaryKey', 'columns'])
    const expected = request.tables.find(table => key(table) === key(row))
    if (!expected || seen.has(key(row))) fail('adoption-catalog-invalid')
    seen.add(key(row))
    if (!/^[1-9][0-9]{0,9}$/.test(row.relationOid) || !['r', 'p'].includes(row.kind) ||
        typeof row.rlsEnabled !== 'boolean' || typeof row.rlsForced !== 'boolean' ||
        !Number.isSafeInteger(row.policyCount) || row.policyCount < 0 || row.policyCount > 1024) fail('adoption-catalog-invalid')
    identifier(row.ownerRole)
    if (row.ownerRole !== expected.owner.role) fail('adoption-ownership-ambiguous', 409)
    if (!Array.isArray(row.columns) || !row.columns.length || row.columns.length > 128 ||
        !Array.isArray(row.primaryKey) || row.primaryKey.length > row.columns.length) fail('adoption-catalog-invalid')
    row.columns.forEach(column); row.primaryKey.forEach(identifier)
    if (new Set(row.columns.map(c => c.name)).size !== row.columns.length ||
        new Set(row.primaryKey).size !== row.primaryKey.length ||
        row.primaryKey.some(name => !row.columns.some(c => c.name === name))) fail('adoption-catalog-invalid')
    row.columns.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  }
  return rows.sort((a, b) => key(a).localeCompare(key(b), 'en'))
}

/** Inspect only explicitly selected catalog entries in one PostgreSQL snapshot.
 * Requires a postgres-js compatible native client; never reads application rows.
 * Native ORM schema generation and policy semantics remain separate owner work. */
export async function planPostgresAdoption(database, value) {
  const request = parseAdoptionRequest(value)
  if (typeof database?.begin !== 'function') fail()
  try {
    return await database.begin('isolation level repeatable read read only', async sql => {
      const identityResult = await sql`SELECT current_database() AS database,
        current_setting('server_version_num') AS "serverVersion",
        current_setting('transaction_read_only') AS "readOnly",
        current_setting('transaction_isolation') AS isolation`
      if (!Array.isArray(identityResult) || identityResult.length !== 1) fail('adoption-catalog-invalid')
      const identityRows = clone(Array.from(identityResult))
      if (!Array.isArray(identityRows) || identityRows.length !== 1) fail('adoption-catalog-invalid')
      const identity = exact(identityRows[0], ['database', 'serverVersion', 'readOnly', 'isolation'])
      if (identity.database !== request.database || identity.readOnly !== 'on' || identity.isolation !== 'repeatable read') fail('forbidden', 403)
      if (!/^[0-9]{6}$/.test(identity.serverVersion) || Math.floor(Number(identity.serverVersion) / 10000) !== 17) fail('adoption-profile-unsupported')
      const selected = request.tables.map(table => ({ schema_name: table.schema, table_name: table.table }))
      // Identifiers remain bound data. No caller SQL, dynamic identifier or row query.
      const catalog = inspectCatalog(await sql`SELECT n.nspname AS schema, c.relname AS "table",
        c.oid::text AS "relationOid", r.rolname AS "ownerRole", c.relkind AS kind,
        c.relrowsecurity AS "rlsEnabled", c.relforcerowsecurity AS "rlsForced",
        (SELECT count(*)::int FROM pg_catalog.pg_policy policy WHERE policy.polrelid=c.oid) AS "policyCount",
        COALESCE((SELECT jsonb_agg(a.attname ORDER BY part.ordinality)
          FROM pg_catalog.pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY part(attnum,ordinality)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=part.attnum
          WHERE i.indrelid=c.oid AND i.indisprimary), '[]'::jsonb) AS "primaryKey",
        (SELECT jsonb_agg(jsonb_build_object('name', a.attname,
          'type', pg_catalog.format_type(a.atttypid,a.atttypmod), 'nullable', NOT a.attnotnull) ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
        JOIN jsonb_to_recordset(${sql.json(selected)}::jsonb) AS selected(schema_name text, table_name text)
          ON selected.schema_name=n.nspname AND selected.table_name=c.relname
        ORDER BY n.nspname,c.relname LIMIT ${request.tables.length + 1}`, request)
      const differences = []
      const ownershipMap = []
      for (const proposed of request.tables) {
        const actual = catalog.find(row => key(row) === key(proposed))
        if (!actual) { differences.push({ table: key(proposed), kind: 'missing-table' }); continue }
        ownershipMap.push({ schema: proposed.schema, table: proposed.table, relationOid: actual.relationOid,
          owner: proposed.owner, scope: proposed.scope, ownership: 'role-matched-owner-reference-unverified' })
        for (const expected of proposed.columns) {
          const observed = actual.columns.find(c => c.name === expected.name)
          if (!observed) differences.push({ table: key(proposed), column: expected.name, kind: 'missing-column' })
          else if (expected.type !== observed.type || expected.nullable !== observed.nullable)
            differences.push({ table: key(proposed), column: expected.name, kind: 'column-shape', expected, observed })
        }
        for (const observed of actual.columns) if (!proposed.columns.some(c => c.name === observed.name))
          differences.push({ table: key(proposed), column: observed.name, kind: 'unmapped-column' })
        if (!actual.rlsEnabled || !actual.rlsForced || actual.policyCount === 0)
          differences.push({ table: key(proposed), kind: 'row-policy-review-required' })
        if (!actual.primaryKey.length || scopeKeys.some(name => !actual.primaryKey.includes(proposed.scope[name])))
          differences.push({ table: key(proposed), kind: 'scope-key-review-required' })
      }
      return clone({ profile: request.profile, database: identity.database, serverVersion: identity.serverVersion,
        schemaVersion: request.schemaVersion, source: request.source, requestDigest: hash(request), catalogDigest: hash(catalog),
        readOnly: true, runtimeBound: false, qualified: false, accepted: false, ownershipMap, catalog, differences,
        status: differences.length ? 'mapping-changes-required' : 'owner-review-required',
        limits: ['owner-reference-not-verified', 'row-policy-semantics-not-verified', 'no-runtime-or-root-authority'] })
    })
  } catch (error) {
    if (error instanceof ExtensionError) throw error
    // Driver errors may contain credentials, paths, database names or query data.
    throw new ExtensionError('unavailable', 503)
  }
}
