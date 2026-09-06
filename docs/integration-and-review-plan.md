# External-project integration and human review implementation plan

Status: proposed implementation contract; no feature, release, or human acceptance claim.
Baseline: `58895eafbd980ae131d8c5f2d1882ac34f5c08b9`, tree `72f06c2aa8183f93dc2b49066a5c4e55d1c2f336`.

<!-- mnstry-review-request: atelier-integration-plan-r1 gate: plan-readiness -->

## Outcome and authority

A domain owner can connect an established repository through a bounded adapter,
run its declared method, inspect proposed claims and their evidence, retain
individual review decisions, and resume without losing authorship or historical
meaning. Canon stays in the domain repository. The root supplies generic
contracts, validators, local review behavior, templates, and synthetic proof.

Implementation is authorized as local pre-production work. This plan introduces
no publication, remote deployment, collaborator enrollment, remote access,
automatic canonical writes, or member/tenant activation. Approval of a proposal
does not authorize publication, runtime admission, or consent changes. Existing
consumer reading and meeting workflows do not depend on this full programme.

All fixtures must be independently invented. Do not copy private correspondence,
domain names, vocabulary, methods, information architecture, or operational
details into this repository. Review packets and implementation branches must
respect the same boundary.

## Baseline findings and evidence

1. `src/project/config.mjs` resolves repository paths in this order: CLI
   `--repo-path`, ignored local overlay, tracked relative path, sibling discovery.
   Discovery checks the declared remote when supplied. Command resolution also
   ensures local state, so describe its possible filesystem writes accurately.
2. `src/commands/extension-pack.mjs` has a separate option allowlist that rejects
   `--repo-path` before `commandProject()` executes. Reproduction on Node 22.18.0:
   `node bin/atelier.mjs extension-pack list --repo-path=sample=.`.
3. `src/upgrade/upgrade.mjs:packageSource()` captures HEAD only when the installed
   package directory is itself the Git top-level. Repository metadata without
   that checkout becomes `private_github` with a null SHA. The lock schema already
   permits `gitSha`; repository metadata alone cannot prove installation type.
4. `src/collaboration/proposals.mjs`, `src/collaboration/event-ledger.mjs`, and
   `src/server/local-sidecar.mjs` provide review records, concurrency machinery,
   and proposal pages. Readiness proposals currently carry claims as JSON.
5. `src/readiness-protocols/runtime.mjs:evaluateProtocolAnswers()` measures
   required-answer presence. `claimsForProtocolRun()` assigns 0.7 or 0.2 based on
   whether any answer is present, and references a run rather than specific
   supporting source evidence. Neither is calibrated evidence confidence.
6. `atelier-claim@v1` fixes `status: proposed` and `promoted: false`.
   `atelier-readiness-run@v1` identifies a protocol but does not itself establish
   a complete source/pack/evaluator snapshot for historical reproduction.
7. Existing distribution/private-domain/shared-project templates, normative
   audience guidance, extension pack versions/digests and migration declarations
   provide foundations. They do not constitute a demonstrated end-to-end
   external-project review experience.

These are bounded source observations, not an exhaustive implementation review.
Other branches are not assumed landed. Refresh main and reconcile owner changes
before each implementation stage.

## Design decisions for the first implementation

- Reuse the proposal ledger and local sidecar; do not create a second review
  database or weaken their current authentication, origin, CSRF, path, private
  file, or concurrency controls. Validate reusable fit before adding UI.
- Preserve immutable v1 claim records. Add a separate versioned review-decision
  contract and derived views. Authoritative new semantics belong in a real
  contract, not in an unvalidated `ext` member that old consumers ignore.
- Acceptance prepares an explicit change proposal for the source owner. The
  source owner applies it through its own workflow. No automatic apply action.
- Initially make portable bundles inspection-only. Imported review decisions
  remain attributed historical assertions, never current local approval.
- Preserve local-only defaults. Export is an explicit local operation, not sync
  or upload. A later encrypted bundle must identify its recipient and selected
  disclosure scope without exposing private content in logs.
- Preserve established CLI aliases and exit codes unless a documented,
  versioned change is unavoidable. No new runtime dependency is assumed.
