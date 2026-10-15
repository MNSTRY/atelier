import type { Sql, TransactionSql } from 'postgres'
import type { Json, ProviderOperationProof } from './contracts.mjs'
import type { VerifiedScope } from './server.mjs'
export function withPostgresScope<T>(database: Sql, scope: VerifiedScope, run: (sql: TransactionSql) => Promise<T>): Promise<T>
export function oncePostgresOperation(database: Sql, scope: VerifiedScope, input: Json, run: (sql: TransactionSql) => Promise<Json>): Promise<Json>
export function lookupPostgresOperation(database: Sql, scope: VerifiedScope, operationId: string): Promise<ProviderOperationProof|null>
export function postgresHealth(database: Sql): Promise<{ ready: true; profile: 'postgres-sql'; postgresMajor: 17 }>
