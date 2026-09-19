# Managed local services

Atelier-backed repositories sometimes need a local authoring, review, or
preview service that writes repository-owned state. The service may be
specialized; its lifecycle and data-boundary behavior should not be improvised.

This contract applies to consumer services other than `atelier dev`. It does
not change the Atelier sidecar's own lifecycle.

## Atelier sidecar reference boundary

The built-in `atelier dev` sidecar is the reference for its request and
publication boundary, not for the managed lifecycle below. It binds only to a
literal loopback host and refuses startup without a valid generated
`atelier.manifest.json`. Static reads are limited to manifest-enrolled,
supported file types after realpath containment; hidden, state, secret-shaped,
symlinked, unknown, and unenrolled paths are denied. API reads require a trusted
loopback host and `Sec-Fetch-Site: same-origin` or `none`; `same-site` and
cross-site requests are refused. Mutations additionally require an
allowed method, exact expected origin, and the session nonce. Its collaboration
records are copy-only proposals, not an apply channel.

## Kit and adapter boundary

The portable Atelier layer owns these invariants:

- bind to loopback only;
- expose explicit `start`, `status`, and `stop` operations;
- detach only when the user asked for a service that survives an agent command;
- identify the running process with both a random runtime identifier and its
  process ID;
- refuse to adopt, overwrite, or stop a process whose identity cannot be
  proven;
- keep runtime records, logs, drafts, and recovery copies in ignored local
  storage with owner-only permissions;
- make writes atomic and keep a failed queued write from poisoning later saves;
- keep unsaved browser work available when the service disappears;
- provide an explicit snapshot export and a retry path;
- use no telemetry, remote dependency, or external send path.

The consuming repository owns its service name, port, executable, state schema,
content, command names, and user-facing recovery copy. None of those adapter
details belong in the public Atelier kit.

## Lifecycle contract

### Start

1. Resolve an explicit loopback port and ignored runtime directory.
2. Probe the service health endpoint.
3. If a managed instance answers with the recorded runtime identifier and PID,
   report it as already running.
4. If anything else owns the port, refuse to take it over.
5. Generate a fresh runtime identifier, start the child without a shell, write
   a mode-0600 runtime record, and wait for health to echo both identifiers.
6. If health never proves ownership, stop only the child just created and
   report the ignored operational log.

### Status

Status is healthy only when the runtime record, health response, runtime
identifier, PID, service identity, and loopback address agree. A responding
port without that proof is occupied, not adopted.

### Stop

Stop only the PID whose health response matches the recorded runtime identifier
and PID. Refuse on disagreement. After a clean stop, remove only the generated
runtime record. Never kill by port, process name, or broad pattern.

Managed start survives a terminal or agent command. It does not imply operating
system startup. Installing an OS-level service is a separate system change and
requires explicit user authorization.

## Authoring-state contract

- The canonical template may be tracked; the live draft must be ignored unless
  a reviewed workflow explicitly promotes a sanitized artifact.
- Live state and runtime metadata use owner-only permissions.
- Browser autosave is a recovery layer, not a substitute for the canonical
  local file.
- A lost server must produce a persistent, actionable message naming the exact
  restart command, the retained browser state, the snapshot option, and Retry.
- Conflict responses remain fail-closed. Do not silently overwrite a newer
  file or reconcile divergent tabs automatically.

## Required evidence

A consumer implementation is not complete until tests prove:

1. start is idempotent and survives the launching command;
2. status refuses an unowned listener;
3. stop is bound to runtime identifier and PID;
4. a stopped server leaves the exact in-browser draft intact;
5. restart plus Retry persists that draft;
6. a refused filesystem write does not break later valid saves;
7. private state and runtime files are ignored and owner-readable only; and
8. a fresh checkout can discover the commands through its agent instructions.

Use synthetic fixtures for public Atelier tests. Tenant-specific proof remains
in the tenant repository.

## The Obsidian maintenance service

The continuous maintenance of Obsidian views (`src/runtime/obsidian/`) is a
consumer of this contract that ships with Atelier. It keeps one service per
enabled workspace: a process that ticks the maintenance engine on an interval
and answers on one loopback port. Its lifecycle is `startService`,
`serviceStatus` and `stopService` in `src/runtime/obsidian/lifecycle.mjs`.

### Identity record

Each workspace has one record, `state/service/runtime.json`, under the
workspace's private state root in the machine-private data directory. It is
never inside a repository or a vault, its directory is owner-only, the file is
mode 0600, and it is replaced atomically. It satisfies
`contracts/atelier-obsidian-service-state.v1.schema.json`:

- the service name, derived from the workspace identity;
- the literal loopback host, `127.0.0.1` or `::1`, never a hostname and never
  a wildcard address, and the selected port;
- the executable identity: the path of the service entry module and the
  SHA-256 digest of its bytes;
- a random runtime identifier and the PID;
- the state location, a health description, and the startup consent (who
  granted it, when, and whether it covers the service only or the service and
  operating-system startup);
- in its private part, the random bearer of that one runtime. The bearer exists
  nowhere else, and nothing that `start`, `status` or `stop` returns carries it.