- External-project is an architecture pattern, not an instruction to use
  `repos[].kind: external`: that kind is unmanaged and supplies no read boundary.
  The adapter must explicitly declare the actual read authority and allowed refs.

## Work packages and dependency order

### W0 — Baseline, ownership, contracts, and plan disposition

Own an isolated root worktree; keep the ordinary checkout and other writers
untouched. Record base SHA/tree, clean status, current branch work and any
overlapping unlanded changes. Resolve overlap through evidence and the source
owner before editing the same boundary. Never import sibling private data.

Disposition every plan finding as accepted, rejected with evidence, or deferred
with a bounded reason. Blocking design findings precede dependent implementation.
Prepare a contract compatibility decision for each new schema and public API.
Do not silently widen existing v1 contracts or rewrite historical runs.

### W1 — Shared project options and transparent resolution

Files: `src/project/config.mjs`, `src/cli/`, all project-aware command entry
points in `src/commands/`, command help, project/config tests.

Inventory commands first: classify project-aware versus standalone commands,
direct-module versus wrapper entry, accepted aliases, environment inputs, and
side effects. Introduce a shared option definition/parser for project location
and repo overrides. Unknown command-specific options still fail; a shared
parser must not accept every argument everywhere. Keep both `--flag=value` and
`--flag value`, repeated named overrides, missing values, and malformed entries
explicit. Choose and document duplicate override behavior from current callers.

Document precedence and provide resolution diagnostics showing logical repo,
resolution source, and declared identity without leaking machine paths in
portable output. Preserve required-repo failure and all boundary validation.
Test each command family against a moved two-repository fixture, both through
the published CLI and an invented wrapper. Include missing/malformed values,
unresolved required repos, identity mismatch, and unchanged read scope.

### W2 — Installed-package provenance

Files: `src/upgrade/upgrade.mjs`, lock tests, consumer/distribution smoke,
`docs/install.md`, `docs/upgrade.md`; schema change only if the compatibility
decision requires it.

Distinguish installed package source from consumer-project source. For a Git
checkout use its own commit plus dirty-state qualification. For an npm Git
dependency inspect supported install-lock metadata and match the exact package
instance, including nested installs and workspace/symlink resolution; never
borrow the consumer repo HEAD or trust a URL/ref as an immutable commit.
Registry/tarball installs record available integrity/provenance without inventing
a Git SHA. Define metadata precedence and refuse conflicting provenance.

Keep historical locks readable. Report legacy/unresolved provenance explicitly;
an exact-source-required check must fail for unresolved or dirty source. A
missing Git SHA must not imply private Git origin. Never write credential-bearing
remote URLs into locks or logs. Test local Git dependency installation with Git
metadata stripped, tagged/branch inputs, registry-shaped and tarball fixtures,
multiple package instances, symlinks, dirty checkout and contradictory metadata.
Use local synthetic repositories and package archives; no registry/network test
is required to prove these cases.

### W3 — Official external-project starter and audience guidance

Files: `templates/`, `src/commands/setup.mjs` or existing setup owner,
`docs/install.md`, `docs/distributions.md`, `docs/blocks/audience-visibility.md`,
template and consumer smoke tests.

Compose existing templates into an invented two-repository example with project
config, bounded source contract, strict policy, namespaced pack, synthetic
protocol/answers, local-state exclusions, and documented validation commands.
No proprietary domain shape may be used as the fixture scaffold. Configuration
must state which repository owns facts, proposed changes, run state and outputs.

Include a CI recipe for graph, pack, boundary, readiness and lock checks using
the repository's current execution policy; adding the recipe does not dispatch
CI. Setup refuses overwrite and unsafe destination paths. Inspect and test
reference traversal, symlinks and path escape using existing defensive controls.
Make source audience, review acceptance, publication eligibility and runtime
visibility separate in the starter and review copy. A public source is not a
publication consent or runtime access grant.

### W4 — Evidence-bound runs and honest evaluation

Files: `src/readiness-protocols/runtime.mjs`, affected contracts, validators,
readiness CLI/renderers and tests.

Separate input completeness, executable rule checks, unresolved evidence,
human judgment and runtime readiness. Preserve the legacy score as documented
input completeness; do not silently change the meaning of old results. New
claims omit unsupported confidence or explicitly identify the method and its
limits. No calibrated confidence claim without a defined evaluation dataset.

