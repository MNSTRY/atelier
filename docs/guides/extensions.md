# Custom database extensions

Use `atelier extension init --directory ./custom-extension --id sample.counter`
to generate a TypeScript Postgres backend. The destination must not exist.
The command writes files only. It creates no database, starts no process and
grants no access. Apply the emitted migration to a customer-owned PostgreSQL 17
database with a separate migration role; keep the application login restricted.

The generated backend is a host adapter. Its host supplies the database client,
verified root public keys, pinned installation/release and an admission origin.
The server authenticates a short-lived invocation and obtains durable root
admission before creating its in-process effect scope. The Postgres helper
keeps a native transaction API and atomically commits custom writes with their
operation receipts. Credentials and application data stay in the customer backend.

Import portable wire types from `@mnstry/atelier/extensions`, member/admin clients
from `/extensions/client`, and backend helpers from `/extensions/server` and
`/extensions/postgres`. Browser clients never import database drivers or server keys.
The Postgres driver is installed in the generated project, not in Atelier.

Studio installation and member permission are separate. An authenticated host
owns membership, consent and product access. The manifest declares requested
capabilities; it grants none. Root-bound results use a separate authorized action.
The generated `atelier.extension-pack.json` reuses Atelier's canonical pack identity,
loader and lock adoption. Its namespaced `runtimeManifest` field pins this component's
manifest file and release digest. The runtime manifest describes the backend protocol;
it does not create another pack identity. Declare the emitted pack in your existing
project and adopt it with the normal validation/lock workflow. Pack loading remains
non-executing and grants no backend or root authority. Standalone hosts can consume
the portable SDK without an Atelier project.

Use `extension validate --directory ...` to check source/schema/release digests.
After reviewing an edit, use `extension seal --directory ...` to update them.
A valid seal identifies bytes; it proves neither publisher trust nor deployment.
Keep the package lockfile after installation. Lost write replies require explicit
lookup/recovery; neither client silently retries or refreshes a generation.

Scaffold profiles include postgres-sql, drizzle-db-first, drizzle-code-first,
prisma-7-postgres and convex-native. Drizzle retains its native query builder and transaction API;
Prisma retains its native generated client and pg adapter. Convex uses the native
starter described below. Prisma 8 remains an unqualified separate experiment. Scaffolding, synthetic
protocol tests, real provider tests, actual supported hosts, public release and
customer acceptance carry separate evidence. Private runtime bindings are not
distributed in this package.

The runtime parser is required after JSON Schema validation: it enforces unique IDs and cross-references, recovery scope/effect, current-schema readability, Unicode and total JSON bounds. Native Postgres operation results are capped at 60 KiB inside the transaction, leaving room for the original-operation recovery proof within the 64 KiB action output bound. Every failure after successful admission remains an uncertain operation; inspect its durable receipt before deciding what to do next.

The candidate SDK version 0.2.0-alpha.15 is unpublished. Before its release,
pack the reviewed Atelier checkout with `npm pack --ignore-scripts` and install
the resulting local tarball in the generated project with
`npm install /absolute/path/to/mnstry-atelier-0.2.0-alpha.15.tgz`. Then run
`npm run typecheck` and reseal the reviewed project. Do not expect the unpublished
version to install from the public registry. String length limits use Unicode
code points, matching JSON Schema; ill-formed surrogate sequences remain refused.

The source seal covers package.json, tsconfig.json, src/, present npm lockfiles,
and present Drizzle/Prisma configuration and Prisma schema files. Installing or
changing a lockfile requires an explicit reseal. It does not cover an arbitrary
external host or deployed image. Schema bytes cover schemas/ and migrations/.
Each source file is limited to 1 MiB; each canonical digest map is limited to
128 KiB. Deterministic invalid pack state refuses before rewriting the manifest.
The manifest and pack remain separate files: an interruption between their writes
is detected as stale by validation and requires an explicit reseal.

Choose a profile with `atelier extension init --profile drizzle-db-first` (or
`drizzle-code-first`, `prisma-7-postgres`). DB-first uses native `drizzle-kit pull`
restricted to extension_data, then normalizes the generated local relation import
for Node ESM. Review and retain the generated schema before resealing. Code-first
uses native generation: review and apply its SQL before the explicit forced-RLS
governance migration. Export the schema declaration so generation creates it.
Prisma 7 uses native client generation and the explicit application DSN supplied
by the customer host; the reviewed SQL still installs RLS. Generator output is
a proposed source change, never permission to mutate a shared or Root database.
Optional provider dependencies are installed in the generated app, never Atelier.

Custom native configuration, schema and migration locations must be listed in the
generated package.json `files` array as literal project-relative files or directories.
This reuses the project's native package input list; it adds no second project catalog
and never executes a TypeScript config during sealing. The list itself is sealed.
Conventional generated paths and present npm locks are included automatically.
Globs, parent paths, dependency directories, hidden paths except Git ignore/attribute files, and self-referential
manifest/pack inputs refuse. The seal identifies these declared inputs; it does not
claim an arbitrary external host, build artifact or dependency outside the project.

