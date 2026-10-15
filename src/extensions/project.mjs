import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, parseManifest } from './contracts.mjs'
import { sqlProjectFiles } from './scaffold-sql.mjs'
import { releaseDigest } from './server.mjs'
import { loadExtensionPacks, RESERVED_NAMESPACE_PATTERN } from '../extension-packs/loader.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifestName = 'extension.manifest.json'
const packName = 'atelier.extension-pack.json'
const backend = `import type { Sql } from 'postgres'
import { exact, ExtensionError, parseProviderOperationProof, type ExtensionManifest, type Json } from '@mnstry/atelier/extensions'
import { createExtensionHandler, createRootAdmissionConsumer, defineAction, defineExtension, type VerifierOptions } from '@mnstry/atelier/extensions/server'
import { lookupPostgresOperation, oncePostgresOperation, postgresHealth, withPostgresScope } from '@mnstry/atelier/extensions/postgres'

function counter(value: unknown): { value: number } {
  const input = exact(value, ['value'])
  if (!Number.isSafeInteger(input.value) || Number(input.value) < 0 || Number(input.value) > 1000000) throw new ExtensionError('invalid-input')
  return { value: Number(input.value) }
}
const empty = (value: unknown) => { exact(value, []); return {} }
const json = (value: unknown) => value as Json
/** The consuming host owns process startup, verified public keys, deployment and secrets. */
export function createBackend(options: { database: Sql; manifest: ExtensionManifest; rootOrigin: string;
  verifier: Omit<VerifierOptions, 'consume'>; allowLocalTesting?: boolean }) {
  const database = options.database
  const extension = defineExtension({ manifest: options.manifest,
    verifier: { ...options.verifier, consume: createRootAdmissionConsumer({ origin: options.rootOrigin, allowLocalTesting: options.allowLocalTesting }) },
    actions: {
      'counter.set': defineAction({ input: counter, output: counter, run: ({ scope }, input) => oncePostgresOperation(database, scope, input, async sql => {
        await sql\`INSERT INTO extension_data.counters (installation_id,tenant_ref,subject_ref,value)
          VALUES (\${scope.installationId},\${scope.tenantRef},\${scope.subjectRef},\${input.value})
          ON CONFLICT (installation_id,tenant_ref,subject_ref) DO UPDATE SET value=excluded.value\`
        return input
      }) }),
      'counter.get': defineAction({ input: empty, output: counter, run: ({ scope }) => withPostgresScope(database, scope, async sql => {
        const [row] = await sql\`SELECT value FROM extension_data.counters WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef}\`
        return { value: row?.value ?? 0 }
      }) }),
      'counter.export': defineAction({ input: empty, output: json, run: ({ scope }) => withPostgresScope(database, scope, async sql => {
        const [row] = await sql\`SELECT value FROM extension_data.counters WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef}\`
        return { schema: 'sample.counter-export/v1', value: row?.value ?? 0 }
      }) }),
      'counter.delete': defineAction({ input: empty, output: json, run: ({ scope }, input) => oncePostgresOperation(database, scope, input, async sql => {
        const rows = await sql\`DELETE FROM extension_data.counters WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} RETURNING value\`
        await sql\`DELETE FROM extension_data.operations WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} AND operation_id<>\${scope.operationId}\`
        return { deleted: rows.length, retention: 'provider-live-rows-deleted', backups: 'operator-policy' }
      }) }),
      'counter.lookup': defineAction({ input: value => { const input = exact(value, ['operationId']);
        if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.operationId)) throw new ExtensionError('invalid-input')
        return { operationId: input.operationId } }, output: value => value === null ? null : parseProviderOperationProof(value),
        run: ({ scope }, input) => lookupPostgresOperation(database, scope, input.operationId) }),
    },
  })
  return { handler: createExtensionHandler(extension), health: () => postgresHealth(database) }
}
`
const migration = `-- Apply only to the customer-owned extension database with a separate migration role.
-- Create extension_app LOGIN and its secret outside this file. Never use a root runtime DSN.
CREATE SCHEMA extension_data;
REVOKE ALL ON SCHEMA extension_data FROM PUBLIC;
CREATE TABLE extension_data.counters (
  installation_id text NOT NULL, tenant_ref text NOT NULL, subject_ref text NOT NULL,
  value integer NOT NULL CHECK(value BETWEEN 0 AND 1000000),
  PRIMARY KEY(installation_id,tenant_ref,subject_ref)
);
CREATE TABLE extension_data.operations (
  installation_id text NOT NULL, tenant_ref text NOT NULL, subject_ref text NOT NULL,
  operation_id text NOT NULL, action_id text NOT NULL, generation bigint NOT NULL CHECK(generation>0),
  release_digest text NOT NULL CHECK(release_digest ~ '^[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  completed boolean NOT NULL DEFAULT false, result jsonb,
  PRIMARY KEY(installation_id,tenant_ref,subject_ref,operation_id)
);
ALTER TABLE extension_data.counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_data.counters FORCE ROW LEVEL SECURITY;
ALTER TABLE extension_data.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_data.operations FORCE ROW LEVEL SECURITY;
CREATE POLICY counter_scope ON extension_data.counters TO extension_app
  USING(installation_id=current_setting('extension.installation_id',true) AND tenant_ref=current_setting('extension.tenant_ref',true)
    AND subject_ref=current_setting('extension.subject_ref',true))
  WITH CHECK(installation_id=current_setting('extension.installation_id',true) AND tenant_ref=current_setting('extension.tenant_ref',true)
    AND subject_ref=current_setting('extension.subject_ref',true));
CREATE POLICY operation_scope ON extension_data.operations TO extension_app
  USING(installation_id=current_setting('extension.installation_id',true) AND tenant_ref=current_setting('extension.tenant_ref',true)
    AND subject_ref=current_setting('extension.subject_ref',true))
  WITH CHECK(installation_id=current_setting('extension.installation_id',true) AND tenant_ref=current_setting('extension.tenant_ref',true)
    AND subject_ref=current_setting('extension.subject_ref',true));
REVOKE ALL ON ALL TABLES IN SCHEMA extension_data FROM PUBLIC;
GRANT USAGE ON SCHEMA extension_data TO extension_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA extension_data TO extension_app;
`
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })
const counterSchema = schema({ value: { type: 'integer', minimum: 0, maximum: 1000000 } })
const readme = `# Custom counter extension

This project owns its custom data. Atelier generated files only; no account, database,
process, listener, deployment or root installation was created.

1. Install the SDK and run npm run typecheck. Keep the generated lockfile.
   The candidate SDK 0.2.0-alpha.15 is unpublished. Until its release, run
   npm pack --ignore-scripts in the reviewed Atelier checkout and install its
   resulting tarball here with npm install /absolute/path/to/mnstry-atelier-0.2.0-alpha.15.tgz.
   After reviewing that dependency edit, run atelier extension seal --directory .
   Once the pinned SDK version is published, ordinary npm install can resolve it.
2. Select a customer-owned PostgreSQL 17 database. Create a restricted extension_app
   login and apply migrations/001-initial.sql with a separate migration role.
   Keep its DSN in your backend secret store. Do not use the root runtime database.
3. Call createBackend from src/backend.ts in your own host. Supply the pinned manifest,
   verified root public keys and installation binding. Mount handler and health using
   your host's lifecycle. This generated module never starts a server.
4. Register the endpoint through your studio's supported connection workflow. Use the
   authenticated admin SDK to configure, verify and enable its exact release. Installation
   does not grant member consent or paid-product access.
5. Supply your supported host's authenticated fetch to createHttpHostTransport. Invoke
   counter.set/get/export/delete with the installation generation and release digest.
   Record a result only after the member permits that separate root action.
6. When a reply is lost, use lookupOperation/recoverOperation. Never automatically
   replay the write or refresh a stale generation. Disable before upgrading; verify
   the new release before enabling it. Retain-data removal and explicit deletion differ.

Atelier keeps this component under the existing non-executing extension-pack system.
Declare atelier.extension-pack.json in your project's existing
ext["mnstry.atelier"].extensionPacks, then use the normal pack validation and lock
adoption workflow. Its pack identity matches the extension ID. The pack's runtime
manifest reference is a digest-bound projection; loading it never runs the backend
or grants root access. Init does not edit another project's configuration or lock.
Run atelier extension validate --directory . after edits. Run atelier extension seal
--directory . to regenerate source/schema/release digests after reviewing those edits.
Sealing records bytes; it does not establish trust, deployment, health or qualification.
The sample deletes its live rows and earlier provider receipts; backup retention remains
the operator's responsibility. Provider qualification and actual Web/native acceptance
are separate from scaffolding. Drizzle, Prisma and Convex profiles remain pending.
`
export async function scaffoldSqlProject({ directory, extensionId = 'sample.counter', profile = 'postgres-sql' }) {
  if(!['postgres-sql','drizzle-db-first','drizzle-code-first','prisma-7-postgres'].includes(profile))throw new Error('unsupported SQL profile')
  if (extensionId.length > 128 || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(extensionId) || RESERVED_NAMESPACE_PATTERN.test(extensionId.split('.')[0])) throw new Error('invalid extension id')
  const target = path.resolve(directory)
  await mkdir(target) // Exclusive reservation: an existing directory is never adopted or overwritten.
  const identity = await lstat(target)
  try {
    const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
    const kit = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    const files = {
      'package.json': JSON.stringify({ name: extensionId, version: '1.0.0', private: true, type: 'module',
        files: ['src','tsconfig.json'], scripts: { typecheck: 'tsc --noEmit' }, dependencies: { '@mnstry/atelier': kit.version, postgres: '3.4.7' },
        devDependencies: { typescript: '5.8.3', '@types/node': '22.18.0' }, engines: { node: '>=22.18.0 <23' } }, null, 2) + '\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true }, include: ['src/**/*.ts'] }, null, 2) + '\n',
      'src/backend.ts': backend, 'migrations/001-initial.sql': migration, 'README.md': readme,
      '.gitignore': 'node_modules/\n.env\n.env.*\n!env.example\n', 'env.example': '# Backend secret reference only; do not commit credentials.\nEXTENSION_DATABASE_URL=\n',
    }
    if(profile!=='postgres-sql') {
      const provider=sqlProjectFiles(profile,backend,migration)
      Object.assign(files,provider.files)
      const pkg=JSON.parse(files['package.json'])
      delete pkg.dependencies.postgres
      Object.assign(pkg.dependencies,provider.dependencies)
      Object.assign(pkg.devDependencies,provider.devDependencies)
      Object.assign(pkg.scripts,provider.scripts)
      files['package.json']=JSON.stringify(pkg,null,2)+'\n'
      files['README.md']=provider.instructions+'\n\n'+readme.replace('Drizzle, Prisma and Convex profiles remain pending.','Convex remains pending; the native SQL profile above requires its own qualification.')
    }
    const resultSchemas = {
      set: counterSchema, get: counterSchema,
      export: schema({ schema: { const: 'sample.counter-export/v1' }, value: counterSchema.properties.value }),
      delete: schema({ deleted: { type: 'integer', minimum: 0, maximum: 1 }, retention: { const: 'provider-live-rows-deleted' }, backups: { const: 'operator-policy' } }),
      lookup: { anyOf: [{ type: 'null' }, schema({ schema: { const: 'mnstry.extension-provider-operation/v1' },
        installationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' }, operationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' },
        actionId: { type: 'string' }, generation: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' },
        releaseDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, payloadDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        resultDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' }, result: {} })] },
    }
    for (const action of ['set', 'get', 'export', 'delete', 'lookup']) {
      const input = action === 'set' ? counterSchema : action === 'lookup' ? schema({ operationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' } }) : schema({})
      files[`schemas/counter-${action}-input.json`] = JSON.stringify(input, null, 2) + '\n'
      files[`schemas/counter-${action}-output.json`] = JSON.stringify(resultSchemas[action], null, 2) + '\n'
    }
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(target, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents, { flag: 'wx' })
    }
    const manifest = { schema: 'mnstry.extension-manifest/v1', extensionId, releaseVersion: '1.0.0', releaseDigest: '0'.repeat(64), protocol: 'mnstry.extension/v1',
      compatibility: { sdkMajor: 1, rootContracts: ['extension.result.record/v1'], hosts: ['web'] },
      deployment: { profile, bundleDigest: '0'.repeat(64), schemaDigest: '0'.repeat(64) },
      actions: ['set', 'get', 'export', 'delete', 'lookup'].map(action => ({ id: `counter.${action}`,
        effect: ['set', 'delete'].includes(action) ? 'write' : 'read', scope: 'member',
        inputSchemaRef: `schemas/counter-${action}-input.json`, outputSchemaRef: `schemas/counter-${action}-output.json`, timeoutMs: 10000 })),
      recovery: { lookupActionId: 'counter.lookup' }, permissions: { rootReads: [], rootWrites: ['extension.result.record/v1'], egress: [] }, surfaces: [],
      data: { classes: ['sample.counter'], retention: 'until-user-delete', exportVersion: 1, schemaVersion: '1', readableSchemaVersions: ['1'] } }
    const result = await sealProject(target, manifest)
    return { directory: target, profile, releaseDigest: result.releaseDigest, qualified: false }
  } catch (error) {
    const current = await lstat(target).catch(() => null)
    if (current?.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) await rm(target, { recursive: true })
    throw error
  }
}
async function projectFiles(root, subpath) {
  const result = {}
  const base = await realpath(root)
  async function walk(relative) {
    const file = path.join(base, relative)
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) throw new Error('extension project symlinks are unsupported')
    if (stat.isDirectory()) {
      for (const entry of (await readdir(file)).sort()) await walk(path.join(relative, entry))
    } else if (stat.isFile()) {
      if (stat.size > 1024 * 1024) throw new Error('extension source file exceeds 1 MiB')
      result[relative.split(path.sep).join('/')] = hash(await readFile(file))
    } else throw new Error('extension project requires regular files')
  }
  for (const relative of subpath) await walk(relative)
  return result
}
async function bundleFiles(target) {
  const paths=['package.json','tsconfig.json','src']
  const packageFile=path.join(target,'package.json')
  if(!(await lstat(packageFile)).isFile())throw new Error('extension package must be a regular file')
  const pkg=JSON.parse(await readFile(packageFile,'utf8'))
  if(pkg.files!==undefined){
    if(!Array.isArray(pkg.files)||pkg.files.length>128)throw new Error('invalid extension source inputs')
    for(const file of pkg.files){
      if(typeof file!=='string'||!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file)||
        file.split('/').some(part=>part==='.'||part==='..'||part.startsWith('.'))||
        [manifestName,packName].includes(file)||file==='node_modules'||file.startsWith('node_modules/'))
        throw new Error('extension source inputs require literal project-relative paths')
      paths.push(file)
    }
  }
  for(const file of ['package-lock.json','npm-shrinkwrap.json','drizzle.config.ts','drizzle-introspect.config.ts','prisma.config.ts','prisma']) {
    try { await lstat(path.join(target,file)); paths.push(file) }
    catch(error) { if(error.code!=='ENOENT')throw error }
  }
  return projectFiles(target,[...new Set(paths)])
}
async function preflightPackSeal(target,manifest) {
  const file=path.join(target,packName)
  if(!(await lstat(file)).isFile())throw new Error('extension pack must be a regular file')
  const original=await readFile(file,'utf8')
  loadExtensionPacks(packProject(target,manifest),{verifyLock:false})
  const preview=JSON.parse(original)
  preview.ext ??= {}; preview.ext['mnstry.atelier'] ??= {}
  preview.ext['mnstry.atelier'].runtimeManifest={schema:manifest.schema,path:manifestName,releaseDigest:manifest.releaseDigest,fileDigest:'0'.repeat(64)}
  canonicalJson(preview)
  return original
}
export async function sealProject(directory, initialManifest) {
  const target = path.resolve(directory)
  const manifestFile = path.join(target, manifestName)
  if (!initialManifest && !(await lstat(manifestFile)).isFile()) throw new Error('extension manifest must be a regular file')
  const originalManifest = initialManifest ? null : await readFile(manifestFile, 'utf8')
  const manifest = parseManifest(initialManifest ?? JSON.parse(originalManifest))
  const bundle = await bundleFiles(target)
  const schemas = await projectFiles(target, ['schemas', 'migrations'])
  manifest.deployment.bundleDigest = hash(canonicalJson(bundle)); manifest.deployment.schemaDigest = hash(canonicalJson(schemas))
  manifest.releaseDigest = releaseDigest(manifest)
  // Re-read before committing the digest; concurrent edits cannot produce a knowingly stale seal.
  if (canonicalJson(bundle) !== canonicalJson(await bundleFiles(target)) ||
      canonicalJson(schemas) !== canonicalJson(await projectFiles(target, ['schemas', 'migrations']))) throw new Error('extension changed during sealing')
  const originalPack = initialManifest ? null : await preflightPackSeal(target,manifest)
  const temporary = path.join(target, `.extension-seal-${randomUUID()}.json`)
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
    if (initialManifest) {
      // Creation keeps an exclusive manifest reservation as well.
      await writeFile(manifestFile, await readFile(temporary), { flag: 'wx' })
    } else {
      if (!(await lstat(manifestFile)).isFile() || await readFile(manifestFile, 'utf8') !== originalManifest)
        throw new Error('extension manifest changed during sealing')
      if(await preflightPackSeal(target,manifest)!==originalPack)throw new Error('extension pack changed during sealing')
      await rename(temporary, manifestFile)
    }
  } finally { await rm(temporary, { force: true }) }
  await writePackProjection(target, manifest, Boolean(initialManifest))
  return manifest
}
export async function validateProject(directory) {
  const target = path.resolve(directory)
  const manifestFile = path.join(target, manifestName)
  if (!(await lstat(manifestFile)).isFile()) throw new Error('extension manifest must be a regular file')
  const manifest = parseManifest(JSON.parse(await readFile(manifestFile, 'utf8')))
  if (manifest.releaseDigest !== releaseDigest(manifest) || manifest.deployment.bundleDigest !== hash(canonicalJson(await bundleFiles(target))) ||
      manifest.deployment.schemaDigest !== hash(canonicalJson(await projectFiles(target, ['schemas', 'migrations'])))) throw new Error('extension seal is stale')
  for (const action of manifest.actions) {
    for (const name of ['inputSchemaRef', 'outputSchemaRef']) JSON.parse(await readFile(path.join(target, action[name]), 'utf8'))
  }
  await validatePackProjection(target, manifest)
  return { valid: true, profile: manifest.deployment.profile, extensionId: manifest.extensionId, releaseDigest: manifest.releaseDigest, qualified: false, packAdoption: 'pending' }
}

function packProject(target, manifest) {
  return { configDir: target, config: { ext: { 'mnstry.atelier': { extensionPacks: [
    { id: manifest.extensionId, version: 'v1', path: packName, enabled: true },
  ] } } } }
}
async function runtimeReference(target, manifest) {
  return { schema: manifest.schema, path: manifestName, releaseDigest: manifest.releaseDigest,
    fileDigest: hash(await readFile(path.join(target,manifestName))) }
}
async function writePackProjection(target, manifest, initial) {
  const file=path.join(target,packName)
  let previous=null, pack
  if (initial) {
    pack={ schema:'mnstry-atelier-extension-pack@v1',id:manifest.extensionId,namespace:manifest.extensionId.split('.')[0],version:'v1',
      terms:[],migrations:[],fixtures:[manifestName],lenses:[],readinessRules:[],actionRules:[],exportMappings:[] }
  } else {
    if (!(await lstat(file)).isFile()) throw new Error('extension pack must be a regular file')
    previous=await readFile(file,'utf8'); pack=JSON.parse(previous)
    loadExtensionPacks(packProject(target,manifest),{verifyLock:false})
  }
  pack.ext ??= {}; pack.ext['mnstry.atelier'] ??= {}
  pack.ext['mnstry.atelier'].runtimeManifest=await runtimeReference(target,manifest)
  const temporary=path.join(target,`.extension-pack-${randomUUID()}.json`)
  try {
    await writeFile(temporary,JSON.stringify(pack,null,2)+'\n',{flag:'wx'})
    if(initial) await writeFile(file,await readFile(temporary),{flag:'wx'})
    else {
      if(!(await lstat(file)).isFile() || await readFile(file,'utf8')!==previous) throw new Error('extension pack changed during sealing')
      await rename(temporary,file)
    }
  } finally { await rm(temporary,{force:true}) }
  await validatePackProjection(target,manifest)
}
async function validatePackProjection(target,manifest) {
  const file=path.join(target,packName)
  if(!(await lstat(file)).isFile()) throw new Error('extension pack must be a regular file')
  const report=loadExtensionPacks(packProject(target,manifest),{verifyLock:false})
  if(report.packs.length!==1) throw new Error('extension pack projection is invalid')
  const pack=JSON.parse(await readFile(file,'utf8'))
  if(canonicalJson(pack.ext?.['mnstry.atelier']?.runtimeManifest)!==canonicalJson(await runtimeReference(target,manifest)))
    throw new Error('extension pack runtime reference is stale')
}

export function scaffoldPostgres(options) { return scaffoldSqlProject({...options,profile:'postgres-sql'}) }
