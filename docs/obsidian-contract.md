# Obsidian projection contract

This document freezes what later work receives from the contract and
feasibility track. It states what is proven, on what, and what is not. Nothing
here enables a feature. The publisher under
`src/projection/obsidian/publication/` is called by the maintenance service
(`atelier obsidian service start`) and so by `atelier obsidian open`; see
[obsidian.md](obsidian.md).

## Registered shapes

Eleven closed v1 schemas, `contracts/atelier-obsidian-<shape>.v1.schema.json`,
and one v2 schema, `contracts/atelier-obsidian-generation-manifest.v2.schema.json`,
are registered in `src/contracts/corpus.mjs` with valid and invalid fixtures
under `fixtures/obsidian/contracts/<shape>/` (the v2 manifest under
`generation-manifest-v2/`). `src/projection/obsidian/contracts.mjs` validates
them and adds the refusals a schema cannot express; a generation manifest is
validated against the version its `schema` names.

| Shape | Portable | Purpose |
| --- | --- | --- |
| `corpus-profile` | yes | Workspace and repository identities, enrollment, audience |
| `scope` | yes | Mode and selector set-AST; an empty selection is valid and empty |
| `source-snapshot` | yes | Raw byte digests, graph pin, dirty state, single consistent read |
| `generation-manifest` | yes | Path map, byte regions, link inversion map, completeness. v1 is vault layout 1; v2 is layout 2 (see "Vault layout") |
| `publication-journal` | no | Conditional operations, partial transition, restart; protocol ID required |
| `service-state` | no | Literal loopback, port, runtime ID, PID, executable, consent |
| `edit-operation` | yes | Object identity, origin generation, base digest, idempotency key |
| `apply-policy` | no | `manual` or `automatic`; only `body-replacement` is an accepted edit class |
| `proposal-receipt` | yes | Repository-scoped store, adapter operation identity, dedupe outcome |
| `acceptance-receipt` | yes | Candidate identity, environment versions, evidence hashes, outcome |
| `ext-settings` | yes | The object under `ext["mnstry.atelier.obsidian"]` |

Portable shapes refuse absolute paths. `atelier-project-config.v1` is
unchanged: extension settings are validated by their own schema, and an
unknown extension key refuses in the adapter, not in the project validator.

## Selection

`selectScope({ canonicalSnapshot, profile, selector, expansion })` is the only
runtime entry point. Visibility fails closed: a node is selectable only when it
is explicitly eligible, its repository is enrolled and its audience is allowed.
Edges to a withheld endpoint are dropped. Absent and withheld identities are
reported together. Expansion requires an explicit depth and node budget,
proceeds in canonical-identity order and reports truncation. Relation types are
`related`, `supports`, `supersedes`, `implements`, `depends_on`, `evidences`,
`contradicts`, `belongs_to` and the derived `links_to`. Literal oracles and
refusals live in `fixtures/obsidian/contracts/oracles/scope-cases.json`.

### What redaction covers

The guarantee: Atelier never generates a reference to a note outside the
view. No link, embed or relation row the emitter writes targets one, no
identity block names one, and no folder name or collision qualifier is
derived from one; manifest entries and link inversions carry nothing about
one either.

Text that comes from an author is carried as authored. Emission is
byte-faithful: a visible author's bytes are emitted unchanged, so a visible
author's own references to withheld or out-of-selection documents (canonical
identities in front matter, repository-relative paths, link text) appear in
the vault exactly as written. Generated regions repeat author text as well:
the titles of in-view notes in relation rows, and a wrapped file's title,
summary and tags in its note. That text is carried as its authors wrote it
too, escaped for Markdown or, in file names and link aliases, with the
characters those cannot hold turned into spaces. A scoped vault is not a
confidentiality boundary against what visible authors wrote (owner decision,
2026-09-22). A redaction boundary over authored bytes cannot coexist with
byte-faithful emission; it would be a separate mode with its own evidence.
The deny-list below is defence in depth over the author text that generated
regions repeat, not the guarantee.

A layout 2 vault shows, in its folder names, the repository identity and the
source directories of the notes in the view; layout 1 showed neither. A
folder exists only because a note of the view is in it.

Each note may carry the generated line `Relationships leading outside this
view: N`. N counts that note's relationships to notes that are visible but not
selected, so it reveals that count, and two views of one workspace can be
compared. It never counts a withheld node: edges to a withheld endpoint are
dropped before the count is taken.

A qualified file name (see "Collisions") can show that another name is, or
was, allocated in the same folder of this workspace; it names nothing about
that other note. Allocation runs over visible nodes only, so a node that was
never visible on this machine never causes a qualifier. A path once allocated
stays reserved, also when its node is later withheld: that is what keeps
every path stable.

### The redaction guard

Before anything is returned, `prepareView` checks the whole result, every
note included, whether it was emitted on this call or reused from the
preparation cache. Any failure refuses the view with `redaction-failure` and
no detail. Three rules, in the vault layout the view is prepared in:

1. Allow-list. Every path the emitter wrote must be a path allocated to this
   view: every note and attachment path of the manifest, every rewritten link
   or embed target (the bytes an inversion emitted must be such a path, as it
   is or percent-encoded the way the emitter encodes it; the words an
   author's wikilink keeps after `|` are the author's), every attachment an
   embed names, and every `[[…]]` or `![[…]]` target in a generated region,
   without its `#` fragment or `|` alias (relation rows, a wrapper's link and
   embed of its file). The identity block of each note must name exactly that
   note's own repository, identity and source path, and nothing else may
   appear in it.
