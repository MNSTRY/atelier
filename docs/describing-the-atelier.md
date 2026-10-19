# Describing the Atelier

Copy about a governance tool is itself a claim. `docs/design.md` says a design
document that cannot be checked is marketing, and the same holds for a README
sentence, a distribution's landing page or a partner's brief. This page carries
the judgment behind the wording. The promises themselves live in
`docs/blocks/` and are embedded verbatim under `test/normative-blocks.test.mjs`;
this page says how to write around them without overclaiming.

It binds anyone writing about the Atelier in this repository, in a
distribution built on it, or in materials that name it.

## Two readers, one rule

Two people read about the Atelier. An operator installs `@mnstry/atelier`,
governs a body of work on their own local computer or virtual machine, and runs
whatever systems they run. A team on a managed runtime works the same
repository from a harness that also reaches that runtime, and cares about what
it retains.

The rule for choosing words: **package copy describes the package; system copy
describes the system.** The package is the repository, the graph, the
contracts, the gates, the projection, the skills and the sync. The system is
the package plus the harness plus a runtime plus connected tools. A sentence
that needs a runtime to be true is system copy. A sentence about the package
is true for both readers and is written once. This repository's own pages are
package copy.

## Agents live in the harness

The agent is never in the package. The harness (Claude Code, Codex or another
coding harness) supplies the agent that edits authored files. The package
supplies context, checks and collaboration records. What the package will and
will not do over the network and to a runtime is stated in the README's
will-not-do and claims blocks; what it does to a source is stated in README
section 4, "The local runtime serves people and agents". Embed or point to
those; do not restate them, because a looser restatement of a boundary is the
failure the public-source rules single out.

Two sentences about agents are both true and must not be confused. About the
workflow: where the checks run in the commit path, every change, by a person
or an agent in the harness, passes the same checks, and that is what makes an agentic process (one where an agent acts inside a
governed workflow) reliable. Do not describe that workflow as agents only
proposing while an owner types the edit; that is neither the design nor the
practice. About the package: its collaboration surface assembles context and
proposals and applies none of them, and the README says so. Do not describe
the package as an editor, autonomous or otherwise.

## Skills guide, gates enforce

Skills carry the workflows an agent runs: opening a source, guiding an
authoring session, running a readiness review, keeping the public boundary.
They are delivered from the package as an audited set of skill files,
installed into a workspace by a plan whose content digest is confirmed before
it applies, and pinned by a lock, so the installed skill files are known and
reviewable. Whether a given harness discovers and follows them is separate
evidence. Enforcement never rests in a skill. Where they are wired into the
commit path or CI, the gates run whether or not an agent followed its
instructions, and they fail closed: the graph check (`atelier graph --check`),
the boundary guard (`atelier boundary check`, installed as Git hooks by
`atelier boundary install-hooks`) and the export validator (`atelier dry-run`).
A Git hook runs only where it is installed
and can be skipped with `git commit --no-verify`; run the same commands in CI
where that matters.

Never write that a skill "bounds", "limits" or "prevents" an agent. A skill
is guidance a model may or may not follow. A gate runs regardless. List gates
by the commands that run them.

## Artifacts are governed, not frozen

Generated artifacts (projected pages, documents built from the graph, a site
built from the same sources) are governed, not forbidden from being touched.
Each carries its source and revision, and a freshness check flags one that has
drifted. Do not write "never hand-edited" or "always generated". Write what
the machinery does: it knows where an artifact came from and says when it no
longer matches.

## Three proofs

Three different things get called "validated". Keep them apart.

- **Conformance.** The export dry-run validator proves an artifact is in the
  published format and every reference resolves to a declared source; the
  README's audience-visibility block states what it refuses across audience
  and visibility. It does not
  prove that referenced content is packaged, and it does not prove that every
  necessary rule was written down. `atelier dry-run <artifact>`
  reports `accepted`, and separately whether the artifact is `importable`.
- **Coverage.** The readiness protocols prove what a record covers against
  an agreed inventory of a complete definition, answer by answer with a
  citation per answer, every gap listed by name. `atelier readiness journey`
  shows each protocol's status and what it still needs, and
  `atelier readiness run PROTOCOL_ID` names each required answer that is
  missing. The responsible people review that coverage; an issuer can record
  its admission decision in an attestation bound to the exact bytes it judged
  (`docs/attestation.md`).
- **Behavior.** Representative inputs and expected results beside each rule,
  run by whatever executes the rule, show that the documented rules do what
  the record says. The package keeps the cases and links them to their rules
  in the graph; it does not run them, so name the runner when you cite this
  proof.

Completeness is coverage plus behavior. No sentence lets one proof stand for
another. "Passes the validator" never means "enough to rebuild from".

## What a universal may claim

Keep a universal only when a mechanism establishes it. "The same files always
produce the same graph" stands because determinism is a tested contract
(`test/graph-determinism.test.mjs`). Replace the rest with the step that makes
the claim true.

| Instead of | Write |
| --- | --- |
| on the intranet the moment it has a header | give a file a header and the next build puts it on the intranet |
| an immutable record | a revision-pinned record that keeps the original contribution beside every later decision |
| a correction made once reaches every artifact | a correction made once reaches every artifact on its next build |
| every file a change affects | every file declared to depend on it |
| the improvement arrives the day it ships | the capability is adopted against the same source and tests: edit the skill, run the checks, keep what passes |
| copying the folder is the backup | a copy of the folder is a copy of the whole record |

## One factual standard

The machinery settles what a sentence may claim it guarantees. An issuer's
approval settles what that issuer commits to and how it frames an offer. When
both meet in one sentence, the commitment reads as a commitment and the
guarantee as a guarantee, and the reader can tell which is which. A sentence
that was approved for one document is not thereby true in the next one.

## The graph is where the work improves

The knowledge graph is an index of what depends on what. It is also the basis
for iterative authoring. By convention each round adds reviewed examples with
expected results, linked to the rules they test. An agent in the harness can
run them against its drafts, revise its work and its instructions where they
fail, and run them again; the package keeps the cases and their links, not the
runner. Say so when describing the graph; an index alone undersells it.

## Extensions, stated as possibility

A website or another tool built on the same graph carries its source and
revision, and can keep its own records in the graph with the decisions made
about them. In package copy
this is what the graph makes possible for an operator's own agents to build,
never a feature list of the package.

## Wording

- "Your local computer or virtual machine", never "this computer".
- American spelling throughout, as the README uses: "artifact", "license", "behavior".
- The public category noun is "local governance toolkit for file-based bodies
  of work".
- Counts are stated by the command that lists them, not by number.
- No speed or ease claims. Show the command.
- Promise, egress, conformance and admission language embeds the block in
  `docs/blocks/`; it is never paraphrased.
- "AI" is a category, not an actor. Name the model, the agent, the harness or
  the system that does the thing.
- "Agentic" is defined where it first appears on a page.
- No client is named and no client's structure is reused. Examples are
  synthetic and are validated against the exact release they ship with.
- Sentence case. Short declaratives.

## Where this came from

These rulings were made while writing about the Atelier and checked by
independent review against the implementation. They are kept here so the next
writer starts from the judgment, not from the wording that happened to
survive.
