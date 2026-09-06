# Experimental portable coauthor session

Tracked by issue #33. The experimental reducer is exported at
`@mnstry/atelier/coauthor`; the private draft adapter at `@mnstry/atelier/coauthor/store`.
The `atelier coauthor start|read|event|recover` CLI consumes one JSON request on
stdin. Run it from the intended Git workspace; `.atelier-local/` must be ignored
and untracked. The shipped `atelier-guided-coauthor` skill guides harness use.
This local candidate has not been published or accepted by a real author.

The harness supplies a session id and an ordered list of consumer-owned field
ids, each bound to an immutable source reference and SHA-256 digest. The pure
reducer accepts revision-bound events and returns a new state plus effects.
It does not access files, render a browser, contact a model or authorize writes.

An answer remains in history. Every proposed wording change requires explicit
confirmation before saving. Answer-and-continue intent survives confirmation;
advance occurs only after a matching receipt. Pause retains the current phase.
Rejection restores the original answer. Undo of an already saved value is not
implemented: consumers must not advertise it or delete history to simulate it.

## Adapter obligations

- Keep reducer state inside the trusted adapter; untrusted callers submit
  intents, never snapshots or save receipts. Rehydrate from validated events
  with `replaySession`, using the original immutable configuration.
- Authenticate and authorize actors outside this module. Session identifiers
  and matching digests are correlation data, not proof of identity or authority.
- Persist accepted events through the existing consumer ledger. This module's
  in-memory history is a replay projection, not a second durable database.
- Before executing `write-field`, verify source identity and containment and
  apply the consumer's compare-and-swap write policy. Key execution by session
  id plus request id. Retry uses the same key; duplicate delivery must not
  perform another write. Reconcile a pending write after a restart rather than
  blindly replaying historical effects.
- Emit a receipt only after durable persistence and readback of the exact
  target field's UTF-8 value. The receipt binds session, request, field, source
  reference, source digest and value digest. A digest match alone does not
  establish that these adapter duties occurred.
- A failure remains visible. One explicit retry is allowed; subsequent failures
  require adapter reconciliation. A valid late receipt can resolve recovery.
- Persist the accepted receipt event before showing saved state. This module
  grants no canonical publication, release, remote execution or guide access.

The supplied store reuses the collaboration ledger implementation, in a separate
coauthor stream that is never mixed into legacy proposal aggregates. It verifies
contiguous versions and previous-event identity; compaction that drops history
is refused. It writes immutable private draft values, then replays a readback-bound
receipt before showing saved state. It never edits selected source files.
Workspace-local Git checks are the only subprocess use; no network is added.
Operation locks serialize this adapter's writers. A leftover lock requires
operator inspection, never automatic removal of an unknown writer's lock.

`start` takes `{config: {id, fields}}`; `read` and `recover` take `{sessionId}`;
`event` takes `{sessionId, event}`. A receipt or failure event submitted through
the CLI is refused. Source changes block new writes, not reading old history.
Configuration and saved drafts have the additive `atelier-coauthor.v1` schema;
source path containment and duplicate fields are checked by the adapter as well.
