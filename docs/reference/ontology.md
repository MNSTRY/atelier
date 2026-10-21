# Atelier export ontology

The public vocabulary of the `atelier-export@v1` contract: the nine runtime
owner terms, the object classes and export collections they govern, the six
runtime targets an export may address, and the boundary between local
`audience` and runtime `visibility`. Everything on this page is defined by
the published schemas and the dry-run validator that ship in this package.

## MNSTRY's format, offered openly

The Atelier export format is MNSTRY's format, offered openly. Conformance is
public and offline: the contracts, fixtures, and dry-run validator are all in
this package, and anyone can check a document against them without a MNSTRY
account, a network connection, or MNSTRY's involvement. Admission is a
separate and narrower decision: MNSTRY's private validator only ever decides
admission into a MNSTRY runtime. It never redefines conformance, and a
document it declines can still be fully conformant. Nothing in this
vocabulary requires MNSTRY approval to use.

## How ownership is declared

An export document declares, in `importPlan.runtimeOwners`, which runtime
owner governs each object class it ships. An owner is an area of runtime
authority — a named accountability for a category of governed records — not a
module, a table, or a service. The owner enum is closed:

`identity`, `catalog`, `commitments`, `events`, `projection`, `consent`,
`messaging`, `providers`, `audit`

Ownership assignments are made per document and reviewed at admission. The
mapping from export collections to runtime targets, by contrast, is fixed by
the contract and is not negotiable per document.

Two namespace notes, because the same words appear at different levels:

- The owner `consent` and the object class `consent_boundary` are different
  namespaces. The class names a kind of exported object; the owner names the
  runtime authority that governs objects of that kind.
- The owner `projection` and the local generated projection are different
  things. The local projection is a development preview of source material on
  your machine; the owner term names the runtime authority over what is
  actually shown to people.

## The six runtime targets

Every export collection maps to exactly one runtime target. Any declared
target field anywhere in a document (`runtimeObject`, `targetObject`,
`targetClass`, and their snake_case forms) must name one of these six values;
anything else is a semantic-profile violation.

| Runtime target | Meaning | Export collections |
| --- | --- | --- |
| `content.material` | Readable and renderable content | `offers`, `surfaces`, `sdui` |
| `core.artifact` | Reviewable records and documents | `consentBoundaries`, `staffPrep`, `providerEgress` |
| `core.trackable` | Measurable signals over time | `trackables` |
| `scheduling.commitment` | Commitment paths and scheduled steps | `commitmentPaths` |
| `space.space` | Spaces where activity happens | `spaces` |
| `space.provision` | Provisioning of a space or provider capacity | (declared directly by readiness mappings) |

The same mapping applies to import object classes: `offer`, `public_surface`,
`surface`, and `sdui_block` target `content.material`; `commitment_path`
targets `scheduling.commitment`; `space` targets `space.space`; `trackable`
targets `core.trackable`; and `consent_boundary`, `staff_prep`, and
`provider_egress` target `core.artifact`.

## Audience and visibility

These are two different vocabularies and the contract keeps them apart.

**Audience** is local readership: `public`, `team`, `operator`, `staff`,
`private`, `sensitive`. It classifies who source material is written for and
whether it is eligible for projection. It is not a security boundary —
repository access is the read boundary, and an audience label does not hide a
file from anyone who can read the repository. Provenance source nodes carry
`audience` and never `visibility`.

**Visibility** is runtime authority: `private`, `shared`, `platform`,
`public`. It is a security boundary on governed runtime objects, and the
runtime default is private. Export objects carry `visibility` and never a
local audience value.

The validator enforces the separation in both directions: a local audience
value appearing in a `visibility` field is rejected, a `visibility` key on a
source node is rejected, and any object with public visibility must resolve
its source references exclusively to public-audience source nodes.

## The nine owner terms

Each section gives the term's definition, what it governs in an export
document, and what admission review checks for material assigned to it. The
"governs" lists describe the characteristic assignments made by the bundled
readiness protocols and the sample fixtures; a document may propose others,
and the proposal is what admission review reviews.

### identity

Runtime authority over who someone is: accounts, actors, roles, and the link
between locally described actors and governed identity records.

Governs: no export collection creates identity records. Identity-owned
material arrives as review artifacts (`staffPrep` entries targeting
`core.artifact`) that describe actors and their roles.

Admission review checks: every actor description carries source evidence and
a declared owner; role claims trace to sources; nothing in the document
creates or mutates an identity record.

### catalog

Runtime authority over what is offered: offers, their components, and their
pricing.

Governs: `offer` objects (the `offers` collection, targeting
`content.material`).

Admission review checks: pricing uses ISO-4217 currency codes and integer
minor-unit amounts; every offer component carries an approval status; a
public offer resolves only public-audience sources.

### commitments

Runtime authority over what participants commit to: commitment paths and the
scheduled steps inside them.

Governs: `commitment_path` objects (the `commitmentPaths` collection,
targeting `scheduling.commitment`).

Admission review checks: the plan is dry-run only — no scheduling writes;
every step is present as reviewable material rather than an instruction to
execute.

### events

Runtime authority over what happened: measurable signals recorded over time.

Governs: `trackable` objects (the `trackables` collection, targeting
`core.trackable`).

Admission review checks: every trackable declares a runtime owner and a
proposed runtime visibility; no local audience value leaks into a visibility
field.

### projection

Runtime authority over what is shown: surfaces, generated display blocks, and
the presented shape of spaces.

Governs: `public_surface`, `surface`, and `sdui_block` objects (the
`surfaces` and `sdui` collections, targeting `content.material`), and
presentation-side `space` material.

Admission review checks: public surfaces resolve exclusively to
public-audience source nodes; the visibility gate defaults to private with a
public-only source policy; an export from a dirty working tree must declare
`forced: true` and carry a non-empty taint list.

### consent

Runtime authority over what has been agreed to: consent boundaries and their
exceptions.

Governs: `consent_boundary` objects (the `consentBoundaries` collection,
targeting `core.artifact`).

Admission review checks: boundaries default to private visibility; every
exception is visible to audit; consent material fails closed — missing or
ambiguous consent evidence blocks rather than warns.

### messaging

Runtime authority over what is sent to people: outbound messages and
notifications.

Governs: no bundled export collection maps to messaging. The term exists in
the owner enum so a document can propose messaging ownership for review — for
example, a journey handoff that would eventually notify a participant.
Nothing in this format sends anything.

Admission review checks: messaging-owned material is proposal-only; the
document demonstrates that no send occurs locally and that any eventual send
would be governed at the runtime.

### providers

Runtime authority over external service relationships: provider egress and
the provisioning behind spaces.

Governs: `provider_egress` objects (the `providerEgress` collection,
targeting `core.artifact`) and provisioning review material targeting
`space.provision`.

Admission review checks: egress is declared, never performed; each declared
provider crossing names its provider class and is individually reviewable.

### audit

Runtime authority over the record of decisions: evidence, review trails, and
the trackables that prove a review happened.

Governs: review artifacts (`staffPrep` entries targeting `core.artifact`) and
review-trail trackables (the `trackables` collection, targeting
`core.trackable`).

Admission review checks: decisions leave a trail; evidence references resolve
to provenance source nodes or to export objects that themselves carry
provenance; nothing is silently dropped.