2. Deny-list, defence in depth. The free text of the generated regions (the
   titles in relation rows, a wrapper's title, summary and tags), the link
   targets excluded and read as a reader sees it, with the backslashes the
   emitter adds to escape Markdown removed, must not contain, as a whole
   token, the canonical identity, the
   repository-qualified source path (`<repository>/<path>`) or the allocated
   vault path of any census node or embedded asset outside this view:
   withheld, outside the selection, or an asset the view does not copy. A
   match is a whole token when no letter or digit is beside it, and no one of
   `. _ : / -` joined to a letter or digit (a full stop that ends a sentence
   is beside a whole token; `x.north-desk:a` is one longer token); it is
   compared exactly, case included. A repository-relative path alone is not an
   identity (every repository may hold a `README.md`), so it is not denied on
   its own; the identity block, which is the one place a note names its own
   repository-relative path, is held to rule 1 instead.
3. Coverage. Rules 1 and 2 run over every note of the view on every
   preparation; a reused note is judged exactly as an emitted one.

What an author wrote inside the authored body or front matter of an in-view
note (a withheld node's canonical identity in a relation list, a link to its
path) is authored bytes: it is emitted as written and never triggers the
guard. When the same words reach generated prose unchanged, as an incoming
relation row repeats an in-view title or a wrapper repeats its summary, rule 2
refuses the view. Where they reach generated text only in a form made safe for
a name, the outgoing relation row's alias and every file name, `:` and `/`
have become spaces; that form is the author's text carried as authored, and
rule 2 does not match it: there is no fuzzy matching. Canonical identities
are matched exactly, so an identity that is an ordinary word refuses a view
whose generated prose uses that word as a whole token; Atelier's own
identities are repository-qualified (`<repository>:<name>`). The matcher reads
each word of a text once, with a few lookups, however many values it denies.

In layout 1 the guard additionally refuses any `--<hex>` identity suffix of a
census identity outside the view, anywhere in generated text or emitted paths,
as the earlier release did. `test/obsidian-materialization.test.mjs` carries a
mutation control per rule: with that rule removed, a view that breaks it is
accepted.

## Vault layout

A prepared view lays its files out in layout 2: the file name is the title a
person reads, the folders are the repository's own folders, and the identity a
machine needs is written into the note, not into its name. Obsidian shows a
file name as the note's title in the file explorer, tabs, the graph, search and
link completion, so the file name is the human title. The generation manifest
records the layout (`layoutVersion: 2`, in
`atelier-obsidian-generation-manifest/v2`) and keeps the path of every note and
attachment beside its identity, as before. Layout 1
(`notes/<readable title>--<identity suffix>.md`, flat, with attachments under
`attachments/`) is what releases up to 0.2.0-alpha.11 wrote; see "Upgrade from
layout 1".

### Folders

A note lives at `<repository folder>/<source directory>/<file name>`.
`<source directory>` is the directory of its source relative to its repository
root, segment by segment, and `<repository folder>` is the repository's
identity (`repoId`); each segment is made safe as a name (below). Nothing is
stripped or shared across repositories: a vault of several repositories has
one top-level folder per repository. No part of a path depends on a property
of the whole census, such as a prefix every path shares, so adding or removing
a file never moves another.

Two folders whose names differ only in case or Unicode normalization are one
folder on a case-insensitive file system (APFS, NTFS), with one spelling. The
first allocation of a folder fixes its spelling, and a later note whose folder
differs from it only that way takes the existing spelling: every path of a
vault spells each folder one way, so the app reports each note under exactly
the path the manifest records, which is how the publisher finds the note's
open editors. Two repositories whose folder names would collide that way are
told apart: the one allocated later gets ` (<id>)`, the first 6 hexadecimal
characters of the SHA-256 of its identity.

### File names

The name of a note is:

- for a Markdown source, its canonical title, the one the graph read: the
  front-matter `title`, else the first H1, with the author's casing and
  spacing. A title that ends in the source's own extension
  (`07-tide-survey-brief.md`) loses that extension. When the graph's title
  is exactly the title-cased file name, the graph's fallback, the title came
  from the file name or equals it, and the file stem is used as written
  (`getting-started`, not `Getting Started`). The rule reads the node record
  only, so every allocation, and a selection resolved without the sources,
  gives the same name. The record does not say where its title came from, so
  an author heading that is exactly the title-cased file name (`# Getting
  Started` in `getting-started.md`) names the note by its stem as well.
- for any other source, a wrapped file, the file name itself: the note is
  `<file name>.md` (`depth-chart.pdf.md`) and the file keeps its own name
  (`depth-chart.pdf`) in the same folder. The pairing is visible, a search
  for the file finds both, and the file's own title (from its sidecar or
  `<title>`) is the first heading of the note.

Every name and folder segment is made safe for macOS, Linux, Windows and
Obsidian links:

1. It is NFC-normalized.
2. Control characters (C0, C1, U+2028 and U+2029) and
   `/ \ : * ? " < > | # ^ [ ]` become a space; bidirectional embedding,
   override and isolate controls and U+FEFF are removed.
3. Runs of spaces become one space, and leading and trailing spaces and dots
   are removed: a leading dot hides a file from the app, and Windows allows no
   trailing dot or space.
4. It is cut to 150 bytes of UTF-8 (a folder segment to 120, a wrapped file's
   stem so that its extension still fits), on a character boundary; a
   combining character, zero-width joiner or variation selector left at the end by
   the cut is removed.
