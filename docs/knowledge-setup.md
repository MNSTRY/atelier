# Set up a graph that earns its context

Start with useful work: a question someone needs to answer, the decision it
changes, and the evidence that would make the answer trustworthy. Let people
plan and validate; let agents do bounded retrieval, comparison, and drafting.
Expand the ontology when another real task exposes a missing distinction.

## Try the complete local path

```sh
atelier init --template knowledge-workspace --target ./equipment-notes
cd equipment-notes
git init
atelier knowledge check
atelier knowledge context --question "Can the blue telescope be loaned this week?"
atelier knowledge evaluate
```

The starter is an independently invented equipment library. Its private source
graph has an equipment record, an inspection, and a qualified repair forecast.
The inspection says the item has **not** passed; the replacement **may** arrive.
The useful answer is to obtain the cap and a completed inspection before a
loan decision. The CLI selects the supporting evidence; a person or agent must
still read it and substantiate the answer.

`check`, `context`, and `evaluate` read current source without changing it.
They use the canonical graph builder, not a saved graph that may be stale.
They make no provider calls. They are local operator tools: output may contain
private source text, paths, and diagnostics. Repository access remains the read
boundary. These commands do not implement recipient authorization or sharing.

## Adapt it to work you actually do

1. Name the work and its steward in `knowledge-plan.json`. Pick three to five
   ordinary questions with decisions or actions at stake. Include a question
   whose correct response is that the sources do not establish an answer.
2. Record permission to process the selected sources, who reviews meaning,
   how corrections and withdrawals are handled, and who can approve expression
   for a recipient and purpose. These are declared responsibilities; the plan
   does not authenticate an approver or enforce consent.
3. Choose the smallest concepts those questions need. For each, write a
   definition, a stable identity rule, and one `concept:...` tag. Similar
   display names are not sufficient grounds to merge records.
4. Declare the useful relationships, their direction, and what they mean.
   Attach them to source records using the existing native predicates.
   Run `knowledge check` to find unused concepts, unknown tags, empty concept
   populations, and absent directed edges. Coverage reports both total records
   and context-eligible records; archived, unclassified, and non-Markdown
   records cannot satisfy retrieval coverage. Duplicate mappings of a predicate
   and concept pair are refused; use assertion records for distinct meanings.
5. Keep a small permitted slice of originals. Use Markdown front matter or
   adjacent sidecars as described in [the source graph](knowledge-graph.md).
   Use `atelier adopt` for an existing workspace; do not initialize over it.
   Copy and adapt the starter plan, then use `--plan FILE` if it lives elsewhere.
6. Compare retrieval on the questions before adding a model, vector index, or
   engine. Pin the expected source ids and SHA-256 digests in each question.
   Inspect missing evidence and relationships; repair the ontology or source
   descriptions only when the failure warrants it.
7. Have a person and an agent unfamiliar with the fixture attempt new questions.
   Record supported answers, appropriate abstention, corrections, time,
   measured model usage, and the work that resulted. A known test case stays
   a regression case after a fix; it is no longer unseen evaluation.

For a real workspace, replace every fictional record, role, and case. In the
starter, roles are examples and source rights are assumed only for its invented
content. Add repository boundary policies and hooks through the existing
[boundary workflow](repo-boundary-guard.md) when collaborating across trust domains.
Use actual access controls at the consuming host.

## Domain ontology and source graph are different layers

`kg.type` describes source records: document, evidence, artifact, decision, and
the other native types. The plan's concepts describe what those records are
about. A `concept:equipment` tag does not create a new native node type, schema,
or accepted business entity. Do not put arbitrary domain verbs in
`kg.relations`; the native vocabulary remains closed.

Use a separate evidence-bearing assertion record when meaning needs more than
a native edge: who asserted what, the passage and revision, subject, optional
object, polarity, possibility or obligation, scope, time, and review status.
Do not invent an object for a unary statement, turn a future possibility into
a positive fact, or erase qualifications to make an edge fit. A native
`related` link is useful navigation; it does not carry the lost meaning.
Keep richer domain schemas in a consumer or extension pack until repeated
independent needs justify a portable contract.