Bind each new run to exact relevant source revisions/content digests, bounded
reference set, answers digest, protocol digest/version, pack digest/version,
evaluator identity and applicable policy digest. Define canonical serialization
and hashing before implementation. Evidence digests must identify the content
actually read; a clean repository HEAD alone is insufficient for dirty sources.
Do not create a timing gap between inspected bytes and recorded identity.

Show field-level evidence links for mapped claims, missing evidence and unresolved
references. Separate source-backed assertions from an operator's recorded answer.
Historical v1 runs remain readable but are labeled provenance-incomplete. New
source/protocol/policy changes invalidate current eligibility for affected reviews
without changing old records. Test changed source, dirty source, changed pack,
policy change, absent evidence, migration and deterministic replay under pinned
inputs; timestamps/run IDs need not match for semantic replay.

### W5 — Structured claim decisions and owner handoff

Files: `src/collaboration/`, proposal rendering modules located from sidecar
imports, `src/server/local-sidecar.mjs`, new review contract and tests.

Render subject/predicate/object with readable labels, original IDs, evidence
excerpts/links within the read boundary, limitations, conflict indicators,
source/run identity, and current decision eligibility. Accept, reject and revise
operate per claim with reviewer attribution, rationale and an exact expected
revision. Required optimistic concurrency checks must apply at the mutation
boundary, not just the UI. Explicitly describe local asserted identity versus
authenticated reviewer identity; typed names alone do not prove human approval.

Revision creates a linked successor rather than overwriting the original claim.
Decisions are separate append-only records with verifiable links to claim and
evidence identity. Retries are idempotent. A change during review refuses stale
acceptance. Crash recovery reconstructs views from the ledger without silently
losing or duplicating decisions. Bulk review is not part of the first slice.

An accepted decision creates a reviewable owner handoff showing intended source
edits, affected IDs and required source revision. It grants no canonical write,
publication or runtime capability. Promotion status is shown only from a
separate source-owner receipt; absent receipt means not established.

Tests: claim-level mixed decisions, stale views, concurrent requests, retries,
crash/restart, missing evidence, source movement, hostile display text, unauthorized
review, unchanged canonical bytes, and accepted-without-promotion behavior.

### W6 — Reusable document response and resume slice

Dependencies: W4/W5 review identity and persistence contracts, but ship a bounded
local slice independently of pack migration and portable bundles.

Use one invented document to prove a reader can open a passage, leave a question
or correction, see save state, close, reopen and find the same response and
reading position. Bind response to document identity, exact revision and stable
anchor; retain the original wording and distinguish generated summaries.
Changed document revisions retain prior responses and require explicit
reassociation. Aggregate unresolved responses and explicitly recorded decisions
into a discussion view. Reading/scrolling/no response never means agreement.

The root owns generic passage references, response records and UI primitives;
consumer repositories own content, reading order, prompts and delivery/access.
Do not convert packet responses into semantic claims automatically. Verify
keyboard operation, visible focus, save failure/retry and two-view conflicts.
Use the established loopback local-service contract for browser proof. No
physical device, remote collaborator access or onboarding is implied.

### W7 — Extension-pack lifecycle

Files: extension loader, pack/protocol contracts, migration checks, fixtures and
new lifecycle documentation.

Define substrate compatibility ranges, pack content identity, deprecation and
replacement terms, protocol version changes and migration modes. Reject an
unsupported combination before new execution. Preserve old term meaning and
source/run records; never silently reinterpret them with the newest pack.
Migration is dry-run first with a report and explicit owner application. Do not
execute arbitrary extension code or install dependencies as part of loading.
Historical inspection uses pinned content or marks missing historic dependencies.

Specify the legacy-pack policy: readable and inspectable does not automatically
mean admitted for new exact-reproducibility execution. Include a compatibility
matrix for old/current root, old/current pack, historical/new run and migration
availability. Test refusal, deprecation reporting, replay and rollback.

### W8 — Private run-state policy and portable inspection bundles

