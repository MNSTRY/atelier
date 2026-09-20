# MNSTRY Atelier Knowledge Graph

The Atelier knowledge graph is a local, Git-backed operating model for project
source material. It is not a taxonomy and it is not runtime retrieval. It is a
durable model of source nodes, evidence, relationships, diagnostics, and
projection readiness.

## Source Rules

- Markdown documents may use front matter. A document with no `kg` block is
  represented as `unclassified`, assigned the fail-closed `private` audience,
  and reported diagnostically rather than silently treated as governed.
- Non-Markdown sources use adjacent `.kg.json` sidecars.
- Once a Markdown `kg` block exists, `kg.id` and `kg.audience` are required;
  empty, partial, and malformed declarations are blocking errors.
- `kg.visibility` is invalid in local source metadata.
- Declared relations emit semantic edges.

## Source formats

The graph has one canonical classification engine in
`src/graph/knowledge-graph.mjs`; the older `graph.mjs` surface is a compatibility
adapter over it, not a second classifier. Markdown front matter is the only inline metadata
format the kit reads, and every other file becomes a first-class node through
an adjacent `<file>.kg.json` sidecar
(`contracts/knowledge-source-sidecar.v1.schema.json`). This is how any format
— json, yaml, csv, images, arbitrary binaries — joins the census without
atelier ever parsing the foreign format itself.

Two census rules follow:

- Document extensions (`.md`, `.html`, `.pdf`, `.docx`) are always sources.
  Non-Markdown documents *demand* a sidecar and fail closed without one.
- Any other file *opts in* by carrying a sidecar. Without one it is simply not
  knowledge-graph material — no error, no node. A sidecar whose adjacent asset
  is missing is still an orphan error either way.

A sidecar that Git ignores cannot enroll a file. Membership asks whether the
sidecar is *visible* in tracked state, not whether it exists on this disk: an
untracked, ignored `<file>.kg.json` is machine-local, so obeying one mints a
node — with whatever audience it declares, up to `public` — that appears in no
tracked file and on no other machine. The refusal runs both ways: an ignored
sidecar enrolls nothing and describes nothing, so a document-extension asset
whose only sidecar is ignored still fails closed with the ordinary
missing-sidecar error, which is the verdict a clean checkout reaches anyway.
Refused sidecars are named — a warning, `ignored-sidecar`, on `buildGraph`'s
`ignoredSidecarWarnings(project)` and on the workspace builder's
`ignoredSidecars`, printed by `atelier graph` — because dropping them silently
is what let the injection through. They are reported *beside* the graph and
never inside it: `buildGraph`'s return value is written verbatim as the
artifact, and a machine-local observation there would churn committed bytes
per machine, which is the failure the ignore filter exists to prevent.

The sidecar branch is binary-safe by construction: the asset's bytes are never
read. Identity, audience, and relations all come from the sidecar, so
audience-based projection filtering, disclosure diagnostics, and the repo
boundary guard treat a sidecar-described binary exactly like a Markdown
document.

Why the kit does not parse yaml (or csv, or anything else): the zero-dependency
trust posture. Node ships no yaml parser, and pulling one in — or hand-rolling
parsers for every format an adopter might commit — widens exactly the supply
chain and attack surface the kit exists to keep auditable. Declared metadata in
a schema-checked JSON sidecar is the trust boundary. Richer format adapters
that derive metadata from asset contents belong to extension packs
(`atelier-extension-pack.v1`), not the kit core.

## A worked example

The assessment below is invented to show the shape and belongs to no one's
method. Once a body of work is authored, a question file looks like this:

```
method/assessments/practice-patterns.md
---
title: Practice patterns assessment
summary: Version 3 of the practice patterns questions, with the scoring rules they depend on.
tags: [method, assessment]
kg:
  id: example:assessment:practice-patterns
  type: document
  status: active
  audience: team
  relations:
    depends_on: [example:scoring:practice-patterns-v3]
---
## Q07
Prompt: When my daily practice lapses, I tend to
Answers: A drop it for the week / B restart the next day / C shorten it and continue
Scores: A adds 2 to lapse. B adds 2 to restart. C adds 1 to adaptation.
Missing answer: no score; mark the reading as partial.
```

The scoring rules live in their own file. The file itself is data a product
reads:

```
method/scoring/practice-patterns-v3.json
{ "version": 3, "weights": { "lapse": 2, "restart": 2, "adaptation": 1 }, "partialWhenMissing": true }
```

A sidecar beside it makes it a governed node, so the relationship between
question, rule and test cases is declared rather than remembered:

```
method/scoring/practice-patterns-v3.json.kg.json
{
  "schema": "mnstry.source-sidecar@v1",
  "asset": "practice-patterns-v3.json",
  "title": "Scoring rules, version 3",
  "summary": "Weights, thresholds and tie rules for the practice patterns assessment.",
  "tags": ["method", "scoring"],
  "kg": {
    "id": "example:scoring:practice-patterns-v3",
    "type": "manifest",
    "domain": "example",
    "lifecycle": "active",
    "status": "active",
    "audience": "team",
    "relations": {
      "implements": ["example:assessment:practice-patterns"],
      "evidences": ["example:examples:practice-patterns-v3"]
    }
  }
}
```

The worked examples are a third source, a table of sample answers with the
scores and readings they produce, declared as evidence for the scoring rules:

```
method/examples/practice-patterns-v3.md
---
title: Worked examples, practice patterns v3
summary: Sample answer sets with the scores and readings they produce.
tags: [method, examples]
kg:
  id: example:examples:practice-patterns-v3
  type: evidence
  status: active
  audience: team
  relations:
    evidences: [example:scoring:practice-patterns-v3]
---
| Answers | Scores | Reading |
| --- | --- | --- |
| Q07 = A | lapse 2 | partial pattern: lapse |
| Q07 = C | adaptation 1 | partial pattern: adaptation |
| Q07 missing | none | reading marked partial |
```

From those headers the builder compiles edges: the assessment depends on the
scoring rules, the rules implement the assessment, and the worked examples
evidence the rules. Ask an agent to revise Q07 and it follows those edges to
the rules and the examples that depend on the question, then revises the
affected files and runs the graph check against the result. The graph check
refuses a header that names a node which does not exist, and the audience on
each file decides what an export may include.

To try it, drop the four files under `content/` in a copy of
`fixtures/projects/sample-workspace` and run `atelier graph --check`. The
sidecar without its asset is refused (`sidecar has no matching source
asset`); a `depends_on` pointing at an id that does not exist is refused
(`declared depends_on target ... was not found`); with all four files present
the graph builds with no diagnostics.

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
