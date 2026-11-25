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
answers: one Markdown file that points at exactly that part of a pinned,
recoverable edition, records who made it, who marked it, when and why, and joins it to the
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
   and exactly one part of it: the whole object, a range of lines or a quote
   that occurs once. It SHOULD select the part that was singled out rather than
   the whole object when the marker meant a part. An agent MUST NOT claim to
   have read material it was not given. If the target is unclear, it recovers
   what is available and asks only for the missing piece.
2. **The reason.** A mark MUST state why the object was marked, in the
   marker's meaning, restated plainly; `summary` carries it in a sentence or
   two and the body says it in full. Neither may be blank. If the reason was
   not given and cannot be recovered, the agent asks one question rather than
   inventing one.
3. **Provenance.** A mark MUST record who made the object (`madeBy`, including
   the work it builds on), who marked it (`markedBy`) and when (`markedOn`), and
   MUST keep source, observation, interpretation, proposal and acceptance
   distinct in its text.
4. **Custody before any write.** Before writing a capture, a mark record or an
   index entry, the agent MUST establish who owns the material and the
   repository it would be placed in, what retention the owner and the people in
   the material permit, who can actually read that repository, and what the
   reason, title, paths, quoted selector and attribution would disclose to
   those readers. Git repository access is the read boundary
   ([repo boundary guard](repo-boundary-guard.md)): `kg.audience` is projection
   metadata, so a record labelled `private` inside a team-readable repository
   is still read by the team. A request to mark is not consent to keep, share
   or send anything. When any of this is unclear, the agent writes nothing: it
   pauses and names the decision needed, or places the material in a location
   already authorized for it, such as the person's private repository
   (`readBoundary: "private"`). The placement passes the repository's boundary
   policy (`atelier boundary check --staged`) before it is committed. A mark's
   audience MUST NOT be wider than the marked material's.
5. **Capture, once custody is settled.** Material that is not yet in the
   owning repository (a passage from a conversation, a call, a file elsewhere)
   MUST be captured where custody placed it, as a source file, and committed,
   with its origin in `capturedFrom`. A mark never points at something only its
   marker can see.
6. **One record per object part.** A mark MUST point at an existing node
   rather than create another for the same object. A mark that replaces an
   earlier one MUST say so with a `supersedes` relation. Recency never makes a
   mark authoritative.
7. **A pinned, recoverable edition.** A mark MUST name its target as an exact
   source reference (below): `revision` is the full commit id (40 hex digits,
   or 64 in a SHA-256 repository) of a commit reachable from `HEAD` or from a
   branch, tag or remote branch (the stash and unreachable commits do not
   count); `objectId` is the one literal path from the Git repository root;
   and that commit MUST hold, at that path, bytes whose SHA-256 is
   `contentDigest`. A branch name, an abbreviation, bytes that happen to be at
   `HEAD` and a path from another base are hints for repairing a draft, never
   an edition. The original stays unchanged; a later change to it does not
   invalidate the mark, which still names the edition that was marked.
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
9. **Verification.** The record MUST be committed. Readers receive the
   committed tree, so the committed tree is what is verified, and a
   working-tree record that differs from the committed one is refused. The mark is reported
   only at the furthest state actually verified.

## The target

A mark's `target` is the [evidence navigation](evidence-navigation.md) exact
source reference (`evidenceRef`). The shared definition is unchanged;
`atelier-graphmark@v1` refines it in its own `graphmarkTarget` definition:

| Field | In a mark |
| --- | --- |
| `owner` | The Atelier repository name that holds the record; a mark lives with what it marks |
| `objectId` | The one literal path from the Git repository root: `/`-separated, with no leading or trailing `/`, no empty, `.` or `..` part, no `\` and nothing under `.git` |
| `revision` | The full commit id of the commit that holds the marked edition |
| `selector` | The marked part: `whole` (value `*`), `lines` (`N` or `N-M`, 1-based, inclusive) or `text-quote` (the exact text, written double-quoted), each at version `1`; no other type or version is valid |
| `contentDigest` | `sha256:` and the SHA-256 of the whole object's bytes at `revision` |

A selector names exactly one part of the edition. `whole` fits any object,
binary ones included. `lines` and `text-quote` need a text edition: valid
UTF-8 with no NUL byte. Lines are the text split at line feeds; a final line
feed ends the last line, a carriage return stays part of its line, and an
empty edition has no lines. A `text-quote` must occur exactly once, counting
overlapping occurrences; a quote that occurs more than once names nothing in
particular and is refused, so quote enough to be unique.

Reusing the shared reference means a mark can be handed to anything that reads
evidence references, and assessed for currency the same way.

## The record contract

`contracts/atelier-graphmark.v1.schema.json` pins the front matter:

| Field | Meaning |
| --- | --- |
| `title` | What was marked |
| `summary` | Why it was marked, in a sentence or two; not blank |
| `tags` | Includes `graphmark` |
| `markedBy`, `markedOn` | Who singled it out, and the day (`YYYY-MM-DD`) |
| `madeBy` | Who made it, and the work it builds on |
| `target` | The exact source reference above |
| `capturedFrom` | Optional: where captured material came from |
| `markState` | The furthest state verified (below) |
| `kg` | Knowledge graph block: `type: evidence`, the repository's audience, `evidences` and `belongs_to` |

`title`, `summary`, `markedBy` and `madeBy` must contain more than
whitespace. The `kg` block stays governed by the
[knowledge graph](knowledge-graph.md) contract; this contract only pins what
makes it a mark. The root is closed: anything the standard does not define
goes in `ext`. The contract follows [contract stability](contract-stability.md):
widening it is a new major version.

## States

| State | What has happened |
| --- | --- |
| `marked` | Someone has said "graphmark this" about a specific thing |
| `preserved` | The material is committed, and the target names its full commit id, path, part and digest |
| `recorded` | The mark record is committed in the owner's repository |
| `graph-checked` | `atelier graph --check` and `atelier graphmark check` pass, and the mark's id and edges are in the built graph |
| `shared` | The record is in a repository its intended readers can read |
| `accepted` | The material's owner has accepted the reading the mark records |

A passing check proves structure, not meaning.

## The check

`atelier graphmark check [--json] [--expect ID]... [--project PATH]` (and the
other [project options](project-options.md)) verifies what readers receive:
the committed tree at `HEAD`.

1. **The committed config.** It finds the Git repository that holds the
   project config and reads the config from its `HEAD` blob, so the config
   need not be checked out (a sparse checkout) and an unfinished edit to it
   does not matter. The config is resolved against this checkout only for
   locations: tracked paths, `--repo-path`, a local overlay or sibling
   discovery tell it where each repository is; its policy comes from the
   committed config. External repositories are dropped before resolution, so
   no sibling discovery or remote probe runs for them.
2. **The committed read policy.** The repository access file the committed
   config names is read from the committed tree of the project repository
   that holds it. One outside every project repository is refused rather than
   read from disk. One that is a link, a directory, too large or unreadable,
   or that lies under a committed link, submodule or file, is refused rather
   than replaced by defaults; only a file that is absent under plain
   committed folders leaves the defaults. A committed access file is
   validated as written, before any defaults are filled in: it must use a
   supported format (`mnstry.atelier-repo-access@v1` or
   `mnstry.repo-access@v1`), name a valid default, and give every managed
   repository a valid read boundary. The graph then reads the policy from a
   file of the snapshot's own, outside the copied tree, holding exactly those
   verified bytes, or from nowhere when the policy is absent. Before an absent
   policy leaves the defaults, the check asks this volume whether it would
   open a committed file under that name (laying down the committed names of
   each folder on the way), and refuses if it would.
3. **The committed files.** It streams the regular files committed under
   each managed repository folder into a private snapshot, with bounded
   memory and with no checkout (so no line-ending conversion or checkout
   filter applies). Symbolic links and submodules are recorded and not
   written. A path that is not valid UTF-8, a segment Git refuses, and the
   same path twice are refused before anything is written. Names are kept as
   Git's bytes, a leading U+FEFF included, and compared as bytes. Whether two
   different names are one file is not modelled but asked of the volume the
   snapshot is on, whatever its case and normalisation rules: every file is
   created exclusively, so two committed names it holds as one file are
   refused, naming both, and each committed file and folder is recorded by
   the identity (device and inode) the volume gave it. A partial clone that lacks a file there is refused.
4. **The committed graph.** It builds the knowledge graph from the snapshot,
   with no repository discovery and no remote probes (external repositories
   are not read), and records every path the graph opens there, by whatever
   rule the graph derives it (a file's sidecar, a sidecar's source, a
   folder's manifest, the folder itself). Each must be what the committed
   tree holds: a committed path must open the very file written for it, and a
   name the tree does not hold must be absent on this volume. Otherwise the
   graph took its facts from another file, and every mark is refused. A
   managed folder the tree does not hold is asked about the same way. Then it
   checks every mark against the graph.

Then, for every Markdown node tagged `graphmark` other than a marks index
(`kg.type: index`) without a `target`, it:

- refuses a record that is not committed at `HEAD`, or whose index or
  working-tree copy differs from the committed one by `git status`, which
  allows for line endings and filters; the record's fields are read from the
  committed copy;
- refuses a record that does not satisfy `atelier-graphmark@v1` (a record
  tagged `graphmark` that carries a `target` is checked even when typed as an
  index), whose body has no prose saying why, whose `evidences` does not name
  the marked file's node, or whose `belongs_to` is not a marks index; the
  standalone validator refuses the same forms, a reversed line range
  included, comparing the bounds as exact integers;
- refuses a node that belongs to a marks index but is not tagged `graphmark`,
  since it would never be checked, and, with `--expect ID` (repeatable), fails
  when the mark with that kg id is missing or is not a GraphMark record;
- refuses a target owned by another repository, an `objectId` that is not one
  literal path from the Git repository root or points into `.git`, a target
  that lies in another configured repository's folder, and a symbolic link;
- refuses an edition that is not verified: `target.revision` must be a full
  commit id, reachable from `HEAD` or a branch, tag or remote branch, that
  holds bytes with `contentDigest` at exactly `objectId`. When it is not, the
  check names what it found as a repair hint (a warning): a name or an
  abbreviation that resolves to a commit holding the bytes, `HEAD` holding
  them, a path from the repository entry's folder holding them, or
  uncommitted changes to the file. A hint never makes a mark verified;
- refuses a selector that does not name exactly one part of the edition: lines
  outside it, a quote that does not occur or occurs more than once, and a
  `lines` or `text-quote` selector on an edition that is not UTF-8 text;
- reports a file changed or removed at `HEAD` since marking, with the command
  that recovers the marked edition,
  `git -C <repository> --no-replace-objects cat-file blob <commit>:<path>`
  (also given as an argument list in `--json`), and warns when a marked quote
  has left the current file. Git's answer for a path is one of: a file,
  absent, a symbolic link, a directory, a submodule, under a link, submodule
  or file, too large (over 64 MiB), not available in this clone, or a failed
  lookup. Only absence under plain folders at `HEAD` is `removed`; every
  other answer refuses the mark, since its currency and current audience
  cannot be checked. A tagged marks index is exempt only once its committed
  record has been read and has no `target`; one that cannot be read is
  refused;
- refuses a mark whose audience is wider than any of: the audience its marked
  edition declares at the pinned commit (Markdown front matter, where
  undeclared Markdown counts as `private` as the graph treats it, or the
  sidecar committed at that commit); the marked file's node in the committed
  graph; or, for a file that is not a graph node, the committed repository
  read boundary and the audience the file declares at `HEAD`; and any node it
  `evidences`. The narrowest wins. A declared audience that is not a name, a
  name outside the six above (one a programming language happens to know
  included), a sidecar that cannot be read, and an `evidences` target that is
  not a node in the graph are errors, since the comparison would otherwise be
  skipped or wrong.

It also reads the working tree, only through `git status` and the front
matter of changed Markdown in the managed folders, classifying each changed
file's index version, each stage of an unresolved conflict, and its working
copy:

- a pending mark record (new, staged, staged and then deleted, or a tracked
  file turned into a mark) is refused;
- a pending marks index change (a new, renamed or edited index) is reported
  as a warning, and the committed index is what counts;
- uncommitted changes to a file a mark depends on (the marked file and its
  sidecar, the files behind its `evidences` nodes and its marks index) or to
  the project config or the effective access file are reported as warnings,
  naming the committed path;
- a file whose front matter cannot be read (no permission, a failed read) or
  does not end within 256 KiB, a pending Markdown file whose name is not
  UTF-8, and a `git status` that fails, make the result indeterminate: an
  error, never a success. A link or a folder in the working tree is known not
  to be a mark record. Status output is split and decoded as bytes, so names
  keep their identity.

Every mark record the committed graph holds appears in the summary and in the
`--json` `marks` list; one with any error has the state `refused`, whatever
its bytes are. When the committed graph does not build, no mark can be
verified: each record the graph could read is listed as `refused` beside the
graph's errors. When the committed tree cannot be read at all (the project
config is not committed, a repository is not under Git, a policy file cannot
be read, the tree cannot be written faithfully, `git status` fails), the check
lists no marks and reports why.

It is offline: it never fetches a missing object (it sets
`GIT_NO_LAZY_FETCH`, and in a promisor repository, recognised as Git
recognises one, by a true `remote.<name>.promisor` read with Git's own
boolean parser, a `remote.<name>.partialclonefilter` or
`extensions.partialClone`, it asks `git rev-list --missing=print` what is
absent before reading anything). It runs Git without ambient `GIT_*`
variables and ignores local replace refs. It still honours the repository's
own trusted configuration: object alternates, includes, safe-directory
ownership, and the clean filters `git status` may run. It writes nothing
outside its snapshot, which it removes when it finishes, when it fails and,
where the platform delivers them, on `SIGINT` or `SIGTERM` (re-raising the
signal afterwards). A run killed outright, and on Windows any run that is
terminated, leaves its snapshot: a directory named
`atelier-graphmark-snapshot-<pid>-…` in the system temporary folder, holding
an owner file with that process id and a random nonce. The next run removes
it once that process is gone, touching only directories with that name and a
matching owner file, and, where the platform has user ids, only those the
same user owns; on Windows the system temporary folder is already per user. The graph itself
already refuses a mark whose relations name nodes that do not exist.

Not checked mechanically: that the reason is the marker's, that custody was
settled before anything was written, that the boundary check ran on each
placement, placement in the marks folder,
`YYYY-MM-DD` naming, and that one object part has one record. Reachability is
judged from this clone's refs: it does not prove that the intended readers'
copy of the repository retains the commit. These stay the marker's and
reviewer's responsibility.

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