Document state classes first: tracked contracts/configuration; ignored local
answers, runs and decisions; regenerable views/caches; ephemeral sessions/nonces;
secrets/grants that are never transferable. Git checkout portability is distinct
from active review portability. Backups are explicit owner-managed actions.

Define a new bundle manifest with selected members, sizes/digests, format version,
source/pack identities, disclosure classification and verification result.
Export only selected bounded artifacts after an inspectable disclosure preview
and required disclosure check. Fail closed when the check is unavailable; do not
label an unchecked export safe. Omit auth/session/grant material and absolute
machine paths. No silent synchronization or upload.

Import first validates bounded sizes/counts, member digests, paths, duplicates,
links, versions and content rendering, then exposes an isolated inspection view.
It cannot overwrite active local state, install packs, execute content or import
approval authority. Keep foreign decisions visibly attributed and unverified
unless their actual signature/trust policy is verified.

Encrypted export is a distinct substage: select a maintained local encryption
mechanism with an explicit recipient/key custody contract, dependency rationale
and failure tests. Do not invent encryption or claim hashes authenticate a
sender. Complete manifest/inspection behavior first; encryption and external
sharing stay unavailable until that mechanism is explicitly selected and proved.
Test disclosure failures, tampering, truncated archives, unknown versions,
oversized content, traversal/symlink refusal, duplicate members and inert import.

### W9 — Installed workflow, release evidence and consumer handoff

Test the exact packed artifact in a fresh synthetic two-repository workspace:
setup -> resolution -> bounded graph/pack checks -> readiness -> claim review ->
owner handoff -> close/reopen. Repeat under different local folder structures,
then an explicit pack upgrade. Include the document response slice, source
immutability, stale-decision refusal and inspection-only bundle behavior.

Use Node 22.18.0. Run focused regression suites, syntax, complete discoverable
tests, contract and public API compatibility, migrations, disclosure and exact
tarball/consumer checks. Verify test discovery includes new nested tests; either
place tests under current discovery or reconcile the separate discovery work.
Use the maintained private disclosure lane, never substitute structural-only
results. Existing global failures are reported separately with exact evidence.

An implementation review binds the final candidate and changed contracts. Valid
review findings are dispositioned and fixed before closeout; a plan review is
not implementation proof. Refresh main and prove required checks before landing.
Publishing a package, deployment, consumer activation and human acceptance remain
separate gates requiring their own authority and evidence.

## Proposed delivery cuts and acceptance gates

1. Reliability: W0-W3. External adapter setup works from the installed artifact
   on two layouts; every documented project-aware invocation accepts the shared
   options; source identity is exact or visibly unresolved. No canonical writes.
2. Human review: W4-W6. A domain owner can understand each claim, inspect evidence,
   record a decision, retain an attributed response and resume. Stale acceptance
   fails; original source and historical claims remain unchanged.
3. Lifecycle: W7-W8 plus W9. Upgrade preserves historical meaning; selected state
   travels only through validated inspection bundles. Imported evidence never
   becomes approval. Encryption is qualified separately before availability.

Each cut has focused local proof, exact source identity, review disposition,
rollback and a clear remaining-gates statement. Consumer human acceptance is
obtained separately; synthetic/browser proof cannot substitute for it.

## Rollback and recovery

Pin the prior package and packs; retain original documents and append-only
responses/decisions. Disable optional new views/exports without deleting state.
Old versions must reject unknown authoritative records or ignore them only when
that cannot grant authority. Demonstrate rollback with historical data before
shipping migrations. Import never writes into the active state directory.

## Reviewer challenge and open decisions

Prefer static inspection and existing defensive tests. Challenge dependency
order, contract evolution, exact provenance, stale acceptance, local reviewer
identity, disclosure, import authority, legacy compatibility and scope growth.
Return evidence, files, severity, confidence, impact, remediation order and
testable acceptance changes. Do not execute new live abuse paths or edit source.

The review must distinguish plan completeness from implementation correctness.
Known decisions: owner-applied canon and inspection-only imports are first-cut
defaults; authenticated multi-user approval, cross-computer continuation of active
authority, concrete encryption/key custody, remote onboarding and any calibrated
diagnostic scoring require explicit later design decisions. Their absence does
not block the independent reliability and local review cuts.
