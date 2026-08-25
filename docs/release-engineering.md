# Release engineering

This document describes the enforcement surface for the Atelier package: the
release gates, the CI lanes, the fork policy, and the version-bump surface.
Every gate named here fails closed and reports findings as a generic label plus
a location, never the matched content.

## Gates

### release:audit

`npm run release:audit` (`scripts/check-release-tarball.mjs`) audits the exact
tarball `npm pack` would publish. `npm run release:candidate` packs once and
passes the same archive and expected SHA-256 through this audit and both
consumer smokes:

- Package metadata: name, license, exposed CLI bins, and a mandatory `files`
  allowlist in `package.json`.
- Tarball allowlist: every packed path must match a known-good pattern; any
  unexpected file fails the audit. The extracted archive inventory must match
  the `npm pack --json` inventory exactly.
- Content scan: every packed file is scanned against committed structural
  patterns (absolute user paths, machine-local temp paths, agent-local state
  paths, key material, secret-like assignments) and against the maintainer-held
  denylist described below.
- Egress scan: the canonical egress control receives the exact `npm pack`
  inventory and inspects every packed executable or markup file, including a
  test-shaped path if one is ever admitted to the artifact. Packed test-fixture
  suppression markers are refused; reviewed local-computed markers are counted.
- Version drift: `CHANGELOG.md` must contain a `## <version>` heading and
  `README.md` must mention the version. The expected version and tarball name
  are derived from `package.json`, never hardcoded.

Exit codes: `0` clean, `1` findings, `2` configuration error (for example an
unavailable denylist without explicit acknowledgment).

`release:candidate` additionally requires a clean tree, records the candidate
commit and tarball digest, and refuses a version already bound to a different
tagged commit. It is a release-evidence command, not a publication command.
When `ATELIER_RELEASE_OUTPUT_DIR` is set, it atomically retains the verified
tarball, npm-pack metadata, and a machine-readable receipt. The trusted
publishing workflow runs `prepublishOnly` explicitly with that output directory,
re-verifies the retained digest, and publishes the retained tarball path rather
than repacking the source checkout.

### repo:check

`npm run repo:check` (`scripts/check-repo-disclosure.mjs`) sweeps the whole
Git-tracked tree, not just the tarball:

- Default mode scans every tracked text file line-by-line with the structural
  patterns and the denylist.
- `--staged` scans staged changes only, for local pre-commit use.
- `--structural-only` is the intentional no-denylist lane used by CI jobs that
  run without secrets.
- `--commits <none|range|all>` adds the commit-identity gate and scans commit
  messages in the selected range with the same patterns.

Exit codes match `release:audit`: `0` clean, `1` findings, `2` configuration or
usage error.

### disclosure check

`atelier disclosure check` is the portable consumer-facing content gate. It
scans every tracked text file by default or the exact staged index with
`--staged`, never follows tracked symlinks, and reports labels plus locations
without echoing matched content. `--untrusted` suppresses finding details.

The command loads private patterns from `ATELIER_DENYLIST_JSON`, an explicit
`--denylist` path, or ignored
`.atelier-local/disclosure-denylist.json`. A repository-local denylist is
refused if it is tracked or not covered by `.gitignore`. Missing private
patterns are a configuration failure unless `--structural-only` explicitly
acknowledges the reduced verdict. Public text-only packaging can also use
`--fail-on-binary`; Atelier's own tarball audit separately refuses packed
binary files.

The public Atelier repository keeps the stronger `repo:check` identity and
commit-message controls. The portable command exists so consumer repositories
can enforce the same public/private content boundary without inheriting
MNSTRY-specific commit identities.

### Commit-identity gate

Part of `repo:check --commits`. Commit authors must match a hardcoded
maintainer allowlist; committers additionally allow GitHub's merge identity,
which GitHub-UI merges reintroduce. The allowlist is committed and reviewable
in the script — it is not a secret.

### migrations:check

`npm run migrations:check` (`scripts/check-breaking-migrations.mjs`) keeps the
changelog and the migration registry honest about breaking changes:

- Every `**Breaking:**` changelog entry must match exactly one entry in
  `scripts/breaking-changes.map.json`, and every map entry must match exactly
  one changelog entry (no stale exemptions).
- Map entries with a migration disposition must name an active breaking
  migration in the registry, and every active breaking migration must be
  referenced by the map.
- Exempt entries require a non-empty reason and a date.
- Every registered migration record is re-validated against the migration
  record contract.

### public-api:compat

