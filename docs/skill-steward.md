# Skill stewardship

Atelier skill stewardship is a local, evidence-gated loop for keeping agent
skills useful without turning every repeated request into permanent
instructions. It separates four concerns that are easy to blur together:

```text
bounded observation -> evidence candidate -> authored and tested change
                                                   |
package release -> content-bound sync plan -> repo-scoped managed projection
```

Git remains the source of record for authored skills. Ignored local state holds
only enumerated observations, staging directories, and recoverable quarantine.
The steward has no telemetry, model provider, prompt capture, send path, browser
apply endpoint, or authority to mutate its source catalog.

## The operating loop

### 1. Observe outcomes, not conversations

An equipped agent can record one outcome after relevant work:

```bash
atelier skills observe \
  --workflow weekly.release \
  --signal repeated-task \
  --outcome success
```

The observation accepts only a stable workflow key, one enumerated signal, an
optional skill name, and an enumerated outcome. It has no fields for prompts,
transcripts, summaries, source excerpts, names, or client material; callers
must not encode any of them into the workflow key. Records live under ignored
`.atelier-local/skill-steward/observations.ndjson`.

Signals are `repeated-task`, `missing-workflow`, `user-correction`,
`trigger-miss`, `trigger-collision`, `tool-failure`, `stale-guidance`,
`successful-run`, `unused-skill`, and `superseded-skill`. Outcomes are
`success`, `failure`, `corrected`, `missing`, and `unknown`.

### 2. Promote only repeated evidence

```bash
atelier skills candidates --json
```

The candidate builder is deterministic. It proposes no source edit and uses
fixed minimums:

| Candidate | Evidence required |
| --- | --- |
| Create | Three combined `repeated-task` or `missing-workflow` signals with no named skill |
| Improve | Two `user-correction` signals, or three combined correction/failure/staleness signals, for a named skill |
| Reconcile | Two `trigger-collision` signals |
| Retire | Two `superseded-skill` signals or three `unused-skill` signals for a named skill |

An agent using the shipped `atelier-skill-steward` skill may turn an eligible
candidate into an authored change, test positive and negative triggers, and
run the catalog audit. Instruction-only changes that retain the same tools,
data boundary, and external authority may progress through that automated
lane. Any new network access, filesystem scope, external message, spending,
destructive action, credential handling, or audience change pauses for human
authorization.

### 3. Audit the whole catalog

```bash
atelier skills audit
atelier skills audit --root ./skills/codex --peer ./skills/claude --json
```

The audit validates required YAML frontmatter, lowercase names, directory/name
agreement, UTF-8 `SKILL.md` text, bounded bundle size, real files and directories,
bundle-contained relative resources, unfinished placeholders, and byte-level
parity between agent surfaces. Errors fail the command. Warnings remain
visible and reviewable.

Catalog audits should run after authored changes and on a regular schedule.
A scheduled agent task can run the audit and candidate builder, exercise
eligible instruction-only changes, and leave a tested Git diff for ordinary
review. Scheduling invokes the same skill and does not widen its permissions or
lower its evidence thresholds.

A portable recurring-task prompt is:

> Use the `atelier-skill-steward` skill in this repository. Audit the complete
> skill catalog, inspect evidence-thresholded candidates, and integrate eligible
> authority-neutral instruction changes with behavioral and repository gates.
> Reconcile overlaps and retire only evidence-backed vestiges. Do not capture
> task content, add authority, overwrite drift, or bypass an exact sync plan.

### 4. Update deployed skills from the released root package

A consuming repository can project the released package's `skills/codex`
catalog into repo-scoped `.agents/skills`:

```bash
atelier skills sync --json
atelier skills sync --apply --confirm sha256:<the-reviewed-plan-digest>
```

The first command is read-only. The second recomputes the current plan and
requires the exact digest that was reviewed. It refuses:

- a target outside the enrolled workspace;
- malformed or redirected bundles and lock files;
- a collision with an unmanaged local skill;
- local drift from the last managed digest; or
- any source catalog that fails audit.

Replaced and retired managed bundles move to
`.atelier-local/skill-steward/quarantine/`; they are never permanently deleted
by sync. The projection lock at
`.agents/skills/.atelier-skill-lock.json` binds each installed bundle to its
content digest and the source package version. This is the update bridge: after
a newer `@mnstry/atelier` is installed, the same plan/apply sequence brings its
shipped skills into the current repository without overwriting local ownership.

Installation is explicit per repository; installing the package alone does not
install a discoverable skill projection. Existing unmanaged bundles, including
byte-identical bundles, are never adopted implicitly. Missing managed bundles
count as local drift. Source and target may not overlap. A confirmation is
bound to the workspace and source location as well as their observed content.
Location hashes are local identifiers, not anonymization or authentication.
Interrupted operations leave a lock and recovery state for inspection; do not
automatically clear them or overwrite a locally edited projection.

## Portable contracts

`contracts/atelier-skill-steward.v1.schema.json` defines four independently
addressable documents:

- `mnstry.atelier-skill-audit@v1` for catalog findings;
- `mnstry.atelier-skill-candidates@v1` for thresholded work;
- `mnstry.atelier-skill-sync-plan@v1` for review and exact confirmation; and
- `mnstry.atelier-skill-sync-lock@v1` for the managed projection inventory.

Fixtures cover valid and invalid examples, and the registry, compatibility,
disclosure, packaging, and release gates treat the contract and portable skill
bundles as public artifacts.

## Automation policy

The safe autonomous lane is deliberately narrower than everything an agent
could theoretically do:

1. record only enumerated, content-free outcomes during ordinary work;
2. audit and aggregate on a schedule;
3. author only evidence-backed, authority-neutral skill changes;
4. validate behavior, catalog integrity, disclosure, and package gates;
5. leave public source changes in Git for review; and
6. update a deployed projection only from a reviewed, exact digest plan.

This makes “self-improving” mean accumulated evidence plus reversible changes,
not silent memory, prompt harvesting, or unbounded self-modification.
