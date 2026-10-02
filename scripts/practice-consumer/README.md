# Decision-practice consumer (Foundation)

This is Foundation's own consumer of the internal decision practice in `src/judgment/` (`docs/decision-practices.md`). It applies the practice to this repository's recorded decisions. It is a repository tool: it is not in the published package and adds no public API or command.

## What it does

`reconsider.mjs measure --pr N --base SHA --head SHA` reads, at exact commits:
- the recorded decisions in `docs/integration-contract-decisions.md` at the base: each section's prose and each decision-table row;
- the repository files each decision links to;
- how the pull request changed those files.

For each cited file it runs `evaluateDecisionPractice` once:
- **Practice:** the adopted definition in `definition.json`.
- **History:** an in-memory Knowledge history rebuilt from the base commit.
- **Evidence:** exact evidence for the changed region and for the decision.
- **Assessment:** a deterministic one, under provider `foundation-deterministic` and model `cited-source-predicate.v1`, with `usage: null` and no model call.

It appends one measurement line to `measurements.jsonl`. A person then appends a label (`correct`, `missed`, `false-alarm` or `useful-abstention`) with the correction effort in minutes.

The assessment is the predicate the rubric declares:

| Change to the cited file | Assessment | Practice outcome |
| --- | --- | --- |
| A line modified or removed | `affected` | proceed: an unaccepted reconsideration draft |
| Only lines added | `unaffected` | stop |
| Binary, removed or over the excerpt bound | abstained, `insufficient-evidence` | escalate |
| Not changed | (prerequisite false) | stop |

Each line also records whether the Knowledge harness itself marks the decision for reconsideration once the changed source is recorded (`harnessReconsider`).

## What it does not do

- It calls no provider and appends to no Knowledge store. It accepts or activates nothing, and it writes only its measurement file.
- The review and activation records in the rebuilt history stand for Foundation's adoption of this practice for its own repository. They are not an independent or human review.
- The confidence value is fixed and uncalibrated.
- A decision without an explicit link cannot be measured. A change that matters to a decision without touching a cited file is a miss the tool cannot see.

## First measurements (retrospective, recorded 2026-10-02)

These are five real merged pull requests, each measured from its parent to its squash commit.

| PR | Cited file changed | Outcome | Label | Minutes |
| --- | --- | --- | --- | --- |
| #107 | no | stop | correct | 2 |
| #111 | `docs/architecture.md` (one table row) | proceed, draft prepared | false alarm | 3 |
| #121 | no | stop | correct | 1 |
| #125 | no | stop | correct | 1 |
| #118 | no | stop | correct | 3 |

**Observations:**
- Only 1 of the 10 recorded decisions links a file. The other 9 are unmeasurable until their records cite sources.
- The modified-line predicate over-triggers on table edits that add cross-references.
- No miss was observed for the one measurable decision. This says nothing about the 9 uncited decisions.

Live measurements continue on the next real root pull requests.