`npm run public-api:compat` compares every package subpath and named JavaScript
export published by `v0.2.0-alpha.4` with the current package. Removing one
fails closed. It also rejects modified source that retains the already-tagged
baseline version, independently of the release-candidate check. The baseline
records and verifies its tag commit and the public npm artifact identity; the
published archive was independently checked to contain all 20 subpaths and 212
named exports. This is runtime JavaScript shape continuity, not a promise about
function signatures, types, or behavior.

### egress:check

`npm run egress:check` (`atelier egress check`) scans package runtime paths for
forbidden non-localhost egress. The package claims no network egress in runtime
paths; this gate is the mechanical check behind that claim.

### consumer:smoke

`npm run consumer:smoke` (`scripts/consumer-smoke.mjs`) packs the real tarball,
installs it offline into a throwaway consumer project with lifecycle scripts
disabled and without copying the publisher's `overrides`, checks the installed
dependency tree, imports every declared JavaScript export, parses every
declared JSON export, and validates a sample export through both API and CLI.
It proves the tarball is installable and functional exactly as a bare consumer
receives it from disk. The offline smoke deliberately warms the locked registry
dependency closure first; it does not prove that a not-yet-published version
resolves from a cold or live registry.

### assurance:mutation-smoke

`npm run assurance:mutation-smoke` runs local, synthetic negative controls for
the boundary, graph, packed and direct egress, sidecar, and distribution
families. Every fixture introduces one named failure and must be refused by the
terminal CLI or release command where one exists. This is part of
`prepublishOnly`; a control that stops detecting its failure mode blocks the
release even if positive-path tests remain green.

### Egress-marker inventory

The local-computed egress allow marker disables unresolved-target egress
detection for a small window around each use, so its spread is pinned:
`test/egress-marker-inventory.test.mjs` asserts the exact files and occurrence
counts where the marker may appear. Widening that inventory is a reviewed
decision, not a mechanical edit.

## Denylist mechanism

Beyond the committed structural patterns, content scans apply a maintainer-held
pattern list supplied via the `ATELIER_RELEASE_DENYLIST` CI secret or a local
gitignored file (`release-denylist.local.json`); the `ATELIER_DENYLIST_JSON`
environment variable takes precedence over the file. Every audit fails closed
when the list is absent; setting `ATELIER_ALLOW_MISSING_DENYLIST=1` explicitly
acknowledges a structural-only run.

Findings are reported as label plus location, never content — neither the
pattern source nor the matched text is printed, and a pattern compile error
prints the label only. Labels are themselves kept generic and are
maintainer-reviewed before entering the list.

## CI lanes

Four jobs run on pushes to `main` and on pull requests, and all four are
required status checks:

- `test`: syntax check (`node --check`, not a type system), the full test suite (including isolated consumer disclosure-command proofs), contract checks, `egress:check`, `assurance:mutation-smoke`, and
  `migrations:check`. This job sets `ATELIER_ALLOW_MISSING_DENYLIST=1` scoped
  to the job only — denylist assertions belong to the secret lane.
- `consumer-smoke`: warms the npm cache with `npm ci` (the offline tarball
  install needs the registry dependencies cached), then runs
  `npm run consumer:smoke`.
- `structural-sweep`: runs `repo:check --structural-only` with the
  commit-identity gate over the pull-request range; on push builds the
  `ATELIER_COMMIT_SCAN` repository variable selects the commit scan depth. No
  secrets are required, so this lane runs for fork pull requests.
- `secret-sweep`: the only lane with access to the denylist. It runs the full
  `repo:check` (with the configured commit scan) and `release:audit`.

## Fork policy

Fork pull requests never receive repository secrets, so `secret-sweep` cannot
pass in place. The job fails explicitly rather than skipping — GitHub treats a
skipped job as satisfying a required status check, so an explicit failure is
the only safe block.

To clear a fork pull request, a maintainer verifies the head SHA and dispatches
the `fork-sweep` workflow with the pull-request number and that SHA. The
workflow runs the trusted scanner from `main` against the fork's tree checked
out as data — it never installs or executes anything from the untrusted tree —
re-verifies that the head SHA has not moved, and posts a `secret-sweep` check
run on the SHA. The newest check run with that name supersedes the earlier
failure for branch protection.

`release:audit` never runs against untrusted code (`npm pack` executes
lifecycle scripts); it re-runs on the push build of the merge commit. No
workflow uses `pull_request_target`.

## Version-bump surface

A version bump touches exactly:

- `package.json` (`version`)
- `CHANGELOG.md` (a `## <version>` heading)
- the pinned install tags in `README.md`, `docs/install.md`,
  and `docs/upgrade.md`

The release scripts derive the expected version and tarball name from
`package.json`, so they are not part of the bump surface, and `release:audit`
fails when the changelog heading or the README mention lags the bump.
