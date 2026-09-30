# Progressive ingestion — proposed acceptance scenarios

Status: design acceptance criteria, not executable tests or passing results.
Read the [architecture proposal](progressive-ingestion.md) first. All public
fixtures must use newly invented content and structure. Private evaluation
material remains in its owner's environment.

## Reference journey

An invented equipment cooperative imports a service note, a parts table and a
scanned checklist. A person wants to understand which maintenance steps remain
unresolved. Inventory reports all sources and modalities. Text search becomes
available before interpretation finishes. A bounded extraction pass proposes
statements with citations. A conflicting replacement interval is shown with
both source passages and becomes a review question. Accepting one scoped
decision updates the derived view without rewriting either original.

Stop the process mid-batch, restart it, change one source and repeat the query.
Completed valid work is reused, uncertain work is reconciled and the affected
decision view becomes stale. Repeat through the local reference runner and,
separately, through any product host claiming support.

## Required cases

| ID | Invented situation | Required observable result |
| --- | --- | --- |
| C01 | A connector returns one page with an unknown total | Discovery reports its bounded scope; it cannot report complete-account coverage |
| C02 | A record contains text, speech, an image and an unknown part | Every part appears in the census; unsupported parts remain explicit |
| C03 | Empty speech, provider placeholder and real transcript coexist | Distinct outcomes and counts; placeholders cannot support a semantic claim |
| C04 | A table has formulas and a marked answer; a deck has multiple slides | Structure and exact locations are preserved or their omission is reported |
| C05 | Text uses multiple languages, combining marks and mixed newlines | Original bytes survive; normalized retrieval maps back to the cited evidence |
| C06 | Two attachments share bytes but have different origins | Storage may deduplicate; source identities and unresolved matches remain separate |
| C07 | Several logical records share one container | Rendering identities and locators remain distinct; no file-hash collision merges them |
| C08 | A source contains apparent instructions to the importer | Content remains inert evidence; access, tools and scope remain unchanged |
| C09 | A quote exists but does not support the proposed relation | Structural validity is reported separately from support; no automatic acceptance |
| C10 | A small model omits a rare exception in an otherwise valid result | Representative audit detects the omission; the relevant task qualification is revised |
| C11 | Two sources copy a common original | They cannot establish independent corroboration merely through separate IDs |
| C12 | A user-role message quotes someone else or a model | The role is preserved; authorship is not inferred without evidence |
| C13 | A conflict contains several positions with incomplete time evidence | All positions and gaps remain visible; container dates do not invent statement order |
| C14 | A search finds no supporting evidence, then a source is added | The negative claim identifies its search scope and becomes stale |
| C15 | A proposal's payload changes after attestation | The old attestation no longer applies; no automatic re-signing or hash rewriting |
| C16 | One record is malformed in a large batch | A per-record failure is retained; remaining checks run and aggregate status is incomplete |
| C17 | Output exists when an assignment is dispatched again | Reconcile the existing attempt; refuse conflicting writes and duplicate accounting |
| C18 | A worker stops before writing its completion record | Partial scratch is not promoted; resume preserves verified completed attempts |
| C19 | Source, model, rubric or extraction configuration changes | Only valid matching work is reused; affected descendants are invalidated |
| C20 | Permission narrows while source bytes remain unchanged | Cache access and generated views honor the new boundary immediately |
| C21 | A provider submission times out after possible acceptance | Attempt becomes uncertain; reconciliation precedes any paid retry |
| C22 | Several jobs compete for the remaining budget | Reservation prevents over-admission; actual and unknown costs are reported separately |
| C23 | An original becomes unavailable or a tool is uninstalled | Evidence availability changes honestly; authored records survive tool removal |
| C24 | Receipts validate but the search index omits their findings | The end-to-end retrieval gate fails despite valid receipts |
| C25 | An external provider is unavailable or not permitted | Local inventory, search and review remain useful; no silent provider substitution |
| C26 | A shared report would expose a private title, path or dependency | The shared output is refused or explicitly reduced without revealing withheld details |

Tests of controls need both a valid case and a changed-input refusal. Checking
fixture shape without invoking the consuming validator is insufficient. Hosts
add their own account, process, storage and transport tests; these portable cases
do not certify those host boundaries.

## Cost and quality qualification

Select a stratified sample spanning format, language, ambiguity, source quality,
length and consequence. Establish expected evidence and human judgments before
comparing processors. Separate calibration material from held-out evaluation;
keep rare exceptions and failure cases in both planning and acceptance criteria.

Compare a stronger-model baseline, a mixed routing pipeline and deterministic
processing where applicable. Record exact processor versions, prompts, rubric,
input hashes, retries, verifier effort and evidence-selection policy. A stronger
model's output is a comparator, not ground truth.

Measure:

- Cost and elapsed time to the first useful, searchable evidence.
- Missing expected evidence and unsupported claims, stratified by task.
- Correct source and locator bindings, with ambiguity retained appropriately.
- Human correction effort and cost per useful accepted result.
- Escalation and failure rates, including apparently successful sampled work.
- Cold-run cost, unchanged-run reuse and cost after a localized source change.
- Cancellation/recovery behavior and unresolved or unmetered usage.

Acceptance thresholds are set per task and consequence before the comparison.
Cost savings do not compensate for failing a required coverage or quality floor.
Reducing output volume must not make cost per accepted result look better while
hiding missed evidence. Report denominators, sample design and uncertainty;
multiple reports from one run are one case study, not independent replications.

No particular processor, price, reduction percentage or throughput target is
qualified by these documents. Publish aggregate results only after checking that
neither the cases nor their statistics disclose a private implementation.
