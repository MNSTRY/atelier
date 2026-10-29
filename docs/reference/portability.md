# Portability: what a record holds and what the checks prove

An Atelier workspace is meant to be enough for another team to build from,
without rediscovering the work it describes. This page says what a complete
record holds, what each check proves about it, and where the line between the
record and a running product falls. `docs/reference/continuity.md` covers the
package's own continuity commitments; this page covers yours.

## What a complete record holds

| What the record must hold | What another team needs from it |
| --- | --- |
| Rules and calculations | The rules the product applies, their inputs, how each result is computed and interpreted, exceptions and versions. |
| Agent behavior | Instructions, tone, context requirements, permitted actions and example exchanges. |
| Product and interface | Screens and flows, state changes, saved results, access rules, and what one person or a group can do. |
| Content and brand | Copy, published material, design references and assets, with ownership or license terms. |
| Business workflows | Processes, responsibilities, handoffs and approval rules. |
| Data and connections | Your systems' data formats, identifiers, relationships and export instructions, plus the service interfaces and dependencies a replacement would reconnect. |
| Tests and decisions | Representative inputs and expected results, quality criteria, accepted decisions and relevant revision history. |

**Every custom rule has a retained explanation.** If a rule determines a
result, a reply, access or a next step, its meaning belongs in the authored
record, including when software executes it.

## How the record is checked

In three parts. The first two are package commands; the third is not.

The export validator checks conformance: the record is in the published
format and every reference resolves to a declared source. What it refuses
across a source's `audience` and an export's `visibility` is stated in the
README's audience-visibility block.

```bash
atelier dry-run ./atelier-export.json
```

The report says `accepted`, and separately whether the artifact is
`importable`. The validator resolves references to declared provenance
entries, not to packaged content, so it proves the artifact's shape and its
references, not that everything necessary was written down.

The readiness protocols check coverage inputs: a supplied answers file is
checked against each protocol's required inputs, and the missing ones are
listed. An answer being present is not evidence that it is right.

```bash
atelier readiness run PROTOCOL_ID --answers answers.json --project ./atelier.project.json
```

That run is an input-completeness check and is not evidence-bound. For a run
bound to its sources, `atelier review run PROTOCOL_ID --answers answers.json`
records that source-bound run. Accepting one of its claims in the review
workspace checks source linkage. A linked source establishes which
bytes were read, not whether they logically support the proposed claim
(`docs/guides/local-review.md`). The responsible people review coverage; an
issuer can record its admission decision in an attestation bound to the canonical form of the document it
judged (`docs/reference/attestation.md`).

The record also carries its own tests. A complete record gives every
documented rule representative inputs and expected results beside it. The
package keeps these cases and links them to their rules; it does not run them.
Whatever executes the rules runs them, so name that runner when you cite this
check.

Together the three show what has been delivered and what remains unresolved,
in the record rather than in someone's memory. A rebuild also needs the authored
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
