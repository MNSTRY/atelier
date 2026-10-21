# Contract stability

How the Atelier contracts evolve without breaking pinned consumers: the
stability epoch, the `contractVersion` field, the reserved `ext` extension
containers and their must-ignore rules, the widening ban, the deprecation
policy, and the compatibility gate that enforces all of it mechanically.

## The stability epoch

The contracts underwent one sanctioned flag-day break — the epoch. All
breaking surgery landed together, before the next release tag: the
vendor-neutral runtime owner vocabulary, the `ext` containers, the optional
`contractVersion` field, the claim provider addition, and the schema const
alignments. The individual changes are listed in the changelog.

The first tag cut after this surgery is the epoch baseline. The compatibility
gate pins to it through `contracts/compat-baseline.json` and is deliberately
inert — a clean pass with a notice — until that tag exists.

From the epoch onward the rule is mechanical: any change that widens the
accepted document space outside `ext` is a new major version, and the gate
enforces this automatically, because validators pinned to the baseline reject
widened documents.

## Contract version

Every document contract declares an optional root `contractVersion` field:

- Type: string matching `^1\.[0-9]+\.[0-9]+$`.
- Semantics: the contract revision (major.minor.patch) the producer targeted.
- The major digit must equal the schema's `@vN` suffix.
- Absence means `1.0.0`.
- Producers should emit it; validators must not require it.

Schemas are not republished per revision. The `schema` consts stay `…@v1`;
each schema root carries a `$comment` naming the current revision (for
example `contract revision 1.1.0 (contract-stability epoch)`), which is the
machine-visible revision marker.

## Extension containers

Every object subschema that closes itself with `additionalProperties: false`
— the root and every nested closed object — declares an optional `ext`
property of type object. `ext` never appears in `required`. This placement is
uniform across all contracts and is enforced by the contract hygiene test, so
new contracts pick up the rule automatically.

`ext` is the only sanctioned place for data the contracts do not define.
Producers may add namespaced members; vendor-prefixed keys are recommended.
Contents are not validated at v1 and carry no authority over first-class
fields.

## Must-ignore rules

- Documents are closed at every level except `ext`. Unknown properties
  outside `ext` are rejected — typo safety is a feature, not a bug.
- `ext` members must be ignored by consumers that do not recognize them, must
  not alter the meaning of first-class fields, and must not be required to
  interpret the document.
- Safety scanners are exempt from must-ignore. The dry-run validator's
  mutation-intent, target-field, and source-reference scanners descend into
  every nested object, including `ext`, and fail closed. A mutation flag or
  an unsupported runtime target hidden inside `ext` is still a refusal;
  must-ignore never suppresses a refusal.

## The widening ban

A v1 revision may tighten constraints or add semantics carried in `ext`;
anything that widens the accepted document space outside `ext` is a new
major. Widening includes adding enum values, opening a closed object, adding
optional first-class properties, and relaxing a pattern or a bound. The
compatibility gate turns this policy into a mechanical check: a widened
document fails validation under the baseline's validators.

## Deprecation policy

- Deprecating a field or value starts with a dated notice in the docs, at
  least one minor revision before any behavioral change.
- Deprecated fields keep validating for their entire deprecation window.
- Removal — or any other change that rejects previously valid documents —
  happens only at a major version.

## The compatibility gate

`scripts/check-contract-compat.mjs` (npm script `contract:compat`) validates
the current document corpus against the validators of a past release:

1. Resolve the baseline: a `--baseline <ref>` override, else the
   `baselineTag` in `contracts/compat-baseline.json`. A null `baselineTag`
   means the epoch is not yet tagged; the gate prints a notice and passes.
2. For each corpus entry, fetch the old schema from the baseline ref.
   Contracts that do not exist at the baseline are reported as new since
   baseline and skipped — new contracts are always admissible.
3. Compile the old schema and validate the current corpus against it: valid
   fixtures, registered sample documents, and generated documents such as the
   bundled readiness protocols. Generated documents are the ones most likely
   to drift, so they are always included.
4. Any rejection names the fixture, the contract, and the baseline, and fails
   the gate.

A self-consistency test runs the same plumbing with the working tree as its
own baseline, so the machinery is proven even while the gate is inert.

## Baseline procedure at release time

Cutting a release tag updates `contracts/compat-baseline.json` in the release
commit, setting `baselineTag` to the tag being cut, and runs
`npm run contract:compat` as part of the release checks. During the following
development cycle the gate therefore validates the evolving corpus against
the most recent release's validators. The first tag after the epoch is the
first baseline; before it exists, the gate stays inert.
