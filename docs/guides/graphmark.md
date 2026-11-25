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

Nothing is written until step 5 has settled custody: not a capture, not a
mark record, not an index entry.

1. **Find exactly what was marked.** Resolve the selection, passage, file or
   reference, and read it through its own tool. Note the part that was meant:
   a few lines, an exact sentence, or the whole object. If the target is
   unclear, recover what is available and ask only for the missing piece.
2. **Say why it was marked.** Write the marker's reason plainly, in their
   meaning. If it was not given and cannot be recovered, ask one question.
3. **Establish provenance.** Who made it, who marked it, when, which source
   owns it, and which parts are source and which are later interpretation. If
   the work builds on someone else's, name them.
4. **Check what already exists.** Search the graph for the object and for
   earlier marks. If it is already a node, the mark points at that node rather
   than creating another. If the mark replaces an earlier one, say so with
   `supersedes`. Recency alone never makes a mark authoritative.
5. **Settle custody before writing anything.** Establish who owns the material
   and the repository it would be placed in, what retention the owner and the
   people in the material permit, who can actually read that repository, and
   what the reason, title, paths, quoted selector and attribution would tell
   those readers. Git repository access is the read boundary
   ([repo boundary guard](../reference/repo-boundary-guard.md)); `kg.audience`
   (`public`, `team`, `operator`, `staff`, `private` or `sensitive`) records
   who the material is for, and labelling a record `private` inside a
   team-readable repository does not hide it from the team. A request to mark
   is not consent to keep, share or send. If any of this is unclear, write
   nothing: pause and name the decision that is needed, or place the material
   somewhere already authorized for it, such as the person's private
   repository. A mark's audience is never wider than the marked material's.
6. **Capture, if the material is not in a repository yet.** A passage from a
   conversation, a call or a file elsewhere is captured where step 5 placed it,
   as a source file. Stage it and run the repository's boundary check
   (`atelier boundary check --staged`, or the installed hook) before
   committing it. Note where it came from for `capturedFrom`.
7. **Preserve the edition.** Make sure the marked material is committed on a
   branch that is kept, then record the target: the repository, the object's
   path from the Git repository root, the full commit id that holds it
   (`git rev-parse HEAD` right after committing it), the selector for the
   marked part, and the SHA-256 of the whole object's bytes at that commit. A
   branch name or a short id is not an edition. Choose a selector that names
   one part: a quote that occurs once, or a line range. Leave the original
   unchanged. If it changes later, the mark still names what was marked, and
   Git can return it.
8. **Write the record and join it to the graph.** Use the record shape below.
   A non-Markdown object is reached through its `<file>.kg.json` sidecar. If
   it has none, its owner adds one; for `.html`, `.pdf` and `.docx` files,
   `atelier enroll documents` writes the smallest sidecar the census accepts,
   at the `private` audience unless told otherwise. Use the existing relation
   types: `evidences` to the marked node, `belongs_to` to the marks index, and
   `depends_on`, `supports`, `contradicts` or `related` only for relationships
   the evidence shows. An open interpretation stays in the record's text,
   labelled as a candidate, and does not become an edge. Never edit a
   generated graph.
9. **Commit, build, check and read back.** Run the repository's boundary
   check on the staged record (`atelier boundary check --staged`, or the
   installed hook) and commit it: the check verifies the committed record,
   never reads the working tree, and refuses a record that is only pending;
   so commit the material and the nodes the mark depends on first.
   Then run `atelier graph`,
   `atelier graph --check` and `atelier graphmark check --expect <the mark's id>`,
   and find the mark's id and edges in the built graph. Report what was marked
   and why, where the record lives, its audience, and the furthest state
   actually reached.

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
  objectId: "content/notes/wheel-checks.md"
  revision: "<the full commit id that holds the edition>"
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

