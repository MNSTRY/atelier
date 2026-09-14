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
an established PostgreSQL client object exposing `query(sql, args)` to `postgresVaultMetadata`. Use the
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

This is an experimental contract, not a qualified hosted product. The service
requires a trusted `deployment: {id, origins}` binding. Origins are canonical
HTTPS origins, including every deployment alias and direct handler origin (up
to 16). The provider inspector must discover any additional bypass surfaces and
refuse `completeInventory` if this binding is stale. Configuration evidence is
trusted host input, never publisher/browser input or a repository assertion.

The context carries vault, owner, publication digest, metadata revision, manifest, deployment,
request origin/path, phase, and `objects: [{key, sha256, size}]`. Object keys are
explicit even before upload. The evaluator requires both vault home routes and
every manifest path on every configured origin, plus every unique object key.
Each route target has `kind: "route"`, URL and expected SHA-256; each storage
target has `kind: "storage"`, URL, key, SHA-256 and size. Storage URLs are only
passed to the trusted inspector/transport, never returned to the browser.

Privacy checks ask whether **anonymous and other-user identities are denied**.
They never request an owner's session or probe as the author. Owner rendering
and login continuity are separate functional acceptance checks. Consequently,
probes against the real handler exit at authorization without recursively
entering the privacy gate. No substitute owner route or privileged inspection
endpoint is used to manufacture a verified verdict.

`privacy.verify(context)` collects before-upload and before-activation evidence.
Before upload, authoritative provider configuration must attest private storage
and owner-only routing before private bytes are written. Denial probes of paths
that do not yet exist are supplementary; a 404 alone cannot prove future bytes
will be protected. A host can supply public synthetic canary markers to check
its protection machinery, without uploading private data to discover exposure.
Before activation, the same gate checks actual staged object locations and all
planned artifact routes. Unactivated artifact paths may return 404; their future
owner rendering is not asserted by a denial verdict. Provider configuration and
the handler's authorization remain the preventive controls. A change between
checks refuses activation, but cannot atomically lock external provider policy.

Read requests call only `privacy.current(context)`, which must load stored
current evidence. They never collect probes. Missing, expired, wrong-owner,
wrong-deployment, wrong-publication or incomplete evidence blocks delivery.
`createVaultPrivacyState({probe, load, compareAndSet})` supplies an explicit refresher and
host-owned evidence persistence. Call `refresh(context)` after commit and from
the host scheduler with the current authoritative manifest and owner. Activation
evidence is deliberately not promoted to read evidence; owner delivery remains
unavailable until the first successful read-phase refresh. Refresh failure never
extends a validity window. A policy change requires immediate host invalidation;
the kit cannot discover that change from an evidence-store read alone.

The store key includes deployment ID and vault. `load(key)` returns an immutable
snapshot `{version, evidence}`; a missing record is `{version: 0, evidence: null}`.
`compareAndSet(key, evidence, {expectedVersion})` must atomically compare the
version, increment it on success and return exactly `true`, or return `false`
without writing. Its transaction must refuse replacement of any exposure alarm
and refuse older metadata revisions. Separate atomic load/save calls are not
sufficient. Protect the store from publishers; no unconditional save adapter is
accepted. Evidence and refresh contexts bind the authoritative metadata revision.

On conflict, the wrapper reloads the stored record, preserves any alarm and
otherwise refuses the collection. It never blindly retries or overwrites newer
evidence. An in-process alarm latch immediately blocks subsequent reads, even
when persistence fails or another collection is still running. The durable
store is still needed across instances and restarts: failed persistence cannot
protect other processes, and must be treated as an operator incident. This
wrapper provides no alarm-clear API. Reconciliation is an explicit host operator
procedure: contain the external exposure, verify restored controls, reconcile
durable state, then replace affected handler instances. Restart alone does not
clear a successfully persisted alarm and is not a recovery procedure.

### Reusable denial probe collector

`createVaultPrivacyProbe({inspect, request, onExposure})` takes an explicit
provider inspector and transport, without choosing a network implementation.
The transport receives only anonymous/otherUser identity, manual redirects and
an AbortSignal; otherUser must be a dedicated synthetic unauthorized principal,
not another real person's session. Never give this collector an owner credential.
The inspector supplies configuration, policy revision and the full target list.
Configuration must report `ownerOnly`, `privateStorage`, `completeInventory`.

