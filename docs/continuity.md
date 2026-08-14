# Distribution continuity commitment

Anyone building on this package needs to know their access cannot be revoked
by a repository permission change. This document is MNSTRY's answer, and it is
written to survive skeptical reading.

## What the license already guarantees

Every copy of this package you have received is licensed under Apache-2.0.
That grant is perpetual and irrevocable for the copy you hold: nothing MNSTRY
does later — repository changes, relicensing of future versions, commercial
disagreements — removes your right to use, modify, and redistribute the
version you received, subject only to the license's own terms (including the
NOTICE attribution obligation and the trademark limits in `TRADEMARKS.md`).

## What MNSTRY commits to beyond the license

1. **Source grant on every tag.** Every tagged release that MNSTRY
   distributes to a collaborator or partner is theirs to keep. If your access
   channel is the Git repository and that access ever ends, you retain every
   tag you fetched, with full Apache-2.0 rights over it. MNSTRY will not ask
   for deletion of received tagged source and has no license mechanism to do
   so.
2. **npm publication.** Tagged releases are published to the npm registry
   under `@mnstry/atelier` with public access, making the registry — not
   repository permission — the distribution channel of record.
3. **Contract compatibility by machinery.** From tag `v0.2.0-alpha.0`
   onward, the published contracts are under a compatibility gate
   (`npm run contract:compat`): documents valid against the baseline tag must
   stay valid, and schema widening outside `ext` containers is refused by a
   schema-vs-schema differ. Breaking changes require a new major contract
   version, recorded in `CHANGELOG.md` under a **Breaking** bullet and in the
   migrations map.
4. **Conformance stays offline.** Validating documents against the published
   contracts requires only this package and never a MNSTRY service. No future
   version will make offline conformance depend on a network call — that is
   enforced by the egress gate, not promised by intention.

## What this document does not promise

- It does not promise that unreleased work, private extension packs, or
  MNSTRY's runtime services are or will become open.
- It does not promise support, maintenance windows, or acceptance of
  contributions.
- It does not grant trademark rights; `TRADEMARKS.md` governs naming.

## Verifying instead of trusting

- The license grant: `LICENSE` (Apache-2.0, section 2 — "perpetual,
  worldwide, non-exclusive, no-charge, royalty-free, irrevocable").
- The compatibility gate: `scripts/check-contract-compat.mjs` and
  `contracts/compat-baseline.json`.
- The offline-conformance property: `npm run egress:check` and the served-CSP
  assertions in the test suite.