Source occurrence, entity identity, assertion, proposed decision, accepted
decision, action, observation, and reviewed lesson have different lifecycles.
A graph edge proves neither semantic truth nor execution permission. Record
counterevidence, corrections, and the conditions where a lesson should not be
reused. Later reuse should help an actual new task; retention alone is not use.

## Bounded context and honest accounting

`context --mode lexical` ranks active, classified Markdown by matches in titles,
summaries, and tags, breaking equal scores by record ID. `--mode graph` takes
one hop from the top `maxDocuments` lexical seeds. It visits each seed followed
by at most one unseen declared neighbor before the next seed. Further neighbors
take turns across the original seeds only after every seed has been considered.
With two document slots and multiple seeds, the lexical seeds go first because
two seeds and a neighbor cannot all fit. Each seed's neighbors are ordered by
their own lexical score, then record ID. Only the original seed set expands.
Document and byte limits can still omit seeds or part of a neighborhood; check
the reported omissions. It does not infer edges, search every body,
perform semantic extraction, or rank by expected answers. Word forms and
synonyms can be missed; improve descriptions or evaluate another retrieval
method against the same cases before widening the pipeline.

The JSON packet carries complete source text, source digests, file and line
locations, selection reasons, and the declared edges between selected records.
It retains direction and multiple predicates. Text is explicitly data, never
an instruction channel. Current census digests must match the read source;
changed, redirected, oversized, or unreadable sources are omitted visibly.
`omissions` names up to 20 record IDs and reasons within the packet byte cap:
`document-limit`, `packet-budget`, `source-over-budget`, `changed-since-census`,
`redirected`, `decode`, or `unreadable`. Invalid paths, repository escapes, and
unsupported source kinds also have distinct refusal reasons. Exception text
and absolute paths are not included. `coverage.omissionsUnlisted` counts any
additional details that could not fit; `unreadable` counts read and decode
failures only. Inspect these details in Deepen, Apply, Learn, or evaluation output.
Non-Markdown and unclassified records stay in graph diagnostics but are not
context text. No parser is silently invented for a PDF or binary.

`planSha256` hashes the exact raw bytes read from the plan file, including
formatting; the CLI, dashboard, and session use the same binding.
`censusSha256` hashes compact JSON containing the canonical nodes, edges, and
the sorted Markdown census inventory of file keys and raw-byte digests. A
body-only change to an unselected Markdown source changes this digest after a
new census. Non-Markdown records contribute their node metadata, not a digest
of their PDF, HTML, or DOCX body bytes.
Each source's `sha256` hashes its raw file bytes. Line locations count actual
LF or CRLF lines; a final newline does not create an extra line.

