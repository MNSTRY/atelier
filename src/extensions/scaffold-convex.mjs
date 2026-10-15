// Source templates only. The CLI never starts a provider or provisions an account.
export function convexProjectFiles() {
  return {
    dependencies: { convex: '1.46.0' },
    files: {
      'convex.json': JSON.stringify({ functions: 'convex/' }, null, 2) + '\n',
      'src/client.ts': "export { createExtensionClient } from '@mnstry/atelier/extensions/client'\n",
      'convex/schema.ts': "export { default } from '../migrations/001-schema'\n",
      'migrations/001-schema.ts': `import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
const scope = { installationId: v.string(), tenantRef: v.string(), subjectRef: v.string() }
export default defineSchema({
  extensionCounters: defineTable({ ...scope, value: v.number() }).index('by_scope', ['installationId', 'tenantRef', 'subjectRef']),
  extensionOperations: defineTable({ ...scope, operationId: v.string(), actionId: v.string(), generation: v.string(),
    releaseDigest: v.string(), payloadDigest: v.string(), result: v.any(), resultDigest: v.string() })
    .index('by_scope_operation', ['installationId', 'tenantRef', 'subjectRef', 'operationId']),
})
`,
      'convex/backend.ts': `import { internalMutation, internalQuery } from './_generated/server'
import type { DataModel } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { v } from 'convex/values'
import manifest from '../extension.manifest.json'
import { canonicalJson, exact, ExtensionError, parseManifest, parseProviderOperationProof, type Json } from '@mnstry/atelier/extensions'
import { defineConvexExtension, runConvexInvocation, onceConvexOperation, lookupConvexOperation, convexHealth,
  type ConvexVerifierOptions } from '@mnstry/atelier/extensions/convex'
import type { VerifiedScope } from '@mnstry/atelier/extensions/server'
const counter = (value: unknown) => {
  const input = exact(value, ['value'])
  if (!Number.isSafeInteger(input.value) || Number(input.value) < 0 || Number(input.value) > 1000000) throw new ExtensionError('invalid-input')
  return { value: Number(input.value) }
}
const empty = (value: unknown) => { exact(value, []); return {} }
const json = (value: unknown): Json => JSON.parse(canonicalJson(value))
const scoped = (context: MutationCtx, scope: VerifiedScope) => context.db.query('extensionCounters').withIndex('by_scope',
  query => query.eq('installationId', scope.installationId).eq('tenantRef', scope.tenantRef).eq('subjectRef', scope.subjectRef))
export function extension(consume?: ConvexVerifierOptions['consume']) {
  const keys: Record<string, JsonWebKey> = JSON.parse(process.env.EXTENSION_ROOT_PUBLIC_KEYS ?? '{}')
  return defineConvexExtension<DataModel>({ manifest: parseManifest(manifest), verifier: {
    issuer: process.env.EXTENSION_ROOT_ISSUER ?? '', audience: process.env.EXTENSION_AUDIENCE ?? '',
    installationId: process.env.EXTENSION_INSTALLATION_ID ?? '', releaseDigest: manifest.releaseDigest,
    keys: new Map(Object.entries(keys)), consume,
  }, actions: {
    'counter.set': { input: counter, output: counter, run: ({ context, scope }, input) => onceConvexOperation(context, scope, input, async () => {
      const row = await scoped(context, scope).unique()
      if (row) await context.db.patch(row._id, input)
      else await context.db.insert('extensionCounters', { installationId: scope.installationId, tenantRef: scope.tenantRef, subjectRef: scope.subjectRef, ...input })
      return input
    }) },
    'counter.get': { input: empty, output: counter, run: async ({ context, scope }) => ({ value: (await scoped(context, scope).unique())?.value ?? 0 }) },
    'counter.export': { input: empty, output: json, run: async ({ context, scope }) => ({ schema: 'sample.counter-export/v1', value: (await scoped(context, scope).unique())?.value ?? 0 }) },
    'counter.delete': { input: empty, output: json, run: ({ context, scope }, input) => onceConvexOperation(context, scope, input, async () => {
      const rows = await context.db.query('extensionOperations').withIndex('by_scope_operation',
        query => query.eq('installationId', scope.installationId).eq('tenantRef', scope.tenantRef).eq('subjectRef', scope.subjectRef)).take(501)
      // A larger history needs an explicitly designed paginated erasure workflow.
      // Refuse atomically instead of claiming a partial delete is complete.
      if (rows.length > 500) throw new ExtensionError('unavailable', 503)
      const row = await scoped(context, scope).unique()
      if (row) await context.db.delete(row._id)
      for (const operation of rows) await context.db.delete(operation._id)
      return { deleted: row ? 1 : 0, retention: 'provider-live-rows-deleted', backups: 'operator-policy' }
    }) },
    'counter.lookup': { input: value => {
      const input = exact(value, ['operationId'])
      if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(input.operationId)) throw new ExtensionError('invalid-input')
      return { operationId: input.operationId }
    }, output: value => value === null ? null : parseProviderOperationProof(value),
    run: ({ context, scope }, input) => lookupConvexOperation(context, scope, input.operationId) },
  } })
}
export const health = internalQuery({ args: {}, handler: context => convexHealth(context, parseManifest(manifest)) })
// This is intentionally internal. No public mutation/query exposes member tables.
export const invoke = internalMutation({ args: { delegation: v.string(), payload: v.any() },
  handler: (context, args) => runConvexInvocation(extension(), context, { delegation: args.delegation, payload: json(args.payload) }) })
`,
      'convex/http.ts': `import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { internal } from './_generated/api'
import { createConvexHttpHandler, createRootAdmissionConsumer } from '@mnstry/atelier/extensions/convex'
import { extension } from './backend'
const http = httpRouter()
http.route({ path: '/health', method: 'GET', handler: httpAction(async context => {
  try { return Response.json(await context.runQuery(internal.backend.health, {}), { headers: { 'cache-control': 'no-store' } }) }
  catch { return Response.json({ code: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } }) }
}) })
http.route({ path: '/invoke', method: 'POST', handler: httpAction((context, request) => {
  const consume: ReturnType<typeof createRootAdmissionConsumer> = (claims, delegation) => createRootAdmissionConsumer({
    origin: process.env.EXTENSION_ROOT_ORIGIN ?? '', allowLocalTesting: process.env.EXTENSION_ALLOW_LOCAL_TESTING === 'true' })(claims, delegation)
  return createConvexHttpHandler(extension(consume), args => context.runMutation(internal.backend.invoke, args))(request)
}) })
export default http
`,
      'convex/tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', lib: ['ES2022', 'DOM'],
        module: 'ESNext', moduleResolution: 'Bundler', resolveJsonModule: true, allowJs: true, noEmit: true, skipLibCheck: true, types: ['node'] }, include: ['./**/*'], exclude: ['./_generated'] }, null, 2) + '\n',
      'env.example': '# Set only on the customer-owned Convex deployment; public verification keys only.\nEXTENSION_ROOT_ORIGIN=\nEXTENSION_ROOT_ISSUER=\nEXTENSION_ROOT_PUBLIC_KEYS=\nEXTENSION_AUDIENCE=\nEXTENSION_INSTALLATION_ID=\n',
      'README.md': `# Native counter extension

This source-only scaffold uses Convex 1.46.0 and its native schema, indexes,
internal mutations, OCC transactions and HTTP actions. It installs no SQL driver.
Use your own Convex project and reviewed deployment workflow. Atelier init never
starts a backend, logs into an account, deploys code or grants an installation.

Install the exact Atelier candidate tarball and pinned dependencies. The versioned native schema lives in migrations/001-schema.ts; convex/schema.ts
re-exports it. Its bytes are bound by the existing schema/migration digest.
Run Convex code generation before the final seal; its generated files are sealed too.
Run the project typecheck, then atelier extension seal, validate and bundle.
After deployment, validate again and bind the tested deployment identity to the
release before host registration. Generated files changing makes the seal stale.
Set the public verification keys, Root issuer/admission origin, exact backend
invocation audience and opaque installation reference in deployment environment.
No admin key, Root database credential or member identity crosses this boundary.

POST /invoke verifies the original short-lived delegation, consumes Root admission
once, then calls the private internal mutation with the original token and payload.
The mutation verifies them again. Native transactions commit custom writes and the
indexed operation result atomically. A lost HTTP reply needs a new admitted lookup
operation; never repeat a business write just because its reply was lost.

GET /health reports the existing immutable release/schema health envelope after\nnative index checks, without member data. Output validators must preserve the\ncanonical result; construct that result inside the action before its once helper.\n\nThe sample supports scoped set/get/export/delete/lookup. Delete clears this member's
live sample rows and older operation results atomically, up to 500 operations; a
larger history refuses and requires a paginated erasure design. Backup retention
remains the operator's responsibility. Existing admitted effects may finish after
disable. No direct public query or subscription exposes member tables. Reactive
revocation, migrations/backfills, comprehensive privacy lifecycle and complete host
journeys remain separate qualification work. Do not enable a host profile on the
strength of a scaffold or unit test.
`,
    },
  }
}
