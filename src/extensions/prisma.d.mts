import type { Json } from './contracts.mjs'
import type { VerifiedScope } from './server.mjs'
export interface PrismaTransaction {
  $queryRaw<T=unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>
}
export interface PrismaDatabase<Transaction extends PrismaTransaction> {
  $transaction<T>(run:(transaction:Transaction)=>Promise<T>, options?: { maxWait?:number;timeout?:number }): Promise<T>
}
export function withPrismaScope<Transaction extends PrismaTransaction,T>(database:PrismaDatabase<Transaction>,scope:VerifiedScope,run:(transaction:Transaction)=>Promise<T>):Promise<T>
export function oncePrismaOperation<Transaction extends PrismaTransaction>(database:PrismaDatabase<Transaction>,scope:VerifiedScope,input:Json,run:(transaction:Transaction)=>Promise<Json>):Promise<Json>
export function lookupPrismaOperation<Transaction extends PrismaTransaction>(database:PrismaDatabase<Transaction>,scope:VerifiedScope,operationId:string):Promise<Json>
export function prismaHealth<Transaction extends PrismaTransaction>(database:PrismaDatabase<Transaction>):Promise<{ready:true;profile:'prisma-7-postgres';postgresMajor:17}>
