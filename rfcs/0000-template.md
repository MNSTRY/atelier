# RFC-0000: <Short Descriptive Title>

- **Status:** Draft | Proposed | Accepted | Rejected | Superseded
- **Author:** <Name or GitHub handle>
- **Created:** YYYY-MM-DD
- **Target surface:** Core | Contracts | Runtime | Harnesses | UI | Adapters

## Summary

One concise paragraph explaining the proposed change and why it belongs in `@mnstry/atelier`.

## Motivation & Problem

What real workflow, invariant, or consumer problem does this solve? Include concrete reproduction steps or evidence.

## Proposed Design

- Exact CLI, API, or schema changes.
- Stability tier (`stable`, `beta`, or `experimental`) per `contracts/stability-manifest.v1.json`.
- How this preserves fail-closed boundaries, offline conformance, and zero undocumented egress.

## Compatibility & Migration

- Does this widen any closed schema outside `ext`? (If yes, a new major contract version + migration record is required.)
- Which downstream consumer classes (`docs/maintainers/consumer-compatibility-matrix.md`) are affected?
- Exact upgrade and rollback path.

## Security & Disclosure Review

- New network paths, subprocesses, or file-system writes (if any).
- Synthetic positive and negative regression tests that will prove the change.

## Alternatives Considered

What simpler approaches were evaluated and why were they declined?
