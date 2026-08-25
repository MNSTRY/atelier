# MNSTRY Atelier Runtime

MNSTRY Atelier is a local-first authoring and collaboration surface for
Git-backed project workspaces. It prepares semantic meaning locally and keeps
runtime enforcement in MNSTRY.

The package owns reusable mechanics:

- project configuration and adapter resolution;
- knowledge graph indexing from front matter and sidecars;
- generated workspace projections;
- local sidecar serving over loopback only;
- agent-harness context envelopes;
- proposal-only collaboration metadata;
- support-bundle dry runs with no send path;
- export dry-run validation for `atelier-export@v1`.
- explicit single-repository enrollment and full-state Git observation;
- fast-forward-only reconciliation and two-phase user-confirmed commits.

Project adapters own project facts: repo roster, source roots, read-boundary
config, extension packs, brand language, and generated project outputs.

## Local Authority

Local files plus Git are the source authority. Generated JSON, HTML, SQLite,
API, and support-bundle outputs are projections. Local view policies are not
runtime permissions. Runtime-grade identity, consent, visibility, provision,
bookings, commerce, sessions, audit, and client-grade sharing remain MNSTRY
runtime authority.

## Safety Posture

The default package posture is no telemetry, no external network egress, no
runtime mutation, no browser apply endpoint, and no model-assisted analysis execution.
Provider analysis output may only enter as proposed `atelier-claim@v1` records
until explicitly reviewed by the project owner.

`atelier dev` is narrower than a general static server. It refuses non-loopback
bind hosts, requires a generated `atelier.manifest.json`, and publishes only
manifest-enrolled HTML, script, style, and image files that remain inside the
workspace after realpath resolution. Hidden paths, local state, secret-shaped
names, symlinks, unknown file types, and unenrolled files are unavailable.
Reads validate the loopback host and fetch metadata; mutations additionally
require an allowed method, exact same origin, and the session nonce.

Collaboration endpoints are copy-only: they create or review proposal records;
they do not apply source changes. Authority is derived from declared
capabilities and apply endpoints, never inferred from action-like prose. A
partially corrupt ledger returns typed incomplete evidence and blocks a clean
claim. Ledger reads and records are bounded, appends are locked, and retention
changes happen only through explicit compaction.

The local Git supervisor is a separate mechanical authority surface. It may
create a repository commit only from an unchanged, bounded plan after the user
repeats its exact operation id. That repository write is not a MNSTRY runtime
mutation and does not grant proposal apply authority to the browser sidecar.
See [Atelier Sync: Deliverable Zero](./atelier-sync.md).
