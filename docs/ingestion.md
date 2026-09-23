# Progressive local ingestion

Status: experimental source implementation, not yet a released package feature.
The local runner preserves explicitly selected files and makes bounded text
search useful before semantic interpretation. It composes the existing
[immutable intake](intake-and-guides.md) with a resumable plan. It never enrolls
raw captures into the canonical graph or treats extracted text as accepted
knowledge. The [architecture proposal](progressive-ingestion.md) describes the
larger destination; this page describes the implemented subset.

## Start with a purpose and selected sources

Use a Git workspace whose `.gitignore` contains `.atelier-local/`. That directory
must be untracked. Sources are visible paths relative to that workspace;
traversal, symlinks and implicit external reads are refused. The local CLI is
for a trusted workspace owner. Its workspace identifier is a binding against
accidental cross-workspace reuse, not an authenticated identity or tenant ACL.

The following examples assume the development checkout or a future package
version containing this command. Released alpha.7 does not contain it.

```sh
atelier ingest plan <<'JSON'
{"workspaceId":"sample-workspace","input":{"sources":[{"id":"service-note","ref":"service.md"},{"id":"parts","ref":"parts.csv"},{"id":"checklist","ref":"checklist.png"}],"scope":{"project":"sample-project","activity":"maintenance"},"purpose":"Find unresolved maintenance work.","budget":{"maxInputBytes":1048576,"maxOutputBytes":1048576,"maxAttempts":8}}}
JSON
```

Save the returned `planId` and `planDigest`. Each subsequent request binds both:

```sh
atelier ingest run <<'JSON'
{"workspaceId":"sample-workspace","input":{"planId":"REPLACE_WITH_PLAN_ID","planDigest":"REPLACE_WITH_PLAN_DIGEST","maxItems":2}}
JSON
atelier ingest query <<'JSON'
{"workspaceId":"sample-workspace","input":{"planId":"REPLACE_WITH_PLAN_ID","planDigest":"REPLACE_WITH_PLAN_DIGEST","query":"filter","limit":20}}
JSON
```

Use `status` with the same input minus `query`, `limit` and `maxItems`. Repeat
`run` to advance a bounded batch or recover an interrupted local attempt. The
source selection, purpose, scope, processor versions and budgets belong to the
immutable plan. A changed selection or budget needs a new plan.

Every selected source remains visible as pending, complete, unsupported,
unavailable, failed, budget-blocked or stale. An image can be preserved while
remaining unsupported for extraction. Coverage refers only to selected files;
it never implies a whole account, repository or compound document was discovered.
A complete extraction still has `semanticAcceptance: "pending"`.

## What the local processors do

| Input | Evidence locations | Limits |
| --- | --- | --- |
| UTF-8 text and Markdown | Physical line numbers, including blank lines | No Markdown semantic interpretation |
| UTF-8 CSV | Header-inclusive row and column coordinates | Quoted cells and embedded newlines supported; no spreadsheet formulas, styles or attachments interpreted |
| UTF-8 JSON | RFC6901 pointers to primitive values | Object/array structure supports locations; embedded media, dates, authorship and relationships are not inferred |
| Other extensions | Explicit unsupported disposition | No OCR, speech, vision, archive traversal or format guessing |

Processor selection uses the extension; it does not certify media content.
Invalid encoding or malformed structures refuse with a per-source failure.
Extraction limits refuse the item instead of silently dropping evidence. Empty
supported text is distinct from an unsupported format; empty JSON is malformed.
JSON containers with no primitive leaves have no searchable evidence. Source
text is inert, including apparent instructions to the importer.

Original bytes and completed extraction outputs live in the existing intake
store. Plans, reservations and outcomes live in private `.atelier-local/ingestion`.
No second blob store or provider daemon is introduced. Both stores require the
workspace's ignored-state boundary. Copying an evidence result to another tool
is a separate disclosure action: CLI output can contain private paths and text.

## Resume, reuse and budgets

The runner serializes local reservations and writes them before processing.
Completed attempts are verified before reuse. Keys include source bytes,
processor identity/version and extraction limits. Different origins retain
separate source identities even when bytes can be reused. Corrupt completed
work refuses; it is not silently recomputed or overwritten.

For local deterministic extraction, resume can reconcile output written before
its completion receipt. This does not authorize retrying an uncertain external
provider submission. There is no provider execution in this runner.

`maxInputBytes`, `maxOutputBytes` and `maxAttempts` bound admitted processing
within one plan. Planning, source verification and query hashing still read
bytes and use CPU; these counters are not a machine-wide I/O or dollar budget.
Cached outputs count toward the plan's output bound. Failed attempts remain in
accounting. Unknown output accounting blocks further admission instead of
becoming zero cost. Budgets are per plan, not a shared account quota.

A query reads actual completed evidence, verifies its receipt and checks the
current source bytes. Changed, deleted or inaccessible originals cannot
silently support fresh hits. Other valid sources remain searchable and omitted
sources remain visible. Query is lexical retrieval, not an answer generator;
absence of a hit is not proof that a claim is false. Search limits and structural
omissions must remain visible in any consuming interface.

## Connect a useful result to learning

A correction made while using a retrieved passage can be captured through
[`atelier learn`](learning.md), with the source reference, its exact digest and
location. Capture is evidence only. Proposals remain inert until a person
reviews the exact content, accepts it and explicitly activates it for a scoped
harness. Withdrawal preserves the decision history while stopping future use.

The core exposes this composition; it does not monitor every tool automatically.
A desktop host must supply capture consent, trusted identity, paired workspace
access, transport and actual harness delivery. Tests of a local client do not
establish native admission. Review and activation never execute text discovered
inside an imported file. A captured source reference remains historical evidence;
source changes do not automatically withdraw a separately accepted lesson. A host
must surface that staleness when it uses source-dependent lessons.

## Evaluate before choosing a model

`@mnstry/atelier/ingestion/evaluation` exports `evaluateIngestionTrial` and
`ingestionEvaluationDigest`. An evaluation suite declares exact expected
structural evidence, source digests, calibration/held-out cases, strata and
thresholds before the trial. A trial binds its suite digest and processor
version/configuration; each case reports attempts, evidence, elapsed time,
cost (or `null`) and an optional explicit human assessment.

The scorer counts omitted cases, wrong locations, changed text and duplicates.
Each held-out stratum must satisfy the declared thresholds. A zero-evidence or
calibration-only sample cannot qualify extraction. Unknown costs stay unknown;
cost per accepted result is absent when cost or acceptance is unavailable.
Human assessment identities are caller assertions. This is an audit aid, not a
model permission grant or an automatic judge of semantic support.

Run the synthetic local example with:

```sh
node scripts/evaluate-ingestion.mjs
```

The example records processor elapsed time and leaves total cost unmetered. It
uses no model and proves no model savings. For a real comparison, the owner
must provide permitted representative examples, exact providers, a spend cap,
predeclared task rubrics and human acceptance. Count retries, failures,
verification and correction effort. Compare cost per useful accepted result,
with quality floors and rare exceptions preserved. Keep private examples and
methods in their owning workspace.

## Remaining product work

The public foundation still needs qualified semantic adapters, focused
synthesis and graph decision integration, richer document/media processors,
connector census and permission-change handling, and representative pilots.
The proprietary runtime adds native scheduling, installed processors,
provider credentials/budgets, progress and source review, cancellation,
notifications and scoped harness delivery. The public reference path remains
usable without that runtime. Neither private material nor private methodology
belongs in public fixtures or distributed proprietary prompts.
