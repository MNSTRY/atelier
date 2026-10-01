# Semantic operation: internal vanilla profile

`src/knowledge/semantic-operation.mjs` connects a host's extraction to the
existing intake and knowledge owners. It is an internal library. There is no
public export, registered schema or CLI command yet. The proposed consumer is
an agent operating the experimental Atelier CLI after Foundation registers it.

Atelier never invokes a model. The host supplies its raw output, its normalized
candidate envelope, configuration pins and usage report. A deterministic or
authored route explicitly declares that it automates no model extraction.
Every receiver decision comes from the host's actual receiver session. The
library checks consistency; it does not authenticate a person or grant source,
model, publication or projection permission.

## Owners and sequence

Create the internal runner with `{workspaceRoot, workspaceId, run}`. The domain
must already exist in the knowledge harness. All writes use its history digest
through `appendHarness`; intake retains the original source and raw output.
There is no second canonical ledger.

1. Complete structural ingestion through the existing ingestion owner. Use
   a separate one-source plan for each independent correction unit. The exact
   reader checks the whole plan: editing another source in a shared plan also
   invalidates that plan. Independent plans let unaffected operations reuse
   their completed attempts without rebinding an old model response.
2. Call `begin` before the host starts extraction. It reads current all-plan
   evidence and the current ledger domain, pins the semantic input, records a
   reservation in the existing ledger, then calls intake `beginAttempt`.
   Only the new successful reservation returns `execution: 'ready-for-host'`.
   A reopened begun, partial or reserved attempt has unknown execution.
3. The host runs its extractor separately. Call `complete` with exact raw
   output bytes, their SHA-256 digest, the normalized candidates and usage.
   Raw output is retained even if candidate interpretation, plain-JSON bounds
   or usage validation fails. Resume that
   interpretation on the same attempt; never rerun extraction silently.
4. Prepare the structural source contribution through
   `prepareIngestionContribution`, retaining its real `extracted` origin and
   source binding. The receiver evaluates and reviews that source.
5. Call `prepareContribution` for each entity, assertion or unknown finding.
   Entities are `concept` contributions, assertions are `claim` contributions.
   Their author identifies the host machine, and `origin.method: 'authored'`
   explicitly means a machine-authored interpretation pending review.
   Their bodies retain the complete qualified candidate, citations, raw attempt
   pins, input digest and host-reported usage.
6. Submit receiver `evaluation`, `review` and `activation` records through
   `record`. Assertion endpoints require currently accepted entity records.
   A source-local identity stays distinct. An existing or unknown identity
   requires an explicit identity choice in the receiver's review basis.
7. Call `prepareRelation` only after assertion acceptance. Qualified assertions
   return an explicit projection omission. An eligible plain relation remains
   pending until the receiver reviews it. Activate the accepted assertions and
   permitted relations, then call `project`.
8. Reopen with the same workspace and run. Use `proposals` for pending results
   and `context` for accepted knowledge. Read both through the supported runner.
9. Record a receiver withdrawal or a superseding source/identity contribution.
   `cascade` performs idempotent relation cleanup after an assertion withdrawal.
   Old projection activations refuse as soon as their support is ineligible,
   including before cleanup. The receiver selects a new current activation.

## Proposed experimental commands and request shapes

Foundation owns command registration. The proposed group is
`atelier knowledge semantic <operation>`, with one JSON stdin request (at most
1 MiB), a caller-selected workspace and a run. These internal operation names
and shapes are the proposed binding; they are not a shipped command contract.

| Operation | Request fields |
| --- | --- |
| `begin` | `operationId`, `attemptId`, `at`, `term`, `plan: {planId, planDigest}`, `references`, `identityCandidates`, `extractor`, `confirm` |
| `status` | `operationId` |
| `reconcile` | `operationId`, `at`, `by`, `reason`, `outcome`, `confirm` |
| `complete` | `operationId`, `output`, `expectedOutputDigest`, `candidates`, `usage`, `at`, `confirm` |
| `proposals` | `operationId`, `query`, optional `limit` |
| `prepareContribution` | `operationId`, `id`, `kind`, `candidateId`, `source` pointer, `sourceBinding`, `term`, `at`, `confirm`; optional exact `supersedes` and `revisionReason` |
| `prepareRelation` | `assertion` pointer, `at`, `confirm` |
| `record` | A complete receiver `record`, `confirm` |
| `cascade` | Existing `withdrawalId`, `at`, `confirm` |
| `context` | `query` |
| `project` | `activationId`, `namespace` |

`extractor` has exactly `id`, `version`, `route`, `model`, `promptDigest` and
`parameters`. Routes are `model`, `deterministic` or `authored`; only the model
route has a nonnull model ID. The configuration digest covers all these fields
and the exact semantic input digest. Parameters and input remain bounded plain
JSON. Byte, member and depth overflow reports `SEMANTIC_OPERATION_LIMIT`;
malformed plain JSON reports `SEMANTIC_OPERATION_INVALID`. A pin records what the host declares; it is not a provider receipt.

`usage` has exactly `inputTokens`, `outputTokens`, `cost`, `currency`,
`elapsedMs` and `retries`. Unknown values are `null`, never zero. Counts are
nonnegative safe integers; cost is nonnegative and currency is an explicit
three-letter code or null. Usage is labelled host-reported. Record actual
provider receipts separately when available.

Reconciliation outcomes are `not-executed` or `failed-no-output`, with an
explicit actor and reason. They are host declarations, not independently
verified cleanup. A partial raw output must be completed on its original
attempt. A completed capture cannot be abandoned to permit another execution.
Matching completed source/configuration operations return a cache hit with the
existing operation ID; they do not create the requested new attempt.

