# Experimental edge policy adapter

This additive module computes eligibility over repository-owned source records
and signed decisions. It is not a new ontology canonical, key registry, identity
provider, access host or source writer. No CLI, browser endpoint, root export or
existing graph/proposal behavior changes. Import the modules within an admitted
source integration; this experimental seam is not a published package subpath.

## Authority reused

Repository sources and the existing graph vocabulary own declarations and
identity. Federation supplies `{repoId,localId}`; local titles, aliases and root
commits do not establish repository identity. The adapter reuses the existing
`attestation/jcs.mjs` RFC8785 canonicalization and `attestation/sign.mjs` detached
signature verification. Existing collaboration proposals remain copy-only.
Local review artifacts and boundary actor delegations remain attribution-grade;
they cannot stand in for authenticated steward approval.

Koiné contribution acceptance is unchanged. Withdrawing an edge's eligibility
does not withdraw or mutate an accepted Koiné proposal. Hosts retain their
existing proposal, receipt, withdrawal and source-owner incorporation paths.
This public adapter has no dependency on Koiné, a private bridge or MNSTRY.

## Record and decision contract

`contract.mjs` validates closed experimental shapes. `edgeIdentity(record)` is
the full RFC8785 SHA-256 of the immutable record, prefixed `edge:`. These are
projection identities, never replacements for source node or repository IDs.

An edge record has:

- `schema: 'atelier-edge-record@experimental-v1'`, `family`, `subject`,
  `predicate`, `object`, and `qualifications[]`;
- `home: {repoId,path,readership}`, `origin`, and `supports: [{id,source}]`;
- `policyDigest`, `proposalRef` and `sourceChange` (nullable only where review
  is unnecessary). `sourceChange` preserves `{repoId,path,baseRevision,
  diffDigest,reviewRef}` for the source owner's normal diff/PR path.

Each source reference contains `{repoId,path,revision,fileDigest,
locator:{byteStart,byteEnd},citedDigest}`. Byte offsets are zero-based with an
exclusive end. File and cited-span digests cover the exact raw bytes, without
normalization. A revision is the producer's exact snapshot revision, including
dirty-tree scope when applicable. Adapters must preserve the federation's raw
file digest separately from its normalized text digest. A pointer-only location
must be resolved to an exact raw-byte range before admission; do not guess a
range from reserialized front matter or JSON. Unknown, changed or absent sources
stay pending/stale. The origin occurrence is always retained along with every
support occurrence, even when two occur in the same file.

Families remain separate:

| Family | Meaning while eligible | Required review |
| --- | --- | --- |
| `hyperlink` | Navigation with predicate `links-to` | No semantic approval is claimed. Exact extracted origin and safe home remain required. |
| `source-declaration` | Native source relation | Same-repository declarations need no invented review. Every cross-repository declaration needs governed review. |
| `reviewed-assertion` | Policy-reviewed semantic assertion | Home-owner and applicable endpoint-steward review, followed by home-owner acceptance. |

The default policy rejects proposer self-review and a common steward for two
repository endpoints unless explicitly delegated by the trusted policy. Policy
is `{version,allowProposerReview,allowSharedSteward}`; its full digest is pinned.
Policy values come from the host, never the record. The version is a receiving
host's existing policy reference, not an admitted shared policy canonical.

Decisions use `atelier-edge-decision@experimental-v1` with `recordDigest`,
`sequence`, `previousDigest`, `action`, `actorId`, `at`, `policyDigest`, `reason`,
`roles[]` and the existing detached `signature` shape. Sign with the existing
`signDocument` procedure; private keys stay in the host's existing custody.
Approval roles are `{repoId,role:'home-owner'|'endpoint-steward'}`. The host
binds each role to its current actor. One verified actor may approve several
explicitly delegated roles, but a signature alone never creates that delegation.
This adapter's roles are repository-scoped. Conflicting endpoint steward IDs
inside one repository refuse instead of dropping one required review. A host
with finer resource stewardship needs an explicitly admitted mapping before use.

The chain begins with `propose`, followed by required `approve` decisions and
`accept`. The adapter derives `draft`, `awaiting-endpoint-review`, `active`,
`rejected`, `suspended`, `withdrawn` and `superseded` states. Changed citations
derive `stale`. Rejection, suspension, withdrawal and supersession are terminal
for that immutable chain. Revalidation/correction requires a new record and
ordinary source review; no accepted record, evidence pin or event is overwritten.
Retain all original records and chains in their safe source home. This module
does not persist, compact or modify them.

## Trusted host ports

Call `await evaluateEdge({record,events}, host)` only after the access composer
has current recipient grants for the home, both endpoints and every source.
Evaluation is eligibility, not an ACL verdict. The host must maintain one
coherent current snapshot throughout the call. It supplies:

| Port / value | Required behavior and result |
| --- | --- |
| `policy`, `now`, `bindingId` | Current trusted policy, trusted ISO time and the access lane's current principal/grant/source snapshot binding. Never a browser assertion. |
| `readRecordHead({edgeId,recordDigest})` | Read the actual source home and complete current log head; return `{recordDigest,eventCount,eventDigest}`. Last-event digest is null only for an empty log. A caller's truncated history cannot replace the stored head. |
| `verifyOrigin({record,edgeId,recordDigest,policyDigest})` | Verify the exact extracted origin family, triple and occurrence against the source contribution, or the exact reviewed assertion source record; return `{recordDigest,bindingId,matches:true}` only on a match. Hashes alone do not prove that a link or relation actually declares this triple. |
| `checkSourceHome({record,edgeId,recordDigest,policyDigest})` | Check the home's entire intended readership can know every endpoint and provenance field, including evidence, qualifications, proposal/PR references and actor identities. Return `{recordDigest,policyDigest,bindingId,allowed:true}` only when safe. A current reader's larger access does not make a broad shared home safe. |
| `resolveEndpoint(ref)` | Exact current source identity, not an alias or external prefix; return `{ref,current:true,stewardId}`. Deleted/migrated identities refuse until explicitly revalidated. |
| `resolveHomeOwner(repoId)` | Current source-home ownership: `{actorId}`. |
| `readSource(source)` | Read that exact current authorized raw file, returning `{revision,bytes:Uint8Array}`. Recheck exact revision, file digest, byte bounds and cited bytes. Never silently replace pins. |
| `resolveActorKey({actorId,keyId,at})` | Use the existing trusted host registry to bind the exact actor/key and current revocation state: `{actorId,publicKey,revoked:false,notBefore,expiresAt}`. `publicKey` is the existing `verifyDocument` public-key document. The key must cover the decision time and remain valid now. Never accept a caller-supplied key registry. |
| `authorizeDecision({event,record,required,policyDigest})` | Verify current action/role scope, principal/key rights and revocation. Return `{eventDigest,policyDigest,bindingId,allowed:true,revoked:false,notBefore,expiresAt}` bound to that exact signed event and policy. Historical or expired rights cannot sustain an active edge. |

Missing ports, exceptions and malformed results fail closed. Key/reviewer/grant
changes, stale policy, missing endpoints, unsafe homes and invalid chains never
remain eligible. Port implementations are host-specific acceptance obligations;
synthetic test hosts do not qualify an actual Git provider or shared service.

## Composer and projection seam

The immutable evaluation result contains `edgeId`, `recordDigest`, `policyDigest`,
`state`, `eligible`, `family`, `triple`, `supportRefs`, `reviewRefs`,
`qualifications`, source-owner handoff and full signed `history`. Failed
verification can return only a generic suspended result. This is an **owner
audit** object, not a response for an arbitrary reader.

`displayEligibleEdge(result)` accepts only an original in-process evaluated
eligible result. Deserialized or fabricated `eligible:true` objects are refused.
It returns `{edgeId,source,target,predicate,family,acceptanceState,assurance,
supportRefs,sourceRef,reviewRefs,qualifications,recordDigest,policyDigest,
verification:{checkedAt,bindingId}}`, with evidence and review references only.
`sourceRef` is the origin's evidence ID. Each evidence occurrence has a
content-bound ID namespaced to its assertion and original occurrence ID;
evaluation `supportRefs` retain the actual exact source refs for the authorized
evidence adapter. No raw decision body, source path, diff or private key reaches
the display shape. Evidence rows must undergo the access lane's own disclosure
filter before serialization.

The access host evaluates again for each new delivery and validates the binding
at use time. Do not persist eligibility decisions as reusable authority or serve
a cached result after a grant/source change. In-process provenance is a guard
against accidental data promotion, not a security sandbox against malicious
code executing inside the trusted host.

`groupEligibleEdges(results)` is an optional view grouping helper. It retains
every distinct assertion with all support occurrences and signed history,
orders deterministically, refuses conflicting results and never merges families
or qualifications. It only accepts evaluated results already authorized for one
reader in one host snapshot. Group output is also owner/audit data; renderers
consume bounded display edges, retaining distinct edge IDs for the same triple.
The helper explicitly refuses mixed binding IDs or policy digests.

## Verification and integration limits

Run `node --test test/edge-policy.test.mjs`. Fixtures generate ephemeral signing
keys at runtime and use synthetic repositories, observations and actors. They
verify the control's refusal behavior without touching a live provider.

The graph builder, collaboration stores, Koiné operations, public package
exports, current host bindings, shared-view access service and source-owner Git
application are separate receiving work. Neither a local test pass nor a signed
decision proves deployment, human acceptance or source incorporation.