Prisma interactive transactions use a 12-second transaction timeout and a 10-second
SQL statement timeout. A manifest may allow up to 30 seconds, but the native
transaction can roll back sooner and the handler then reports operation unknown.


After reviewing and sealing a project, `atelier extension bundle --directory
./custom-extension --json` writes its registration bundle to stdout. It contains
the pinned manifest, exact schema strings and migration hashes. It uses the same
file checks as sealing and refuses stale inputs. It creates no account, database,
process or installation and applies no migration.

Pass this bundle to `createExtensionAdminClient(transport).registerRelease(bundle)`
through the consuming host's authenticated transport, then configure the returned
release using the existing connection and lifecycle methods. The receiving host
must independently verify every release and file digest and apply its publisher
policy. A registration receipt is separate from health, enablement and consent.
An older host without registration refuses with `unavailable`; clients do not
silently enable or repeat the operation.

A generic counter response is custom application data. A host's result-recording
contract can require a different schema and narrower bounds. Author that result
explicitly, update its action output schema, review and reseal it, and request the
host's separate permission before recording it. Declaring a root-write permission
alone does not make an arbitrary action result compatible.

## Native Convex starter

Use `atelier extension init --profile convex-native --directory ./custom-extension`
for a TypeScript project pinned to Convex 1.46.0. This optional adapter uses native
Convex schema/functions, indexes and OCC transactions. It installs no SQL driver
and adds no Convex dependency to Atelier itself. Import native backend helpers
from `@mnstry/atelier/extensions/convex`; browser clients use the same portable
`/extensions/client` interface as the SQL profiles.

The HTTP action verifies the original Root delegation and consumes admission
once. It then passes that token and the canonical payload to an **internal
mutation**, which verifies them again. A serialized scope or an `admitted`
boolean is not authority. Native writes and the indexed operation result commit
in one mutation. Output validators refuse invalid values and preserve canonical
result bytes, so response and durable lookup cannot diverge. Root callbacks and provider commits remain separate. A lost
reply requires a new admitted lookup operation, without repeating the write.
No ordinary public mutation/query exposes the generated member tables. `GET /health`
reports only the immutable release/schema health envelope after native index checks.

The customer owns its Convex project and deployment. Set the public verification
keys, issuer, exact invocation audience, opaque installation reference and Root
admission origin in that deployment. Keep admin keys and member identities out
of the browser and runtime request. HTTPS is required by default. The explicit
local test option additionally requires both provider deployment URLs to be
literal loopback addresses; Convex can set `NODE_ENV` to production even locally.

The versioned native schema is `migrations/001-schema.ts`; `convex/schema.ts`
re-exports it. The existing schema digest binds those migration bytes. Native
source and generated code are sealed as bundle inputs. Generate provider code,
strictly typecheck, seal, validate and export the bundle; validate again after
deployment. Any changed generated input requires resealing and requalification.
Atelier's CLI performs no provider login, process startup or deployment.

The sample supports scoped set/get/export/delete and durable lookup. Deletion
atomically clears live sample rows and older operation results for up to 500
operations; larger histories refuse and need an explicit paginated erasure design.
Backups remain subject to the operator's retention policy. In-flight admitted
mutations may finish after disable. Public reactive feeds, revocation on feed
reconnect, schema backfills, portability and complete host/privacy acceptance
remain unqualified. The native starter's provider proof does not enable a
receiving host's Convex profile or establish a complete customer journey.

## Readiness extension packs

Local readiness protocols use the existing extension-pack declarations in
`atelier.project.json`. They are separate from database runtime adapters. A
project can select custom protocols without the bundled MNSTRY readiness pack:

```json
{
  "ext": {
    "mnstry.atelier": {
      "readiness": { "includeBundled": false },
      "extensionPacks": [
        {
          "id": "sample.readiness",
          "version": "v1",
          "path": "packs/sample-pack.v1.json",
          "enabled": true
        }
      ]
    }
  }
}
```

Review the pack, then run `atelier extension-pack validate` and
`atelier lock write`, both with `--project ./atelier.project.json`.
Use `atelier readiness protocols --project ./atelier.project.json` to list the
selected protocols, then pass a full namespaced ID to `atelier readiness run`
or `atelier review run` with the same project. Evidence-bound review still
requires the existing [pack compatibility declaration](../reference/extension-pack-lifecycle.md).
Existing answer, proposal and evidence rules continue to apply.

Omitting `readiness.includeBundled` or setting it to `true` keeps custom
protocols alongside the bundle. With `false`, bundled IDs and aliases are
unavailable to project runs. A standalone `readiness protocols` invocation
without a project selection still lists the bundle. Generic graph, project and
readiness checks remain available; the MNSTRY journey, packet and readiness
export commands refuse. See [pack selection and lock transitions](tenant-readiness.md#select-the-readiness-pack).
