# Progressive ingestion — design proposal

Status: proposed architecture, not an available ingestion command or a released
contract. This document adds no executor, provider connection, schema field, or
permission. The existing analysis adapter remains disabled.

## Outcome

A person selects useful source material, obtains a searchable evidence base,
and deepens the interpretation needed for their current work. They can inspect
coverage, stop and resume processing, review interpretations against originals,
and move their records to another compatible host. A complete semantic model of
the entire collection is not a prerequisite for the first useful result.

The person establishes purpose and meaningful distinctions before bulk model
work, then validates consequential interpretations afterward. Mechanical work
should remain mechanical. Models receive bounded tasks and evidence; they do
not decide what they are authorized to access or promote their own output.

## Proposed open-source and host boundary

The proposed public foundation must be useful independently of a commercial
desktop application or managed service. All implementations need the same
integrity, provenance, refusal, and portability rules.

| Public Atelier foundation | Optional host or distribution |
| --- | --- |
| Source, snapshot, attempt, coverage and dependency contracts | Connector sessions, account enrollment and secret storage |
| Deterministic inventory, validation and incremental planning | Resident processes, OS scheduling, resource allocation and notifications |
| Adapter capability declarations and portable routing rules | Concrete processor installation and authorized provider execution |
| Budget accounting interfaces and bounded execution plans | Managed quotas, paid capacity, account usage reconciliation and billing |
| A local reference runner and synthetic conformance cases | Native progress, source comparison and decision-review experiences |
| Evidence-backed proposal exchange and explicit decision records | Organization policy, managed sharing and service operations |

Public adapters can be implemented by anyone. Local or bring-your-own-provider
operation must not require a paid account with the desktop vendor. Safety and
data export must not depend on commercial entitlement. Host execution is
separately configured and authorized; a portable plan grants no execution power.

Private source material, domain vocabularies, decision heuristics, authored
methods, evaluation examples and operational identifiers stay in their owning
workspace. A generic mechanism is re-derived against invented cases before
public contribution. A renamed private example is still a private example.

Software distributed under a proprietary license is not necessarily secret.
Sensitive methodology must not be embedded in a distributed prompt, skill or
manifest on the assumption that users cannot inspect it. See the existing
[guide and private implementation boundary](intake-and-guides.md).

## Stages and processing depth

1. **Purpose and scope.** Select repositories and sources, an immediate use case,
   permitted destinations, a budget and a representative modeling sample.
   Scope is bounded and inspectable; source text cannot expand it.
2. **Inventory.** Enumerate accessible records and every detected part or
   modality. Record unknown discovery limits, missing references and unavailable
   originals. Hashes identify bytes, not truth or real-world identity.
3. **Extraction.** Use format parsers where possible and separately qualified
   OCR, speech or vision processors where necessary. Preserve original bytes,
   language, structure and locations. These specialized processors may use
   models; they are not automatically cheap or deterministic.
4. **Bounded interpretation.** A qualified inexpensive model proposes explicit
   entities, classifications and relations using a small, versioned vocabulary.
   Evidence and unresolved cases accompany each proposal.
5. **Focused synthesis.** Stronger reasoning addresses ambiguity, conceptual
   reconciliation, contradictions and synthesis relevant to the selected purpose.
   Original evidence remains retrievable; summaries are not the sole input.
6. **Consolidation and decisions.** Deduplicate questions without losing their
   evidence, separate questions answerable from sources from those requiring an
   owner or external input, and present coherent decisions for human review.
7. **Retrieval and maintenance.** Exercise representative questions through the
   real index, return exact supporting evidence and limitations, and invalidate
   affected results when their dependencies change.

Stages have independent progress measures. Found, preserved, extracted,
searchable, interpreted and accepted are different facts. Cheap discovery and
search may be useful while semantic processing remains incomplete.

## Coverage before interpretation

Every adapter reports what it encountered and what happened to each part:
processed, retained without extraction, unsupported, unavailable or failed.
Each adapter declares units appropriate to its format, such as pages, cells,
slides or timed segments, and documents whether formatting, formulas, hidden
content, branches and attachments are included. A zero count differs from an
unknown count. Unexplained skipped content prevents a complete-extraction claim.

Discovery, byte preservation, extraction, semantic inspection and acceptance
each have their own denominator and unknowns. Connector metadata access does not
prove binary retrieval. A listed attachment is not a resolved source reference.
An empty speech part, a placeholder and a transcription are distinct states.

Normalized search text is a derivative. Exact citations bind to original bytes
or a named, digest-bound rendering, with a reversible location map where
normalization changes offsets. Formulas, table identity, slide boundaries and
meaningful formatting must be retained or reported as omitted.

## Identity, evidence and decisions

Keep logical source identity, source revision, acquisition snapshot, rendering,
extraction attempt, proposal, decision and generated view separate. Identical
bytes may be stored once while distinct records retain their provenance. A file
digest alone cannot identify a logical record inside a multi-record container.
A move is not necessarily a content revision; a later retrieval is not proof of
a later source revision. Use stable record identities when available and retain
ambiguity when they are unavailable.

Evidence records distinguish the attributed producer, observation method and
availability of the referent. Unknown authorship stays unknown. A conversation
role or a model's image description does not establish who authored a statement
or what the original artifact contains. Independent inspection can support an
observation; it does not establish universal truth.

Every proposal links to evidence locations and records unsupported portions.
String matching establishes that a quotation occurs at the declared location;
it does not establish entailment. Related copies must not count as independent
corroboration. Different identifiers alone do not prove independent origins.