`target` is the shared exact source reference from evidence navigation, with
a full commit id and the path from the Git repository root. The selector is
`whole` (value `*`), `lines` (`N` or `N-M`) or `text-quote` (an exact sentence
that occurs once). A `lines` or `text-quote` selector needs a UTF-8 text file;
mark a binary file whole. Captured material adds `capturedFrom`.

The body says, in plain sentences: what was marked, why, its provenance, what
the mark does not do, and any open interpretation labelled as a candidate. The
summary and the body must both say why; the check refuses either when blank.

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
| `preserved` | The material is committed, and the target names its full commit id, path, part and digest |
| `recorded` | The mark record is committed in the owner's repository |
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
atelier graph --project .
atelier graph --check --project .
atelier graphmark check --project .
```

The graph builds with no diagnostics. The check refuses all three marks: their
`revision` is the placeholder `0000000000000000000000000000000000000000`,
which names no commit, and for each one it gives a repair hint that `HEAD`
holds the marked bytes, with its full commit id. Set each `revision` to that
id, commit, and the check reports three marks, all intact. Commit a change to
the note and the check reports the wheel checks mark as changed, with the
command that returns the marked edition. Widen that mark's audience to
`public` and the check refuses it. Point a mark's `evidences` at an id that
does not exist and the build is refused
(`declared evidences target ... was not found`). Delete the drawing and the
build is refused twice: the sidecar becomes an orphan and the drawing's mark no
longer resolves. `test/graphmark.test.mjs` pins these behaviours.

## Limits

- `atelier graphmark check` verifies the committed tree at `HEAD`, not the
  working tree: it reads the project config, the read policy and the
  committed files from Git objects alone and builds the graph from them,
  copying nothing to disk and opening no working-tree file, so an
  uncommitted edit can neither pass nor fail a mark, a sparse checkout works,
  and the result does not depend on the host's filesystem. What is pending
  comes from `git status` alone: a pending change to Markdown in a folder
  that holds marks, and a staged mark record anywhere, are refused (commit
  them to verify); new Markdown elsewhere and uncommitted changes to what a
  mark depends on are warnings. A failed `git status` makes the result
  indeterminate. A record in a Git-ignored path
  is not read at all. Use `--expect <id>` so a mark that went missing fails
  the check instead of disappearing from the count. A mark with any error is
  reported as `refused`.
- The check verifies the mark records the knowledge graph counts. Each
  repository keeps its path from the project config's folder, so the
  project's census scope (`setup.include`, `setup.exclude`) selects what it
  selects in a checkout. A committed mark record the scope leaves out is
  named in a warning and not checked; when the census holds no mark record
  but the committed tree holds some outside it, the check fails. A repository
  inside another one's folder is read as its own repository only.
- `atelier graphmark check` compares a mark's audience with the audience the
  marked edition declared at its commit, the marked file's committed node or,
  for a file that is not a graph node, the committed read boundary and what
  the file declares at `HEAD`, and the nodes it `evidences`. Custody (step 5)
  remains the agent's and reviewer's responsibility.
- A changed edition is a warning, not an error: the mark still names the bytes
  that were marked, and Git returns them with the printed command, which reads
  Git as the check does (`--no-replace-objects`). An edition the named commit
  does not hold is an error.
- A history rewrite that drops the marked commit (a squash merge, a rebase or
  a force push) leaves the mark unverified, even when a kept commit holds the
  same bytes; the check names such a commit as a repair hint. Mark material
  once it is on a branch that is kept, and record the full commit id.
  Reachability is judged from your clone's refs, which does not prove that
  every reader's copy keeps the commit.
- A mark is local, Git-backed source material. It grants no export, runtime
  visibility or publication. Export audience rules apply unchanged.

## Origin

See [the standard's origin](../reference/graphmark.md#origin): the MNSTRY
GraphMark standard was created in collaboration with Brand Temple; Tiyana Ti
of Brand Temple introduced graphmark on 8 November 2026.
