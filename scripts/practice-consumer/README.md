# Decision-practice consumer (Foundation)

This is Foundation's own consumer of the internal decision practice in `src/judgment/` (`docs/decision-practices.md`). It applies the practice to this repository's recorded decisions. It is a repository tool: it is not in the published package and adds no public API or command.

## What it does

`reconsider.mjs measure --pr N --base SHA --head SHA` measures a pull request from its merge base (`git merge-base base head`). It reads, at exact commits:
- the recorded decisions in `docs/integration-contract-decisions.md` at the base: each section's prose and each decision-table row;
- the repository files each decision links to;
- how the pull request changed those files.

For each cited file it runs `evaluateDecisionPractice` once:
- **Practice:** the adopted definition in `definition.json`.
- **History:** an in-memory Knowledge history rebuilt from the base commit.
- **Evidence:** exact evidence for the changed region and for the decision.
- **Assessment:** a deterministic one, under provider `foundation-deterministic` and model `cited-source-predicate.v1`, with `usage: null` and no model call.

It appends one measurement line to `measurements.jsonl`.

A reviewer then appends a label with `reconsider.mjs label --by NAME --decision ID --file PATH`.
- The label is one of `correct`, `missed`, `false-alarm` or `useful-abstention`.
- It records the review effort in minutes, which includes confirming a correct outcome.
- It records the digest of the latest measurement of that pull request, so it judges one exact outcome.
- `by` records who labelled it.

**Reproducibility.** Git (2.32 or later) runs without system or global configuration or attributes, with configuration and attribute overrides removed from the environment. It ignores renames, forces text diffs, names its diff algorithm, and resolves every path from the repository top. A measurement therefore does not depend on the caller's settings or working directory. A file is binary only when its contents at the head contain a NUL byte, never because of an attribute. Each measurement records the tool's own digest and the git version.

The assessment is the predicate the rubric declares:

| Change to the cited file | Assessment | Practice outcome |
| --- | --- | --- |
| A line modified or removed | `affected` | proceed: an unaccepted reconsideration draft |
| Only lines added | `unaffected` | stop |
| Binary, removed, renamed or over the excerpt bound | abstained, `insufficient-evidence` | escalate |
| Changed without line changes (for example a mode change) | `unclear` | escalate |
| Not changed | not assessed (prerequisite false) | stop |
| Cited path missing, a directory, unreadable or over bounds at the base | not evaluated (`cited-path-missing`, `cited-path-not-a-file`, `cited-source-unreadable-or-over-bounds`) | none |

Each line also records whether the Knowledge harness itself marks the decision for reconsideration once the changed source is recorded (`harnessReconsider`).

## What it does not do

- It calls no provider and appends to no Knowledge store. It accepts or activates nothing, and it writes only its measurement file.
- The review and activation records in the rebuilt history stand for Foundation's adoption of this practice for its own repository. They are not an independent or human review.
- The probabilities are declared values (1 for the chosen criterion, 0 otherwise), and the confidence is a fixed, uncalibrated 0.5.
- For a removed or binary source, the source evidence is a placeholder text that says so, bound to the head commit.
- An unchanged source is not assessed. The evaluator validates the result, which is a fixed placeholder there, and then stops on the false prerequisite.
- Appending to a file that has no final newline also changes its last line, so it counts as `affected`.
- A decision without an explicit link cannot be measured. A change that matters to a decision without touching a cited file is a miss the tool cannot see.

## First measurements (retrospective, recorded 2026-10-02)

These are five real merged pull requests, each measured from its parent to its squash commit.

**The labels are Foundation's own.** Foundation (`atelier-foundation`) appended them retrospectively, in one batch, after reading each change. They are not an independent or human review.

| PR | Cited file changed | Outcome | Foundation's label | Review minutes |
| --- | --- | --- | --- | --- |
| #107 | no | stop | correct | 2 |
| #111 | `docs/architecture.md` (one table row) | proceed, draft prepared | false alarm | 3 |
| #121 | no | stop | correct | 1 |
| #125 | no | stop | correct | 1 |
| #118 | no | stop | correct | 3 |

**Observations:**
- Only 1 of the 10 recorded decisions links a file. The other 9 are unmeasurable until their records cite sources.
- The modified-line predicate over-triggers on table edits that add cross-references.
- Foundation saw no miss for the one measurable decision. This says nothing about the 9 uncited decisions.

Live measurements continue on the next real root pull requests.