The record is validated on every read. A record that does not validate, or
that names another workspace, service or state location, makes `start`,
`status` and `stop` refuse with `invalid-service-record`. It is never repaired,
adopted or removed automatically; a person inspects it and removes it.

The port is a machine-specific value. `start` takes an explicit port, or
selects a free loopback port once and records it beside the consent in
`state/service/settings.json`, so later starts, `status` and any installed
unit name the same one. The first start of a workspace refuses without an
explicit consent that names its actor.

### Health fields and fixed operations

| Operation | Method and path | Credential | Answer |
| --- | --- | --- | --- |
| Health | `GET /health` | none | service name, workspace identity, runtime identifier, PID, loopback host and port, executable digest, start time, status |
| Status | `GET /status` | bearer | the health fields, loop state, last tick, last error code, and per-view freshness with held notes counted, not named |
| Tick now | `POST /tick` | bearer | the state of the tick that ran |
| Stop | `POST /stop` | bearer | an acknowledgement naming the runtime and PID, then the service ends |

Health carries no path, no note title, no source name and no withheld
identity. There is no other operation: no file serving, no command, no
evaluation, and no route that takes a path or code from a request. The service
opens no outbound connection, has no telemetry and depends on nothing remote.

The listener refuses a request before looking its operation up when:

- `Host` is not exactly the literal loopback authority it is bound to, which
  also refuses a name that resolves to loopback;
- `Sec-Fetch-Site` is present and is neither `none` nor `same-origin`, or
  `Origin` is present and is not the listener itself;
- the path is not one of the four, exactly and without a query, or the method
  is not that path's method.

Status, tick and stop additionally refuse without the bearer of the running
runtime. A `POST` payload is a JSON object of at most 1 KiB that names the
runtime identifier it is meant for, so a request aimed at an earlier runtime on
the same port does nothing.

### Status values and refusal cases

| Status | Meaning | `start` | `stop` |
| --- | --- | --- | --- |
| `healthy` | record and health agree on service name, workspace, runtime identifier, PID, executable digest and loopback address, and the PID is alive | reports already running | asks that runtime to stop |
| `stopped` | no record and nothing listens | starts | nothing to do |
| `occupied` | something answers on the port without that proof: another program, a silent listener, or a health answer with any field different | refuses; never takes over | refuses |
| `stale-record` | the recorded address is closed and the recorded PID is gone | starts; the new service replaces the record once it listens | refuses; nothing is proven to stop |
| `pid-not-ours` | the recorded address is closed and a process has the recorded PID (the number was reused, or a process outlived its listener) | starts; that PID is never signalled | refuses; that PID is never signalled |

`start` is serialized per workspace, spawns the service without a shell, and
detaches it only when asked for a service that survives the launching command.
It waits for health to echo the runtime identifier it generated and the PID of
the child it created. If that proof never arrives it stops only that child, by
its process handle, and reports the private operational log,
`state/service/service.log`.

`stop` sends the stop operation to the proven runtime only, waits for that PID
to end and removes only the generated record. It never looks a process up by
port, name or pattern. Ending a proven runtime that ignores the request is
opt-in and is proven again immediately before the signal.

The service itself refuses to start beside a runtime of the same workspace
that proves itself, and ends cleanly when its record no longer names it. Two
engines can never tick one workspace together: each tick holds a private
per-workspace lock, and an engine that finds it held writes nothing and
reports busy.

### What stop and a hard end leave intact

On `stop` the tick in flight finishes, within a grace period. Drafts in a
vault, pending edits, recovery copies, staging and the last good view are left
exactly as they are. The service never sweeps or deletes anything under
`staging/` or `recovery/`: not at start, on a tick, at shutdown, after a hard
kill or when it finds a stale record. A publication cut short by a hard kill
is settled by the publisher's own journaled restart recovery on a later tick.

A tick that fails for a reason nobody typed (a full disk, a crash inside a
step) does not end the service. Its error code is kept in
`state/service/last-error.json`, its message only in the private log; the
delay before the next attempt doubles up to a ceiling, and the next tick
proceeds.

### Cases that need a person

- a record that does not validate, or that belongs to another workspace;
- an `occupied` port: decide what owns it, or select another port;
- an engine lock whose holder is a live process that recorded no health
  address, a lock written on another machine, an unreadable ticket, or an
  unknown file in the lock directory. A lock is taken from a holder only with
  proof that its process is gone, or that it was a service whose recorded
  address is closed or answers as another runtime or PID. An address that
  accepts a connection and does not answer in time proves nothing.
  `inspectPrivateGenerationLock` reports the holder without changing anything.

### Operating-system startup

`buildStartupAdapter` returns the text of a launchd user agent (macOS) or a
systemd user unit (Linux) from the values it is given. It writes no file,
installs nothing, runs no service manager and looks nothing up on the machine.
Windows startup has not been qualified and refuses with
`startup-platform-unqualified`. Installing a unit is a separate system change
that needs explicit user authorization; the service refuses to run with
`--startup` unless the recorded consent covers startup.

The service entry refuses to run without an explicitly selected editor
adapter. Public Atelier tests start only a test entry whose adapter reports
that no app runs, in temporary directories, on ephemeral loopback ports.
