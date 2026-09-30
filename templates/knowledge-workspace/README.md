# A useful knowledge graph, from one question

This is an invented equipment-loan workspace. All three records are private.
The question is whether an instrument can be loaned: the inspection has not
passed, and a possible repair is not a completed repair.

```sh
git init
atelier knowledge check
atelier knowledge context --question "Can the blue telescope be loaned this week?"
atelier knowledge evaluate
atelier graph
atelier build
atelier dev --knowledge
```

Adapt `knowledge-plan.json` before using your own material. Name the work,
steward, reviewer, source permissions, correction path, small domain vocabulary,
and questions that make the graph worth maintaining. Source records use
Atelier's native `kg.type` and relationship vocabulary; domain concepts use
`concept:...` tags. Every concept should help answer a useful question.

Review the complete source and its qualifications before answering. A passing
check measures structure, not truth or acceptance. The evaluation compares
lexical selection with one hop of declared relations and checks expected source
digests. After editing evidence, update a test pin only after reviewing the
changed meaning.

The starter's `.gitattributes` keeps record line endings as LF so ordinary Git
checkouts preserve those exact source pins, including on Windows. Intentional
record edits still require review and renewed pins.

Context is local operator material. It grants no sharing or action permission.
Its byte budget includes the JSON envelope; token estimates are approximate.
The tool makes no model calls. Measure actual tokens and resulting work with
your own agent or host before claiming savings.

The package guide `docs/knowledge-setup.md` explains adoption, limitations, and
how to measure unseen questions, human correction, and appropriate later reuse.

Open `/knowledge` at the printed address for Onboard, Model, Deepen, Apply,
and Learn dashboards. Coauthor answers stay in private local history and can
resume through `atelier knowledge session`. Review exported drafts before
applying any source change. See the package guide `docs/knowledge-workspace.md`.