The collector supports at most 2000 targets, sufficient for 100 files across
16 origins plus home routes and unique storage objects. Exceeding the bound or
the configurable whole-operation deadline (maximum/default 60 seconds) refuses
verification; completeness is never replaced with sampling. The serial transport
may not finish a large inventory in time. Qualify provider latency and choose a
smaller deployment or a separately reviewed batched collector if needed. The
current 60-second validity starts at collection start; refresher period plus
worst-case collection time must be strictly less than 60 seconds. A minute
schedule or a near-deadline collection cannot provide continuous availability.
These defaults are an open product limitation, not a scheduling recommendation.

Each target supplies an expected SHA-256, optionally a public synthetic `canary`
marker of at least 32 characters. Nonempty whole-body digest or embedded canary matches
are exposure even on error or already-followed responses. Zero-byte artifacts
remain valid: an empty refusal discloses no bytes and never raises an exposure
alarm. Home-route digests may use an inspector-defined placeholder; use an
explicit public canary to detect actual listing disclosure. Nonempty 401/403/404 bodies without a match
are inconclusive, because a body fragment is not proof of non-disclosure. Empty
401/403/404 responses count as denial. Arbitrary HTML and 5xx are inconclusive.
Login redirects may match trusted `loginEndpoints: [{url, queryKeys}]`; endpoints
are exact HTTPS origin/path, with an explicit allowlist of supported non-secret
parameter names. Credential-bearing or unexpected parameters, hosts and paths
are inconclusive. The collector never follows redirects or copies login values
into evidence. This verifies refusal, not the return-to user experience.

Evidence starts its freshness window at collection start (60 seconds), binds
owner/operation/publication/deployment, retains target digests and keys, and
re-inspects provider policy using canonical object-key ordering. An unauthorized
content observation returns immediately and stays `exposed` even if evidence
later expires. Optional `onExposure(evidence)` is a best-effort host notification;
it cannot delay or downgrade the alarm and is not durable containment. Hosts
must persist incidents and enforce provider-side containment independently.
No scheduler, provider configuration collector, credential store, containment
operation, or hosted transport is bundled here.

A provider bypass can expose staged objects after a successful preflight. This
handler can refuse its own delivery/activation but cannot close an external
public origin or delete orphaned bytes. Before real material, qualify atomic
incident persistence, provider protection restoration, staging retention/deletion
and owner-visible recovery. Do not advertise a denied handler response as global
containment or an observed denial as permanent privacy.

### Reference interface and browser qualification

The reference home provides privacy status, revision, navigation, search, empty
and unavailable states, accessible labels and responsive layout. Its status
states that unauthorized-access checks passed at a recorded time, not that owner
rendering or every future provider state is proven. Generated HTML stays outside
the trusted shell under script-disabled sandbox CSP. This is a minimal reference
interface, not full authoring/review parity.

**Open browser design gate:** opaque-origin sandboxed HTML may lose SameSite
session cookies on CSS/image requests. Widening cookies can permit cross-site
embedding. The kit does not silently remove sandbox isolation or widen cookie
scope. A consuming host must qualify an isolated artifact-origin/session design,
including Chromium/Firefox/WebKit subresources and refused cross-site embeds,
before claiming browser-product readiness. No browser acceptance is claimed.

### Source layouts

The Node-only `@mnstry/atelier/vault/source` entrypoint exports
`prepareVaultSource({root, paths, expectedRevision})`. Pass an absolute local
artifact root and explicit relative file paths. A root can be a folder inside
the authoring repository or a separate artifact checkout; neither is scanned
automatically. It returns the publication request, digest and manifest without
uploading anything. Keep machine-specific roots in local host configuration.

The reader refuses symlinks, hard-linked files, path escapes, directories,
unsupported formats and oversized bundles. It checks file identity and metadata
around the read and binds the resulting bytes to the manifest. Run against a
quiescent source tree; portable filesystem checks are not a sandbox against a
malicious process concurrently replacing ancestor directories. The publication
bundle is an immutable byte snapshot, not a live directory handle.
