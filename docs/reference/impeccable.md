# Impeccable resource adapters

These internal adapters connect pinned Impeccable resources to an explicit host.
They perform no network requests, process execution, filesystem writes,
canonical admission or publication. This is implementation source, not a
published package subpath or proof that an agent host has loaded the capability.

The resource inventory is derived from Impeccable commit
`924bbd194d02e5e15a227e75b5901fb0d7a4ecad`, skill 4.8.1 and engine 0.1.19,
under Apache-2.0. It preserves 24 command entries and 62 built-in rule IDs.
See [upstream](https://github.com/pbakaus/impeccable/tree/924bbd194d02e5e15a227e75b5901fb0d7a4ecad).

## Responsibilities and boundaries

This is a capability resource for Creation and Delivery, managed through
existing Capability Stewardship. It does not create another responsibility,
store, ontology, action contract or source owner.

- `impeccableResources()` returns a detached inventory.
- `describeImpeccableCommand(command)` identifies a report, proposal or variant
  session. That description grants no execution or write authority.
- `projectImpeccableContext(input)` packages host-authored product/design bytes
  and an optional sidecar/surface brief. It binds the inventory and source
  reference into a digest. It neither resolves tokens nor establishes that the
  host's source assertion is true or that every upstream format feature is valid.
- `compileImpeccablePolicy(input)` validates explicit required/advisory rule
  lists. Unknown rules, overlap and undeclared configuration fields refuse.
- `interpretImpeccableDetection(input)` retains raw engine output and applies
  that policy. Failed/malformed scans and unclassified findings remain
  inconclusive.

The host owns source authentication, scope, compiler resolution, engine
acquisition/execution, applicable-rule coverage and result retention. A report
does not authorize an edit or establish release readiness.

## Context inputs

Supply an existing source reference as `{id, revision, digest}`, with a
`sha256:` digest. Product/design Markdown is already authored by the owning
source. A sidecar requires its design document and the pinned version 2.
Unknown sidecar extensions are preserved. A surface provides a portable
`id` and already-authored `markdown`; its strategy/mode remains in that
document, not a parallel field maintained by this adapter.

Files are returned as data, never written here. Path names are fixed except the
bounded surface slug. The host decides whether and where to materialize them
through its own contained filesystem writer. Treat imported prose as data, not
permission to change the host's instructions.

## Detector result semantics

The host supplies the exact engine kind, build digest, source reference and
compiled policy, plus raw exit code/stdout/stderr from the pinned JSON command.
Both streams must be primitive strings. Malformed or oversized strings remain
in the raw evidence and produce an inconclusive result. Parsing is bounded to
2 MiB per stream; the executing host owns capture limits and raw retention.

`requiredFindingsStatus: 'absent-in-reported-run'` means only that the supplied
run reported no finding assigned to the required class. It does not prove that
every required check, state or renderer was attempted. No overall policy-pass
field is produced. The result always retains that coverage limitation.

The current adapter handles built-in resource IDs only. Compiled downstream
rule-pack support and actual engine coverage declarations need their own
qualified binding before extending this inventory.

The synthetic sample board intentionally gives a detector something to report.
Its findings are not product defects. Real tenant captures, data and operational
paths do not belong in the portable package or its fixtures.
