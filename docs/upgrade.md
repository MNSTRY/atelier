# Upgrade Guide

Use this guide when upgrading a copied private-domain or shared-project starter
workspace between Atelier package releases. The flow is local-only: it does not
provision repositories, contact a Git host, mutate the MNSTRY runtime, or write
through a browser view.

## Before You Upgrade

- Start from a clean Git status in the copied workspace.
- Confirm Node.js matches the package range: `>=22.18.0 <23`.
- Keep this package root and copied starter workspaces separate.
- Keep upgrade diffs generic: placeholders only, no project-specific private
  material, transcripts, support bundles, local absolute paths, local agent
  state, keys, or credential assignments.

## Refresh The Atelier Lockfile

`atelier.lock.json` records the installed Atelier package version, source,
contract versions, template lineage, extension packs, and applied migrations.
New workspaces get this file from `atelier init`. Existing workspaces can
backfill it without changing source content:

```bash
atelier lock write --project ./atelier.project.json
atelier lock check --project ./atelier.project.json
```

For private-preview installs, pin the install command to the release tag and
record the resolved Git SHA in the lockfile:

```bash
npm install --save-dev git+https://github.com/mnstry/atelier.git#v0.1.0-alpha.0
atelier lock write --project ./atelier.project.json
```

Before accepting upstream changes, run the non-mutating upgrade planner:

```bash
atelier upgrade --dry-run --project ./atelier.project.json
```

Apply upgrades only after reviewing the plan:

```bash
atelier upgrade --apply --project ./atelier.project.json
```

The apply path creates a branch, refuses unsafe dirty state, regenerates
projections, runs checks, and leaves a reviewable commit.

## Re-run Local Checks

Run checks from the copied workspace after refreshing dependencies:

```bash
atelier graph --project ./atelier.project.json
atelier project --project ./atelier.project.json
atelier readiness --project ./atelier.project.json
atelier lock check --project ./atelier.project.json
atelier upgrade --dry-run --project ./atelier.project.json
atelier boundary check --project ./atelier.project.json
atelier boundary check --staged --project ./atelier.project.json
```

Generated `atelier-output/` files are projections. Treat source files,
`atelier.project.json`, `repo-access.v1.json`, `boundary-policy.v1.json`, and
`atelier.lock.json` as the review authority.

`atelier` is the primary command. `mnstry-atelier` remains a legacy alias for
older workspaces and should not be used in new docs or package scripts.

## Boundary Review

- Verify every repo in `atelier.project.json` is covered by `repo-access.v1.json`.
- Verify private-domain repos still use `readBoundary: "private"`.
- Verify shared-project repos do not contain private or sensitive source nodes.
- Verify local source front matter uses `kg.audience`, not `kg.visibility`.
- Verify upgrade diffs do not add project-specific private material to package
  docs, fixtures, or templates.

When unsure, fail closed: keep source in the private-domain workspace and move
only a reviewed summary into the shared-project workspace through ordinary Git
review.
