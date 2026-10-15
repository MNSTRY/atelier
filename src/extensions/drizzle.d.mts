import type { Sql } from 'postgres'
import type { Json, ProviderOperationProof } from './contracts.mjs'
import type { VerifiedScope } from './server.mjs'
export interface DrizzleTransaction { execute(query: any): PromiseLike<any> }
/** Native drizzle-orm/postgres-js database; other drivers are unsupported. */
export interface DrizzleDatabase<Transaction extends DrizzleTransaction> { readonly $client: Sql; transaction<T>(run:(transaction:Transaction)=>Promise<T>):Promise<T> }
export type DrizzleSqlTag = (chunks:TemplateStringsArray,...values:any[])=>unknown
export function withDrizzleScope<Transaction extends DrizzleTransaction,T>(database: DrizzleDatabase<Transaction>, scope: VerifiedScope, sql: DrizzleSqlTag, run: (transaction: Transaction) => Promise<T>): Promise<T>
export function onceDrizzleOperation<Transaction extends DrizzleTransaction>(database: DrizzleDatabase<Transaction>, scope: VerifiedScope, input: Json, sql: DrizzleSqlTag, run: (transaction: Transaction) => Promise<Json>): Promise<Json>
export function lookupDrizzleOperation<Transaction extends DrizzleTransaction>(database:DrizzleDatabase<Transaction>,scope:VerifiedScope,sql:DrizzleSqlTag,operationId:string):Promise<ProviderOperationProof|null>
export function drizzleHealth(driver: Sql, profile: 'drizzle-db-first'|'drizzle-code-first'): Promise<{ ready: true; profile: 'drizzle-db-first'|'drizzle-code-first'; postgresMajor: 17 }>
