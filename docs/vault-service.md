# Portable private artifact vaults (experimental)

This is an optional hosted service contract, not part of the local authoring
server. The core does not start a service, provision infrastructure, select an
identity provider, or make network requests on import. A host explicitly binds
provider SDKs and owns their network access, credentials, costs and operations.
Canonical sources and editorial review remain in the consuming repository.
Uploading a derived artifact does not satisfy an editorial publication gate.

## HTTP contract

- `GET /<vault>/<artifact-path>` and `HEAD` authenticate a browser session and
  require exact owner issuer + subject equality. Every asset uses this route.
- `POST /_publish/<vault>` requires a separate vault-scoped machine credential.
  Browser cookies and Origin headers are refused on this endpoint. The JSON
  body has schema `atelier-vault-publication/v1`, `contractVersion: "1.0.0"`,
  `expectedRevision` (initially
  zero), and `files: [{path, base64}]`. No URL retrieval or directory discovery
  occurs. The caller explicitly selects all uploaded files and is responsible
  for source selection, disclosure checks and any editorial approval.
- Successful publication returns 201 and a receipt containing vault, revision
  and the SHA-256 publication digest. Conflicts return 409. Retry after uncertain
  delivery requires checking the current revision through an operator; there
  is no automatic retry or idempotency promise yet.
- Unauthenticated reads return 401; a host may route these to its established
  sign-in UI. Missing and non-owned vaults both return 404. Failures return 503
  without leaking adapter errors. No CORS grants or sharing bypass exist.
- Requests are limited to 4 MiB encoded JSON, 100 files, conservative ASCII
  paths and allowlisted types. HTML and CSS are supported with restrictive CSP;
  scripts, SVG and arbitrary interactive applications are excluded. HTML is
  sandboxed without same-origin or script privileges. PDF is a download.

All output, including errors, is private/no-store. Content bytes are checked
against the committed manifest before delivery. No public object URLs or
presigned download redirects are returned. Revocation blocks subsequent
checks; it cannot recall a response already authorized or a downloaded file.

The optional `contractVersion` and inert `ext` containers follow the kit schema
epoch. Extension data never grants authority and is not copied into artifacts.

## Host interfaces

Import the `@mnstry/atelier/vault` entrypoint. `createVaultService` takes:

- `identity.read(request)` returns a verified `{issuer, subject}` or null. It
  must verify signatures, issuer/audience, expiry and current revocation using
  the chosen provider. Never derive identity from a caller-provided header.
- `identity.publish(request, vault)` verifies a machine credential. The supplied
  `vaultIdentity` helper hashes a high-entropy bearer credential and calls the
  host's authoritative `lookupCredential(hash)`. A record contains `vault`,
  `owner`, `revoked: false` and finite millisecond `expiresAt`. Generate at least
  32 random bytes; never place credentials in repository files or URLs.
- `metadata.get(vault)` returns owner, revision and manifest. `commit` compares
  owner AND expected revision atomically before replacing the current manifest.
- `storage.put(key, bytes)` and `get(key)` use private storage. Keys are generated
  from validated vault IDs and byte digests; request paths never become keys.

Metadata lookup and credential lookup must use authoritative current state,
not eventually consistent caches. Provision vault ownership out of band; the
publication endpoint cannot claim a vault or change ownership. A host identity
migration must explicitly map issuer and subject, not match email strings.

## Provider bindings

`createVercelVault` composes Blob/PostgreSQL bindings into a Web handler.
`createCloudflareVault` returns a Worker with per-request first-primary D1
sessions, using `env.VAULT_OBJECTS` and `env.VAULT_DB`. Both require explicit
verified-session and current-credential lookup functions from the host.


Vercel: pass the host-installed `@vercel/blob` SDK to `vercelPrivateStorage` and
an established PostgreSQL client's `query` to `postgresVaultMetadata`. Use the
exported `VAULT_TABLE_SQL` to initialize a new disposable/purpose-built store.
Bind an established browser identity SDK to `verifySession`; the kit does not
ship a bespoke login system. Route all vault paths through the handler. Do not
copy artifact output into public/static deployment directories.

Cloudflare: pass a private R2 binding to `r2PrivateStorage` and D1 to
`d1VaultMetadata`. If using D1 read replication, pass a session with
`first-primary` semantics so ownership lookup cannot use a stale replica.
The Web Request/Response handler can run directly in a Worker. Disable public
R2 access and do not attach a public R2 domain. All Worker/provider aliases must
run the same handler; no cache rule or static-assets shortcut may bypass it.

Each adapter puts immutable-in-meaning content-addressed bytes first, then
switches the manifest through an atomic SQL update. Concurrent publications
cannot overwrite a newer revision. Failed uploads can leave unreferenced
private objects; garbage collection and retention are host responsibilities.
There is no automatic deletion. Republishing a selected earlier artifact set
at the current expected revision implements rollback as a new revision.

References:
- https://vercel.com/docs/vercel-blob/private-storage
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- https://developers.cloudflare.com/d1/worker-api/d1-database/

## Qualification and remaining integration

`node --test test/vault.test.mjs` exercises both storage adapters with SDK-shaped
local doubles and a real SQLite engine behind both SQL interfaces. PostgreSQL
placeholder translation in the test is a local double, not a PostgreSQL engine. This proves
shared local behavior, not Vercel, R2, D1 or PostgreSQL hosted operation.

Before serving real material: qualify the chosen identity SDK and browser
login/revocation, deployed provider bindings, owner/wrong-owner/anonymous reads,
all aliases and assets, CSS/image rendering under sandbox CSP, publication
failure recovery, limits and credentials. Run a source-bound independent
review. These are open gates. The implementation is not deployment-ready.
The SDKs, production credential store, provisioning UI, CLI integration and
hosted conformance runner remain consumer-host work for the next integration
step. No existing deployment or protection setting is modified by this code.
