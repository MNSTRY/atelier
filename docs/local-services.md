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
