# Trackables: one definition, one domain writer

A Trackable follows an identifiable subject or pursuit over time. Its adopted
definition, instance, occurrences, evidence and qualified views retain separate
meanings. Following a practice, completing a milestone and recording a reflection
use different profiles. A recorded result does not establish independent ability.

The portable `@mnstry/atelier/trackables` API exports one domain reducer used by
`previewTrackable` and the private `createTrackableStore` reference adapter.
Product hosts adapt this reducer through their existing authenticated domain
writer. They must not copy member state into a Witness-specific store.

## Supported reference profile

| Profile | Occurrence | Evidence | Domain fulfillment |
| --- | --- | --- | --- |
| Recurring practice | Local calendar day in an explicit IANA timezone | Completed, partial, skipped, waived, not applicable | Separate from completing an occurrence |
| Milestone | One opportunity for the adopted definition | Same explicit result states | Explicit open, fulfilled or released disposition |
| Qualitative series | Unscheduled source event | Attributed text observation | Unscored |

Missing evidence is `unobserved`, never zero or automatic failure. Several
matching reports of one occurrence count once; conflicting reports remain
`disputed`. Manual and session records retain separate source identities and
assistance. A source event cannot be recaptured under another evidence ID for the
same instance. Different instances and days remain distinct.

This bounded profile supports daily calendars, not arbitrary recurrence,
quantitative meters, streaks or a universal progress score. It uses the host's
installed IANA timezone data for new records, previews and current windows.
Journal replay preserves each recorded occurrence's original local day. Native
schedulers retain calendar ownership and
must qualify their mappings, including timezone database version where needed.

`releaseTrackable` validates and hashes a definition. Releasing new bytes does
not change existing instances. `adopt` requires a later compatible revision and
an explicit effective instant; it refuses changes that reinterpret recorded
occurrences. Late reports resolve the definition applicable at occurrence time.
DST changes preserve local-day identity. A timezone change uses a new definition.

The immutable journal records every command, actor assertion, recording time,
source time and resulting state digest. New events use `atelier-trackable-event@v2`;
record events also pin the resolved occurrence, source instant/reference and host
timezone-data version (`null` if unavailable). Replay checks these against the
adopted definition, scope, instance and command, without recalculating the stored
local day. Event-chain and resulting-state digest checks still apply. This is
local integrity checking, not authentication of the host calendar or recorder.
Corrections preserve original events and
invalidate dependent fulfillment evidence. Lifecycle, domain fulfillment,
evidence quality and attention remain independent. Pausing prevents new capture;
retirement is terminal. Views describe current corrected knowledge about the
selected occurrence time, not historical knowledge as it was then understood.

## Local use and ownership

Run `atelier trackable preview|release|execute|snapshot|view|export` with JSON stdin.
The existing workspace must ignore `.atelier-local/`. Local identity is asserted,
not authenticated. `scope` selects a private store; operating-system access is
its trust boundary, so this is not multi-tenant access control. Exports are
private and require deliberate handling. Withdrawal and correction retain
history; this adapter does not claim secure erasure or automated retention.

A command has `schema: "atelier-trackable-command@v1"`, `requestId`,
`expectedRevision`, `operation` and `input`. Operations are `release`,
`instantiate`, `adopt`, `record`, `correct`, `lifecycle` and `disposition`.
The exported [schema](../contracts/atelier-trackable.v1.schema.json) and
[fixtures](../fixtures/atelier-trackable) specify exact fields.

`execute` locks the selected scope, verifies history, applies the shared reducer,
atomically publishes one event and reads it back. Replaying the same request and
actor returns the original receipt; changed input under that identity refuses.
A lost response can therefore be reconciled by retrying the original command.
Dead process locks use the existing private-state custody mechanism. Journal
capacity reserves room for correction and retirement; full histories remain
available for explicit export. No automatic archive or compaction is performed.

Older `atelier-trackable-event@v1` events remain readable and can precede new v2
events without rewriting history. They lack the original calendar observation,
so replay still needs compatible timezone data. If replay of a legacy record
produces a different state digest, snapshot, view and execute refuse.
`exportHistory()` remains available after verifying the full event chain and
returns `stateVerified: false` plus `replayError`; these raw events are not a
verified reconstructed state. Restore the original calendar environment before
resuming that store. Do not infer a timezone change from this diagnostic alone,
or rewrite old digests to make them pass. Other replay and integrity failures
still refuse; a valid reconstruction exports `stateVerified: true`.

## Authoring and host adoption

Definition fields `profile` and `schedule` are enforced by the reducer and
occurrence resolver. `id` and `revision` pin meaning; `purpose` is rationale;
`interpretationLimits` are surfaced guidance. The engine revision appears in
release and view outputs. Host binding must additionally name immutable source
resolution, authentication, operation authorization, evidence-source validation,
storage and rendering. Caller-supplied source digests are provenance assertions,
not proof that a session or instrument reported them.

The reducer's optional `occurrenceResolution` context is for replay of a
previously verified journal, never user-authored command input. Native writers
that use it must persist and verify the command, complete resolution and state
digest together. The local adapter derives it from the new state and never
accepts a caller override. Existing recorded evidence keeps its occurrence when
current rules change; new evidence and the current-window view can consequently
resolve the same instant to a different day. The API does not silently merge or
reinterpret those occurrences.

Reference tests exercise preview/runtime parity, durable reload, scoped stores,
correction, duplicate transport/source events, same-day instances, late evidence,
DST, timezone adoption, simulated timezone-data drift, legacy export-only
recovery and refusal of inconsistent replay metadata. These establish the portable subset. Authenticated
member-host adoption, actual UI refresh and broader calendar profiles require
separate receiving-host evidence.
