import { lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseManifest } from './contracts.mjs'

// This sample owns its task fields. Only the SDK envelope, verified scope,
// transaction and operation proof have shared protocol meaning.
const backend = `import type { Sql, TransactionSql } from 'postgres'
import { exact, ExtensionError, parseProviderOperationProof, text, type ExtensionManifest } from '@mnstry/atelier/extensions'
import { createExtensionHandler, createRootAdmissionConsumer, defineAction, defineExtension, type VerifierOptions } from '@mnstry/atelier/extensions/server'
import { lookupPostgresOperation, oncePostgresOperation, postgresHealth, withPostgresScope } from '@mnstry/atelier/extensions/postgres'

type Task = { slot: number; label: string; checked: boolean }
function slot(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 32) throw new ExtensionError('invalid-input')
  return Number(value)
}
function addInput(value: unknown) {
  const input = exact(value, ['slot', 'label'])
  return { slot: slot(input.slot), label: text(input.label, 80) }
}
function updateInput(value: unknown) {
  const input = exact(value, ['slot', 'checked'])
  if (typeof input.checked !== 'boolean') throw new ExtensionError('invalid-input')
  return { slot: slot(input.slot), checked: input.checked }
}
const empty = (value: unknown) => { exact(value, []); return {} }
function created(value: unknown) {
  const result = exact(value, ['created'])
  if (typeof result.created !== 'boolean') throw new ExtensionError('invalid-input')
  return { created: result.created }
}
function matched(value: unknown) {
  const result = exact(value, ['matched'])
  if (typeof result.matched !== 'boolean') throw new ExtensionError('invalid-input')
  return { matched: result.matched }
}
function tasks(value: unknown): Task[] {
  if (!Array.isArray(value) || value.length > 32) throw new ExtensionError('invalid-input')
  const rows = value.map(value => {
    const row = exact(value, ['slot', 'label', 'checked'])
    if (typeof row.checked !== 'boolean') throw new ExtensionError('invalid-input')
    return { slot: slot(row.slot), label: text(row.label, 80), checked: row.checked }
  })
  if (new Set(rows.map(row => row.slot)).size !== rows.length) throw new ExtensionError('invalid-input')
  return rows
}
function readOutput(value: unknown) {
  const result = exact(value, ['tasks']); return { tasks: tasks(result.tasks) }
}
function exportOutput(value: unknown) {
  const result = exact(value, ['format', 'rows'])
  if (result.format !== 'sample.task-rows/v1') throw new ExtensionError('invalid-input')
  return { format: 'sample.task-rows/v1', rows: tasks(result.rows) }
}
function deleteOutput(value: unknown) {
  const result = exact(value, ['deleted', 'retention', 'backups'])
  if (!Number.isInteger(result.deleted) || Number(result.deleted) < 0 || Number(result.deleted) > 32 ||
      result.retention !== 'provider-live-rows-deleted' || result.backups !== 'operator-policy') throw new ExtensionError('invalid-input')
  return { deleted: Number(result.deleted), retention: 'provider-live-rows-deleted', backups: 'operator-policy' }
}
function lookupInput(value: unknown) {
  const input = exact(value, ['operationId'])
  if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.operationId)) throw new ExtensionError('invalid-input')
  return { operationId: input.operationId }
}
async function readRows(sql: TransactionSql, installationId: string, tenantRef: string, subjectRef: string): Promise<Task[]> {
  const rows = await sql<Task[]>\`SELECT slot,label,checked FROM extension_data.tasks
    WHERE installation_id=\${installationId} AND tenant_ref=\${tenantRef} AND subject_ref=\${subjectRef} ORDER BY slot\`
  return rows.map(row => ({ slot: row.slot, label: row.label, checked: row.checked }))
}
/** Supply your own host lifecycle, restricted database connection and admitted
 * installation. This module starts no listener and records no host result. */
export function createBackend(options: { database: Sql; manifest: ExtensionManifest; rootOrigin: string;
  verifier: Omit<VerifierOptions, 'consume'>; allowLocalTesting?: boolean }) {
  const database = options.database
  const extension = defineExtension({ manifest: options.manifest,
    verifier: { ...options.verifier, consume: createRootAdmissionConsumer({ origin: options.rootOrigin, allowLocalTesting: options.allowLocalTesting }) },
    actions: {
      'checklist.add': defineAction({ input: addInput, output: created, run: ({ scope }, input) => oncePostgresOperation(database, scope, input, async sql => {
        const rows = await sql\`INSERT INTO extension_data.tasks (installation_id,tenant_ref,subject_ref,slot,label,checked)
          VALUES (\${scope.installationId},\${scope.tenantRef},\${scope.subjectRef},\${input.slot},\${input.label},false)
          ON CONFLICT (installation_id,tenant_ref,subject_ref,slot) DO NOTHING RETURNING slot\`
        return { created: rows.length === 1 }
      }) }),
      'checklist.update': defineAction({ input: updateInput, output: matched, run: ({ scope }, input) => oncePostgresOperation(database, scope, input, async sql => {
        const rows = await sql\`UPDATE extension_data.tasks SET checked=\${input.checked}
          WHERE installation_id=\${scope.installationId} AND tenant_ref=\${scope.tenantRef}
            AND subject_ref=\${scope.subjectRef} AND slot=\${input.slot} RETURNING slot\`
        return { matched: rows.length === 1 }
      }) }),
      'checklist.read': defineAction({ input: empty, output: readOutput, run: ({ scope }) => withPostgresScope(database, scope, async sql =>
        ({ tasks: await readRows(sql, scope.installationId, scope.tenantRef, scope.subjectRef) })) }),
      'checklist.export': defineAction({ input: empty, output: exportOutput, run: ({ scope }) => withPostgresScope(database, scope, async sql =>
        ({ format: 'sample.task-rows/v1', rows: await readRows(sql, scope.installationId, scope.tenantRef, scope.subjectRef) })) }),
      'checklist.delete': defineAction({ input: empty, output: deleteOutput, run: ({ scope }, input) => oncePostgresOperation(database, scope, input, async sql => {
        const rows = await sql\`DELETE FROM extension_data.tasks WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} RETURNING slot\`
        await sql\`DELETE FROM extension_data.operations WHERE installation_id=\${scope.installationId}
          AND tenant_ref=\${scope.tenantRef} AND subject_ref=\${scope.subjectRef} AND operation_id<>\${scope.operationId}\`
        return { deleted: rows.length, retention: 'provider-live-rows-deleted', backups: 'operator-policy' }
      }) }),
      'checklist.lookup': defineAction({ input: lookupInput, output: value => value === null ? null : parseProviderOperationProof(value),
        run: ({ scope }, input) => lookupPostgresOperation(database, scope, input.operationId) }),
    },
  })
  return { handler: createExtensionHandler(extension), health: () => postgresHealth(database) }
}
`

