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
answers: one Markdown file that points at exactly that part of a recoverable
edition, records who made it, who marked it, when and why, and joins it to the
knowledge graph as evidence, in the repository that owns the material.

The reason is the centre of the record. A mark that keeps the object but loses
why it was marked does not meet this standard.

A mark is not approval, adoption, publication, release, acceptance or a credit
claim. It is not a summary and not a link. It is not a second owner: the marked
material stays where it lives, and its owner still decides what happens to it.

## Requirements

The keywords MUST, MUST NOT and SHOULD are used in their ordinary normative
sense.

1. **The exact part.** A mark MUST name one object read through its own tool,
   and SHOULD select the part that was singled out (lines or an exact quote)
   rather than the whole object when the marker meant a part. An agent MUST NOT
   claim to have read material it was not given. If the target is unclear, it
   recovers what is available and asks only for the missing piece.
2. **The reason.** A mark MUST state why the object was marked, in the
   marker's meaning, restated plainly; `summary` carries it in a sentence or
   two and the body says it in full. If the reason was not given and cannot be
   recovered, the agent asks one question rather than inventing one.
3. **Provenance.** A mark MUST record who made the object (`madeBy`, including
   the work it builds on), who marked it (`markedBy`) and when (`markedOn`), and
   MUST keep source, observation, interpretation, proposal and acceptance
   distinct in its text.
4. **Capture first.** Material that is not yet in the owning repository (a
   passage from a conversation, a call, a file elsewhere) MUST first be
   captured there as a source file and committed, with its origin in
   `capturedFrom`. A mark never points at something only its marker can see.
5. **One record per object part.** A mark MUST point at an existing node
   rather than create another for the same object. A mark that replaces an
   earlier one MUST say so with a `supersedes` relation. Recency never makes a
   mark authoritative.
6. **Custody and audience.** The owner, the consent that covers the material
   and its audience MUST be settled before placement. A mark's audience MUST
   NOT be wider than the marked material's. Titles, paths and relations count
   as disclosure. When unsure, the mark stays `private` and the decision needed
   is named.
7. **A recoverable edition.** A mark MUST name its target as an exact source
   reference (below) whose `contentDigest` is the SHA-256 of the whole object's
   bytes, and those bytes MUST be recoverable from Git: committed at
   `target.revision`, or at least at the current commit. A fingerprint of bytes
   no commit holds preserves nothing. The original stays unchanged; a later
   change to it does not invalidate the mark, which still names the edition
   that was marked.
8. **The record.** A mark MUST be one Markdown file in the repository's marks
   folder, beside a marks index whose `kg.type` is `index`, and SHOULD be named
   `YYYY-MM-DD-short-name.md` with a matching id, so parallel markers never
   collide. Its front matter MUST satisfy `atelier-graphmark@v1`: `tags`
   includes `graphmark`, `kg.type` is `evidence`, `kg.relations.evidences`
   points at the marked node and `kg.relations.belongs_to` at the marks index.
   Other relations appear only where the evidence shows them. Open
   interpretations stay in the text, labelled as candidates, and never become
   edges. Ids follow the repository's namespace and never change. A
   non-Markdown object is reached through its sidecar.
9. **Verification.** The record MUST be tracked (the graph reads tracked files
   only), and the mark is reported only at the furthest state actually
   verified.

## The target

A mark's `target` is the [evidence navigation](evidence-navigation.md) exact
source reference (`evidenceRef`), unchanged:

| Field | In a mark |
| --- | --- |
| `owner` | The Atelier repository name that holds the record; a mark lives with what it marks |
| `objectId` | The object's path from the Git repository root (a path from the repository entry's folder is also accepted) |
| `revision` | The commit that holds the marked edition |
| `selector` | The marked part: `whole` (value `*`), `lines` (`N` or `N-M`, 1-based, inclusive) or `text-quote` (the exact text, which must occur in the edition), each at version `1` |
| `contentDigest` | `sha256:` and the SHA-256 of the whole object's bytes at `revision` |

Reusing the shared reference means a mark can be handed to anything that reads
evidence references, and assessed for currency the same way.

## The record contract

`contracts/atelier-graphmark.v1.schema.json` pins the front matter:

| Field | Meaning |
| --- | --- |
| `title` | What was marked |
| `summary` | Why it was marked, in a sentence or two |
| `tags` | Includes `graphmark` |
| `markedBy`, `markedOn` | Who singled it out, and the day (`YYYY-MM-DD`) |
| `madeBy` | Who made it, and the work it builds on |
| `target` | The exact source reference above |
| `capturedFrom` | Optional: where captured material came from |
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
| `preserved` | The material is committed, and the target names its revision, part and digest |
| `recorded` | The mark record is written in the owner's repository |
| `graph-checked` | `atelier graph --check` and `atelier graphmark check` pass, and the mark's id and edges are in the built graph |
| `shared` | The record is in a repository its intended readers can read |
| `accepted` | The material's owner has accepted the reading the mark records |

A passing check proves structure, not meaning.

## The check

`atelier graphmark check [--json] [--project PATH]` builds the knowledge graph
and then, for every Markdown node tagged `graphmark` other than the marks
index:

- refuses a record that does not satisfy `atelier-graphmark@v1`, and a target
  owned by another repository or whose `objectId` leaves the repository;
- refuses an edition that Git cannot return: bytes with `contentDigest` must be
  held at `target.revision` or at `HEAD`, and an edition that exists only in
  the working tree is refused until it is committed;
- warns when the edition is held at `HEAD` but not at the named revision;
- refuses a selector that names nothing inside the edition, and warns about a
  quote that occurs more than once;
- reports a file changed or removed since marking, with the command that
  recovers the marked edition, and warns when a marked quote has left the
  current file;
- refuses a mark whose audience is wider than the marked file's node or any
  node it `evidences`.

It is offline, reads tracked sources and Git objects, and writes nothing. The
graph itself already refuses a mark whose relations name nodes that do not
exist.

## Boundaries

- **Evidence navigation** owns the exact source reference. GraphMark uses it
  as its target and adds who, when, why and the graph placement.
- **Learning** (`atelier learn`) governs lessons that change what agents are
  given as context: observation, proposal, decision, activation. A mark does
  not activate anything. A marked passage can be cited as the evidence for a
  lesson proposal; a lesson is not recorded by marking it.
- **Claims** (`atelier-claim@v1`) carry proposed relationships. An open
  interpretation in a mark may be proposed as a claim; it does not become an
  edge by being written in a mark.
- **Relation type.** A mark uses `evidences` today. A dedicated relation for
  marking would be a knowledge graph contract revision and is not part of v1.

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
