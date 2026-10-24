# Read-only database adoption and a standalone app

These APIs prepare a proposed mapping and a local app. They do not create a
database, apply migrations, establish a Root installation or grant authority.

For an existing PostgreSQL database, retain its native schema and ORM sources.
Hash the exact existing source and identify its schema version. The planner
retains that caller declaration; it does not open or verify the source file.
Supply an
explicit schema allowlist, exact tables within it, one expected database owner
role and a local owner reference per table. Map the existing SDK scope names
`installationId`, `tenantRef` and `subjectRef` to concrete text columns. A
mapping is a projection of that existing schema, not a new schema authority.

```js
import { planPostgresAdoption } from '@mnstry/atelier/extensions/adoption'

// database is your own postgres-js compatible client, configured with a
// read-only inspection account, finite connection/statement/transaction limits.
// sourceDigest is SHA-256 of the exact native schema source you reviewed.
const plan = await planPostgresAdoption(database, {
  profile: 'postgres-sql', database: 'sample_store', schemaVersion: '1',
  source: { reference: 'schema.sql', digest: sourceDigest },
  schemas: ['sample_data'],
  tables: [{
    schema: 'sample_data', table: 'counters',
    owner: { role: 'sample_owner', reference: 'owner-selected-local-label' },
    scope: { installationId: 'installation_id', tenantRef: 'tenant_ref', subjectRef: 'subject_ref' },
    columns: [
      { name: 'installation_id', type: 'text', nullable: false },
      { name: 'tenant_ref', type: 'text', nullable: false },
      { name: 'subject_ref', type: 'text', nullable: false },
      { name: 'value', type: 'integer', nullable: false },
    ],
  }],
})
```

The planner selects catalog metadata in a repeatable-read, read-only
transaction. Identifiers are bound data; there are no application-row reads or
DDL/DML statements. It checks the database name and PostgreSQL 17 identity,
refuses wildcard or ambiguous ownership requests and mismatched observed owner
roles, and compares column shapes, primary-key scope coverage and RLS metadata.
Only the selected tables appear in the report. Store the report locally: schema
and ownership metadata can be private. Native ORM introspection output remains
in the consuming repository; the planner never runs a schema generator or push.

An unchanged shape still returns `owner-review-required`, `accepted: false`,
`qualified: false` and `runtimeBound: false`. A matched database owner role does
not verify the local owner reference. RLS flags and a policy count do not prove
policy semantics, membership, consent or application-role safety. Resolve each
diff through the existing database owner's review. No SQL repair is generated.
Missing tables and scope columns are differences; views and foreign tables are
unsupported and refuse. This API deliberately refuses Convex: an existing
Convex adoption path must inspect its exact deployment, schema and native
functions under the provider owner's authority, without claiming SQL parity.

Create a separate fresh TypeScript app from the installed SDK:

```js
import { scaffoldStandaloneProject } from '@mnstry/atelier/extensions/standalone'
await scaffoldStandaloneProject({ directory: './counter-app' })
```

In that app, run `npm install`, `npm run typecheck` and `npm start -- 19`.
The local app uses process memory, starts no network service, and has no Root
authority. For an unpublished candidate install its exact owner-supplied
tarball and record the artifact digest. Existing directories are refused.

The generated `src/root.ts` exports `bindRootCounter`. Supply the existing
sealed manifest, exact existing installation binding and the supported host's
authenticated fetch. The host and provider retain their existing authentication,
consent, admission, lifecycle and storage controls. The sample pins and rechecks
generation and release digest before each call; it never refreshes a stale
binding, retries writes, enables an installation or uploads the local counter.
Its methods return SDK operation receipts. Unknown work must be reconciled
through the existing lookup/recovery workflow before a caller decides to retry.

The synthetic tests check the planner and extracted-package app with an injected
host response. Actual SQL read-only proof, native Convex adoption, real Root
admission and Web/Native host journeys remain independent qualification work.
