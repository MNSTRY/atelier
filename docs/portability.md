# Portability: what a record holds and what the checks prove

An Atelier workspace is meant to be enough for another team to build from,
without rediscovering the work it describes. This page says what a complete
record holds, what each check proves about it, and where the line between the
record and a running product falls. `docs/continuity.md` covers the
package's own continuity commitments; this page covers yours.

## What a complete record holds

| What the record must hold | What another team needs from it |
| --- | --- |
| Method and assessments | Questions, answer formats, scoring formulas, interpretation rules, exceptions and versions. |
| Companion behavior | Instructions, voice, session stages, context requirements, permitted actions and example conversations. |
| Product and interface | Screens and journeys, state changes, saved results, access rules, individual and shared participation. |
| Content and brand | Readings, practices, copy, design references and assets, with ownership or license terms. |
| Business workflows | Offers, campaign instructions, intake and follow-up processes, responsibilities and approval rules. |
| Data and connections | Your systems' data formats, identifiers, relationships and export instructions, plus the service interfaces and dependencies a replacement would reconnect. |
| Tests and decisions | Representative inputs and expected results, quality criteria, accepted decisions and relevant revision history. |

**Every custom rule has a retained explanation.** If a rule determines a
score, a reply, access or a next step, its meaning belongs in the authored
record, including when software executes it.

## How the record is checked

Against a published standard, in three parts.

The export validator checks conformance: the record is in the published
format, every reference resolves to a declared source, and no reference
reaches outside the audience the export declares.

```bash
atelier dry-run ./atelier-export.json
```

The report says `accepted`, and separately whether the artifact is
`importable`. The validator resolves references to declared provenance
entries, not to packaged content, so it proves the artifact's shape and its
references, not that everything necessary was written down.

The readiness protocols check coverage: an agreed inventory of what a complete
definition contains, each answer citing the record it was taken from and each
gap listed by name. The responsible people review that coverage, and an
attestation records the review bound to the exact bytes it judged
(`docs/attestation.md`).

```bash
atelier readiness --project ./atelier.project.json
```

The record also carries its own tests. Every documented rule has
representative inputs and expected results beside it, so the behavior the
record describes is checkable from the record alone, by anyone who holds it.

Together the three establish what has been delivered and what remains
unresolved, and nothing is left to memory. A rebuild also needs the authored
rules, their representative tests, the data exports, the dependencies and the
operating instructions, reviewed together against the agreed scope. No
validator can supply that review.

## The dividing line

If it describes how the work is done, it is a file in the Atelier. If it
records what happened to a particular person, or has to be enforced at the
moment of use, it lives in a product runtime. A folder of files cannot
decide, while two people are in a session, which of them may see what;
cannot hold a payment; and cannot be the consistent, recoverable record when
several parties write at once.

The Atelier holds how the work is done and the documentation of your systems'
data: formats, identifiers, relationships and export instructions. Records
about particular people live in the systems you run. What the package will
and will not do toward any runtime is stated once, in the README's
will-not-do block; this page adds nothing to it.

## Copying the record

The repository is the store, Git is the history, and a copy of the folder is a
copy of the whole record. A copied folder carries the record and its history,
not remote data or assets stored elsewhere; the data-and-connections row above
is where those are described so a replacement knows where to look.
