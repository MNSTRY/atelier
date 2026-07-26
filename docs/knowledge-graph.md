# MNSTRY Atelier Knowledge Graph

The Atelier knowledge graph is a local, Git-backed operating model for project
source material. It is not a taxonomy and it is not runtime retrieval. It is a
durable model of source nodes, evidence, relationships, diagnostics, and
projection readiness.

## Source Rules

- Markdown documents use front matter.
- Non-Markdown sources use adjacent `.kg.json` sidecars.
- `kg.id` is required and stable.
- `kg.audience` is required.
- `kg.visibility` is invalid in local source metadata.
- Declared relations emit semantic edges.

## Census Rules

Graph and projection walks skip git-ignored paths. A committed artifact must
describe the repository, not one machine's working tree — if `.mnstry-local/`,
support bundles, editor scratch, or OS junk enter the census, every machine
produces different bytes for the same commit and multi-machine workspaces
rebase-conflict on every sync.

The check is one batched `git ls-files --others --ignored --exclude-standard
--directory` per repository root, not a per-file `git check-ignore`, which is
too slow to survive contact with a real workspace.

Repository *discovery* is deliberately not filtered this way: a git folder that
appears in the workspace is an explicit decision for the operator to make (see
the `external` repo kind), not something to drop silently.

Determinism is a tested contract. `test/graph-determinism.test.mjs` builds
twice, plants git-ignored junk between builds, and fails if any committed
artifact changes a byte. It also asserts the planted paths really are ignored,
so a dropped `.gitignore` pattern fails loudly rather than passing while the
churn quietly returns.

## Projection Rules

The graph feeds local views, readiness reports, and dry-run exports. A local
projection may hide or emphasize material for a stakeholder, but it does not
enforce object-level permissions. If enforcement is required, the project must
use Git repo access locally or MNSTRY runtime permissions after import.

## Collaboration Rules

Git authorship is the primary local attribution signal. Actor and harness
annotations are advisory context. Sensitive semantic fields should fail closed
without an explicit review marker, while ordinary authored files can use normal
Git merge/review workflows.
