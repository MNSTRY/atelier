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

Scaffold profiles include postgres-sql, drizzle-db-first, drizzle-code-first and
prisma-7-postgres. Drizzle retains its native query builder and transaction API;
Prisma retains its native generated client and pg adapter. Convex remains pending,
and Prisma 8 remains an unqualified separate experiment. Scaffolding, synthetic
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
Globs, parent paths, dependency directories, hidden environment paths and self-referential
manifest/pack inputs refuse. The seal identifies these declared inputs; it does not
claim an arbitrary external host, build artifact or dependency outside the project.
