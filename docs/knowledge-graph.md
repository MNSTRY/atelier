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
