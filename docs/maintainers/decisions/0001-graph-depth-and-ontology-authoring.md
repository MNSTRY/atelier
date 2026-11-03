# ADR 0001: Graph depth and ontology authoring

- Status: proposed
- Date: 2026-11-03
- Applies to: `@mnstry/atelier/graph-workspace` (0.2.0-alpha.15 and later), the
  ontology guide in `src/knowledge/ontology-guide.mjs`, Knowledge Health
- Decides: how a third dimension is used in the graph view, and how ontology
  changes are proposed, checked and reviewed

## Context

0.2.0-alpha.15 ships the graph workspace: one graph in three rooms. The
constellation draws every readable record on a night-sky canvas with folder
zones. The workbench authors one concept or relation at a time. The review room
shows what is proposed and who decides. Atelier provides the primitives and
defaults, a cohort coach shapes them, and the owner has the final say.

Two needs remain open.

1. **A 3D view that is useful, not decorative.** Free-orbit 3D force layouts of
   abstract graphs look striking but cost more than they give: nodes occlude
   each other, depth is hard to judge, navigation takes effort, and depth
   encodes nothing. The workspace must also stay legible at tens of thousands
   of records.
2. **Ontology authoring that is consistent, intuitive and robust.** The
   workbench gets the shape right (one subject, one step, evidence, a case that
   would prove it wrong, a separate review). Four gaps remain:
   - Changes are free-form drafts, not typed operations. Splits, merges and
     renames, where ontologies decay, have no flow of their own.
   - Structural guidance in the browser is a simulation. The authoritative
     guidance runs on the host, so the browser, the command line and CI can
     disagree.
   - Nothing measures whether a change makes the ontology better at its
     purpose.
   - Authoring starts from writing definitions, which is the hardest entry
     point, rather than from the records a person already has.

Building blocks that already exist:

- the knowledge plan's questions and `evaluateKnowledgeQuestions`, which checks
  whether retrieval finds each question's expected evidence
- the ontology guide's question-bound prompts
- the Knowledge Health rule identity, which pins rule bytes so verdicts are
  reproducible
- the optional Babylon graph-view renderer, currently capped at 48 nodes and
  96 edges
- the injected-renderer pattern used for Sigma and graphology
- recipes layered as Atelier, then coach, then owner

## Decision

### 1. Depth means abstraction: the ontology floats above its evidence

The graph view gains a two-layer, tilting mode.

- **Records stay a plane.** The constellation keeps its layout, zones and
  labels. Looking straight down is exactly today's view, which remains the
  default.
- **Concepts form a layer above.** Relations between concepts run across that
  layer.
- **Evidence drops as beams.** A concept sends a thin line to each record that
  declares it, and a brighter one to each record cited as its evidence. A cited
  record outside the reader's readable set is drawn as a dashed beam into
  darkness: counted, never shown.
- **The camera is constrained.** It tilts and turns around the vertical axis
  only, with no roll and no free orbit, and one key returns to the plan view.
  Labels stay in screen space and keep using the existing collision-free
  placement (`placeLabels`).
- **Beams are drawn on demand,** for the selected, lit or hovered concepts,
  never all at once, so the view scales with the record budget.

Two later modes may reuse the same machinery, each behind a lens:

- **strata:** depth is time, showing how the knowledge base grew
- **focus:** one concept's neighbourhood is pulled forward and the rest pushed
  back

The tasks this view must make faster or clearer than the flat view:

- find a concept no readable record grounds (no beams)
- find a concept that is probably two concepts (beams fanning into unrelated
  zones)
- find a zone the ontology does not yet cover (bright plane, empty sky above)
- see where a question's evidence sits (the question's concepts lit above,
  their beams below)
- see which cited evidence this reader cannot open (dashed beams)

**Rendering.** A WebGL renderer drawn with instanced points and lines, injected
by the host as Sigma is today, so Atelier gains no runtime dependency. The
existing Babylon renderer is the first candidate; the 48-node cap must go before
it qualifies. Without WebGL, or with reduced motion, the view stays flat.

### 2. Ontology changes are typed proposals, checked by one rule set and tested against the questions

**Typed operations.** Every change is one operation with fixed steps,
preconditions and a predicted effect:

- add, refine, split, merge, rename and retire a concept
- add, refine and remove a relation

