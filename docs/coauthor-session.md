# Experimental portable coauthor session

Tracked by issue #33. This source-only adapter seam is not yet a published
package export or an installed authoring experience.

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

Integration must reuse the existing review/ledger owner. Shared package exports,
CLI wiring, schema-corpus admission, release versioning and installed-consumer
proof remain separate work. No live authoring adapter is included here.
