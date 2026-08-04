# MNSTRY Atelier format ontologies

How authored surfaces encode their reading formats so that the practice of
composing good ontologies improves with use. Established 2026-08-05 by
operator ruling during the mnstry.org corpus renovation; the first worked
system is the long-form article format proven on the-craft and discernment.

## The principle

A format is not a template. A template is a fixed schema stamped onto every
piece, and it becomes detectable within ten instances; the corpus audit that
started this work found exactly that failure at scale. A format is a
phronesis: a menu of options, worked examples, underlying principles, and
guardrails, held together by judgment questions that derive the right
composition from the piece at hand. The menu keeps composition varied, the
examples teach the judgment, the principles say why, and the guardrails
record every founder rejection so a mistake is made at most once.

Atelier owns the semantics of formats: the named slots, their knowledge-graph
edges, and the readiness rules that make a format checkable. Rendering is
owned by the marketing foundation (`@mnstry/marketing-foundation`, 0.7.0 and
later, practices `at-a-glance-opener` and `deepening-panel`), and editorial
composition is owned by the format's phronesis document in the authoring
repo. Three layers, three owners, no drift between them: a change to what a
slot means lands here, a change to how it renders lands in the foundation,
and a change to how it is composed lands in the phronesis with its
originating ruling attached.

## The long-form article format (first worked system)

**Slots.** A piece opens with a title unit (title carries the claim, subtitle
one step down), then an at-a-glance card: three labeled prose paragraphs by
default, the concrete twin of the essay, honest enough that a reader who
stops there still leaves with the truth. Body sections carry concrete
companion headers that state their takeaway and double as a standing outline.
Claims state once and open deepening doors: panels carrying one linked graph
node's one-line claim with an explore-plus-name call to action. The landing
varies by piece: an adoptable kit, an assessment, an open question, a scene,
never the same shape twice running.

**Menu of worked ontologies** (illustrations of judgment, not a catalogue):

- an economics argument: the shift / what to do / the tools
- a self-audit: what we claimed / what we found / what we fixed
- a case re-reading: the result / the re-reading / what it asks of builders
- a concept piece: the failure / the word / what to build
- a tool release: the problem it removes / what it is / install it

**Principles.**

- Labels are wayfinding, not writing: understood instantly by anyone, or
  they fail. The essay is where the voice performs.
- The card is a threshold, not a summary: it decides entry honestly.
- Doors, not repetition: one canonical home per case and statistic;
  everything else links. The explore verb is invitation, never assignment.
- Name the doer at the claim's resolution: category-word subjects
  (systems, technology, tools) hide which part does what.
- A piece's category follows what it teaches the reader to do, not the
  flavor of its subject.
- Honest time: research dates and publication dates are separate facts and
  both are told.

**Guardrails, each with its originating rejection.**

- No schema vocabulary in labels (the frontmatter brief leaked into prose
  as "the mechanism is..." beats; audit finding, 2026-08-04).
- Cold-reader test label by label: no presumed history ("what changed"),
  no presumed subject ("the practice"), no two labels gesturing at the
  same thing (rejected 2026-08-05).
- Plain over clever: coinage in a label fails by default ("the
  countermove", rejected 2026-08-05).
- No ambiguous standalone terms: a word whose reading depends on context
  the reader lacks is disambiguated or replaced ("generation" sentence-
  initial; "company" near the companion product sense; both flagged
  2026-08-05).
- A word of honor is defined by what it is before what machines lack
  (phronesis card slot, rejected twice, 2026-08-05).
- No label triple repeats on adjacent reading paths; validators can check
  this once cards carry labels as data.

## Adoptable tools (the second worked system)

Long-form pieces land in an instrument rather than a benediction, and the
instrument is the part most likely to be adopted somewhere we never see. The
craft ships a harness kit of annotations and a five-question audit; the
discernment piece ships a placement walk; the REAL test ships a product
assessment. Design rules learned building those three, in force for every
tool the corpus ships:

- **Runnable by a person and by an agent, from the same definition.** One
  instrument with two surfaces, never a human version and a separate machine
  version that drift apart. The human surface is an ordered walk; the machine
  surface is a contract with a typed return.
- **Observable inputs only.** A tool that requires private data cannot be run
  by the reader who most needs it. Every question resolves against something
  shipped: a mechanic, a default, a diff, a pricing page.
- **Evidence per verdict.** Each verdict cites the specific thing that
  produced it. A verdict without its evidence is an opinion wearing a
  finding's clothes, and it becomes indistinguishable from a real finding the
  moment it is written down.
- **Abstention is a first-class result.** Every tool ships a not-visible or
  unknown verdict and instructs the runner to prefer it over inference. An
  assessment that guesses is worse than one that abstains, because the guess
  travels with the authority of the finding. This is the corpus's own
  discernment argument turned back on its own instruments.
- **Refuse the composite when the composite is the error.** Where a framework
  exists to say that judgment cannot be delegated, its tool must not emit an
  overall score, and must refuse it even when asked. Encode the refusal in
  the contract, not in a footnote.
- **Verdicts expire.** A tool that reads a build says so, and re-runs on the
  next release rather than aging into a claim about a company.

An instrument that follows these is adoptable in contexts we do not control,
which is the point: the corpus earns its keep when its tools run inside other
people's harnesses.

## How this system grows

Every founder rejection during composition is recorded in the format's
phronesis document with the failed attempt, the repair, and the generalized
rule, in the same change that applies the fix. New formats (course surfaces,
tool releases, research notes) enter by writing their own slot vocabulary and
menu against this document's principle, reusing guardrails that generalize
and recording the ones that do not. When a format's slots stabilize, they
graduate into data: frontmatter declarations validated at build, an
extension-pack entry (`atelier-extension-pack.v1`) carrying the terms and
readiness rules, and foundation practices carrying the rendering. The
sequence is deliberate: judgment first, then examples, then schema, so the
schema encodes a practice that already works instead of prescribing one that
does not exist yet.

## Pointers

- Editorial phronesis of record: mnstry-org
  `editorial/notes/at-a-glance-phronesis.md`
- Rendering practices: `@mnstry/marketing-foundation` registry,
  `at-a-glance-opener`, `deepening-panel`, `page-navigation-semantic`
- Corpus audit that motivated the system: mnstry-org, 2026-08-04
- Slot data contract (when formats graduate): `contracts/atelier-extension-pack.v1.schema.json`
