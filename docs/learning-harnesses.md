# Knowledge development and the learning cycle

Status: implemented locally for the next release. Published alpha.7 does not
contain these commands. Use `node bin/atelier.mjs harness help` in this source
checkout, or `atelier harness help` from a package built from this candidate.

Knowledge Harness helps people establish, develop, use and revise what they know.
Ingestion is one capability within that larger purpose. Sources can also originate
in authorship, conversation, observation, research or implementation experience.
The graph is one maintained representation; documents, source collections,
datasets and decisions remain important in their own right.

People define purpose and acceptance criteria. Agents prepare admitted work.
Designated owners validate consequential interpretations and delivery. The local
records cannot authenticate those people or grant permissions on their behalf.

## The capability family

| Capability | Responsibility |
| --- | --- |
| Discovery Harness | Frame questions, alternatives and uncertainties |
| Research Harness | Investigate and return traceable evidence |
| Knowledge Harness | Develop, evaluate, curate and activate knowledge |
| Build Harness | Turn an objective into a verified deliverable |
| Fabric or another coordinator | Coordinate owners, outcomes, dependencies and delivery gates |
| Skill Steward | Govern capability versions, adoption and improvement |

The shared API is `@mnstry/atelier/harnesses`; domain APIs are
`@mnstry/atelier/knowledge` and `@mnstry/atelier/build`. The existing
`@mnstry/atelier/harness` context API and `atelier build` projection alias are
unchanged. Build workflow commands begin `atelier harness build`.

The shared layer provides immutable references, bounded history storage,
explicit handoffs, current-input reconciliation and version-bound feedback.
Knowledge and build retain separate closed schemas and state semantics. Existing
inquiry records are read through a bridge, never rewritten into a universal record.

## Establish a useful knowledge domain

An establishment record names its repository identity, owner, purpose, scope,
audience, source policy, acceptance policy, identity rules, vocabulary and the
questions it must support. Each question has a concrete acceptance criterion.
Types and relations have definitions; each relation maps explicitly to an
existing graph predicate. Start with a small representative collection and
check the question-to-evidence trace before scaling acquisition.

Contribution categories are source, observation, concept, claim, model,
interpretation and decision rationale. Their domain-specific term comes from the
declared vocabulary. These categories describe a contribution's role; they are
not grades of truth. Ontology changes use a new `domain-revision` with migration
rationale and flag old dependants for reconsideration. This conservative first
implementation requires reevaluation under the new domain; it does not silently
remap old types or merge identities.

## Acquire, create, interpret and evaluate

`atelier harness example` prints an invented complete learning cycle. It includes
simulated owner decisions, CI and delivery reports; none is real execution proof.
The per-profile ledger examples show every supported record shape.

Preserve existing files with `@mnstry/atelier/intake`. Its `ingest`, `beginAttempt`,
`completeAttempt` and `readCompletion` operations keep source bytes, extractor
identity/configuration and output receipts separate. The new
`prepareIntakeContribution` verifies existing completion and output bytes and
prepares a source contribution. It invokes no extractor and accepts no meaning.

```js
import { createIntakeStore, intakeDigest } from '@mnstry/atelier/intake'
import { prepareIntakeContribution } from '@mnstry/atelier/knowledge'
import { appendHarness, EMPTY_HARNESS_HEAD } from '@mnstry/atelier/harnesses'

// The caller chooses a Git root with ignored .atelier-local/ and authors domain.
appendHarness({ workspaceRoot, profile: 'knowledge', record: domain,
  confirm: EMPTY_HARNESS_HEAD })
const intake = createIntakeStore({ workspaceRoot })
const source = intake.ingest({ ref: sourcePath, expectedDigest: intakeDigest(sourceBytes) })
intake.beginAttempt({ attemptId, blobId: source.blobId,
  extractorId, extractorVersion, configurationDigest })
// The separately authorized processor supplies output; the harness does not run it.
intake.completeAttempt({ attemptId, output, expectedOutputDigest: intakeDigest(output) })
const proposed = prepareIntakeContribution({ workspaceRoot, records: [domain],
  attemptId, title: 'Source material', term: declaredType })
// Author a contribution record around proposed.data, then append with the current head.
```

Authored contributions retain a rationale for their origin. Captured text binds
its digest and source locator. Extraction binds the original blob, attempt,
configuration and output. An exchange retains its complete handoff. Derived
contributions use exact quoted passages from earlier contributions; scope and
audience widening refuse. Missing passages, versions, references and vocabulary
are failures. Source text cannot expand execution authority.

Evaluation records preserve judgment (`supported`, `contested`, `uncertain`,
`unsupported`), rationale, applicability scope and limitations. Reviews separately
record accepted, deferred or rejected dispositions. Accepted contributions require
an evaluation and accepted evidence dependencies. A curated uncertain claim
remains uncertain. This layer does not calculate an undifferentiated confidence
score. Bayesian assumptions and computed results remain in the inquiry assessment
that the research handoff references and preserves.

A new evaluation reopens the contribution's prior acceptance and its downstream
uses. A replacement review must account for every current evaluation, including
contradictory judgments. Reacceptance preserves the earlier review and does not
silently restore old handoffs or activations.

## Connect, activate and revise

Propose identity matches or conceptual links as relation records. Acceptance
requires current accepted endpoints. No entity merge is automatic. An activation
names reviewed contributions/relations, purpose, destination and domain questions.
`knowledgeGraphProposal` emits draft Markdown and unpromoted `atelier-claim@v1`
edges, with selected evidence dependencies, reviews and limitations retained.
The receiver reviews/adopts the exact files through its existing authoring process,
rebuilds the graph and verifies the meaningful source trace.

