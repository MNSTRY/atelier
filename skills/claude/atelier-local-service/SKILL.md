---
name: atelier-local-service
description: Build or repair a durable loopback-only authoring, review, or preview service in an Atelier-backed repository when local state must survive agent commands and fail safely.
---

# Atelier local service

Use this skill for a consumer-owned service that persists repository-backed
local state. Do not use it to change `atelier dev` itself or to install an
operating-system service without explicit authorization.

Read `docs/local-services.md` from the installed Atelier package or source
checkout before changing lifecycle code.

## Boundary first

Separate the portable mechanism from the consumer adapter before editing:

- Atelier invariants: loopback binding, proven ownership, exact stop, ignored
  mode-0600 state, atomic writes, recoverable browser failure, and tests.
- Consumer details: service identity, port, commands, paths, schema, content,
  and user-facing language.

Never promote consumer names, content, structures, examples, or local paths
into Atelier. Public tests use invented fixtures.

## Workflow

1. Inspect the existing server, process owner, port, persistence file,
   `.gitignore`, health route, save handler, and tests. Preserve the live draft
   before restarting anything.
2. Expose repository-owned `start`, `status`, and `stop` commands. Start may
   detach only because the user needs continuity beyond the launching command.
3. Bind to loopback. Pair a random runtime identifier with the PID in both the
   private runtime record and health response. Refuse unowned listeners.
4. Keep drafts, runtime metadata, and operational logs ignored and owner-only.
   Do not commit live authoring state.
5. Make the UI retain the draft when the service disappears. Show the exact
   restart command, snapshot export, and Retry path instead of a generic error.
6. Serialize writes without permanently rejecting the queue after one failed
   operation. Keep conflicts and invalid state fail-closed.
7. Prove lifecycle ownership, server-loss recovery, later-save recovery,
   permissions, ignore coverage, and fresh-checkout discoverability.

Do not claim durability from a passing request alone. Report separately:
saved file truth, managed-process truth, browser recovery truth, and the
remaining OS-restart boundary.