// Native PostgreSQL ownership, forced RLS and operation columns follow the
// existing public counter. Slot bounds are this sample's business rule.
const migration = `-- Customer-owned PostgreSQL 17 only. Apply with a separate migration role.
-- Create extension_app LOGIN and its secret outside this file; never use a host runtime DSN.
CREATE SCHEMA extension_data;
REVOKE ALL ON SCHEMA extension_data FROM PUBLIC;
CREATE TABLE extension_data.tasks (
  installation_id text NOT NULL, tenant_ref text NOT NULL, subject_ref text NOT NULL,
  slot integer NOT NULL CHECK(slot BETWEEN 1 AND 32),
  label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
  checked boolean NOT NULL DEFAULT false,
  PRIMARY KEY(installation_id,tenant_ref,subject_ref,slot)
);
CREATE TABLE extension_data.operations (
  installation_id text NOT NULL, tenant_ref text NOT NULL, subject_ref text NOT NULL,
  operation_id text NOT NULL, action_id text NOT NULL, generation bigint NOT NULL CHECK(generation>0),
  release_digest text NOT NULL CHECK(release_digest ~ '^[a-f0-9]{64}$'),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  completed boolean NOT NULL DEFAULT false, result jsonb,
  PRIMARY KEY(installation_id,tenant_ref,subject_ref,operation_id)
);
ALTER TABLE extension_data.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_data.tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE extension_data.operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE extension_data.operations FORCE ROW LEVEL SECURITY;
CREATE POLICY task_scope ON extension_data.tasks TO extension_app
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
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) })
const slotSchema = { type: 'integer', minimum: 1, maximum: 32 }
const labelSchema = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f]+$' }
const taskSchema = object({ slot: slotSchema, label: labelSchema, checked: { type: 'boolean' } })
const rowsSchema = { type: 'array', maxItems: 32, items: taskSchema }
const operationIdSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' }
const digestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const proofSchema = { anyOf: [{ type: 'null' }, object({ schema: { const: 'mnstry.extension-provider-operation/v1' },
  installationId: operationIdSchema, operationId: operationIdSchema, actionId: { type: 'string' },
  generation: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, releaseDigest: digestSchema,
  payloadDigest: digestSchema, resultDigest: digestSchema, result: {} })] }
const inputs = { add: object({ slot: slotSchema, label: labelSchema }), update: object({ slot: slotSchema, checked: { type: 'boolean' } }),
  read: object({}), export: object({}), delete: object({}), lookup: object({ operationId: operationIdSchema }) }
const outputs = { add: object({ created: { type: 'boolean' } }), update: object({ matched: { type: 'boolean' } }),
  read: object({ tasks: rowsSchema }), export: object({ format: { const: 'sample.task-rows/v1' }, rows: rowsSchema }),
  delete: object({ deleted: { type: 'integer', minimum: 0, maximum: 32 }, retention: { const: 'provider-live-rows-deleted' }, backups: { const: 'operator-policy' } }),
  lookup: proofSchema }

const instructions = `# Provider-owned task checklist