Withdraw or revise a contribution without deleting the original. Local descendants
become reconsideration items. Downstream repositories use current source snapshots
to discover changed inputs through `reconcileKnowledge` or `buildReadiness`.
Previously admitted graph files are not rewritten or removed automatically.
Revisit their source decisions and prepare a new authorized change.

## Handoffs and freshness

`createHarnessHandoff` binds source repository, profile, run, history digest,
subject reference, audience, exact payload, destination and purpose. Knowledge
exports accepted contributions; inquiry exports accepted current decisions; build
exports a current accepted candidate with resolved dependencies. An external
destination remains subject to the host's disclosure and execution rules.

`verifyHarnessHandoff` verifies a supplied producer history against those pins.
The current history must contain the complete exact issued history as a prefix;
unrelated appends are allowed only while the subject and accepted payload remain
unchanged and current. A source rewrite, relevant correction, ontology migration,
gate replacement or candidate replacement invalidates the relevant handoff.

Snapshots are explicit `{repository, profile, records}` objects. Missing or
ambiguous sources cannot clear freshness. Reconciliation can traverse knowledge,
inquiry and build dependencies, bounded to 12 levels and 64 supplied snapshots.
Freshness is relative to the supplied snapshot, not a live remote observation.
The toolkit cannot detect a withheld update or authenticate the source owner.
The receiver must obtain snapshots through its existing trusted process.

`prepareKnowledgeImport` verifies a handoff and prepares a contribution with
semantic acceptance pending. Its full context stays in the contribution. Graph
activation and outgoing handoffs recheck relevant imported dependencies. An
unavailable proprietary service does not prevent reading or exporting saved
records, although current remote-input freshness may remain unresolved.

## Build discipline derived from Fabric

A build objective declares owner, scope, acceptance criteria, required gates,
artifact dependencies, admitted effects, attempt budget and stopping rule.
A candidate pins repository identity, commit, tree, artifact digest and reported
writer custody. `prepareGitCandidate` reads a selected local Git root, requires
clean source, verifies the artifact twice and prepares its exact candidate data.
It executes no build or test and does not authenticate the writer declaration.

Record attempt intent before an external command/adapter invocation. Progress can
be running, uncertain, completed, failed or cancelled. Unsettled or completed
operations refuse replay; a failed/cancelled attempt can be retried within the
declared budget. An uncertain attempt requires reconciliation against that same
attempt. The harness neither dispatches nor cancels the actual process, and a
caller-reported cancellation cannot establish physical process cleanup.

Gate reports bind the exact candidate and a declared gate with evidence digest,
locator and verifier identity. Required source, review, CI, runtime, integration
and delivery gates stay distinct. Transport completion never creates a passed
gate. Where a gate names an attempt, a pass requires completion on that candidate.
External CI/review adapters must validate their native receipts before recording
reports; this local core cannot authenticate arbitrary supplied evidence digests.

An accepted decision requires current passed required gates and settled attempts.
`buildReadiness` also rechecks explicit dependency snapshots. Its result is
`readyReported`, with `authenticatedAcceptance:false` and
`executionAuthorized:false`. A delivery report is a separate record. Replacing
a candidate, gate or decision leaves older proof visible and marks dependants.

`buildCoordinationProposal` exposes owner, outcome, dependencies, candidate, gates
and blockers for Fabric or another coordinator. It reads no private Fabric state,
creates no tasks, sends no messages, and does not claim coordinator acceptance.
Concrete CI connectors, authenticated receipt verification, distributed worker
leases and operated scheduling remain adapters, outside this local implementation.

## Storage, skills and boundaries

`atelier harness knowledge|build append --record FILE --confirm DIGEST` appends
to `.atelier-local/harnesses/PROFILE/RUN/ledger.json`. Use `status` for the head
and `export` for the complete ledger, including private content. `inspect` checks
history and references; `validate` checks one record's shape only.

Writes require a Git root, ignored untracked private state, a qualified POSIX
filesystem, the cooperating-writer lock and the current head. Atomic single-file
replacement preserves a complete previous or next history after interruption.
Hard process termination can leave the shared lock for operator reconciliation;
no automatic lock recovery or multi-repository transaction is added here. Hashes
do not defend against a writer who can replace the whole history. Audience labels
are descriptive; repository access remains the actual read boundary.

Limits are 256 records and 8 MiB serialized per ledger, 64 items in bounded record
arrays, 262,144 characters per contribution, and 1,048,576 characters per handoff
payload. Existing intake allows larger outputs; a contribution that exceeds these
bounds needs an explicit continuation plan. No silent compaction occurs.

`atelier-knowledge-harness` and `atelier-build-harness` ship as identical Codex and
Claude skills and independently sealed reference packages. Adopt through the
existing capability Steward with observed `atelier-harness-v1` availability and
explicit local effects. Preserve third-party skills and customizations. The
packages declare their behavioral evaluation unknown; placement is not host use.

`prepareHarnessFeedback` binds feedback to the skill binding in effect at the
subject record. The receiver's `capability observe` checks actual current binding.
Context/provider causes remain in the wrapper and map to unknown in the older
Steward event vocabulary. Feedback never rewrites, publishes or upgrades a skill.

The contracts, skills, storage, basic calculations, graph proposals and offline
exchange remain open. Optional operated services can supply specialized extraction,
managed execution, collaboration, connectors or advanced inference. Credentials,
cost limits, source access, authenticated receipts and operational permissions
remain host-owned; local manifests confer none of them.
