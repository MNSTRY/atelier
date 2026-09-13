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
  delivery uses `GET /_publish/<vault>` with the same machine credential. It
  returns only schema `atelier-vault-status/v1`, vault, revision and publication
  digest (null before the first publication), never the file manifest. Compare
  both revision and digest with the intended publication before declaring it
  delivered. A differing digest or later revision requires reconciliation; do
  not silently overwrite it. There is no automatic retry or idempotency promise.
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

## Privacy gate and vault interface

A trusted host must now provide `privacy.verify(context)`. Without it, uploads
and artifact reads fail closed. The authenticated vault home at `/<vault>/`
still renders a prominent unavailable/privacy-failure state. This optional
reference server is not a requirement to use Atelier with provider-managed
hosting: other publishing adapters should enforce the same gate semantics.

The verifier receives vault, publication digest, manifest and phase:
`before-upload`, `before-activation`, or `read`. Before-upload verification uses
synthetic canaries; do not upload private bytes to discover whether a destination
is public. Before activation, verify the actual privately staged bytes. Host
probes must use a dedicated internal inspection path which cannot recursively
call the public read handler and cannot be accessed by ordinary readers.

Evidence contains matching vault/publication, `checkedAt`, `validUntil` (epoch
milliseconds, at most five minutes apart), nonempty `policyRevision`, and
`configuration: {ownerOnly, privateStorage, completeInventory}`. All configuration
values must be true. `targets` inventories HTTPS URLs of kinds `artifact`,
`asset`, `alias`, `origin`, `storage`. Each reports `owner`, `anonymous`, and
`otherUser` as `content`, `denied`, or another value for an inconclusive result.
All five surface kinds are required, with unique credential-free URLs. Storage
URLs must deny every browser identity; the other surfaces must return exact
expected content to the owner and deny both unauthorized identities.

The host enumerates ALL actual aliases/routes/storage locations, not a convenient
sample. It must compare expected bytes or a synthetic canary, verify the final
redirect destination and distinguish authentication refusal from service errors.
A redirect or 5xx alone is inconclusive. Configuration inspection must come from
the actual provider and identify the relevant policy revision. Cache evidence
only within its validity and invalidate it on policy/configuration changes.

The evaluator is pure and does not independently authenticate adapter evidence.
It MUST NOT accept evidence from a publication request, browser, repository file,
or publisher-controlled callback. The synthetic test verifier is deliberately
outside the package. Actual Vercel/Cloudflare policy inventory and network probe
implementations remain a host integration requirement; no live protection claim
follows from the local tests. Neither adapter currently ships those probes.

An unauthorized content response produces `exposed`; missing, stale, failed or
incomplete checks produce `unknown`. Both refuse upload/activation/read. Policy
revision changes between upload and activation also refuse the switch. Existing
private objects remain stored and the previous manifest remains current.
Containment of a provider-side bypass requires provider controls: this handler
cannot block a public storage URL outside its runtime. Automated provider
containment and periodic revalidation are not implemented by this module.

The server-rendered vault home contains privacy status, published revision,
artifact navigation, search, empty and unavailable states, accessible labels,
keyboard focus indicators and responsive layout. It uses no JavaScript. Generated
HTML remains a separate document under sandbox CSP with scripts disabled; the
trusted shell never injects generated content. This is a minimal reference
interface, not full authoring/review functionality or browser-qualified parity
with other Atelier interfaces.
