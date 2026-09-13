# Immutable intake and guide integration

## Keep source, extraction and meaning separate

`@mnstry/atelier/intake` supplies a bounded local integrity store for existing
extractors. It does not select or run a processor, install dependencies, import
an entire corpus, upload data, or accept semantic claims.

Create the store in a Git workspace whose `.atelier-local/` is ignored and
untracked. Ingest a visible relative source file against an expected SHA-256.
The store copies verified bytes, checks the source again, and writes an immutable
provenance record. Identical bytes from different source paths retain separate
records. Original files are never moved, rewritten or removed.

Begin an attempt using an explicit identifier, verified blob digest, extractor
identity/version and configuration digest. Retrying the identical attempt is
idempotent; changing its identity is refused. Complete it with bounded UTF-8
output and its expected digest. Output is written and checked before completion.
An interrupted or conflicting output is preserved, never overwritten; inspect
it and use a new attempt identifier for a changed run. An occupied operation lock
requires recovery inspection. A completion receipt proves byte integrity only:
semantic acceptance remains pending. Read completion through the store to verify
its attempt, output and source blob again.

The current per-file/output ceiling is 16 MiB. Larger media stay in existing
bounded processing tools; do not split or downsample originals silently. This
adapter does not promise aggregate disk quota, malware isolation, cross-host
locking, backup, or a Windows qualification. Consumers retain conversation branch
structure, missing-asset evidence, and format-specific completeness checks.
Do not flatten a conversation export merely to satisfy a text-output API.
Packet authoring can proceed before corpus ingestion.

## Guides and private implementations

`@mnstry/atelier/guides` and the guide schema define portable offers, inert
remote capability descriptors, local engagement transitions and exact-payload
consent assessment. Offers identify the guide and capabilities; engagement can
be accepted, paused, resumed or irrevocably revoked. An updated offer requires
a newly bound engagement. Deliverable acceptance remains an explicit human step.
Commercial terms, booking, billing and provider enrollment remain consumer-owned.

Descriptors contain schema digests and a service reference, not executable code,
private instructions or credentials. Do not place sensitive prose in a local
skill, blueprint, manifest, bundle or model context and expect it to remain hidden.
A proprietary implementation must stay behind a separately operated service.
The local harness can call an authenticated remote MCP tool through its configured
host; installing this package neither configures MCP nor makes that connection.

Consent binds the canonical JSON payload, exact offer and capability, engagement
revision and a validity interval. Changing any binding requires new consent.
Revoked/paused engagements and expired consent are refused by local assessment.
Even a positive result is only `eligible-for-host-validation`, never execution
authority. These are unsigned local assertions, not authenticated approvals.

A production host must authenticate guide and author, enforce tenant isolation
and current entitlements/revocation server-side, validate the real schemas, show
exact outbound disclosure and cost, acquire current authorization, and verify
the returned output before proposing a local change. Never send private inputs
just because a descriptor or saved consent says to. Outputs remain untrusted
proposals and cannot publish, edit canonical sources or grant permissions.

No remote executor, endpoint, credential store, scheduling, billing, browser
editor or network behavior is added here. Codex Desktop remains the conversation
surface; the local packet and durable drafts remain independently usable when
the hosted service is unavailable.
