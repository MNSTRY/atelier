# The MNSTRY GraphMark standard

Standard: `graphmark@v1`, revision 1.0.0. Record contract:
[`atelier-graphmark@v1`](../../contracts/atelier-graphmark.v1.schema.json).
Check: `atelier graphmark check`. How-to: [the GraphMark guide](../guides/graphmark.md).
Agent workflow: the bundled `atelier-graphmark` skill.

This is the normative definition. Where the guide, the skill or a repository's
own notes differ from it, this page governs and the difference is a correction
to them.

## Definition

To graphmark something is to say: this specific thing matters, keep it, and
keep why. A person singles out a passage, a table, a design, a decision, a
pattern or a phrase, and says "graphmark this". A GraphMark is the record that
answers: one Markdown file that preserves the exact edition that was singled
out, records who made it, who marked it, when and why, and joins it to the
knowledge graph as evidence, in the repository that owns the material.

The reason is the centre of the record. A mark that keeps the object but loses
why it was marked does not meet this standard.

A mark is not approval, adoption, publication, release, acceptance or a credit
claim. It is not a summary and not a link. It is not a second owner: the marked
material stays where it lives, and its owner still decides what happens to it.

## Requirements

The keywords MUST, MUST NOT and SHOULD are used in their ordinary normative
sense.

1. **The exact object.** A mark MUST name one specific object that was read
   through its own tool. An agent MUST NOT claim to have read material it was
   not given. If the target is unclear, it SHOULD recover what is available and
   ask only for the missing piece.
2. **The reason.** A mark MUST state why the object was marked, in the
   marker's meaning, restated plainly. If the reason was not given and cannot
   be recovered, the agent asks one question rather than inventing one.
3. **Provenance.** A mark MUST record who made the object (`madeBy`, including
   the work it builds on), who marked it (`markedBy`) and when (`markedOn`), and
   MUST keep source, observation, interpretation, proposal and acceptance
   distinct in its text.
4. **One record per object.** A mark MUST point at an existing node rather
   than create another for the same object. A mark that replaces an earlier one
   MUST say so with a `supersedes` relation. Recency never makes a mark
   authoritative.
5. **Custody and audience.** The owner, the consent that covers the material
   and its audience MUST be settled before placement. A mark's audience MUST
   NOT be wider than the marked material's. Titles, paths and relations count
   as disclosure. When unsure, the mark stays `private` and the decision needed
   is named.
6. **The edition.** A mark MUST record the marked file's path relative to the
   root of the Git repository that holds the record (`markedPath`; where the
   Atelier repository entry is a knowledge folder inside that repository, a
   path relative to the folder is also accepted, and the repository root is
   tried first) and the SHA-256 of its bytes at the moment of marking
   (`markedSha256`), and MUST leave the original unchanged. A later change to
   the file does not invalidate the mark: it still names the edition that was
   marked.
7. **The record.** A mark MUST be one Markdown file, numbered in order in the
   repository's marks folder, beside a marks index whose `kg.type` is `index`.
   Its front matter MUST satisfy `atelier-graphmark@v1`: `tags` includes
   `graphmark`, `kg.type` is `evidence`, `kg.relations.evidences` points at the
   marked node and `kg.relations.belongs_to` at the marks index. Other relations
   (`depends_on`, `supports`, `contradicts`, `related`) appear only where the
   evidence shows them. Open interpretations stay in the text, labelled as
   candidates, and never become edges. Ids follow the repository's namespace
   and never change. A non-Markdown object is reached through its sidecar.
8. **Verification.** The record MUST be tracked (the graph reads tracked files
   only), and the mark is reported only at the furthest state actually
   verified.

## The record contract

`contracts/atelier-graphmark.v1.schema.json` pins the front matter:

| Field | Meaning |
| --- | --- |
| `title`, `summary` | What was marked, in the record's own words |
| `tags` | Includes `graphmark` |
| `markedBy` | Who singled it out |
| `markedOn` | The day it was marked (`YYYY-MM-DD`) |
| `madeBy` | Who made it, and the work it builds on |
| `markedPath` | Repository-relative path of the marked file |
| `markedSha256` | SHA-256 of the marked bytes at the moment of marking |
| `markState` | The furthest state verified (below) |
| `kg` | Knowledge graph block: `type: evidence`, the repository's audience, `evidences` and `belongs_to` |

The `kg` block stays governed by the [knowledge graph](knowledge-graph.md)
contract; this contract only pins what makes it a mark. The root is closed:
anything the standard does not define goes in `ext`. The contract follows
[contract stability](contract-stability.md): widening it is a new major
version.

## States

| State | What has happened |
| --- | --- |
| `marked` | Someone has said "graphmark this" about a specific thing |
| `preserved` | The edition's path and digest are recorded and the original is unchanged |
| `recorded` | The mark record is written in the owner's repository |
| `graph-checked` | `atelier graph --check` and `atelier graphmark check` pass, and the mark's id and edges are in the built graph |
| `shared` | The record is in a repository its intended readers can read |
| `accepted` | The material's owner has accepted the reading the mark records |

A passing check proves structure, not meaning.

## The check

`atelier graphmark check [--json] [--project PATH]` builds the knowledge graph
and then, for every Markdown node tagged `graphmark` other than the marks
index:

- refuses a record that does not satisfy `atelier-graphmark@v1`;
- refuses a mark whose marked file is gone or whose `markedPath` leaves the
  repository;
- reports a marked file whose bytes no longer match `markedSha256` as a
  changed edition (a warning: the mark still names the edition in history);
- refuses a mark whose audience is wider than the marked file's node or any
  node it `evidences`.

It is offline, reads tracked sources through the graph, and writes nothing.
The graph itself already refuses a mark whose relations name nodes that do not
exist.

## Changing the standard

A correction or a reusable lesson from a real mark is made first in that
record, then proposed here as a new revision, with its reason, in a pull
request to this repository. Nothing changes the standard automatically.
Agents propose skill changes through Skill Steward.

## Origin

The MNSTRY GraphMark standard was created in collaboration with Brand Temple.
Tiyana Ti of Brand Temple introduced graphmark on 8 November 2026 as a way to
mark material from any conversation into a knowledge graph with its reason and
provenance. MNSTRY formalized it as this standard on 25 November 2026. It is
built on the Atelier knowledge graph, its source rules and its ontology and
phronesis foundations, developed by Erik Desrosiers for MNSTRY.
