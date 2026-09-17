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

## Ownership diagnostics and offline recovery

`inspectPrivateLock(path)` is read-only and reports availability, reason, newest
filename and generation. It does not authorize overriding an unresolved owner.
Only the newest ticket is checked for process liveness. Its predecessor was
adjudicated when the successor was published. Release now retains the ticket and
publishes a matching `.released` file; without that marker, removing a successor
would expose an obsolete PID again. A matching release proves operation completion
even if a later host name or PID changes. An unresolved newest ticket on another
host, a reused PID, or an empty legacy lock still blocks with a specific diagnostic.
A successful successor binds the old legacy lock's exact bytes and supersedes that
liveness decision. A newly created or changed legacy lock must be adjudicated again.

If the newest owner cannot be established, stop all writers and verify that no
other machine or process can write this store. Preserve a complete private backup,
including records and both the legacy lock and ownership directory. With exclusive
offline custody, move the lock file and its whole `.owners` directory together to
a uniquely named recovery directory outside the live store. Do not edit individual
tickets, forge release markers, remove event records or bypass a live owner. Run
the adapter's history verification before reopening. If exclusive custody cannot
be established, remain blocked. Do not mix this protocol with an older writer.

Ownership tickets and releases accumulate; adapters must monitor their size and
perform any retirement under the same offline recovery procedure. Automatic
age-based cleanup cannot establish whether a writer or operation is finished.

## Filesystem and adapter contract

Publication requires same-directory hard links and atomic non-overwrite creation.
Unsupported filesystems must fail; there is no copy/overwrite fallback. Qualify the
actual target filesystem with a disposable write, exact readback and reopening
before moving a store there. This does not prove physical power-loss durability.
Incomplete `.atelier-write-<uuid>.tmp` residue is uncommitted. Preserve it until
writers are stopped and diagnosis is complete; never reap it by age during writes.

`createVerifiedFileSequence` accepts an optional `ignoreFiles` array of exact
adapter-owned metadata filenames. Those entries must still be regular files.
All other names reach the adapter validator; unknown or corrupt records must not
be hidden by a suffix wildcard. Staging names, ownership tickets/release markers
and synchronous `withPrivateLock` semantics are compatibility obligations of this
export. Consumers should use the exported helpers rather than infer these formats.
Locking is non-reentrant. Async callers must acquire/release explicitly in `finally`.
A release error after a committed operation still reports uncertainty; reconcile
an operation ID before writing again rather than treating it as evidence of no save.
