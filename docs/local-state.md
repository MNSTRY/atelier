# Durable local state

`@mnstry/atelier/local-state` provides filesystem mechanisms for local adapters.
The adapter owns paths, schema, content, transport, authentication, state limits,
and user-facing recovery. These helpers do not create a service or publish data.

- `publishPrivateFile(path, bytes)` stages and syncs bytes, publishes with an
  atomic non-overwriting hard link, syncs the directory, and verifies readback.
  An identical existing file is an idempotent success. A differing file refuses.
- `acquirePrivateLock(path)` returns an idempotent release function. Callers must
  release in `finally`, after all asynchronous work has finished.
- `withPrivateLock(path, operation)` is for **synchronous** operations only.
- `createVerifiedFileSequence({directory, initial, apply})` reads immutable
  records in filename order. `initial()` creates reducer state and
  `apply(text, previous, oneBasedIndex, filename)` validates each record and
  returns the next state. The adapter validates names, chain, schema and limits.
  Unchanged prefixes reuse their validated result; file identity and timestamps
  are checked on each call. Startup verifies the complete history.
- `isPendingPrivateWrite(name)` recognizes incomplete staging names. They are
  never committed records. Preserve them for diagnosis after interruption.
- `syncPrivateDirectory(path)` flushes a directory where supported. Windows
  directory durability requires target-filesystem qualification; synced file
  contents alone do not prove survival of power loss.

Use an ignored private directory whose ancestors have already been validated.
Leaves refuse symlinks. These are local integrity mechanisms, not a sandbox
against an actor able to rewrite the same user's files or filesystem metadata.
Do not run old and new writer implementations concurrently against one store.

## Recovery and compatibility

Locks use atomic numbered ownership tickets. A definitely absent local process
can be succeeded without deleting its ticket. Contending recoverers compete for
the same next number. Live, reused, foreign-host and unverifiable process IDs
block. No elapsed timeout grants ownership. The nonce binds release to the
exact ticket. Legacy PID-only lock records can be bypassed only when the PID is
definitely absent; unidentified legacy locks require operator diagnosis.

Process interruptions can leave staging files or dead-owner tickets. Retain
these as evidence. Never clear an entire private-state directory to recover a
single interrupted operation. A corrupted committed record is still an error;
the reader does not silently skip or truncate it.

The collaboration ledger retains its existing bounded NDJSON format but writes
each complete validated successor atomically. Coauthor and intake reuse the
same ownership protocol. Immutable intake blobs and coauthor values use atomic
publication. Existing history is not rewritten by these changes.

Adapters should bind retries to the same operation identity and exact input,
retain newer edits while an earlier save is pending, measure limits in UTF-8
bytes, and verify runtime build identity before declaring an existing service
current. Opening a previously verified artifact must not require optional graph
or projection generation to succeed.

## Evidence boundaries

Local tests inject interruption before publication, verify the previous ledger
remains readable, restart after an owner exits without releasing, refuse live
and unknown owners, verify binary readback, and exercise cache invalidation.
These are process-interruption tests, not physical power-loss qualification.
No cache promises constant memory or constant metadata work for unbounded
history. A different checkpoint format needs its own migration and replay proof.
