# MNSTRY Atelier

Local-first authoring, knowledge-graph, projection, and dry-run runtime
readiness for MNSTRY Atelier projects.

This alpha package contains the reusable Atelier surface: project adapters,
front-matter and sidecar knowledge graph indexing, generated local GUI
projections, loopback-only sidecar serving, agent-harness context flow,
proposal-only collaboration metadata, support-bundle dry runs, no-egress
checks, optional claim-only analysis gates, and `atelier-export@v1` dry-run
validation. It is designed for project adapters that prepare semantic source
material locally while the MNSTRY runtime remains the authority for identity,
consent, visibility, provisioning, bookings, commerce, sessions, audit, and
client-grade sharing.

## Status

- Version: `0.1.0-alpha.0`
- Runtime: Node.js `>=22.18.0 <23`
- Stability: alpha
- Telemetry: none
- Network egress: none in package runtime paths
- Runtime mutation: not implemented
- Runtime import/apply: not implemented
- Analysis execution: not implemented

## What This Package Does

- Initializes neutral local Atelier projects.
- Builds a front-matter and sidecar-led knowledge graph.
- Builds a generated local GUI projection.
- Serves the generated projection over a loopback-only sidecar.
- Produces agent-harness context and capability envelopes.
- Records proposal metadata without browser apply/write endpoints.
- Previews no-send support bundles.
- Checks package runtime paths for forbidden non-localhost egress.
- Validates `atelier-export@v1` JSON against the published schema.
- Enforces the local source `audience` and runtime `visibility` boundary.
- Rejects mutation/apply intent in dry-run validation.
- Rejects unresolved, disguised, or non-public-projectable source references.
- Produces deterministic dry-run reports with `accepted`, `importable`, and
  `worstOperationStatus`.

## What This Package Does Not Do

- It does not write to a MNSTRY runtime database.
- It does not import, provision, publish, or send anything.
- It does not contact external services.
- It does not execute Analysis or any model provider.
- It does not include client-zero project content.

## Usage

```js
import { validateAtelierExportDryRun } from '@mnstry/atelier'

const report = validateAtelierExportDryRun(exportDocument)
console.log(report.accepted, report.importable, report.errors)
```

The package also exposes local-only CLI validation:

```bash
mnstry atelier dry-run ./atelier-export.json
mnstry atelier contract check
mnstry atelier init --fixture=sample-workspace --target ./sample
mnstry atelier graph --project ./sample/atelier.project.json
mnstry atelier project --project ./sample/atelier.project.json
mnstry atelier readiness --project ./sample/atelier.project.json
mnstry atelier dev --project ./sample/atelier.project.json
```

The direct package binary supports the same Atelier subcommands:

```bash
mnstry-atelier dry-run ./atelier-export.json
```

## Contract Boundary

`audience` describes local source readership. Runtime/export `visibility`
describes runtime exposure and accepts only:

- `private`
- `shared`
- `platform`
- `public`

Local words such as `team`, `operator`, `staff`, and `sensitive` are not valid
runtime visibility values.

## Sample Fixtures

Fixtures in this package are fictional and generic. Project-specific adapter
fixtures belong in their project repositories, not in the published Atelier
package.
