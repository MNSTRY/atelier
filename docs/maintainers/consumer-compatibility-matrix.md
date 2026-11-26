# Consumer compatibility matrix

This document defines the public compatibility obligations between `@mnstry/atelier`
and its downstream consumer classes. It governs how internal reorganizations,
schema additions, and version bumps are qualified before release.

## Reference baselines

- **Contract-stability epoch:** `v0.2.0-alpha.11` (`contracts/compat-baseline.json#baselineTag`).
- **Latest release baseline:** `v0.2.0-alpha.25` (`contracts/compat-baseline.json#latestReleaseTag`), covering contracts added after the epoch.
- **Public API baseline:** `contracts/public-api-baseline.json` (checked in CI via `npm run public-api:compat`).
- **Next minor line:** `0.3.0` (`0.2.0` is unavailable on npm; `publish.yml` binds npm Trusted Publishing to that exact workflow filename).

## Consumer classes and qualification rules

| Consumer class | Consumed surfaces | Qualification obligations before a breaking move |
| :--- | :--- | :--- |
| **CLI & workspace adopters** | `atelier` / `mnstry-atelier` bins, `init`, `graph`, `project`, `boundary`, `disclosure`, `readiness`, `lock`, `upgrade`, `dry-run` | Must pass `npm run consumer:smoke` and cross-Node byte-identity CI (`cross-node-bytes`). Shipped templates, skills, and init fixtures remain intact. **CLI JSON outputs and process exit codes are contractual; human-readable `--help` banners and summary prose may evolve without a major version bump.** |
| **Branded distributions** | Wrapper CLI, extension pack loader, themed projections, `TRADEMARKS.md` attribution | Must pass `npm run distribution:smoke` against `examples/loomworks-studio`. |
| **Web & presentation hosts** | `./presentation`, `./presentation/browser`, `./ui`, `./ui/primitives`, `./ui/primitives/browser` | Browser behavior and `.d.mts` declarations must be qualified against the packed tarball (`npm run consumer:smoke` compiles and executes strict TypeScript calls). |
| **Desktop & local-service hosts** | `./personal-workspace`, `./runtime`, `./obsidian`, `./obsidian/*`, `./local-state` | Package name remains `@mnstry/atelier`. Obsidian upgrades require a separate isolated desktop-host rehearsal beyond CI. |
| **Contract & template receivers** | `./contracts/*.schema.json`, `./templates`, `./template-bindings`, `./attestation`, `./collaboration` | Schemas remain addressably exported; moved schemas must declare `previousContractFiles` in `src/contracts/corpus.mjs` so `contract:compat` never skips them silently. |
| **Optional host-bound adapters** | `./extensions/*`, `./vault`, `./impeccable`, `./impeccable/wasm` | Host owns credentials, storage, and execution. Experimental surfaces are explicitly labeled and do not couple into core graph/governance modules (`test/architecture-boundaries.test.mjs`). |

## Internal boundary invariants

`test/architecture-boundaries.test.mjs` enforces four ratchets on `src/`:

1. `src/vault/` has zero inbound imports from other source areas.
2. `src/disclosure/` and `src/egress/` have zero outbound cross-area imports; `src/contracts/` only dynamically imports `src/readiness-protocols/` to load bundled readiness protocols for contract corpus validation.
3. Core graph and governance areas (`graph`, `graphmark`, `boundary`, `export`) do not import `ui`, `vault`, `harnesses`, `extensions`, `impeccable`, `inquiry`, `knowledge`, `knowledge-health`, `learning`, `build`, or `coauthor`.
4. Only `projection`, `server`, and `template-bindings` may import `src/ui/`.