Split and merge carry the retagging of declaring records as part of the
proposal. For example: "splitting this concept retags 23 records; 4 are
ambiguous and need your call."

**One card for every element.** Every concept and relation, in every
operation, uses the same card: meaning, boundary (identity and near miss),
example, evidence, and what would prove it wrong. The step order and keys are
the same everywhere.

**One rule set, in the library.** Structural checks move from the browser
simulation into Atelier as rules with stable ids and pinned identity, as
Knowledge Health pins its rules. The browser, the command line and CI then give
identical verdicts. Initial rules:

- a definition that repeats the name
- an identity rule that names no criterion
- near-duplicate definitions
- cycles in an "is a" relation
- a concept no record declares
- a relation with no readable evidence
- a reverse reading recorded as a second relation
- an example equal to its near miss

**Questions are the acceptance test.** The review room runs
`evaluateKnowledgeQuestions` on the current plan and on the plan with the
proposal applied, and shows the difference, for example: "question 3 now finds
14 of 15 expected records (was 9); question 5 lost 2." A change that loses
expected evidence on any question needs an explicit owner acknowledgement.

**Authoring can start from records.** A sorting activity shows a handful of
readable records and asks, for each: is this a ⟨concept⟩, a near miss, or
neither? The sorts become the example, near miss and evidence before any
definition is written. A drafted definition is then checked against them:
records it would include but the person excluded are flagged.

**Lifecycle and provenance.** A concept or relation is proposed, in review,
accepted or retired. Each state change records who made it, when, under which
operation, and on what evidence. Retired elements keep their identity so
existing references still resolve.

**Ownership by layer.** Atelier ships the operations and rules. A coach may add
starter concepts, stricter rules and recipes. The owner decides; nothing a coach
adds changes the owner's accepted ontology without the owner's review.

**Persistence.** Drafts and accepted changes persist only through a host storage
port bound to the coauthor ledger. Until a host binds one, drafts stay in the
browser or tab, and the interface says so.

## Sequencing

1. The ontology rule set in the library, plus the question comparison in the
   review room. Both later parts depend on these.
2. Typed operations, starting with refine, split and merge, plus sorting from
   records.
3. A prototype of the two-layer tilt, run on a private evaluation corpus held
   outside this repository, with the five tasks above timed against the flat
   view. It enters the package only if it wins.
4. The host storage-port binding, so drafts and accepted changes persist.

Steps 1 and 2 make authoring robust without any 3D. Step 3 is cheap to test and
cheap to drop.

## Consequences

- The flat constellation remains the default and the accessible path. Depth is
  an added mode, never a requirement.
- Ontology verdicts become reproducible across the browser, the command line
  and CI. Changing a rule changes its pinned identity, as with Knowledge Health.
- Review gains a measurable outcome per change. Plans without questions get
  structural checks only, and the review room says that the outcome was not
  measured.
- Typed operations make splits and merges safe, but each operation is a public
  contract that needs versioning and migration notes.
- The 3D renderer adds a second injected rendering dependency for hosts that
  enable it.

## Alternatives considered

- **Free-orbit 3D force layout.** Rejected: depth carries no meaning, and
  occlusion and navigation cost outweigh the visual effect.
- **3D by default.** Rejected: harder to read, heavier on low-end devices, and
  worse for keyboard and screen-reader users.
- **Keep guidance host-only.** Rejected: verdicts drift between surfaces, and
  the browser cannot say whether a draft is ready.
- **Free-form drafts with a richer editor.** Rejected: splits, merges and
  renames need preconditions and record retagging that free text cannot carry.
- **Judge changes by reviewer opinion alone.** Rejected as the only signal. The
  questions give a measurable check, and a person still decides.

## Validation

- The depth mode passes only if the five tasks are faster or clearer than in
  the flat view on the private evaluation corpus. Otherwise it is cut and this
  ADR is amended.
- The rule set has a regression test per rule and a pinned identity test.
- The question comparison is tested on invented fixtures where a proposal both
  gains and loses expected evidence.
- Each typed operation has a refusal test for every precondition and a round
  trip through the review room.

## Open questions

1. Are accepted ontology changes written back to the records' concept tags in
   the source files, or kept in an ontology file that the tags point to?
2. Is the depth prototype judged on the owner's own use, or first on tasks a
   maintainer writes and times?
3. Which private corpus is the evaluation bed for ontology authoring?
