# Knowledge ontology profile example

This structural case kit describes identity, directed source relationships,
and qualified assertions using Atelier's invented equipment-loan starter.
Start with a useful question, permitted sources, and a person who can review
the resulting meaning. The cases preserve uncertainty and keep a proposed
assertion separate from a saved draft, accepted knowledge, or an action.

The workspace is generated from the canonical `knowledge-workspace` template
through Atelier's own CLI. There is no copied workspace in this example. Two
source links connect an item, an incomplete inspection, and a possible cap
arrival. Invented identity counterexamples add two similarly named items and
an unresolved alias; they are expectations, not admitted graph nodes.

| Asset | Use |
| --- | --- |
| `profiles/equipment-loans-reference/profile.json` | Version 1.0.0 definitions, identity rules, direction, questions, and unknowns |
| `profiles/equipment-loans-reference/profile.schema.json` | Local validation of this reference profile |
| `profiles/equipment-loans-reference/cases.json` | Eight known cases and exact source anchors |
| `profiles/equipment-loans-reference/sources.json` | Expected digests of the canonical starter records |
| `tools/profile-cases.mjs` | Exact comparison of supplied observations against the known cases |
| `tools/assess.mjs` | Read-only CLI assessment and reported-measurement validation |
| `tools/fixture-workspace.mjs` | Temporary test workspace generated through canonical CLI init |

These are example contracts, not new package exports, graph types, native
predicates, or admission interfaces. The example is private and outside the
published npm tarball. It uses the root's pinned dependencies; do not install
nested dependencies or add a lockfile.

## Exercise it from the repository root

Use a Node version supported by Atelier and install the repository dependencies
through its normal workflow. The flat root driver makes these cases part of
`npm test` and hosted CI:

```sh
node --test test/knowledge-ontology-profile-example.test.mjs
```

It includes the case and assessment checks plus a generated-consumer check.
That consumer uses the actual CLI to initialize the starter, retrieve ordinary
and missing evidence, save and reread an explicitly invented private draft,
and assess it without changing source or session bytes. Tests cover polarity,
unary form, scope, source revision, identity, aliases, direction, possibility,
unknown time, unsupported predicates, omitted projections, and incomplete
session coverage. Unit measurements and sessions are invented; they are not
quality, cost, adopter, or native qualification.

To explore a workspace yourself, choose a new temporary destination and run:

```sh
node bin/atelier.mjs init --template knowledge-workspace --target TEMP_DIRECTORY
```

From that generated directory, use the selected CLI entry to run `knowledge
check`, `knowledge dashboard`, and `knowledge evaluate`, then try `knowledge
context --question "What prevents lending the blue telescope?" --mode graph`.
Inspect the missing cap, the negative inspection passage, and the directed
source dependency. Ask "Who signed the lunar station maintenance order?" to
observe a bounded `needs-evidence` result. These are newly authored questions
against known invented sources, not held-out semantic evaluation or proof of
global absence.

Shared sessions require a Git workspace with untracked, ignored `.atelier-local/`
state. Initialize Git in the generated temporary workspace before using sessions.
The root consumer checks all workspace bytes, including `.git` and the private
session store, and compares exact session list/readback before and after assessment.
Child processes drop inherited `GIT_` overrides so an enclosing Git hook cannot
redirect the fixture or selected workspace to its parent repository.

## Compare extracted observations

An extraction owner can import `evaluateProfileCases` and supply an array of
`{id, profileId, profileVersion, value}` observations. Bind them to the source
and profile revisions. Missing observations stay unknown. Changed versions,
reversed direction, invented dates, extra meaning, and lossy projections fail
comparison. An equivalent alternate representation needs a reviewed adapter.
Supplying the authored expected values checks the comparator, not an extractor.
A change in canonical starter bytes requires review of this profile's source
pins and passage anchors; do not refresh them merely to make a check pass.

Keep a negative check negative, a possible arrival possible, and an unresolved
Friday date unresolved. If projection would lose a qualifier, retain the
assertion as evidence with its omission reason. Tags classify source records;
they do not create domain entities. Matching labels or aliases do not authorize
identity merges, and attribution does not authenticate a reviewer.

## Run a read-only assessment

Select an Atelier CLI entry and a receiving binding for its declared files.
The binding contains `sourceCommit`, `sourceTree`, `tarballSha256`, and `files`
(a map of package-relative regular-file paths to SHA-256 digests, including
`bin/atelier.mjs` and `package.json`). Use schema
`atelier-profile-install-binding/local-v1` with a verified archive digest for
an installed package, or `atelier-profile-repository-binding/local-v1` with
`tarballSha256: null` for a repository CLI. The root test driver constructs the
latter from its selected repository and verifies that the declared tracked CLI
files are unchanged across the reads. Declared hashes do not authenticate the receiving author, prove
that mutable files equal a commit, verify dependencies, or grant host permission.
Keep bindings and operational captures outside this source example.

```sh
node examples/knowledge-ontology-profile/tools/assess.mjs \
  --atelier-entry CLI_ENTRY --binding RECEIVING_BINDING_JSON \
  --workspace PERMITTED_WORKSPACE
```

The command prints JSON and writes nothing. Optional `--metrics JSON` accepts
reported measurement records; `--floor JSON` supplies a prespecified quality
floor. Exit 1 means unavailable input or readback; exit 2 means an observed
check failed. Exit 0 gives no overall semantic, economic, host, or human pass.

The reader permits only check, dashboard, context, evaluate, and session
list/read operations. It imports no unpublished core modules and creates no
engine or session store. It reads at most 20 exact sessions, retains total and
truncation data, and keeps omitted or unavailable history incomplete. Planned
questions remain in the evaluation denominator when a case is missing, duplicated,
or unplanned; changed expectations fail assessment. Saved draft value fields and
unknown receipt fields are omitted; allowlisted identifiers and value digests
remain. Dashboard source excerpts, planned questions, and asserted authors may
contain other workspace wording. Dashboard output
is experimental; validate its shape and retain the exact selected candidate.

Use Atelier's existing shared sessions to coauthor, propose, confirm or reject,
and save a private draft. Source-owner review and canonical application remain
separate. This kit grants no consent, disclosure, admission, merge, or execution
authority. Meaning quality, full cost, host permission, and actual acceptance
remain unknown until separately observed.

Measurement method names are reported labels. `structured-extractor-plus-jev`
identifies an optional adjunct to structured extraction; this example contains
no Jev implementation, dispatch, or qualification. Declared direct provider calls
describe the example code. Dashboard provider counts come from the selected CLI
and remain unknown when absent; neither count establishes complete task usage.