5. A Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`,
   `LPT0` to `LPT9`, `COM¹` to `COM³`, `LPT¹` to `LPT³`, `CONIN$`, `CONOUT$`),
   compared case-insensitively on the part before the first dot, gets a `_`
   in front.
6. A name left empty is the file stem, made safe the same way, else
   `Untitled`; a folder segment left empty is `_`.

A path longer than the file system allows (255 bytes a name, and
`maxFullPathBytes`, 1024 by default, with the vault root) is shortened by
cutting the title part further, never below 16 bytes; a path that still does
not fit refuses `path-too-long`.

### Collisions

Names are compared the way a case-insensitive, normalization-insensitive file
system compares them (`collisionKey`: NFKC, case-folded), across every file of
the vault: notes, wrapped files and embedded assets. When two would share a
name in one folder, the one allocated later is qualified:

1. `<name> (<source file stem>).md`, the stem made safe and cut to 60 bytes;
2. when that is taken too, `<name> (<stem>) (<id>).md`, where `<id>` is the
   first 6 hexadecimal characters of the SHA-256 of the repository identity
   and the node identity, lengthened two at a time, up to 16, until it is
   free.

A wrapped file's name is already its file name, so it is qualified by the
identity alone, before its extension: `depth-chart (1a2b3c).pdf` and
`depth-chart (1a2b3c).pdf.md`. An embedded asset is qualified the same way.
A name that collides with nothing carries no qualifier and no hash.

Allocation runs in canonical identity order (repository, then node) over every
visible node of the workspace, then every visible embedded asset, and an
existing allocation is never changed: a newcomer that collides takes the
qualifier. The same census and registry give the same paths in whatever order
the census lists them.

### Stability

The persistent path registry allocates each path once per workspace and every
view and generation reuses it; it is machine-private state, and when it is
lost the prior manifest seeds it. A retitled source keeps its path: the note
shows the new title in its heading and every relation row that names it shows
it too. A source deleted and added again keeps its allocated path. Renaming
on retitle arrives with the in-vault plugin, which can use Obsidian's own
rename so that the app's bookmarks, open tabs, graph layout and links follow;
a rename made by a program outside the app would break all of them.

### Identity in the note

Every note names its identity in three generated properties that Obsidian
shows (Properties, Bases, search) and any YAML reader or agent can read
without the manifest:

```yaml
atelier-id: "north-desk:harbor-plan"
atelier-repo: "north-desk"
atelier-source: "plans/harbor-plan.md"
```

`atelier-id` is the canonical node identity, `atelier-repo` the repository
identity and `atelier-source` the repository-relative source path, each a
JSON string. They are the last lines of the note's front matter, directly
before its closing delimiter, when the source's front matter is a plain block
mapping at column 0 that does not already use one of the three keys. A source
without front matter gets a generated front matter holding only them (after a
byte order prefix, which the app does not read). Any other front matter (a flow
mapping, an indented or sequence root, a document marker, a repeated key)
could change meaning with a line added, so for those sources the lines go
into a generated `%%` comment block at the very end of the note instead, the
last generated region. The line ending is the source's.

The source digest is not written into the note. Once a person's edit is
applied, the source has a new digest, and the hold on the edited note lifts
only when the note prepared from the new source is byte for byte the note the
person edited; a digest in the note would keep it held forever. The digest of
every generation is in the manifest
(`notes[].ext["mnstry.atelier.obsidian"].source.rawDigest`).

The block is generated. The manifest records its bytes as `regions.identity`,
inverting a note removes them, and the edit lens never attributes them to the
author. An edit to them is a front-matter edit, which is never applied to a
source: it becomes a semantic proposal (see "Proposal adapter for structural
edits"). In the end-of-note placement it is a generated-region edit and
refuses.

### Links

A rewritten link or embed, a relation row and a wrapper's link to its file
name the target by its full vault path:
`[[north-desk/plans/Harbor plan.md|the plan]]`,
`[tide table](south-desk/tables/Tide%20table.md#spring)`,
`![[east-desk/pages/img/gauge.png|200]]`. A wikilink carries `.md`, so a note
named after a file never resolves to the file. Obsidian's resolver
(`MetadataCache.getLinkpathDest`, read in the 1.13.7 application bundle) looks
a path that contains a folder up as an exact vault path before it tries any
suffix or file-name match, so the target is exactly the allocated file,
whatever folder the linking note is in. A wikilink rewrite keeps the words the
author chose by appending `|<what the author wrote>`, as before.

### Upgrade from layout 1

A view whose prior generation is in layout 1 is laid out again once, in one
generation:

1. `prepareView` allocates layout 2 paths for every note and asset. The
   layout 1 entries of the persistent registry are dropped, and the registry
   records `layout: 2`. The generation is an
   `atelier-obsidian-generation-manifest/v2`, and `changes.removed` names
   every layout 1 path.
2. The publisher retires each layout 1 path with its ordinary remove unit. A
   note or file that still holds its published bytes is moved to the recovery
   area with a receipt; a note somebody edited is never removed: it stays
   where it is and is surfaced as a retained edit. Nothing is deleted.
3. While a note of the view has an open edit, the view is not laid out again.
   The engine passes the paths of held notes (`heldNotePaths`), and
   `prepareView` prepares a view whose prior generation is in layout 1 and
   holds one of them in layout 1, exactly as the earlier release did, a new
   note included (`notes/<title>--<suffix>.md`). A held note therefore stays
   under its layout 1 path and is held, applied and withdrawn by the rules it
   was held under. The first preparation with no held note of the view lays
   it out again.
4. An edit made on a layout 1 note can be applied after the upgrade: apply
   and the proposal adapter prepare the generation the edit was made on in
   that generation's own layout (`layout`) to recover the note as it was
   published.

The folders `notes/` and `attachments/` are left behind empty: the publisher
moves files, never folders, and a person may delete them. While a view waits
for a held note, a selection resolved from the registry names layout 2 paths
that the vault does not hold yet.

In automatic mode a policy may apply a held edit in the very tick that lays
the view out again: the edit is then closed as applied before the view is
prepared, nothing holds the layout, and the note the person edited is not
removed (it differs from what was published) but kept at its layout 1 path
and surfaced as a retained edit. Its text is in the source and in the laid
out note; nothing is lost, and the person may delete the copy. In manual mode
the hold lifts first, the note is published over nothing, and it is then
retired to recovery like any other.

## Graph behaviour changes since the shared link resolver

The resolver that produces `links_to` edges changed in these ways, each pinned by a
test in `test/graph-knowledge-graph.test.mjs`. Repository artifacts committed by a
consumer may differ after upgrading in exactly these classes and no others:

1. Links inside fenced code (backtick or tilde, any info string, up to three
   spaces of indent, CRLF, CommonMark fence-length rules), inside inline code
   (including two stray backticks that happen to pair across a link) and inside
   front matter no longer produce edges. Links after an unbalanced fence that
   runs to the end of the file are inside code.
2. A link to a directory resolves to that directory's `README.md`, then
   `index.md`, testing eligibility per candidate; a link to a parent directory
   now resolves where the earlier reader missed it.
3. A link that climbs above its own repository root and re-enters through the
   checkout's directory name is reported as leaving the enrolled roots, as it
   always was; it is never turned into a repository-local edge.
4. Malformed percent-encoding in a link is a `link-href-malformed` finding;
   it no longer throws out of the graph build.
5. The workspace graph (not repository artifacts) additionally carries
   wikilink edges and cross-repository Markdown-link edges, de-duplicated.

## Embedded assets

An embed (`![](file)` or `![[file]]`) whose target is not a document of the
census resolves in the canonical graph, never in the emitter. The resolver
reports `embeds` beside `links`: one `embeds_asset` record per occurrence, with
the same UTF-16 and byte offsets, naming an asset
`{ id, repo, path, extension }` whose id is `<repository>:asset:<path>`.
`buildCanonicalGraph` returns `embeds` and the de-duplicated `assets`. Neither
is a node or an edge: committed graph artifacts and `markdownLinkEdges` are
byte-identical with and without assets.

An asset is a regular file inside an enrolled repository root. A link on disk,
a file reached through one, a git-ignored path, anything inside `.git`, a
Markdown file and a census node are never assets. Markdown embeds resolve by
relative path like links. A wikilink embed whose target contains `/` resolves
by repository-relative path, in the source's repository first and then as
`<repository>/<path>`; a bare file name resolves by basename across enrolled
repositories and refuses as `link-target-ambiguous` when more than one file
matches. `isAssetEligible({ repo, path })` fails closed and is asked per
candidate before choosing: a refused asset is reported exactly as an absent
one (`link-target-unresolved`), so a finding never confirms that a withheld
file exists.

Behaviour change: an embed that resolves to an asset no longer produces a
`link-target-unresolved` finding. No other finding changes.

In a view, an asset is copied only when the embedding note is in the vault
set, the asset record carries `eligible: true` (`withEligibility` takes a
second predicate; without it every asset is withheld) and the profile enrols
its repository under the same audience rule as a node without an audience of
its own. It is copied once, byte for byte, to its own path mirrored in the
vault (`<repository folder>/<source directory>/<file name>`, allocated like a
note; see "Vault layout"; in layout 1,
`attachments/<readable stem>--<identity suffix>.<ext>`), read through the
pinned snapshot (`source-not-in-snapshot`, `mixed-read`). The embed target is
rewritten through the link inversion machinery: a Markdown embed to the
percent-encoded vault-root path, a wikilink embed to the plain path with its
size or fragment left as authored and no alias added. The manifest lists the
copy in `attachments[]` with
`ext["mnstry.atelier.obsidian"] = { kind: "embedded-asset", repoId, assetPath }`
and records the inversions on the embedding note at
`notes[].ext["mnstry.atelier.obsidian"].assetEmbeds = [{ attachment, inversions }]`,
in the shape of link inversions. A withheld or out-of-selection asset leaves
the authored embed untouched and appears in no output, manifest entry or
diagnostic.

## Unclosed code fence at the end of a source

An authored Markdown body that ends inside a fenced code block would turn any
generated section after it into code. When, and only when, a generated section
follows such a body, the emitter writes a closing fence as the first bytes of
the first generated region. The fence is generated, not authored: it lies
inside that region's range, so authored ranges and inversion stay exact. It
repeats the opener's indentation (0 to 3 spaces), character and length, starts
on its own line (a line break is added first when the body has none) and uses
the source's line ending, CRLF or LF. The region records it as
`ext["mnstry.atelier.obsidian"].fenceClosure = { fence, byteLength }`, where
`fence` is the emitted fence line without its line ending and `byteLength`
counts every closure byte, line breaks included. The view is not refused; its
diagnostics carry `unclosed-code-fence-closed-in-generated-region`. With no
generated section, nothing is emitted and nothing is reported.

Fence detection is the canonical graph scanner's: `unclosedFenceAtEnd` in
`src/graph/knowledge-graph.mjs` shares the rules that decide which text is
scanned for links. Front matter is never read for fences.

## Incremental preparation

A maintenance tick rebuilds the canonical graph and prepares the whole view.
Both stages accept a cache that makes repeated runs proportional to what
changed, without changing a single emitted byte. Each cache is derived,
in-memory, droppable state: it is never written anywhere, a dropped cache
costs a full build or preparation, and the result is by construction the one
a run with no cache produces. `test/obsidian-incremental.test.mjs` proves the
equality over the materialization fixture under both scopes and over random
change sequences (edits, retitles, relations, links, added and removed notes,
eligibility and scope changes), and shows with mutation controls that the
oracle sees a wrong cached byte, entry, inversion, node or scan.

Graph stage: `buildKnowledgeGraph` / `buildCanonicalGraph` take `fileCache`
(`createGraphFileCache`) and, optionally, `observedDigest`. A census node and
link scan are reused only under an equal sha256 of the bytes and equal
per-file inputs outside the bytes (coverage and the repository's read
boundary), and the cache is rebuilt to hold exactly the current census.
Without `observedDigest` every Markdown source is read and hashed on every
build. The maintenance engine passes `observedDigest` from its observation
index, and a source whose observed digest equals the cached one is then not
opened: the bound is observation's own, a stat hint between full
reconciliations, so bytes that change under an unchanged stat hint are not
seen by the graph, the snapshot or the view until observation hashes the file
again. The result reports `fileCensus: { reused, derived, read }`.

Preparation stage: `prepareView` takes `cache` (`createPreparationCache`).
Each note's bytes and manifest entry are a function of the vault layout and
emitter version, its pinned source digest, node record (repository, identity
and source path, which also make its identity block), allocated path (which
also names a wrapped file), generated rows (which carry the paths and titles
of their targets), outside-selection count and rewritten occurrences with
their emitted targets; those inputs form a dependency key, and a note whose
key equals the cached one reuses the cached bytes, manifest entry, attachment
record and inversions. Where the identity block goes and with which line
ending is decided from the source bytes, which the pinned digest covers.
Everything else (asset copies, links, settings, collision checks, the
manifest and the redaction guard over the whole result) runs as before. The
result reports
`preparation: { emitted, reused }`, and a preparation that emits exactly the
notes whose output changed is what the tests pin.

One bound is stated rather than hidden: a reused note's source is not read
again, so bytes that drift under an unchanged pinned digest are not seen by
`mixed-read` on that call. The emitted note is exactly the one the pin
describes, and the next observation by digest sees the drift. A note whose pin
changed is read and verified against the pin as always.

The engine holds one graph file cache and one preparation cache per scope for
its lifetime and hands them through the `createGraphCache` and
`createPreparationCache` production seams; a test replaces either with
`() => null` to build or prepare in full.

## Publication protocol `obsidian-cli-critical-section/v1`

The journal's `protocolId` names this protocol. A publisher may use it only
within the proven boundary below.

1. Stage the candidate on the vault's volume and bind it by SHA-256. A
   candidate that replaces an existing file is staged in that file's unit
   recovery directory (see "Where candidates are staged").
2. Inside the app, in one synchronous step: refuse if any editor of the note in
   any window is unsaved or differs from the expected base; refuse if the bytes
   on disk differ from the expected base; refuse a staged file whose digest
   differs; atomically exchange the staged candidate with the note, so
   whatever occupied the path becomes the recovery file; update every open
   editor in one transaction and record the view as saved with that content.
   The app must not write the note as a result of publication.
3. Reply immediately. Record the outcome in the app. A caller whose reply is
   lost re-reads the outcome and never resends.
4. Re-check the recovery file after a quiet period: a program that held the
   note open before the exchange writes into it.
5. Commit the trusted manifest last. Until then the transition is reported as
   updating. A view converges to one verified generation; atomic visibility
   across notes is not claimed.

A refusal is always an acceptable outcome. A note being edited stays one
generation behind until its editor is clean.

### Where candidates are staged

The exchange in step 2 leaves the displaced bytes at the candidate's path until
they are moved to their recovery name. Those bytes may be a person's only copy,
and `staging/` is classed discardable, so that path is never in `staging/`.
This is a layout inside the private store; the protocol is unchanged.

| Bytes | Path |
| --- | --- |
| Any candidate while it is written and fsynced (generated bytes only) | `staging/<journalId>/NNNNNN.candidate`, or `NNNNNN.late.candidate` for one that could not be known when the run began |
| Candidate of a file that is created (exclusive link, no exchange) | stays at that staging path until it is linked |
| Candidate of a file that is replaced (note, attachment, policy settings) | moved, complete, to `recovery/<journalId>/<unit>/exchange.candidate`, or `exchange.late.candidate` |
| Displaced bytes | the vault path, then that same candidate path, then `recovery/<journalId>/<unit>/displaced.bin` |

The journal names every exchange candidate, by path and SHA-256, before the
file is at that path: in the header for candidates known when the run began, in
a write-ahead entry for a late one. A file at a candidate path whose digest is
the recorded one is a generated candidate and may be deleted; any other file
there is displaced bytes and is moved to its recovery name with a receipt,
never deleted. Restart recovery decides only this way. The candidate names end
in `.candidate`; every other name in a unit directory ends in `.bin` or
`.json`. The same-volume check covers staging and recovery, and the exchange
self-test runs inside the recovery area, in `recovery/.exchange-probe/`.

### One publisher per vault

A publication holds two locks: the view's, in its private state, and the
vault's. Two views, or two sets of workspace state, that point at one vault
share nothing but the vault, so the vault lock lives under the vault's real
path in `.atelier-publication/`, a dot-directory that no note path can name
and that the app does not show. The second publisher refuses with
`publication-in-progress` and writes nothing. It is the only thing the
publisher writes in a vault besides notes, attachments and the policy
settings file.

Release and recovery follow the view lock exactly. A finished publication
writes a release marker. A publisher that dies leaves a ticket naming its
process; the next publisher on the same host sees that the process is gone and
takes the lock over, so a crash does not wedge the vault. Superseded tickets
are removed while the lock is held. Two cases refuse until a person acts: a
ticket written on another host (a vault reached through a shared or
synchronized folder), and an unrelated live process that reuses the dead
publisher's process ID, which clears when that process exits. When no
publisher is running anywhere, deleting `.atelier-publication/` is safe.

### The path with no app

When the process table shows, positively, that no Obsidian runs, the same
critical section runs in the publisher's own process with no editor to
coordinate with. The table is read at path selection, again immediately before
the first note whatever time has passed, and again whenever two seconds have
passed since the last reading. Once a reading is anything other than absent,
every remaining note that would be written refuses.

Residual window, stated plainly: an app that starts after a reading and before
the next is not seen, for at most two seconds plus one note's publication. In
that window a note is exchanged with no editor check. Bytes saved to disk are
still protected by the on-disk comparison and the exchange. An unsaved buffer
in the newly started app is not: the app then takes its own
external-modification merge, which can drop overlapping edits. The probe also
cannot see an app on another machine that reaches the vault through a shared
or synchronized folder, or an app packaged under another executable name. It
recognises the app by the executable a process runs (`ps -A -o comm=`, or
`pid=,comm=` on Linux), never
by its arguments; on Linux a system Electron process, which does not say which
app it hosts, makes the reading unknown rather than absent, and a process whose
name is not recognised is identified by the executable `/proc/<pid>/exe`
resolves to. A `ps` that does not answer within five seconds is unknown.
Before 0.2.0-alpha.10 no production reading was ever absent, because the probe
found Atelier's own service; from that release this path, and this window, are
live.

### Proven boundary

macOS (Darwin 25, arm64) with Obsidian 1.13.7 (installer 1.12.7), CLI enabled,
no community plugin. Sixteen interleavings, 25 rounds for each racing case, in
four complete clean runs of the prototype in `experiments/obsidian-publication/`
at commits `34f5fab` and `c5142e7`. The receipts record those same trees under their
pre-sign-off identities `5930f85` and `93303ff`; the branch was rewritten only to add
sign-off trailers, with identical content. Receipt SHA-256 digests:

- `379992a6cc0e6c95581459412e8cab68d9b260a631fa891089613f120b40a67a`
- `63a5b69b203125b6099f2398d1ebddd0e4f3265a0401becbddff5e6d72fee16e`
- `95995051859e02042d648d1a0b513d86fa9f1d72d82359030e21858cdba5d959`
- `0984c35087ff91c0cc0d0f37f533eea1fc6c6380705491362eec98368f64fe01`

A fifth run aborted because the harness could not open a note after the
second-window case; no bytes were involved. The receipts are maintainer-held
and are not part of this repository.

### Receiving obligations for the production publisher

The publisher may not claim the protocol outside the proven boundary until
each open item is discharged with its own evidence.

| Obligation | State |
| --- | --- |
| Atomic exchange without the system Python | Done. The system Python is gone. The exchange is a raw syscall (`renameatx_np` with `RENAME_SWAP` on macOS, `renameat2` with `RENAME_EXCHANGE` on Linux) reached through the system perl, with no perl module, compiler or package dependency. |
| Interpreter trust | Done. The perl binary is used only when uid 0 owns it and neither group nor others can write it, in the publisher and in the script the app runs; otherwise `exchange-interpreter-untrusted`. An interpreter is still a dependency, and the exchange still costs a process start inside the critical section. |
| Exit status of the exchange helper | Done. The critical section reads the staged path after the call and decides from the bytes whether the exchange took place; a helper killed after the call returned no longer reads as a failure. |
| Linux | Partly open. The exchange primitive is proven in a container on aarch64. The app suite (the interleavings above) has not been run on Linux. |
| x86_64 | Open. Never run, on macOS or Linux; the syscall numbers are present and untested. |
| Windows | Refuses. No direct equivalent is known; the publisher refuses with `exchange-unsupported-platform` and publishes nothing. |
| App capability floor | Partly open. The step that prevents an app write sets the view's undocumented `lastSavedData`; open notes refuse when it is absent. The floor is pinned: `MINIMUM_APP_VERSION` in `src/runtime/obsidian/app-capability.mjs` is 1.13.7, the only version the protocol was proven on, and an older, unreadable or unknown version is refused as `app-version-unsupported`. There is no ceiling: a newer app is admitted, and the cases must be re-run on each app release. |
| Late-writer re-check | Partly open. The publisher re-checks displaced files twice per publication (on the blocking path, and after the quiet period). A holder can write later still, so the check must be repeated by the future maintenance service; carried to the maintenance track. |
| Displaced bytes between exchange and recovery move | Done, by the maintenance track's staging layout change. The exchange still leaves the displaced bytes at the candidate's path until the next step moves them to their recovery name, and that path is now in the unit recovery directory: candidates for replaced files are staged there, and staging holds only generated bytes. A crash in between is settled by restart recovery from the journal, which names that path and the candidate's digest. A staging sweeper is still not provided; any future one may discard `staging/` only and must never touch `recovery/`. |
| Transport | CLI replies are occasionally lost while the app stays responsive. Calls are serialized; every call is idempotent or outcome-recorded, and a publish is never resent. |
| Timer throttling | A hidden app window delays the app's own autosave. Do not read that as a fault. |
| Unreproduced anomaly | One early run ended with typed text on disk but absent from the editor buffer. It did not recur in any later run. Keep the typing-race case in every qualification run and treat a recurrence as a failed gate. |
| Link scanner cost | Open, carried. The Markdown link scanner is roughly quadratic in skipped regions times link occurrences on pathological inputs; fine for ordinary documents, minutes for several megabytes of adversarial Markdown. |
| Link-then-rename | Rejected. It leaves a window in which a concurrent replacement is destroyed. |
| App-driven save after replacement | Rejected. Observed losing an outside writer's bytes; kept as a negative control. |

## Obsidian's vault list

Obsidian opens a vault by path (`obsidian://open?path=`) only when the folder
is in its own vault list. `atelier obsidian open` puts the view's vault there.
Outside its own storage (the data root, which holds the vaults and their
policy-owned `.obsidian/core-plugins.json`), the list is the only file of
another application that Atelier writes; to write it, Atelier writes nothing
else outside the app's user-data directory, and no vault note.

**The file.** `obsidian.json` in the app's user-data directory:
`$HOME/Library/Application Support/obsidian/` on macOS and
`$XDG_CONFIG_HOME/obsidian/` (else `$HOME/.config/obsidian/`) on Linux; no
location is known on other platforms. Its shape is
`{ "vaults": { "<16 hex>": { "path", "ts", "open"? } }, …other settings }`.
The app reads it when it starts and rewrites all of it, with
`JSON.stringify`, whenever its list changes; `open` is true while a window of
that vault is open and stays true for the vaults open when the app quit.
Modules: `src/projection/obsidian/publication/vault-list.mjs` (read only) and
`src/runtime/obsidian/app-registration.mjs` (the write).

**While Obsidian runs and answers its command line**, the file is the running
app's and is only read. `open` asks the app instead, through `obsidian-cli
eval` with constant scripts: `vault-list` (the app's own map) and `vault-open`
with the folder and `false`, which adds an existing folder to the list (the app
writes its own file) and opens it in a window; `true`, which would create a
folder, is never sent. The folder travels as a base64-encoded JSON payload, as
in the publication bridge, so a path never becomes code. The addition is
verified by reading the app's list again and finding the vault root's entry
(asked again, a bounded number of times, while the window the app just opened
is still loading and answers that a command does not exist yet); an addition
the app did not answer (a call that timed out) is looked up the same way, and
is `addition-not-answered` when the list does not show it. `open` then waits,
bounded, until the app answers for exactly that vault. Like Obsidian's own
"open folder as vault", `vault-open` also adds the folder to the operating
system's recently used documents (Recent Items on macOS).

An entry is the vault root's when its folder, as written, is the root as
given or its real path; a listed folder's own real path is read only when its
last component is the root's (the root reached through a linked parent), so
a vault on a mount that does not answer is never waited on, and a link to the
root under another name is not recognised.

**While Obsidian runs with no vault open**, its command line answers nothing
and the file is still the running app's: it is read, never written. A vault
it already lists is opened by path; one it does not is refused as
`no-vault-open`.

**Never inside another vault.** In every state, a vault inside a folder the
list has as a vault already (compared as written, against the vault root and
its real path) is not added, through the
app or in the file: that vault would show its notes too, and a call run in
its folder would reach that vault. `open` answers `launch-failed` with reason
`vault-inside-another-vault`.

**A Flatpak or snap build** keeps its list inside its sandbox
(`~/.var/app/md.obsidian.Obsidian/config/obsidian/`,
`~/snap/obsidian/<revision>/.config/obsidian/`) and never reads the file above.
Such a build is recognised on Linux by its sandbox in HOME or its
installation (`~/.local/share/flatpak/app/md.obsidian.Obsidian`,
`/var/lib/flatpak/app/md.obsidian.Obsidian`, `/snap/obsidian`); the file is
then neither read nor written, `open` answers `obsidian-sandboxed`, and the
vault is added through the running app only.

**While no Obsidian runs**, the vault is added to the file itself, and only
then:

1. The process table is read and must say, positively, `absent`. `running` or
   `unknown` refuses (`app-may-be-running`).
2. The user-data directory and the file must exist, be this user's own, and be
   a real directory and a regular file (neither a link), and the file must be
   a JSON object whose `vaults`, when present, is an object, of at most 4 MiB.
   A file with a second name (a hard link) is refused as
   `obsidian-settings-unsafe`: the replacement would leave that name with the
   old list. A missing
   directory or file means Obsidian has not run on this account and is
   refused (`obsidian-settings-missing`): the file is never created. The other
   refusals are `obsidian-settings-unsafe`, `obsidian-settings-not-owned`,
   `obsidian-settings-unreadable` and `obsidian-settings-not-object`.
3. A vault whose real path an entry already has is left as it is; nothing is
   written. A vault inside a folder an entry has is refused
   (`vault-inside-another-vault`).
4. The new document is the file's object with one entry added under a fresh
   random 16-hex id that no entry has: `{ path: <the vault root's real path>,
   ts: <now, ms>, open: true }`. Every other key and every other entry is kept
   in its place, as values. A document that would be larger than 4 MiB is
   refused (`obsidian-settings-too-large`).
5. A temporary file in the same directory is written with the file's mode and
   fsynced; the bytes as they were are written, fsynced, to
   `obsidian.json.atelier-backup-<UTC time>` beside it.
6. Immediately before the rename, the process table must still say `absent`
   and the file must still hold the bytes that were read; otherwise both new
   files are removed and the write is refused (`app-may-be-running`,
   `obsidian-settings-changed`).
7. The temporary file is renamed over `obsidian.json` and the directory is
   fsynced. Of the backups beside it, the first (the list as it was before
   Atelier wrote it) and this one are kept, and any between them removed. The
   process table is read once more: an app that appeared just then may have
   read the list before the rename, so the addition is reported unconfirmed
   and `open` answers `launch-failed` with reason
   `app-started-during-registration` instead of launching; the next `open`
   adds the vault through the app if it missed it. A file that cannot be read
   back to find the new entry is reported unconfirmed as well, with reason
   `registration-not-read-back`.

Every refusal writes nothing and leaves nothing behind: a temporary file or
backup created on the way is removed again whichever later step fails.
`open` then asks the operating system to open
`obsidian://open?path=<the vault root>`, as before.

**Which window answers.** The command line (1.13.7) answers a call whose first
argument is `vault=<value>` in the window of the first listed vault whose id is
the value, or whose folder's name is the value in any letter case; any other
call in the window of the first listed vault whose folder is the tool's working
directory or contains it, the folders compared as written; and otherwise in the
vault window that had focus last. It opens a vault that takes a call when it is
closed. The first match in list order wins, not the deepest folder, so a vault
listed before the view's vault at a folder above it would take every call run
in the view's folder. Calls about no vault (the version, the vault list, the
addition) run in a directory that is no vault and name none. A call about the
view's vault goes where the list says only that vault takes it
(`vaultRoute` in `vault-list.mjs`): in its folder (its real path) when the
first listed vault that is or contains that folder is this vault, and
otherwise from a directory that is no vault with `vault=<id>` first, when that
id names this vault first; when neither holds, no call is made. `open`'s check
that the app answers for the vault is routed from the list it verified the
vault in. Publication calls are routed from the file, and only while it lists
the vault open; otherwise they run in a directory that is no vault and name
none, so maintenance never reopens a vault window that was closed and never
reaches another vault. The bridge still checks that the app answered for
exactly this vault.