Conflicts may contain more than two statements. Preserve positions, statement
units, temporal basis and missing evidence without forcing a resolution.
Source membership in one file does not by itself distinguish a defect from a
contradiction. A negative finding is bounded by a declared search scope and
method; it becomes stale when that scope changes and never proves universal
absence. Corrections retain the earlier and later evidence, with reasons marked
as stated, interpreted or unavailable.

Review and admission are separate from extraction and conformance. Changing an
attested payload invalidates its binding. Any future amendment mechanism must
create a new issuer-authorized decision for the new payload and preserve the
old record; a worker must not rewrite a digest or reuse another issuer's
signature to manufacture continuity. Unchanged evidence may support a new
decision, but cannot make the old attestation apply to different bytes.

## Routing and cost controls

Route by task requirements, admissible evidence and measured processor quality,
not by model branding or self-reported confidence.

| Work | Initial route | Escalation signal |
| --- | --- | --- |
| Enumeration, byte matching, schema checks, graph construction | Code | Unsupported format or integrity failure goes to a diagnosed exception |
| Format conversion, OCR or transcription | Qualified specialist | Missing modality, uncertain passage or structural loss |
| Extraction of explicit statements into an established schema | Qualified inexpensive model | Unsupported claims, ambiguous identity or repeated validation failure |
| Cross-source meaning, conflicting concepts, ontology changes | Stronger reasoning on focused evidence | Missing source or unresolved human decision |
| Acceptance of consequential interpretations | Human decision | Request the specific missing evidence or judgment |

Reserve stronger reasoning early for the representative modeling sample. Apply
the resulting versioned rubric to routine batches. Audit a stratified sample
of apparently successful inexpensive results to detect silent omissions.
Verification effort follows measured error and consequence; a second expensive
model pass over every result must not become the default cost of using a cheap
first pass.

Routing first checks access, approved destination and processor capability, then
quality qualification and available budget. A cheaper processor cannot override
privacy or quality requirements. If none qualifies, leave the work deferred or
request the concrete missing decision. Do not silently substitute a provider.

Plans bound bytes, tokens, output size, wall time, concurrency and attempts.
Account for retries, verification and escalation as well as first-pass cost.
Reserve budget before dispatch and reconcile actual usage afterward. Unknown
cost is unknown, not zero. An uncertain submission remains unresolved until
reconciled; it must not trigger a duplicate paid attempt automatically.

Prioritize useful pending work by the person's current purpose, missing
prerequisites, consequence and expected processing cost. Keep prioritization
inspectable. Semantic similarity and query frequency are hints, not authority
to discard rare or contradictory evidence. Preserve a coverage backlog and
exploration sample so demand-driven processing does not hide neglected sources.

## Incremental work and recovery

A reusable result binds its input snapshots, extractor configuration, model and
prompt versions when applicable, ontology/rubric version, dependency set and
relevant policy. Store the output digest as well as the cache key. Reuse is
subject to current access and output validation; a matching key is not semantic
acceptance and does not promise deterministic model output.

Changes invalidate affected descendants. A changed audience can withdraw
visibility without changing source bytes. A deleted or unavailable source
marks dependent evidence unavailable; the system must not invent a replacement
binding. Shared storage never permits reuse across an unauthorized workspace.

Use bounded assignments, isolated scratch, immutable completed attempts,
exclusive output ownership and an idempotent single-writer merge. A completion
record is published only after its output is validated. Interrupted scratch is
not accepted evidence. Cancellation retains verified partial work and exposes
uncertain provider outcomes. Resume reconciles existing attempts before retry.

Track reverse dependencies for retention and withdrawal. Uninstalling a tool
must preserve authored results and explicit decisions. Removing an index entry
does not prove deletion from snapshots, caches, backups or provider retention.
Destructive history rewriting is a separately authorized operation.

## Existing contracts and implementation sequence

Build on [immutable intake](intake-and-guides.md),
[knowledge graph construction](knowledge-graph.md),
[attestation](attestation.md), and the existing proposal-only claim contract.
The current intake store provides integrity-bound attempts and bounded text
output, not modality completeness or processing orchestration. Its existing
size and platform limitations remain in force.

The Obsidian proposal queue is scoped to that adapter. Compare its identity,
backpressure and recovery invariants before sharing implementation; do not
silently turn an adapter-specific queue into a general ingestion service.

New coverage or evidence shapes need a separately versioned contract or a
validated, namespaced extension. Unknown `ext` data is not validated by the
base v1 contract and carries no authority. Existing claim predicates and
numeric confidence fields must not be silently reinterpreted. Typed provenance
is separate from confidence, and routing must not depend on confidence alone.

Proposed delivery order:

1. **Coverage and evidence.** Add a modality census, stable record/rendering
   links, dependency tracking and a deterministic report over synthetic inputs.
2. **Planning and reuse.** Add capability declarations, incremental plans,
   budget accounting and a local reference runner with deterministic fake
   processors. Prove pause/resume and stale-input refusal without provider calls.
3. **Processor qualification.** Benchmark explicitly selected real processors
   on permitted representative material; introduce bounded optional execution
   adapters only after the corresponding egress, permission and privacy design.
4. **Host integration.** Consume the public contracts through the host's existing
   job and capability services. Prove restart, cancellation, cost visibility and
   review-to-source behavior on the actual installed host.

Each increment must support a user-visible path from selected source to a
retrievable result or a useful diagnosed limitation. Contract tests alone do
not establish that path. The [acceptance scenarios](progressive-ingestion-acceptance.md)
describe the intended evidence; none is claimed as executed by this proposal.