An explicit identity review basis uses JSON shaped as:

```json
{
  "schema": "atelier.semantic-identity-decision/v0",
  "operationId": "example-operation",
  "candidateId": "example-entity",
  "resolution": {
    "status": "existing",
    "contribution": {"id": "accepted-entity", "digest": "sha256:..."}
  }
}
```

The existing contribution must be a supplied identity candidate of the matching
type and currently accepted. An explicit `resolution: {status: 'source-local'}`
chooses the new contribution instead. A label never resolves identity by itself.
An explicit contribution revision supersedes the latest interpretation for that
operation and candidate, with a stated reason. It still needs fresh receiver
evaluation, review and activation. Rebinding assertions to a revised entity
reuses the immutable raw capture; it does not re-execute extraction. Changing
the extracted candidate itself requires a separately declared interpretation
route and capture, rather than rewriting the recorded model output.

## Citations, witnesses and supported representation

The profile is `atelier.semantic-operation-profile/v0`. It retains the semantic
candidate's binary or unary participants, direction, negation, six modalities,
domain scope, full time qualifications, unknowns and located quotes. Original
quotes remain unchanged in the body and are revalidated against exact source
evidence. See [semantic ingestion](semantic-ingestion.md) for candidate bounds.

The structural source body is JSON extraction output. Ledger `basedOn` quotes
are limited to 8192 characters, with unique contribution IDs. Each dependency
therefore gets one labelled witness: the JSON-string encoding of its first
cited quote, without outer quotation marks, cut only at complete code points
and escape sequences. It must occur in the stored contribution body. Endpoint
dependencies use encoded candidate IDs when present in the entity body, or a
bounded actual text substring for an ordinary accepted concept. Its record ID
need not occur in its body. A body with no representable witness is refused.
The body labels `sourceWitness` entries
with `encoding: 'json-string-substring'` and `purpose: 'ledger-dependency-only'`.
Display citations from the candidate, never the dependency witness.

The witness helper can form distinct source dependencies, but this operation
profile processes one source per semantic input. It refuses missing or
ambiguous current structural sources, attempt/digest mismatch, absent witnesses
and more than 64 source-plus-endpoint dependencies with
`SEMANTIC_UNSUPPORTED_LEDGER_CITATION` (`unsupported-ledger-citation`). It
retains all cited spans in the candidate even when they share one dependency.

UTF-8 byte-range locators, multiline quotes, structured per-assertion scope,
literal-valued objects and speaker attribution are outside this profile.
The runner returns named `SEMANTIC_UNSUPPORTED_LOCATOR`,
`SEMANTIC_UNSUPPORTED_SCOPE` and `SEMANTIC_UNSUPPORTED_LITERAL_OBJECT` refusals
for these richer locator, scope and object forms. Richer forms require an
owner-reviewed mapping. They must be refused or retained
as explicit unknowns by the host, rather than dropped or coerced into entities
or edges. Canonical identity resolution stays in explicit receiver reviews.

## Projection and freshness

Only a binary `subject-to-object` assertion with `negated: false`,
`modality: 'asserted'`, the domain scope, and no time boundaries, expression or
unknowns can become a plain relation. Every other assertion remains a qualified
contribution and appears in `projectionOmissions`.

The relation ID is derived from its assertion contribution ID. Its rationale
ends with `semantic-support: <assertionId> <sha256:digest>`. On every projection,
that assertion must exist at the exact digest, be currently accepted and active,
and be neither stale, withdrawn nor superseded. Relation participants must match
the assertion. An ineligible relation refuses the whole activation; it is never
silently filtered out. This guard is required because harness v1 relations do
not have a supporting-assertion dependency field.

`project` calls the existing `knowledgeGraphProposal` only after this check. Its
document graph stays a document graph; typed `semanticEntities` and
`semanticAssertions` retain the interpretation and qualifications separately.
Calling the ordinary graph projector directly does not implement this semantic
support profile. Neither projection applies canonical graph mutations.

When a freshness or concurrent-history check fails after an interpretation write,
the error carries `recorded: {record, head, nextAction: 'reopen-recorded-write'}`.
Reopen that saved record; do not blindly repeat the write. A completed raw attempt
always stays immutable, including a refused interpretation.

Within one synchronous runner call, repeated validation can reuse one verified
ledger snapshot and raw capture. Sources and ledger history are rechecked before
returning. This cache is discarded after the call. Subsequent calls reread
current state. Edited originals make earlier operations stale; a new structural
plan and extraction are required. Unaffected independent plans reuse their
completed raw attempts. History remains intact.

`proposals` declares `answerClass: 'pending-proposals'`; `context` declares
`answerClass: 'accepted-knowledge'` and does not synthesize an answer. Accepted
source material is evidence, not automatic acceptance of every statement in it.
A host-generated derived answer is a separate host artifact with explicit
support and limitations; this runner neither creates nor admits such answers.

## Qualification and optional tools

Tests use invented sources and simulated receiver decisions. They establish
mechanics, not model quality, authenticated human acceptance or economic benefit.
Durable intake execution uses the qualified POSIX profile; portable stateless
eligibility and witness tests run on Windows as well.

This runner needs none of Graphify, LightRAG or Jev. It has no native adapter
binding yet. Their implementations and all eight presence profiles remain
separate qualification work. A real receiver run through the installed command,
saved-state readback, a correction repeat and an independent useful-task repeat
are required before claiming completion. Measure cold ingestion, incremental
correction and warm retrieval separately, retaining unknown cost and omissions.
