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

### Open decision: one writer

Determinism guards the trigger, not the underlying shape. Committing generated
artifacts and rebuilding them on every machine on every tick is inherently
collision-prone: any nondeterminism that slips back in — a new census input, a
Node version difference, a timestamp — reproduces the churn, and a machine that
cannot fast-forward keeps publishing its own build, which is self-sustaining.

The durable fixes are one-writer postures: generate in CI only, or stop
committing projections and build them on demand. This is not yet decided. When
the kit formalizes projection workflows for multi-machine adopters, one of those
should become the documented default, with committed artifacts treated as the
single-machine special case.

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

## File Classification

Every file the kit ships or generates belongs to one of three classes, declared
once in the kit manifest's `fileClasses` and resolved through
`classifyPath(path, { repoRole })`:

| Class | Meaning | Safe automated handling |
|---|---|---|
| `source` | canonical, human or agent authored | never discard; conflicts need a human |
| `generated-projection` | rebuilt deterministically every tick | discard and regenerate freely |
| `distributed-runtime-copy` | canonical in ONE repo role, copied into consumers by runtime sync | rederivable in consumers, canonical where it is owned |

A `distributed-runtime-copy` **must** declare `canonicalRepoRole`. This is the
part that cannot be skipped: name-matching alone cannot tell the repo that owns
a file from the repos that merely receive it. A self-repair loop that treats a
runtime copy as authored work wedges the consumer in permanent rebase conflict;
a sync loop that folds it into a plain "generated" list silently destroys
canonical edits in the repo where it is source. The same path therefore resolves
to `source` in its canonical role and `distributed-runtime-copy` everywhere else.

Unclassified paths default to `source`, the fail-closed answer — never discarded.
Later entries win, as in `.gitignore`, so an adopter can narrow a kit default by
appending a more specific pattern.

Adapters must not maintain shadow lists. `test/file-class.test.mjs` asserts the
kit itself keeps no second copy: the graph walker's skip list is derived from the
declaration, and the glob dialect lives in one module.
