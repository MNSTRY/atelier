# Evidence navigation

The portable evidence contract describes exact source references, attributed
claims, declared host capabilities, and dependency snapshots. It sits under
Knowledge Stewardship and can be composed by inquiry harnesses. The initial
implementation provides pure assessments; package and CLI integration are
separate receiving changes.

`validateEvidenceDocument(shape, value)` validates bounded JSON against the
closed versioned schema. Supported shapes include `profile`, `hostCapabilities`,
`evidenceRef`, `claim`, and `snapshot`. Unknown fields, unsupported kinds, missing
attribution, invalid dates, and malformed references fail. Reserved `ext` fields
cannot carry behavior. Unknown event time and source attribution remain explicit.

`assessEvidenceCompatibility(profile, host)` compares exact declared protocols,
operations, and capability versions. The result says whether those declarations
match. The host must separately qualify its implementation and enforce permission.

`assessEvidenceCurrency(reference, snapshots, { at, maxDepth, maxNodes })` checks
an exact source reference and all supplied dependencies. Missing, ambiguous,
changed, withdrawn, expired, and cyclic evidence cannot yield `current`. Reaching
a verification bound also refuses current use. The caller supplies a valid time;
the pure module never reads a clock, storage, identity, or permission service.
Snapshots are protected host inputs, not permission grants or agent-visible
provenance. This function does not establish coverage, absence, or completeness.

`assessClaimContinuity(previous, next)` checks one logical claim's immutable kind
and requires a new revision for changed content or status. Acceptance cannot
turn an observation into a stated preference. A separately attributed new claim
has a separate identity and lifecycle. Matching references do not prove semantic
support or truth.

Every assessment explicitly returns `executionAuthorized: false`,
`authorityTransferred: false`, and `semanticTruthVerified: false`. No assessment
installs instructions, changes consent, writes a record, or qualifies a host.
Source text remains evidence even when it contains imperative language.

The host owns authenticated scope, audience projection, current permission,
source admission and capture, dispatch, effects, and retention. It must recheck
at each read and handoff. Internal paths, selectors, identifiers, digests, and
hidden diagnostic details do not belong in an agent's result. The local
reader uses the existing ingestion and intake owners; these
pure functions create no second source store or acceptance lifecycle.

The generator projects the canonical schema and JSDoc types into ESM modules
and records their hashes and the pinned validator versions. Validation uses the
package's existing Ajv and format dependencies with strict validation and no
coercion or default insertion. A consuming runtime must supply those dependencies
or qualify its own generated validator against the same schema and fixtures. Run
`node scripts/generate-evidence-navigation.mjs --check` to refuse drift. The
generation manifest identifies generated artifacts; a receiving integration
must additionally pin the complete adopted source revision and its distribution.

Invented garden fixtures and focused tests exercise these bounded structural
properties. They do not prove installed consumers, operating-system isolation,
database transactions, source removal, provider retention, or end-to-end consent.

## Local search and exact fetch

`createLocalEvidenceReader` in `src/evidence-navigation/local.mjs` is a Node
adapter over one already-created ingestion plan. Its package subpath and CLI
require the receiving owner's integration. The pure entry point does not import it.

Trusted host construction supplies `workspaceRoot`, `workspaceId`, exact
`plan: { planId, planDigest }`, and synchronous `admit`. The callback receives the
operation and exact plan binding. Only precisely
`{ disposition: 'permit', revision, readScope: 'all-plan' }` proceeds. The revision
is a nonempty, bounded identifier from current host authority. It changes whenever
relevant scope, audience, destination, or permission changes, including withdrawal
and regrant. Unknown scope, promises, callback errors, and other dispositions
refuse. The host must admit the whole plan for this reader and intended recipient.
A test callback that always permits establishes no actual consent.

`search({ query, limit })` accepts up to five items and a 2,048-byte UTF-8 query.
`get({ handle })` accepts only a handle issued by this reader. Optional `readScope`
must be `all-plan`; narrower scopes refuse before store construction. Model
arguments cannot choose paths, plans, backends, or permissions. Construction-only
`openStore` and `now` are trusted host/test seams, defaulting to the existing
store and monotonic clock. Never expose these options as tool arguments.
Admission is checked before construction, before reads, and before release,
against the same revision.

Search treats hits as pointers and re-fetches every item through the owner's
`getEvidence`. Only exact-fetched text is returned. Get rechecks its protected
source/attempt/locator binding and a private commitment to the earlier fetched
text. The owner's integrity label does not prove independent content authenticity:
its journal has no output digest, so a same-size stored rewrite before first
fetch may be undetectable. Backend errors expose no paths or stored diagnostics.
Admitted text itself is not redacted here; the host owns its audience and any
permission to process it downstream.

Results contain text, temporary handles, truncation, and `source-evidence` kind,
without protected IDs, digests, selectors, or hidden-match counts. Coverage is
always `partial`, including zero results. No current absence claim follows.
Instruction-looking text remains evidence; the consuming host must preserve that
distinction in its prompt/context boundary.

Defaults are 32 reserved store calls, 32 handles, 16,384 text bytes per item,
65,536 total released text bytes, and a 60-second session. Trusted limits can
vary within hard ceilings of 128 calls/handles, 65,536 bytes per item, 262,144
total bytes, and ten minutes. Search reserves one query plus its requested maximum
exact fetches. Failed and unused reservations are not refunded. UTF-8 truncation
preserves whole code points. The ingestion owner's plan/processor ceilings bound
traversal; a hit limit does not limit inspected sources. Synchronous store reads
cannot be preempted by the lifetime check. A host requiring a hard execution-time
limit must qualify an isolated worker.

`close()` discards handles and refuses further reads. Expiry, clock reversal,
reentrant calls, foreign handles, changed authority, and changed sources refuse.
The adapter persists, ingests, accepts, activates, and schedules nothing. It
provides cooperative process-level checks, not OS isolation, a permission issuer,
or a database workflow. The host must qualify the real authority and release path.