This example stores at most 32 task rows per verified installation, tenant and
member. A task has a numbered slot, a label of 1–80 Unicode code points and a
checked flag. These are this application's local business fields, not shared
host contracts. No host composition or result-recording permission is supplied.

Install the pinned SDK and postgres driver, retain the lockfile, and run npm run
typecheck. If the SDK version is unpublished, explicitly install a reviewed,
owner-supplied tarball and record its digest; then review and reseal the dependency
edit with atelier extension seal --directory .

Use a fresh customer-owned PostgreSQL 17 database. Create the restricted
extension_app login outside the migration, keep its DSN in the backend secret
store, and apply migrations/001-initial.sql with a separate migration role.
Do not apply this fresh-project migration over an existing counter project.
The application login must not own the tables, bypass RLS or inherit unsafe roles.

Your host starts the process and calls createBackend from src/backend.ts with
its database, verified manifest, public verification keys, exact existing
installation binding and admission origin. Mount handler and health in your
own lifecycle. The generated module never starts a listener. Scaffolding creates
no account, database, installation, consent, grant, connection or deployment.
An actual connection must use the host's supported admission and enablement
workflow, with its own membership and consent controls.

Actions are checklist.add({slot,label}), checklist.update({slot,checked}),
checklist.read({}), checklist.export({}), checklist.delete({}) and
checklist.lookup({operationId}). Adding an occupied slot returns created:false
and preserves its label and checked flag. Update returns matched:false for a
missing slot. Reads return tasks ordered by slot. Export returns only this
sample's task rows under format sample.task-rows/v1, without scope or receipts.
It is a logical data export, not a database backup or host import contract.

Writes use oncePostgresOperation: effect and original result commit in the
same scoped transaction. A repeated operation returns that original result;
a changed input, action, generation or release conflicts. A lost reply remains
uncertain: use explicit lookup/recovery, do not automatically replay or refresh
a generation. The operation proof uses the existing SDK format and preserves
the original effect's binding, operation, action, generation and result digests.
Delete removes this scope's live task rows and prior provider receipts, retains
its own receipt, and leaves backup retention to operator policy. It neither
erases host records nor guarantees deletion from backups.