**Retries.** The maintenance service is told what the app looks like from
the process table and the file alone (whether an Obsidian process runs, and
which vaults the file shows open; the file is read, never written, by the
service): nothing runs in the app to find out. The app is asked for its
version only when a view is about to be published, and without blocking the
service. A tick requested over the service's listener for one view (`open`
names its own) prepares and publishes that view once more, with the app's
qualification asked again; the engine takes such requests only for views the
project declared at its last tick, and at most 64 before its first. A view
whose last publication did not settle is also tried again as soon as that
picture changes, and otherwise after a delay that starts at 30 seconds and
doubles per attempt, up to the full reconciliation interval.

Source application back into canonical files carries the same conditional-write
obligation against other source writers; its protocol follows.

## Source apply protocol `source-apply-exchange/v1`

Source apply writes one edit made in a vault back to the one source file the
note was generated from. It is the only operation of this integration that
writes a source file. A person's explicit Apply (`atelier obsidian apply run
EDIT [--actor ID]`, or the same call through the API by an agent acting for them)
and an automatic policy reach the same function; they differ only in who
authorises. It never stages, commits or otherwise asks git to change anything:
its two git calls ask whether the path is ignored and where the git directory
is.

### Who authorises

| Mode | Authority | Actor recorded |
| --- | --- | --- |
| `manual` | an explicit request that names the edit; the integration must be enabled | the request's actor, else `manual-request` |
| `automatic` | the installed policy, read from private state at the decision and again immediately before the write: machine mode `automatic`, status `active`, the policy's recomputed digest equal to the digest it carries, the object inside the policy's `selector`, `body-replacement` in `allowedEditClasses`, retry budget not spent | the policy's actor, with the policy identifier and digest |

In both modes the object must be visible in the canonical graph as it is now
(eligible, enrolled, audience allowed). An absent object and a withheld one get
the same answer, `object-not-visible`, and they get it first: before the
manifest, the record of the object or the source path is looked at, with
nothing recorded, so a moved or deleted source, an earlier apply or a missing
manifest never tells the two apart. A source deleted from the corpus is
therefore answered `object-not-visible` as well. There is no ambient agent mode: an automatic request with no
matching active policy is refused.

The digest of a policy is `sha256:` and the hex SHA-256 of its canonical form:
the policy document without its `digest` member, keys sorted at every depth,
two-space indentation, one final newline, UTF-8. `atelier obsidian policy
digest FILE` prints it and writes nothing; `policy install FILE` recomputes it
and refuses `policy-digest-mismatch`, naming the digest the file has to carry.
The file is never rewritten for the person. `maxBatchSize` bounds an
automatic dispatch (the engine's, and `applyBatch` in automatic mode); a batch
a person names through `applyBatch` is bounded too, by 1000, the largest bound
a policy can carry, and the rest of either batch refuses `batch-bound-reached`. `retryBudget` allows one attempt and
that many retries per operation under one revision of the policy; it is counted
over the refusals recorded in the events of the object, so a restart does not
refill it, and a spent budget refuses before anything is recorded.
`conflictDisposition` is `hold`: a conflict stays queued with its bytes, and
nothing a policy says overrides a stale source.

### Order of one apply

1. Resolve the workspace and the pending edit. Build the canonical graph now
   and ask whether this machine may see the object. Then resolve the view and
   the immutable manifest of the generation the edit was observed under.
2. The identity must still name the path the
   manifest recorded, in an enrolled repository. That path must be a regular
   file with one name, reached through no symbolic link, inside the repository,
   outside every managed root and every git directory, and not git-ignored.
   A git directory is any path with a segment spelled `.git` in any case (a
   nested repository, a submodule), anything under `<root>/.git`, and anything
   under the directory git itself names for the repository, which a `gitdir:`
   file can place elsewhere; a git that cannot name it refuses
   `source-ignore-state-unknown`. The only git calls ask whether the path is
   ignored and where the git directory is.
3. Read the source. Run the lens from the preserved edit bytes, never from the
   note as it is now. Record the observation of this edit and of every other
   open edit of the same object, so a divergent edit in another view makes the
   object conflicted before anything is written.
4. Take the object lease. An earlier apply whose outcome is unknown is settled
   first, from digests on disk.
5. Refuse, writing nothing: a repeated request (answered from the record), a
   stale source, a conflicted object, a lens refusal, a change outside the
   authored body, a result equal to the source, the policy, a volume that is
   not the source's, a missing exchange.
6. Write the apply record, then the candidate (the new source bytes, with the
   source's mode, fsynced) in `recovery/<applyId>/000000/` of the private
   workspace state.
7. Record `apply-intent` in the object store.
8. Read the policy again. Exchange the candidate with the source atomically.
9. Read what the exchange displaced. Equal to the base: it stays as the
   retained backup under its recovery name, with a receipt binding its digest;
   the source is verified; `applied` is recorded with old and new digests, the
   actor and the policy. Not equal: another program saved the source between
   the read and the exchange. Its bytes are retained as an immutable object and
   the files are exchanged back, so its bytes return to the source path; what
   that displaces must be the candidate, and anything else is kept with a
   receipt. `apply-refused`, `concurrent-source-writer`, with every reference.
   Nothing is retried inside one call. An exchange that reports a failure is
   not believed either way: only the candidate still at its path beside the
   source as it was read means that nothing was exchanged
   (`exchange-unavailable`); anything else is decided as restart recovery
   decides it, so an exchange that did take place is recorded as applied
   (`applied-after-restart`) with its backup.
10. After a quiet period the backup is read again. A program that opened the
    source before the exchange still holds the old file and can write into it
    at any later time: `source-changed-after-apply`, both byte sets retained.
    An applied source leaves a closed journal of this protocol beside the
    publication journals of the view, so the maintenance engine's late-writer
    re-check covers the backup on the tick of the apply and on later ticks,
    for as long as it covers a publication.

The candidate is never written inside a repository working tree, where a stray
file could be committed by somebody. An exchange cannot cross a volume, so the
private workspace state and the source must share one; otherwise the apply
refuses `apply-volume-mismatch`. Where no atomic exchange exists (Windows
today) it refuses `exchange-unavailable`. Both write nothing.

### Refusals

| Code | When |
| --- | --- |
| `integration-disabled`, `workspace-not-prepared`, `unknown-edit`, `foreign-workspace`, `unknown-scope`, `edit-not-open` | the request cannot be resolved |
| `corpus-unreadable` | the canonical graph cannot be built on this machine: an enrolled file may not be read; no file is named |
| `manifest-unavailable`, `published-note-unavailable` | the generation's manifest, or the note as it was published, cannot be established |
| `repository-not-enrolled`, `source-not-in-graph`, `source-moved` | the identity of a visible object no longer names that path: a renamed or moved source (a deleted one is `object-not-visible`) |
| `source-missing`, `source-symlink`, `source-not-regular-file`, `source-unreadable`, `source-hard-linked`, `source-outside-repository`, `source-inside-managed-root`, `source-inside-git-directory`, `source-git-ignored`, `source-ignore-state-unknown` | the path is not one this operation writes |
| `invalid-apply-request`, `object-not-visible`, `edit-class-not-allowed`, `conflict-disposition-unsupported`, `maintenance-mode-manual`, `no-apply-policy-installed`, `apply-policy-revoked`, `apply-policy-paused`, `apply-policy-invalid`, `apply-policy-reference-mismatch`, `policy-digest-mismatch`, `policy-changed-since-dispatch`, `policy-selector-invalid`, `outside-policy-selection`, `retry-budget-exhausted`, `batch-bound-reached` | the decision |
| `stale-source`, `object-conflicted`, `sibling-edit-unobservable`, `lease-held` | arbitration; the operation stays conflicted or pending with its bytes |
| `edit-not-applicable`, `change-outside-authored-body`, `no-source-change` | the lens result is not an applicable body replacement |
| `exchange-unavailable`, `apply-volume-mismatch` | this machine cannot write conditionally here |
| `concurrent-source-writer`, `source-changed-during-apply` | another program wrote the source during the apply; every byte is retained |
| `interrupted-before-exchange`, `apply-interrupted-needs-person` | what restart recovery decided for an interrupted apply |
| `recovery-state-unreadable` | a candidate, backup or source path of an interrupted apply may not be looked at or read; nothing is settled from a read this process was denied, that record is reported with its intent still open, and every other one is still settled |
| `apply-outcome-unknown` | the source was exchanged and the settlement from digests could not be carried out; the source may have been changed, the intent stays open and `apply recover` decides |

A path that another program removes or replaces between two steps, before the
intent is recorded, answers one of these refusals (`source-missing`,
`source-not-regular-file`, `workspace-not-prepared`), never an exception; one
that this process may not look at or read answers `corpus-unreadable` while the
graph is built and `source-unreadable` from then on. The
mode of the source is read from the descriptor its bytes were read from.

### Restart recovery

An `apply-intent` with no outcome is never guessed. `atelier obsidian apply
recover`, and the next apply of the same object, decide from digests on disk.
Only bytes with the recorded candidate digest are ours to delete. Every
interrupted apply is settled on its own: an object whose record cannot be read
is reported with its code, left exactly as it is, and delays no other. `apply
list`, `show`, `run` and `recover` answer such a record as a typed refusal.

| At the candidate path | Source | Decision |
| --- | --- | --- |
| the candidate | anything | nothing was exchanged, or it was exchanged back: the candidate is retired, `interrupted-before-exchange` |
| the base | the candidate | applied: the base becomes the backup, `applied` is recorded |
| anything else | anything | everything is kept with receipts, `apply-interrupted-needs-person` |
| nothing, backup recorded as the base | the candidate | applied |
| nothing, no backup | the base | `interrupted-before-exchange` |

### Limits

- The applied source is a new file: a hard link is refused up front, extended
  attributes and ownership are those of the candidate, and only the permission
  bits are carried over.
- A hard link is refused when the path is checked. One that another program
  creates on the source after that check and before the exchange keeps the old
  bytes under its other name; the source path itself ends as the applied file,
  and nothing detects the second name.
- Every component of the source path is checked for a symbolic link, and the
  file itself is opened without following one. A directory component that
  another program replaces with a symbolic link after that check and before the
  exchange is not detected; what contains it is the commit rule: unless the
  file the exchange displaced holds exactly the bytes that were read, the files
  are exchanged back and everything is retained.
- When the exchange back reports a failure, or the displaced file cannot be
  retained first, nothing is guessed and the report is not believed either way:
  the apply is settled from the digests on disk by the restart table above.
  If the exchange back did not take place, the source path keeps the candidate,
  whole, the other program's bytes stay where recovery references name them,
  and the answer is `apply-interrupted-needs-person`. If it did take place
  before it reported the failure, the source path holds the other program's
  bytes, the candidate is retired, and the answer is
  `interrupted-before-exchange`. If the digests show that the first exchange
  displaced the base after all, the apply happened and is answered as applied.
- A refusal says that nothing was written. From the moment the first exchange
  may have taken place (a clean exchange, or one that reported a failure while
  the digests no longer show the untouched state), a failure is therefore never
  returned as a plain refusal with the intent open: it is settled from the
  digests on disk, and only when that settlement itself cannot be carried out
  is the answer `apply-outcome-unknown`, which says that the source may have
  been changed and that `apply recover` decides. Once the outcome is durable
  that answer is no longer given.
- A read that this process is denied (a permission or I/O error) proves
  nothing about a file, unlike a path that is no longer a regular file. It is
  never taken as evidence that the source changed or that another program
  wrote: the apply is settled again from digests when the path can be read.
  A typed failure of the late-writer check after a durable apply leaves the
  answer applied; the engine repeats that check.
- An enrolled file this process may not read while the canonical graph is built
  refuses `corpus-unreadable`, naming no file. A source that cannot be read at
  the moment of the apply refuses `source-unreadable`. Both carry the system's
  error code as the cause. Only bytes with the recorded candidate digest are
  ours to delete, so a file that cannot be read is never retired as a generated
  candidate.
- Where no atomic exchange exists the whole apply half of the test suite is
  skipped: on such a platform the only executed evidence is that apply refuses
  `exchange-unavailable` and writes nothing.
- Lifting the hold after an apply relies on the publisher: it reads the note
  again under its own lock and settles it as already current only while the
  note still holds the prepared bytes. The engine's own read of the held note
  narrows the window; the publisher's expected-bytes check closes it.
- Between the exchange and the exchange back, readers of the source path see
  the candidate for a moment. A third write in that moment is kept: the source
  ends as one whole version and the other is in recovery with a receipt.
- A program that holds the old file open and writes later has its bytes
  retained and surfaced, not merged: deciding what the source should be is a
  person's work.
- Generated regions are never applied. The edited note must still end with the
  exact generated bytes, or have lost them whole while the end of its authored
  text is provably the published end: the last authored line and its line
  endings byte for byte, followed by nothing but what is left of the separator
  or fence closure. A region cut in the middle of a line from either side, a
  fragment of one left in the body, and text typed at the very end of the body
  together with a removed region all refuse `generated-region-edited`. Some of
  those refusals a person could have been spared; a generated byte in a source
  is never accepted in exchange. The identity block in the front matter is
  generated as well: it is removed before the source bytes are made, and a
  note whose front matter changed, the identity lines included, is a
  front-matter edit that becomes a proposal. A byte order prefix the editor
  dropped is taken from the source, as before.
- After an apply the next tick prepares the view again. When the prepared note
  is byte for byte the note the person edited (read from the vault at the
  moment of that decision, never taken from the engine's observation index; a
  note that cannot be read stays held), it is published over nothing,
  the hold lifts and the pending record closes as `withdrawn`; the `applied`
  record of the object store is the authority. When it is not (the person
  removed a generated region, for example) the view stays held.
- `--actor` is an option of `apply run`. The command has one option table for
  every operation; every other operation, of `apply` or not, refuses it as a
  usage error and does nothing.
- Proven on macOS arm64 on APFS with a real second process. Linux, x86_64 and
  other filesystems carry the open obligations of the exchange listed above.

## Proposal adapter for structural edits

An edit the byte lens cannot turn into source bytes (a new or changed link to
another note of the vault, an edited front matter) is recorded as an edit
operation of kind `semantic-proposal`, state `proposed`. It is never applied.
The proposal adapter (`src/projection/obsidian/proposals/`) turns each such
operation into exactly one copy-only proposal in the existing proposal store of
the repository that owns the source, so that a reviewer of that repository sees
one durable request. It writes no source file and no vault, it never accepts or
applies a proposal, and no status of a proposal is an instruction to it.

The adapter is a contribution (`src/runtime/obsidian/contributions/`). On a
tick the engine first lets it observe the open pending edits (below), then,
after the automatic dispatch, hands it a copy of the pending edits once.

### Observation on a tick

An operation exists once the edit has been observed: the source is read now,
the lens runs over the PRESERVED edit bytes (never the live note) against it,
and the resulting edit operation is recorded in the object store. Source apply
does this before it takes its lease. The adapter does the same on every tick
(`src/projection/obsidian/proposals/observation.mjs`), through the same
observer and the same store, for every open pending edit the object store does
not know yet, in manual and in automatic mode alike, so that a structural edit
becomes `proposed`, and is routed in the same tick, without anybody running
`atelier obsidian apply run EDIT`. What it records is what an apply would have
recorded: a body replacement `pending`, which stays queued and is written only
by apply; a structural edit `proposed`; a lens refusal `refused`; a base source
that moved on `conflicted`. It writes no source file and no vault, and takes no
lease.

Ticks stay quiet. The object store answers the same for an origin it already
holds and appends nothing, and an edit whose operation is recorded is not
offered again: the record of the object is the authority, and an adapter that
has just started finds it there. A refusal that comes before anything can be
recorded (`object-not-visible`, `source-not-in-graph`, `source-moved`, the
`source-*` codes of locating the file, `manifest-unavailable`,
`published-note-unavailable`, `stale-source`) is remembered in memory with its
code and offered again only at the full reconciliation cadence of the engine,
never on every tick. At most 16 edits are observed per tick, in the order they
were observed, starting where the last tick stopped. The tick reports
`observed`: for each edit looked at, its identifiers, `observed` or `refused`,
a code, and for a recorded one the kind and state of the operation.

### Routing

The routing key is the whole identity `(workspaceId, repoId, nodeId)`. The store
is the one every other writer of proposals uses for a root:
`<repository root>/.atelier-proposals`. Two repositories that hold the same
relative path and the same local node id have different stores and different
operation identities. A route that cannot be resolved refuses, writes nothing,
and leaves the preserved bytes and the record of the object as they were:

| Code | Meaning |
| --- | --- |
| `invalid-operation`, `foreign-workspace` | the identity is malformed or belongs to another workspace |
| `repository-not-enrolled`, `repository-external`, `repository-root-unreadable` | the project does not enrol the repository on this machine |
| `route-withheld` | this machine may not see the object now (the rule source apply asks); `route-visibility-unknown` waits instead |
| `source-path-invalid`, `source-path-not-preservable` | the repository-relative path is unusable, or the store would trim or cut it (500 characters) |
| `proposal-store-unsafe`, `proposal-store-inside-managed-root` | the store directory is a link or a file, or overlaps private state or a vault |
| `proposal-store-not-ignored`, `proposal-store-ignore-unknown` | the store does not exist yet and git would report it; nothing is created that changes `git status` |

### Operation identity and deduplication

The adapter operation identity is `pa-` and the SHA-256 of the identity and the
idempotency key of the edit operation, joined by a character no identifier can
hold: 67 lower-case characters. It is carried in `payload.adapter.operationId`
of the proposal, a member the store persists as JSON without normalising it.
The identifier the store gives a proposal is seeded with the time and decides
nothing here.

Per operation, under a private lock per repository (the generation lock of the
maintenance engine; taken over only with proof that its holder is gone, never
because time passed):

1. the operation is recorded in the adapter queue,
   `<state>/state/proposals/<repo>/operations/<operation>--NNNNNN.json`:
   immutable, owner-only, canonical files, each naming the digest of the one
   before it;
2. the ledger of the store is read and its room judged;
3. the persisted store is searched for a proposal that carries the operation
   identity, and one is created only when there is none;
4. `submitted` is recorded, the proposal is read back, and `acknowledged` is
   recorded with an `atelier-obsidian-proposal-receipt/v1` that binds the edit
   to the proposal (`dedupe`: `new`, `recovered` after a lost acknowledgement,
   `duplicate` when an acknowledged operation is offered again).

A crash before the append leaves a queued record and no proposal; after it, a
proposal that step 3 finds. An unchanged tick reads the queue and nothing else:
no store is opened and nothing is written. An operation whose edit was withdrawn
or superseded while it waited is refused `edit-withdrawn` or `edit-superseded`.

### What a proposal holds

Identifiers, the repository-relative source path, the lens code and reason,
byte offsets into the edited note, digests and recovery references of the
preserved bytes, and sentences made from those codes. It holds no text of any
note: what a person typed can carry the title of another document, and a
reviewer of one repository must not learn a title of another repository, or of
a withheld document, from a proposal. The preserved bytes stay in private state.

### Ledger limits and backpressure

The limits are those of the existing ledger and are not widened: 256 KiB a
line, 16 MiB, 10,000 events, and an unreadable line refuses every append.

| Code | Outcome |
| --- | --- |
| `proposal-too-large` | refused before anything is appended; nothing is cut to fit |
| `ledger-full` | fewer than 1 + 32 events or less than the line + 512 KiB of room (the reserve is the reviewers'); the operation waits as `backpressure` with its edit retained |
| `ledger-corrupt` | refused, for that repository only; other repositories progress in the same tick |
| `store-unavailable` | the store cannot be read or is locked now; waits like a full one |

A waiting operation is tried at most 8 times, 60 seconds after the first attempt
and twice as long after each, up to an hour. At most 8 operations per repository
and 64 unexamined edits are looked at per tick. A repository holds at most 4096
operations, 256 of them open, 64 records of 16 KiB each; a full queue refuses
`queue-full` and records nothing. Nothing is compacted, rotated or deleted, in
the ledger or in the queue. A refused or exhausted operation is final until the
adapter's `requeue` is called for it, which is a person's decision after making
room or fixing the route; it is an exported function, and no command binds it
yet.

`atelier obsidian proposals list` and `show OPERATION` are read-only: per
repository the counts by state, the codes of the waiting and the refused, and
the events and bytes the ledger has left; never note or source text.