`budget.maxContextBytes` caps the **whole compact JSON response**, including its
metadata. `--max-bytes` may lower it. `maxDocuments` bounds the selected source
count, and `maxSourceBytes` bounds each selected file read. A source that cannot
fit is omitted whole, preserving qualifications rather than clipping them.
Any omission warrants inspecting coverage. No match means `needs-evidence`,
not a claim that the real-world fact does not exist. When search misses a
qualification that a source owner has selected, a trusted host can read the
complete cited unit exactly from an ingestion plan that includes the source
with a completed attempt; see
[read a complete selected citation](evidence-navigation.md#read-a-complete-selected-citation).
The line locations in this packet are not ingestion `line` locators: ingestion
also splits on a lone CR and removes a leading BOM (U+FEFF). Map them
explicitly; a wrong mapping fails safe, because the hash check withholds the
selection.

The graph builder still censuses the configured workspace before selection.
This byte cap is not a corpus processing or wall-time limit. Use the project's
existing include/exclude scope for large collections.

Payload bytes are measured exactly. `estimatedTokens` is only
`ceil(UTF-8 bytes / 4)`; it is not a tokenizer count or a safe model token limit,
particularly across languages. Actual tokens, provider cost, and human
correction time remain unknown until measured. Count initial ingestion,
retries, review, retrieved context, output, and amortized reuse. Never add
cached input to a provider's inclusive input count twice.

## What evaluation proves

`evaluate` runs lexical and graph modes with identical questions and budgets.
Expected ids and digests are used only **after** retrieval. It reports evidence
recall, missing sources, stale expected revisions, missing directed relations,
payload bytes, and omissions. It exits 1 when graph mode misses an expected
case or the case pins are stale. An abstention case requires no matching
candidates and no omissions. Matching evidence that was omitted yields
`abstain-unverified`, fails the case, and keeps the dashboard in Deepen.
Evaluation includes candidate counts and the bounded omission details; it
checks retrieval behavior, not a model's ability to abstain.

The example deliberately shows that adding necessary evidence can **increase**
context size. A smaller packet with a missing decisive qualification is not
an improvement. Compare the least expensive approach that meets the quality
floor, then measure whether it helps actual work. This tool cannot establish
answer correctness, consent, ontology quality, causal benefit, operational
acceptance, or token savings from a passing structural check.

## Growing from a supported result

Keep the source-to-answer trace usable first. Add richer extraction only for
demonstrated missing meaning; keep proposals reviewable. Add incremental
processing when repeated parsing dominates measured cost, with exact source
revision and ontology-version invalidation. Add another engine when it improves
the same reserved cases enough to justify its full cost and correction burden.
Add recipient expression only with separate permission checks and a bounded
serializer. Existing review, coauthoring, intake, and optional decision APIs
remain separate capabilities with their own contracts.

For sustained value, link the reviewed decision to the actual action, observed
consequence, and a later appropriate use or non-use. Evaluate usefulness and
care alongside costs; no count of nodes, edges, or retrieved tokens substitutes
for that evidence.

## Guided dashboards and coauthoring

Use `atelier dev --knowledge` after graph/build to work through Onboard, Model,
Deepen, Apply, and Learn. The browser and `knowledge session` CLI share
source-bound private drafts, confirmation, and recovery. See
[knowledge workspaces](knowledge-workspace.md) for the complete flow and limits.

## Recording a host's semantic extraction

`atelier knowledge semantic` records an extraction that your own tool or model
ran, so a receiver can review it against the exact source. Atelier never runs
the extraction. The runner, its request shapes and the receiver journey are
described in [semantic operation](semantic-operation.md); this section covers
the command.

- Run it in the Git workspace where `atelier ingest` planned and ran the
  sources. Each call reads one JSON object from stdin, at most 256 KiB:
  `{"workspaceId": "...", "run": "<knowledge domain run>", "request": {...}}`.
- Operations: `begin`, `status`, `reconcile`, `complete`, `proposals`,
  `contribution` (prepareContribution), `relation` (prepareRelation), `record`,
  `cascade`, `context` and `project`.
- `request` holds exactly the operation's fields. Optional fields are `limit`
  for `proposals`, and `supersedes` with `revisionReason` for `contribution`.
  Any other field, or a missing one, refuses as `SEMANTIC_OPERATION_INVALID`
  and writes nothing. The command closes every request; the internal library
  closes only `begin` and some nested values, so library callers do not get
  this check.
- Success prints the operation's JSON result. A refusal prints
  `{"ok": false, "code": "SEMANTIC_...", "error": "..."}` on stderr and exits 1.
  When the runner already saved a completion or captured raw output, the
  refusal also carries `recorded` or `captured` with a `nextAction`: reopen the
  same operation rather than running the extraction again.
- Raw output travels inside the 256 KiB request as UTF-8 text, so larger raw
  output cannot be recorded through the command yet.
- Known limits from the runner's review stay: contradictory host declarations
  across the ledger and intake can lead to two executions, found afterwards,
  and a detected contradiction cannot yet be resolved. Neither is hidden by the
  command.
