// Generated projects retain the native ORM. These strings never run in Atelier.
const drizzleSchema = `import { sql } from 'drizzle-orm'
import { bigint, boolean, check, integer, jsonb, pgSchema, primaryKey, text } from 'drizzle-orm/pg-core'
export const extensionData=pgSchema('extension_data')
const scope = () => ({ installationId:text('installation_id').notNull(),tenantRef:text('tenant_ref').notNull(),subjectRef:text('subject_ref').notNull() })
export const countersInExtensionData=extensionData.table('counters',{...scope(),value:integer('value').notNull()},table=>[
  primaryKey({columns:[table.installationId,table.tenantRef,table.subjectRef]}),check('counter_value',sql\`\${table.value} BETWEEN 0 AND 1000000\`),
])
export const operationsInExtensionData=extensionData.table('operations',{...scope(),operationId:text('operation_id').notNull(),actionId:text('action_id').notNull(),
  generation:bigint('generation',{mode:'bigint'}).notNull(),releaseDigest:text('release_digest').notNull(),payloadDigest:text('payload_digest').notNull(),
  completed:boolean('completed').notNull().default(false),result:jsonb('result')},table=>[
  primaryKey({columns:[table.installationId,table.tenantRef,table.subjectRef,table.operationId]}),
  check('operation_generation',sql\`\${table.generation}>0\`),check('release_digest_format',sql\`\${table.releaseDigest} ~ '^[a-f0-9]{64}$'\`),
  check('payload_digest_format',sql\`\${table.payloadDigest} ~ '^[a-f0-9]{64}$'\`),
])
`
const prismaSchema = `generator client {
  provider = "prisma-client"
  output = "../src/generated/prisma"
  moduleFormat = "esm"
  importFileExtension = "js"
}
datasource db {
  provider = "postgresql"
  schemas = ["extension_data"]
}
model Counter {
  installationId String @map("installation_id")
  tenantRef String @map("tenant_ref")
  subjectRef String @map("subject_ref")
  value Int
  @@id([installationId,tenantRef,subjectRef])
  @@map("counters")
  @@schema("extension_data")
}
model Operation {
  installationId String @map("installation_id")
  tenantRef String @map("tenant_ref")
  subjectRef String @map("subject_ref")
  operationId String @map("operation_id")
  actionId String @map("action_id")
  generation BigInt
  releaseDigest String @map("release_digest")
  payloadDigest String @map("payload_digest")
  completed Boolean @default(false)
  result Json?
  @@id([installationId,tenantRef,subjectRef,operationId])
  @@map("operations")
  @@schema("extension_data")
}
`
function replace(source, before, after) {
  if(source.split(before).length!==2) throw new Error('scaffold source shape changed')
  return source.replace(before,after)
}
export function sqlProjectFiles(profile, baseBackend, baseMigration) {
  const drizzle=profile==='drizzle-db-first'||profile==='drizzle-code-first'
  if(!drizzle && profile!=='prisma-7-postgres')throw new Error('unsupported SQL profile')
  let backend=baseBackend
  const names=drizzle?['Drizzle','drizzle']:['Prisma','prisma']
  backend=backend.replaceAll('oncePostgresOperation',`once${names[0]}Operation`).replaceAll('lookupPostgresOperation',`lookup${names[0]}Operation`)
    .replaceAll('withPostgresScope',`with${names[0]}Scope`).replaceAll('postgresHealth',`${names[1]}Health`)
    .replace("from '@mnstry/atelier/extensions/postgres'",`from '@mnstry/atelier/extensions/${names[1]}'`)
  backend=replace(backend,"import type { Sql } from 'postgres'",drizzle?`import type { Sql } from 'postgres'
import { and, eq, sql as query } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { countersInExtensionData as counters } from './${profile==='drizzle-db-first'?'introspected/':''}schema.js'
import type { VerifiedScope } from '@mnstry/atelier/extensions/server'
const scopedWhere=(scope:VerifiedScope)=>and(eq(counters.installationId,scope.installationId),eq(counters.tenantRef,scope.tenantRef),eq(counters.subjectRef,scope.subjectRef))`:
`import type { PrismaClient } from './generated/prisma/client.js'`)
  if(drizzle) {
    backend=backend.replaceAll('database, scope, input, async sql =>','database, scope, input, query, async db =>')
      .replaceAll('database, scope, async sql =>','database, scope, query, async db =>')
    backend=backend.replace('const database = options.database','const database = drizzle(options.database,{schema:{counters}})').replace('lookupDrizzleOperation(database, scope, input.operationId)','lookupDrizzleOperation(database, scope, query, input.operationId)').replace('drizzleHealth(database)',`drizzleHealth(options.database,'${profile}')`)
  }else backend=backend.replace('database: Sql','database: PrismaClient').replaceAll('database, scope, input, async sql =>','database, scope, input, async db =>').replaceAll('database, scope, async sql =>','database, scope, async db =>')
  backend=replace(backend,`await sql\`INSERT INTO extension_data.counters (installation_id,tenant_ref,subject_ref,value)
          VALUES (\${scope.installationId},\${scope.tenantRef},\${scope.subjectRef},\${input.value})
          ON CONFLICT (installation_id,tenant_ref,subject_ref) DO UPDATE SET value=excluded.value\``,drizzle?
`await db.insert(counters).values({installationId:scope.installationId,tenantRef:scope.tenantRef,subjectRef:scope.subjectRef,value:input.value})
          .onConflictDoUpdate({target:[counters.installationId,counters.tenantRef,counters.subjectRef],set:{value:input.value}})`:
`await db.counter.upsert({where:{installationId_tenantRef_subjectRef:{installationId:scope.installationId,tenantRef:scope.tenantRef,subjectRef:scope.subjectRef}},
          create:{installationId:scope.installationId,tenantRef:scope.tenantRef,subjectRef:scope.subjectRef,value:input.value},update:{value:input.value}})`)
  const read=`const [row] = await sql\`SELECT value FROM extension_data.counters WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef}\``
  if(backend.split(read).length!==3)throw new Error('scaffold read shape changed')
  backend=backend.replaceAll(read,drizzle?`const [row]=await db.select({value:counters.value}).from(counters).where(scopedWhere(scope)).limit(1)`:
`const row=await db.counter.findUnique({where:{installationId_tenantRef_subjectRef:{installationId:scope.installationId,tenantRef:scope.tenantRef,subjectRef:scope.subjectRef}}})`)
  backend=replace(backend,`const rows = await sql\`DELETE FROM extension_data.counters WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} RETURNING value\``,drizzle?
`const rows=await db.delete(counters).where(scopedWhere(scope)).returning({value:counters.value})`:
`const deleted=await db.counter.deleteMany({where:{installationId:scope.installationId,tenantRef:scope.tenantRef,subjectRef:scope.subjectRef}})
        const rows=Array.from({length:deleted.count})`)
  backend=replace(backend,`await sql\`DELETE FROM extension_data.operations WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} AND operation_id<>\${scope.operationId}\``,drizzle?
`await db.execute(query\`DELETE FROM extension_data.operations WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} AND operation_id<>\${scope.operationId}\`)`:
`await db.$executeRaw\`DELETE FROM extension_data.operations WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} AND operation_id<>\${scope.operationId}\``)
  const files={'src/backend.ts':backend}
  const dependencies=drizzle?{'drizzle-orm':'0.44.5',postgres:'3.4.7'}:{'@prisma/client':'7.10.0','@prisma/adapter-pg':'7.10.0',pg:'8.16.3'}
  const devDependencies=drizzle?{'drizzle-kit':'0.31.8'}:{prisma:'7.10.0','@types/pg':'8.15.5'}
  const scripts=drizzle?{'schema:generate':'drizzle-kit generate --config drizzle.config.ts','schema:introspect':'drizzle-kit pull --config drizzle-introspect.config.ts && node src/normalize-introspection.mjs'}:
    {'schema:generate':'prisma generate','schema:introspect':'prisma db pull'}
  if(drizzle){
    // Drizzle Kit 0.31 emits an extensionless local relation import. Preserve
    // the native generated schema and normalize only that Node ESM specifier.
    files['src/normalize-introspection.mjs']=`import {lstat,readFile,rename,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
const file=new URL('./introspected/relations.ts',import.meta.url)
const identity=await lstat(file)
if(!identity.isFile()||identity.isSymbolicLink())throw new Error('Generated relations must be a regular file')
const before=await readFile(file,'utf8')
const after=before.replaceAll('from "./schema"','from "./schema.js"').replaceAll("from './schema'","from './schema.js'")
if(after!==before){
  const temporary=new URL('./introspected/.relations-'+randomUUID()+'.tmp',import.meta.url)
  await writeFile(temporary,after,{flag:'wx'})
  const current=await lstat(file)
  if(!current.isFile()||current.isSymbolicLink()||current.ino!==identity.ino||await readFile(file,'utf8')!==before)throw new Error('Generated relations changed concurrently')
  await rename(temporary,file)
}
`
    files[`src/${profile==='drizzle-db-first'?'introspected/':''}schema.ts`]=drizzleSchema
    files['drizzle.config.ts']=`import {defineConfig} from 'drizzle-kit'\nexport default defineConfig({dialect:'postgresql',schema:'./src/${profile==='drizzle-db-first'?'introspected/':''}schema.ts',out:'./migrations/drizzle',schemaFilter:['extension_data'],strict:true,verbose:false})\n`
    files['drizzle-introspect.config.ts']=`import {defineConfig} from 'drizzle-kit'\nconst url=process.env.EXTENSION_MIGRATION_DATABASE_URL\nif(!url)throw new Error('Migration database secret must be supplied explicitly')\nexport default defineConfig({dialect:'postgresql',out:'./src/introspected',schemaFilter:['extension_data'],dbCredentials:{url},strict:true,verbose:false})\n`
    if(profile==='drizzle-code-first') {
      // The native generator creates tables. These reviewed policy statements must follow it.
      files['migrations/001-initial.sql']=`-- Apply the native Drizzle-generated SQL first, then migrations/002-governance.sql.\n`
      const governance=baseMigration.split('\n').filter(line=>/^(REVOKE|ALTER TABLE|CREATE POLICY|  USING|    AND subject_ref|  WITH CHECK|GRANT)/.test(line))
      files['migrations/002-governance.sql']=governance.join('\n')+'\n'
    }
  } else {
    files['prisma/schema.prisma']=prismaSchema
    files['prisma.config.ts']=`import {defineConfig} from 'prisma/config'\nconst url=process.env.EXTENSION_MIGRATION_DATABASE_URL\nexport default defineConfig({schema:'prisma/schema.prisma',...(url?{datasource:{url}}:{})})\n`
    files['src/database.ts']=`import {PrismaPg} from '@prisma/adapter-pg'\nimport {PrismaClient} from './generated/prisma/client.js'\nexport function createDatabase(connectionString:string){\n  if(!connectionString)throw new Error('Application database secret must be supplied explicitly')\n  return new PrismaClient({adapter:new PrismaPg({connectionString,max:6,connectionTimeoutMillis:5000,idleTimeoutMillis:1000},{schema:'extension_data'})})\n}\n`
  }
  files['env.example']='# Keep both secrets outside source; use separate restricted application and migration roles.\nEXTENSION_DATABASE_URL=\nEXTENSION_MIGRATION_DATABASE_URL=\n'
  const instructions=drizzle?(profile==='drizzle-code-first'?
    'This profile uses native Drizzle code-first generation. After npm install, run npm run schema:generate, review its SQL under migrations/drizzle, apply it with the separate migration role, then apply migrations/002-governance.sql. Omitting forced RLS makes health refuse. Reseal after generator output changes. Later generation is a proposed migration; review it before application.':
    'This profile uses database-first ownership. Apply the reviewed baseline migration with the migration role, then run npm run schema:introspect against only extension_data. Review src/introspected/schema.ts and retain it in source; it replaces the initial example projection. The backend consumes that actual generated schema. Reseal after introspection. Introspection does not prove RLS policy semantics.'):
    'This profile uses Prisma 7 with its native pg adapter and generated client. After npm install, run npm run schema:generate. Apply migrations/001-initial.sql with the separate migration role. Prisma schema/client generation does not install RLS; the reviewed SQL is required. Use src/database.ts from your own host with an explicit application secret. Reseal after schema/client changes. Prisma 8 remains an unqualified separate experiment.'
  return {files,dependencies,devDependencies,scripts,instructions}
}
