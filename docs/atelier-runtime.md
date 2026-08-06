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
