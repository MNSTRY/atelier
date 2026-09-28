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
hidden diagnostic details do not belong in an agent's result. A future local
reader must use the existing knowledge, ingestion, and intake owners; these
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