Manifest surfaces and root permissions are empty. No action records a host
result or supplies a renderer. Any host-specific adapter and accepted data
contract require separate work by that receiving host. The web label identifies
the SDK host profile, not proven host compatibility. Sealing records bytes;
qualification, a real PostgreSQL run and installed host acceptance remain separate.
The non-executing atelier.extension-pack.json projection uses the existing pack
workflow; adopt it explicitly in the consuming project's configuration and lock.
`

/** Internal generator seam. The project owner supplies the existing sealer. */
export async function createChecklistProject({ directory, extensionId = 'sample.tasks', profile, packageVersion, sealProject }) {
  if (profile !== 'postgres-sql') throw new Error('unsupported checklist profile')
  if (typeof directory !== 'string' || !directory || typeof extensionId !== 'string' || extensionId.length > 128 ||
      !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(extensionId) || /^mnstry([.-]|$)/.test(extensionId.split('.')[0])) throw new Error('invalid extension id or directory')
  if (typeof packageVersion !== 'string' || !packageVersion || typeof sealProject !== 'function') throw new Error('invalid scaffold dependencies')
  const target = path.resolve(directory)
  await mkdir(target)
  const identity = await lstat(target)
  try {
    const files = {
      'package.json': JSON.stringify({ name: extensionId, version: '1.0.0', private: true, type: 'module',
        files: ['src', 'tsconfig.json'], scripts: { typecheck: 'tsc --noEmit' },
        dependencies: { '@mnstry/atelier': packageVersion, postgres: '3.4.7' },
        devDependencies: { typescript: '5.8.3', '@types/node': '22.18.0' }, engines: { node: '>=22.18.0 <23' } }, null, 2) + '\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', noEmit: true, skipLibCheck: true }, include: ['src/**/*.ts'] }, null, 2) + '\n',
      'src/backend.ts': backend, 'migrations/001-initial.sql': migration, 'README.md': instructions,
      '.gitignore': 'node_modules/\n.env\n.env.*\n!env.example\n',
      'env.example': '# Backend secret reference only; never commit credentials.\nEXTENSION_DATABASE_URL=\n',
    }
    for (const action of Object.keys(inputs)) {
      files[`schemas/checklist-${action}-input.json`] = JSON.stringify(inputs[action], null, 2) + '\n'
      files[`schemas/checklist-${action}-output.json`] = JSON.stringify(outputs[action], null, 2) + '\n'
    }
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(target, relative)
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents, { flag: 'wx' })
    }
    const manifest = parseManifest({ schema: 'mnstry.extension-manifest/v1', extensionId, releaseVersion: '1.0.0', releaseDigest: '0'.repeat(64), protocol: 'mnstry.extension/v1',
      compatibility: { sdkMajor: 1, rootContracts: [], hosts: ['web'] },
      deployment: { profile, bundleDigest: '0'.repeat(64), schemaDigest: '0'.repeat(64) },
      actions: Object.keys(inputs).map(action => ({ id: `checklist.${action}`, effect: ['add', 'update', 'delete'].includes(action) ? 'write' : 'read',
        scope: 'member', inputSchemaRef: `schemas/checklist-${action}-input.json`, outputSchemaRef: `schemas/checklist-${action}-output.json`, timeoutMs: 10000 })),
      recovery: { lookupActionId: 'checklist.lookup' }, permissions: { rootReads: [], rootWrites: [], egress: [] }, surfaces: [],
      data: { classes: ['sample.task-rows'], retention: 'until-user-delete', exportVersion: 1, schemaVersion: '1', readableSchemaVersions: ['1'] } })
    const sealed = await sealProject(target, manifest)
    return { directory: target, profile, model: 'checklist', releaseDigest: sealed.releaseDigest, qualified: false, hostBinding: 'unbound' }
  } catch (error) {
    const current = await lstat(target).catch(() => null)
    if (current?.isDirectory() && current.dev === identity.dev && current.ino === identity.ino) await rm(target, { recursive: true })
    throw error
  }
}
