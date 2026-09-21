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
installed IANA timezone data. Native schedulers retain calendar ownership and
must qualify their mappings, including timezone database version where needed.

`releaseTrackable` validates and hashes a definition. Releasing new bytes does
not change existing instances. `adopt` requires a later compatible revision and
an explicit effective instant; it refuses changes that reinterpret recorded
occurrences. Late reports resolve the definition applicable at occurrence time.
DST changes preserve local-day identity. A timezone change uses a new definition.

The immutable journal records every command, actor assertion, recording time,
source time and resulting state digest. Corrections preserve original events and
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

## Authoring and host adoption

Definition fields `profile` and `schedule` are enforced by the reducer and
occurrence resolver. `id` and `revision` pin meaning; `purpose` is rationale;
`interpretationLimits` are surfaced guidance. The engine revision appears in
release and view outputs. Host binding must additionally name immutable source
resolution, authentication, operation authorization, evidence-source validation,
storage and rendering. Caller-supplied source digests are provenance assertions,
not proof that a session or instrument reported them.

Reference tests exercise preview/runtime parity, durable reload, scoped stores,
correction, duplicate transport/source events, same-day instances, late evidence,
DST and timezone adoption. These establish the portable subset. Authenticated
member-host adoption, actual UI refresh and broader calendar profiles require
separate receiving-host evidence.
