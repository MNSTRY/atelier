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
The extension-pack loader remains non-executing and is separate from these APIs.

Use `extension validate --directory ...` to check source/schema/release digests.
After reviewing an edit, use `extension seal --directory ...` to update them.
A valid seal identifies bytes; it proves neither publisher trust nor deployment.
Keep the package lockfile after installation. Lost write replies require explicit
lookup/recovery; neither client silently retries or refreshes a generation.

The initial scaffold profile is Postgres. Drizzle, Prisma and Convex are planned
native integrations and are not advertised as qualified. Scaffolding, synthetic
protocol tests, real provider tests, actual supported hosts, public release and
customer acceptance carry separate evidence. Private runtime bindings are not
distributed in this package.
