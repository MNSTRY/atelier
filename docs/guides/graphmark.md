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

This guide is the how-to. The normative definition is [the MNSTRY GraphMark
standard](../reference/graphmark.md): its requirements, the
`atelier-graphmark@v1` record contract and `atelier graphmark check`. A mark is
a Markdown source on the existing [knowledge graph](../reference/knowledge-graph.md)
contract, with a `kg` block whose relations point at the marked node. It adds
no store and no runtime authority. The bundled `atelier-graphmark` skill
carries the workflow for agents.

## What a mark is not

- **Not approval.** A mark preserves and connects. Adoption, publication,
  release and acceptance stay with the marked material's owner.
- **Not a summary or a link.** A link to a source is not a mark. A mark exists
  when its record is written and the graph builds with it.
- **Not a second owner.** The marked material stays where it lives. The mark
  names the exact edition that was marked and points to it.

## The steps

1. **Find exactly what was marked.** Resolve the selection, passage, file or
   reference, and read it through its own tool. Note the part that was meant:
   a few lines, an exact sentence, or the whole object. If the target is
   unclear, recover what is available and ask only for the missing piece.
   If the material is not yet in the owning repository (a passage from a
   conversation, a call, a file elsewhere), capture it there first as a
   source file, commit it, and note where it came from for `capturedFrom`.
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
6. **Preserve the edition.** Make sure the marked material is committed, then
   record the target: the repository, the object's path from the repository
   root, the commit that holds it, the selector for the marked part, and the
   SHA-256 of the whole object's bytes at that commit. Leave the original
   unchanged. If it changes later, the mark still names what was marked, and
   Git can return it.
7. **Write the record and join it to the graph.** Use the record shape below.
   A non-Markdown object is reached through its `<file>.kg.json` sidecar. If
   it has none, its owner adds one; for `.html`, `.pdf` and `.docx` files,
   `atelier enroll documents` writes the smallest sidecar the census accepts,
   at the `private` audience unless told otherwise. Use the existing relation types: `evidences`
   to the marked node, `belongs_to` to the marks index, and `depends_on`,
   `supports`, `contradicts` or `related` only for relationships the evidence
   shows. An open interpretation stays in the record's text, labelled as a
   candidate, and does not become an edge. Never edit a generated graph.
8. **Build, check and read back.** Run `atelier graph`,
   `atelier graph --check` and `atelier graphmark check`, then find the mark's
   id and edges in the built graph. Report what was marked and why, where the record lives, its audience,
   and the furthest state actually reached.

## The record

One Markdown file per mark in the repository's marks folder, beside an index
file, named by the day it was marked and a short name so that two people
marking at once never collide. Ids never change.

```
marks/2026-01-12-order-of-wheel-checks.md
---
title: "Mark: the order of wheel checks"
summary: "Marked for the order of the checks and the reason each one comes where it does."
tags: [graphmark]
markedBy: "A volunteer lead"
markedOn: "2026-01-12"
madeBy: "The workshop's volunteers"
target:
  owner: "content"
  objectId: "notes/wheel-checks.md"
  revision: "<the commit that holds the edition>"
  selector:
    type: "lines"
    version: "1"
    value: "16-21"
  contentDigest: "sha256:832bff3f…"
markState: "graph-checked"
kg:
  id: "repair-workshop:mark:2026-01-12-order-of-wheel-checks"
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

`target` is the shared exact source reference from evidence navigation. The
selector is `whole` (value `*`), `lines` (`N` or `N-M`) or `text-quote` (the
exact sentence). Captured material adds `capturedFrom`.

The body says, in plain sentences: what was marked, why, its provenance, what
the mark does not do, and any open interpretation labelled as a candidate.

The graph reads `title`, `summary`, `tags` and the `kg` block. The other front
matter fields (`markedBy`, `markedOn`, `madeBy`, `target`, `capturedFrom`,
`markState`) are pinned by the `atelier-graphmark@v1` contract and verified by
`atelier graphmark check`; the graph does not interpret them. Git authorship remains the primary attribution signal, as the
knowledge graph's collaboration rules state.

## States

A mark moves through separate states. Report the furthest one you verified.

| State | What has happened |
| --- | --- |
| `marked` | Someone has said "graphmark this" about a specific thing |
| `preserved` | The material is committed, and the target names its revision, part and digest |
| `recorded` | The mark record is written in the owner's repository |
| `graph-checked` | `atelier graph --check` and `atelier graphmark check` pass, and the mark's id and edges are in the built graph |
| `shared` | The record is in a repository its intended readers can read |
| `accepted` | The material's owner has accepted the reading the mark records |

A passing graph check proves structure, not meaning. It does not establish that
the marked reason is right, that the reader agrees or that anything was
adopted.

## Try it

`fixtures/graphmark/` is an invented community repair workshop with one note,
one drawing, one captured phone call and three marks: a table by its lines,
the whole drawing, and one sentence of the call by quote. Copy the folder,
commit it (`git init`, `git add -A`, `git commit`), then:

```sh
atelier graph --project ./atelier.project.json
atelier graph --check --project ./atelier.project.json
atelier graphmark check --project ./atelier.project.json
```

The graph builds with no diagnostics, and the check reports three marks, all
intact. Their `revision` is the placeholder `example` and their state
`recorded`, so the check also says each edition is held at `HEAD`; set each
`revision` to your full commit id and the warnings go. Commit a change to the note and the check reports the wheel
checks mark as changed, with the command that returns the marked edition.
Widen that mark's audience to `public` and the check refuses it. Point a
mark's `evidences` at an id that does not exist and the build is refused
(`declared evidences target ... was not found`). Delete the drawing and the
build is refused twice: the sidecar becomes an orphan and the drawing's mark no
longer resolves.
`test/graphmark.test.mjs` pins these behaviours.

## Limits

- The graph reads every file Git does not ignore, so a mark record can be
  built into the graph before it is committed. `atelier graphmark check`
  refuses a record that is not tracked; commit the record, rebuild, and
  confirm its id is in the built graph. A record in a Git-ignored path is not
  read at all.
- `atelier graphmark check` compares a mark's audience with the marked file's
  node, the nodes it `evidences`, and, for a file that is not a graph node, the
  repository's read boundary and the audience the file declares itself. Consent and custody (step 5) remain the agent's
  and reviewer's responsibility.
- A changed edition is a warning, not an error: the mark still names the bytes
  that were marked, and Git returns them. An edition no commit holds is an
  error.
- A history rewrite that drops the marked commit (a squash merge, a rebase or
  a force push) leaves the edition recoverable only if a reachable commit still
  holds the same bytes, and the check says so. Mark material once it is on a
  branch that is kept, and record the full commit id.
- A mark is local, Git-backed source material. It grants no export, runtime
  visibility or publication. Export audience rules apply unchanged.

## Origin

See [the standard's origin](../reference/graphmark.md#origin): the MNSTRY
GraphMark standard was created in collaboration with Brand Temple; Tiyana Ti
of Brand Temple introduced graphmark on 8 November 2026.
