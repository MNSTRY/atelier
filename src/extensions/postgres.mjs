import { ExtensionError } from './contracts.mjs'
import { assertVerifiedScope, digest } from './server.mjs'

import { assertApplicationRole, boundedSqlResult, assertSqlOperationId } from './sql-scope.mjs'

// The callback receives the provider's native transaction, retaining its query APIs.
export async function withPostgresScope(database, scope, run) {
  assertVerifiedScope(scope)
  return database.begin(async sql => {
    assertVerifiedScope(scope)
    await assertApplicationRole(sql)
    await sql`SELECT set_config('extension.installation_id', ${scope.installationId}, true),
      set_config('extension.tenant_ref', ${scope.tenantRef}, true), set_config('extension.subject_ref', ${scope.subjectRef}, true),
      set_config('statement_timeout', '10000', true), set_config('lock_timeout', '10000', true),
      set_config('idle_in_transaction_session_timeout', '10000', true)`
    assertVerifiedScope(scope)
    const result = await run(sql)
    // An expired handler cannot commit delayed work under a captured effect scope.
    assertVerifiedScope(scope)
    return result
  })
}
export async function oncePostgresOperation(database, scope, input, run) {
  assertVerifiedScope(scope)
  if (digest(input) !== scope.payloadDigest) throw new ExtensionError('invalid-input')
  return withPostgresScope(database, scope, async sql => {
    await sql`INSERT INTO extension_data.operations
      (installation_id,tenant_ref,subject_ref,operation_id,action_id,generation,release_digest,payload_digest)
      VALUES (${scope.installationId},${scope.tenantRef},${scope.subjectRef},${scope.operationId},${scope.actionId},
        ${scope.generation},${scope.releaseDigest},${scope.payloadDigest}) ON CONFLICT DO NOTHING`
    const [row] = await sql`SELECT action_id,generation::text,release_digest,payload_digest,completed,result
      FROM extension_data.operations WHERE installation_id=${scope.installationId} AND tenant_ref=${scope.tenantRef}
        AND subject_ref=${scope.subjectRef} AND operation_id=${scope.operationId} FOR UPDATE`
    if (!row || row.action_id !== scope.actionId || row.generation !== scope.generation ||
        row.release_digest !== scope.releaseDigest || row.payload_digest !== scope.payloadDigest) throw new ExtensionError('idempotency-conflict', 409)
    if (row.completed) return row.result
    const result = boundedSqlResult(await run(sql))
    await sql`UPDATE extension_data.operations SET completed=true,result=${sql.json(result)}
      WHERE installation_id=${scope.installationId} AND tenant_ref=${scope.tenantRef}
        AND subject_ref=${scope.subjectRef} AND operation_id=${scope.operationId}`
    return result
  })
}
export async function lookupPostgresOperation(database, scope, operationId) {
  assertVerifiedScope(scope)
  assertSqlOperationId(operationId)
  return withPostgresScope(database, scope, async sql => {
    const [row] = await sql`SELECT operation_id,action_id,generation::text,release_digest,payload_digest,result
      FROM extension_data.operations WHERE installation_id=${scope.installationId} AND tenant_ref=${scope.tenantRef}
        AND subject_ref=${scope.subjectRef} AND operation_id=${operationId} AND completed=true`
    return row ? { schema: 'mnstry.extension-provider-operation/v1', installationId: scope.installationId,
      operationId: row.operation_id, actionId: row.action_id, generation: row.generation, releaseDigest: row.release_digest,
      payloadDigest: row.payload_digest, result: row.result, resultDigest: digest(row.result) } : null
  })
}
export async function postgresHealth(database) {
  return database.begin(async sql => {
    await sql`SELECT set_config('statement_timeout','10000',true),set_config('lock_timeout','10000',true)`
    await assertApplicationRole(sql)
    const [version] = await sql`SHOW server_version_num`
    if (Math.floor(Number(version?.server_version_num) / 10000) !== 17) throw new ExtensionError('unavailable', 503)
    await sql`SELECT installation_id,tenant_ref,subject_ref,operation_id,action_id,generation,
      release_digest,payload_digest,completed,result FROM extension_data.operations LIMIT 0`
    return { ready: true, profile: 'postgres-sql', postgresMajor: 17 }
  })
}
