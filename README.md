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
- Distribution: private-preview Git tag
  `git+https://github.com/mnstry/atelier.git#v0.1.0-alpha.0`
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
- Writes and checks `atelier.lock.json` for reviewable upstream package state.
- Plans and applies branch-based upgrades without silently overwriting authored
  content.
- Validates `atelier-export@v1` JSON against the published schema.
- Enforces the local source `audience` and runtime `visibility` boundary.
- Rejects mutation/apply intent in dry-run validation.
- Rejects unresolved, disguised, or non-public-projectable source references.
- Produces deterministic dry-run reports with `accepted`, `importable`, and
  `worstOperationStatus`.
- Enforces Repo Boundary Guard V1 for private domain and shared project repos.

## What This Package Does Not Do

- It does not write to a MNSTRY runtime database.
- It does not import, provision, publish, or send anything.
- It does not contact external services.
- It does not execute Analysis or any model provider.
- It does not include client-zero project content.

## Usage

Private-preview installs are Git tag pinned while npm publishing remains
deferred:

```bash
npm install --save-dev git+https://github.com/mnstry/atelier.git#v0.1.0-alpha.0
```

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
mnstry atelier boundary check --project ./sample/atelier.project.json
mnstry atelier lock write --project ./sample/atelier.project.json
mnstry atelier upgrade --dry-run --project ./sample/atelier.project.json
mnstry atelier dev --project ./sample/atelier.project.json
```

The direct package binary supports the same Atelier subcommands:

```bash
mnstry-atelier dry-run ./atelier-export.json
```

Boundary guard commands are local and Git-native:

```bash
mnstry-atelier boundary check --project ./atelier.project.json
mnstry-atelier boundary check --staged --project ./atelier.project.json
mnstry-atelier boundary install-hooks --project ./atelier.project.json
mnstry-atelier promote --source-repo mnstry-private-author --target-repo mystery-example --kg-id mnstry-private-author:seed
```

Strict policies fail closed when private or sensitive source is placed in a
shared repo, when protected local/support/session files are staged, or when
private-domain material appears in shared work without a `git.promote`
disclosure record.

Upgrade commands are also local and review-first:

```bash
mnstry-atelier lock check --project ./atelier.project.json
mnstry-atelier upgrade --dry-run --project ./atelier.project.json
mnstry-atelier upgrade --apply --project ./atelier.project.json --branch codex/atelier-upgrade-YYYYMMDD
```

`upgrade --apply` creates or switches to the requested branch, refuses dirty
authored repos, preserves unrelated user hooks through composed hook files, runs
only registered migrations, refreshes generated projections, and leaves a Git
commit for review. It will not weaken boundary policy, introduce telemetry,
enable non-localhost egress, run Analysis, or write/import/apply runtime state.

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
