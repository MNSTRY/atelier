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

## Anchored citations (definition revision two)

A decision can cite some lines of a file rather than the whole file, with a GitHub line anchor: `[text](../src/example.mjs#L12-L30)` or `#L12`. Put the link in a table row's second or third cell; the first cell names the decision, and changing it changes the decision's id.

**How an anchor is read**
- The anchor is translated at this boundary into the existing selector `text-lines@1`, value `lines:12-30`, owner `atelier-root`, with the repository path as the object id. Nothing downstream sees the `#L` form.
- Any other fragment (a heading, `#L0`, `#L5-L3`, `#L1-2`) is refused as `cited-anchor-unsupported` or `cited-anchor-malformed`. It is never read as the whole file.
- The anchored lines are read at the merge base, where the decision is read. A range past the end of the file is refused (`cited-anchor-out-of-range`), and so is one longer than 120 lines (`cited-anchor-over-bounds`).
- Lines are the UTF-8 file split on LF. A CR or a BOM stays in the text, and a final LF makes a final empty line.
- Each outcome records two references, each with its own revision and digest:
  - the anchor at the merge base (`anchor.base`);
  - the same lines mapped to the head (`anchor.head`, null when every anchored line was removed).

**Whether a change touches an anchor** is decided in base coordinates:
- A removed or modified base line inside the anchor counts as removed.
- An insertion counts as inside only between two anchored lines. Insertions directly before or after the anchor are outside it.
- The prerequisite is that the anchored lines changed, or that the head cannot show them (file removed or binary). A change only outside the anchor stops on the false prerequisite, and `anchor.outsideChanges` records it.

**Re-anchoring is reported apart from the outcome.** `anchor.reanchor` is true when the anchor moved or its lines changed, and `summary.reanchors` counts these. A draft never hides a needed re-anchor, and a stop never drops one.

Renames are not followed. A moved file is absent at the head, so its anchors escalate and need re-anchoring.

**Versions**
- Revision two writes `atelier-practice-consumer-measurement@v1` lines, which add the `anchor` field.
- Labels are `atelier-practice-consumer-label@v1`. `label --anchor lines:S-E` names the anchored outcome, and is required when a decision cites the same file more than once.
- Earlier `@v0` lines keep their own definition and tool digests and stay labelable as whole-file citations.
- Whole-file citations keep their revision-one request and instance identities.

## What it does not do

- It calls no provider and appends to no Knowledge store. It accepts or activates nothing, and it writes only its measurement file.
- The review and activation records in the rebuilt history stand for Foundation's adoption of this practice for its own repository. They are not an independent or human review.
- The probabilities are declared values (1 for the chosen criterion, 0 otherwise), and the confidence is a fixed, uncalibrated 0.5.
- For a removed or binary source, the source evidence is a placeholder text that says so, bound to the head commit.
- An unchanged source is not assessed. The evaluator validates the result, which is a fixed placeholder there, and then stops on the false prerequisite.
- Appending to a file that has no final newline also changes its last line, so it counts as `affected`.
- A decision without an explicit link cannot be measured. A change that matters to a decision without touching a cited file, or its anchored lines, is a miss the tool cannot see.

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
