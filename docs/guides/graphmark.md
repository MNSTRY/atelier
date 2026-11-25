# Graphmark: marking what matters

To graphmark something is to say: this specific thing matters, keep it, and
keep why. A person singles out a passage, a table, a design, a decision, a
pattern or a phrase. The agent who receives the mark finds that exact thing,
preserves the edition that was marked, records who made it, who marked it,
when and why, and joins it to the knowledge graph through the owner's own
records. Later work then reaches it through what it relates to, not through
someone's memory of where it was.

The reason for the mark is the centre of the record. A table marked for the
way its parts depend on each other is recorded for that dependence, not
summarised along with the project it came from.

Graphmark needs nothing beyond the existing [knowledge graph](../reference/knowledge-graph.md)
contract. A mark is a Markdown source with a `kg` block whose relations point
at the marked node. It adds no schema, store, command or runtime authority.
The bundled `atelier-graphmark` skill carries the workflow for agents.

## What a mark is not

- **Not approval.** A mark preserves and connects. Adoption, publication,
  release and acceptance stay with the marked material's owner.
- **Not a summary or a link.** A link to a source is not a mark. A mark exists
  when its record is written and the graph builds with it.
- **Not a second owner.** The marked material stays where it lives. The mark
  names the exact edition that was marked and points to it.

## The steps

1. **Find exactly what was marked.** Resolve the selection, passage, file or
   reference, and read it through its own tool. If the target is unclear,
   recover what is available and ask only for the missing piece.
2. **Say why it was marked.** Write the marker's reason plainly, in their
   meaning. If it was not given and cannot be recovered, ask one question.
3. **Establish provenance.** Who made it, who marked it, when, which source
   owns it, and which parts are source and which are later interpretation. If
   the work builds on someone else's, name them.
4. **Check what already exists.** Search the graph for the object and for
   earlier marks. If it is already a node, the mark points at that node rather
   than creating another. If the mark replaces an earlier one, say so with
   `supersedes`. Recency alone never makes a mark authoritative.
5. **Decide custody and audience before placement.** Confirm the owner, the
   consent that covers the material and its audience (`public`, `team`,
   `operator`, `staff`, `private` or `sensitive`). A mark's audience is never
   wider than the marked material's. Titles, paths and relations can reveal as
   much as content does. When unsure, keep the mark private and name the
   decision that is needed.
6. **Preserve the edition.** Record the marked file's repository path and the
   SHA-256 of its bytes at the moment of marking. Leave the original
   unchanged. If it changes later, the mark still names what was marked.
7. **Write the record and join it to the graph.** Use the record shape below.
   A non-Markdown object is reached through its `<file>.kg.json` sidecar. If
   it has none, its owner adds one; for `.html`, `.pdf` and `.docx` files,
   `atelier enroll documents` writes the smallest sidecar the census accepts,
   at the `private` audience unless told otherwise. Use the existing relation types: `evidences`
   to the marked node, `belongs_to` to the marks index, and `depends_on`,
   `supports`, `contradicts` or `related` only for relationships the evidence
   shows. An open interpretation stays in the record's text, labelled as a
   candidate, and does not become an edge. Never edit a generated graph.
8. **Build, check and read back.** Run `atelier graph` and
   `atelier graph --check`, then find the mark's id and edges in the built
   graph. Report what was marked and why, where the record lives, its audience,
   and the furthest state actually reached.

## The record

One Markdown file per mark in the repository's marks folder, numbered in
order, beside an index file. Ids never change.

```
marks/0001-the-order-of-wheel-checks.md
---
title: "Mark 0001: the order of wheel checks"
summary: "Marked for the order of the checks and the reason each one comes where it does."
tags: [graphmark]
markedBy: "A volunteer lead"
markedOn: "2026-01-12"
madeBy: "The workshop's volunteers"
markedPath: "notes/wheel-checks.md"
markedSha256: "832bff3f…"
markState: "graph-checked"
kg:
  id: "repair-workshop:mark:0001-the-order-of-wheel-checks"
  type: "evidence"
  status: "active"
  audience: "team"
  relations:
    evidences:
      - "repair-workshop:notes:wheel-checks"
    belongs_to:
      - "repair-workshop:marks"
---
```

The body says, in plain sentences: what was marked, why, its provenance, what
the mark does not do, and any open interpretation labelled as a candidate.

The graph reads `title`, `summary`, `tags` and the `kg` block. The other front
matter fields (`markedBy`, `markedOn`, `madeBy`, `markedPath`, `markedSha256`,
`markState`) are for people and tools that read the record; the graph does not
interpret them. Git authorship remains the primary attribution signal, as the
knowledge graph's collaboration rules state.

## States

A mark moves through separate states. Report the furthest one you verified.

| State | What has happened |
| --- | --- |
| `marked` | Someone has said "graphmark this" about a specific thing |
| `preserved` | The edition's path and digest are recorded and the original is unchanged |
| `recorded` | The mark record is written in the owner's repository |
| `graph-checked` | `atelier graph --check` passes and the mark's id and edges are in the built graph |
| `shared` | The record is in a repository its intended readers can read |
| `accepted` | The material's owner has accepted the reading the mark records |

A passing graph check proves structure, not meaning. It does not establish that
the marked reason is right, that the reader agrees or that anything was
adopted.

## Try it

`fixtures/graphmark/` is an invented community repair workshop with one note,
one drawing and two marks. From a copy of that folder:

```sh
atelier graph --project ./atelier.project.json
atelier graph --check --project ./atelier.project.json
```

The graph builds with five nodes, five edges and no diagnostics. Point a mark's
`evidences` at an id that does not exist and the build is refused (`declared
evidences target ... was not found`). Delete the drawing and the build is
refused twice: the sidecar becomes an orphan and mark 0002 no longer resolves.
`test/graphmark.test.mjs` pins these behaviours.

## Limits

- The graph reads tracked files only. A mark record in a Git-ignored path is
  skipped by the census without an error, so a mark can seem written and still
  be absent. Commit or stage the record, rebuild, and confirm its id is in the
  built graph.
- The graph does not compare a mark's audience with the marked material's
  audience. Step 5 is the agent's and reviewer's responsibility.
- The graph does not verify `markedSha256`. A repository that wants that check
  can run its own, as the fixture test does.
- A mark is local, Git-backed source material. It grants no export, runtime
  visibility or publication. Export audience rules apply unchanged.

## Origin

Graphmark was introduced by Tiyana Ti of Brand Temple on 8 November 2026, as a
way to mark material from any conversation into a knowledge graph with its
reason and provenance. It is built on the Atelier knowledge graph, its source
rules and its ontology and phronesis foundations, developed by Erik Desrosiers
for MNSTRY.
