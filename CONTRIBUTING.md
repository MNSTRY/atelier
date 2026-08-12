# Contributing to MNSTRY Atelier

Come with care, bring what is alive, protect what is entrusted, and help make
the Atelier more useful than any of us could make it alone.

This document is the working agreement for contributions. It is written to be
read once and relied on: what you keep, what the project keeps, what is
welcome, and what will be refused. It applies to everyone equally: there is
no separate arrangement for invited collaborators, and none for MNSTRY.

## The license terms: inbound equals outbound

Contributions are accepted under exactly the license this project gives you:
**Apache-2.0, in and out.** By contributing you license your contribution to
the project and to every downstream recipient under Apache-2.0 — and nothing
more. There is no contributor license agreement, no copyright assignment, and
no side letter granting MNSTRY rights that you do not also receive.

Be aware of what that symmetry means, in both directions. Apache-2.0 is a
permissive license: MNSTRY may include your contribution in commercial
products, and so may anyone else, including you. If you are not comfortable
with that, do not contribute the material — use it in your own workspace
instead, where it stays entirely yours.

MNSTRY deliberately reserves no dual-licensing rights over contributions.
Anything MNSTRY can do with your contribution, Apache-2.0 is what permits it.

## Certifying your contribution

Every commit must carry a Developer Certificate of Origin sign-off:

```bash
git commit -s
```

This adds a `Signed-off-by:` line certifying, under DCO 1.1
(<https://developercertificate.org>), that you wrote the contribution or
otherwise have the right to submit it under Apache-2.0, and that you
understand the contribution and its record are public and permanent. Sign
with a real identity you are entitled to use. Unsigned commits are not
merged.

## Protect what is yours before you contribute

The Atelier exists so people can author private material safely. That cuts
both ways for contributors:

- **Never contribute client material.** No client names, content, structures,
  or identifying details — including in test fixtures, comments, examples, or
  commit messages. The repository gates scan for disclosure patterns and
  fail closed, but the gates are a backstop, not permission to be careless.
- **Never contribute your own private methodology by accident.** A bug
  report, fixture, or example distilled from your real work can carry your
  method's structure with it. Fictionalize first: the `sample-workspace`
  fixture and the `examples/loomworks-studio` distribution show the pattern —
  invented brands, invented content, real mechanics. If a fixture needs a
  realistic shape, invent the shape.
- **No secrets, ever.** No key material, tokens, or credentials in any form,
  including "obviously fake" ones — the scanners treat key-shaped material as
  key material on purpose.
- **No absolute home paths** in code, fixtures, or commit messages; the
  full-history sweep refuses them. Build test paths at runtime.

## What is welcome

- Bug reports and fixes — a fix lands with the failing case as a permanent
  test. This project's standing rule is that every demonstrated defect
  becomes a regression test; contributions follow it too.
- Tests that sharpen an existing guarantee, especially adversarial ones.
- Documentation corrections and clarity improvements.
- Fictional fixtures that exercise real mechanics.
- Extension packs and distributions in your own repositories — these are
  yours and need no contribution at all; `docs/distributions.md` is the
  contract.

## What needs a conversation first

Open an issue before writing code for any of these — they carry obligations
a pull request cannot see:

- **Contract changes.** The published contracts are under a stability epoch:
  widening outside `ext` containers is refused by the compatibility gate, and
  breaking changes require a new contract version with a recorded migration.
  A contract PR without that conversation will be declined regardless of
  quality.
- **New runtime dependencies.** The package ships with two and intends to
  keep it that way.
- **Anything touching the guards** — the egress gate, disclosure scanners,
  boundary guard, or release audit. Changes here need an adversarial review,
  not just a green suite.
- **New network behavior of any kind.** The correct amount is none; the
  egress gate enforces it.

## The quality bar

Before submitting, run what CI runs:

```bash
npm run syntax:check
ATELIER_ALLOW_MISSING_DENYLIST=1 npm test
npm run contract && npm run contract:compat
npm run egress:check && npm run repo:check && npm run migrations:check
```

All gates green is the entry condition, not the goal — tests that prove the
change is the goal.

## Attribution

Contribution history is public attribution: your commits carry your name
permanently, and that record is the durable credit. The `NOTICE` file remains
MNSTRY's attribution statement and is not extended per contributor. Where a
contribution meaningfully shapes a document or design, maintainers may credit
it in prose — and will ask first, because attribution that exposes someone's
private work or unwanted visibility protects the person first and the credit
second.

## Names and marks

Contributing grants no rights to the MNSTRY or MNSTRY Atelier names or marks.
`TRADEMARKS.md` governs naming, truthful references, and distribution
attribution. You may accurately say you contributed; you may not imply
affiliation, endorsement, or official standing.

## What the private preview left behind

This repository was developed in private preview before it was made public.
Everything in the repository at the moment it went public is public, and no
confidentiality obligation attaches to any of it. What survives is narrow and
specific: material shared with preview collaborators that MNSTRY has *not*
published — unreleased plans, private correspondence, anything shown in
confidence outside the repository — stays confidential. That obligation never
restricted what was always yours: your own work, made with the Atelier, in
your own repositories.

## If your commit access ends

Commit access can end — by your choice or MNSTRY's. What that does and does
not change:

- Everything you lawfully received stays yours under Apache-2.0, per
  `docs/continuity.md`. Nothing is clawed back.
- Your merged contributions remain in the project under Apache-2.0, with
  your authorship intact. They are not removed, and cannot be, retroactively.
- You keep every right any other member of the public has, which — this
  repository being public and Apache-2.0 — is every right that matters:
  read it, fork it, build on it, ship it.

## Disagreements and boundary violations

Raise problems directly — a feedback report or an issue, plainly stated.
Maintainers decide what merges; that decision is final for this repository,
and the fork rights in Apache-2.0 are the structural check on it: if you
believe the project is wrong, the license guarantees your right to prove it
elsewhere. Boundary violations — leaked client material, disclosed private
methodology, secrets in history — are handled immediately and without
negotiation: the material is expunged, the gates are widened to catch the
class, and access may end. If your own material is what leaked, say so
fast; expunging early is cheap and late is not.

---

These terms are a working agreement, not a substitute for the license: where
they and `LICENSE` diverge, the license controls. Questions about them are
themselves welcome contributions.
