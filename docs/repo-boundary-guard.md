# Repo Boundary Guard V1

Repo Boundary Guard V1 is the Atelier workspace convention for separating
private domain source from shared project source before anything reaches the
MNSTRY runtime.

## Boundary Model

- Private domain material lives in one private Git repository per user.
- Shared project material lives in shared project repositories.
- Git repository access is the source read boundary.
- `kg.audience` is local projection metadata, not a permission system.
- Runtime/export `visibility` remains reserved for MNSTRY runtime objects.

If a file is private, place it in the user's private domain repo. Do not rely on
front matter, generated projections, readiness output, browser views, or local
HTML hiding to protect source material inside a shared repo.

## Guard Rules

- Private or sensitive source belongs in a repo with `readBoundary: "private"`.
- Shared project source may use `team`, `operator`, `staff`, or `public`
  audiences when the repository readership matches that exposure.
- Local source metadata must use `kg.audience`.
- Local source metadata must not use `kg.visibility`.
- Dry-run exports may contain runtime `visibility` only on export/runtime
  objects.
- Generated outputs are projections and should be reproducible from source.

## External Repos

Real workspaces accumulate git folders that are not Atelier repos: vendored
checkouts, app-builder exports, scratch clones. Declare one in
`atelier.project.json` with `kind: "external"`:

```json
{ "name": "external-vendor-site", "path": "external-vendor-site", "kind": "external" }
```

An external repo is acknowledged, not managed. It implies **no** read boundary,
so it must not declare `readBoundary`, must not appear in `repo-access.v1.json`,
and must not appear in the boundary policy — declaring a boundary for a repo
nobody manages is exactly the confusion this classification removes. Its files
are excluded from graph walking, sidecar requirements, and projection, and the
staged guard and hook installer skip it entirely.

An undeclared git folder in the workspace remains an error. Forcing an explicit
decision is the point: it is how a repo pushing to an unexpected host gets
noticed. `atelier graph` prints the remote host of each external repo for the
same reason — a workspace should know where its folders push, especially when a
host is a lookalike of a familiar one.

At least one repo must remain managed; a workspace of only external repos is
not an Atelier workspace.

## Staged Boundary Field Review

The staged guard (`atelier boundary check --staged`) inspects every staged
`*.md` and `*.kg.json` diff for changes to boundary fields — `kg.audience`,
`audience`, `handling`, `sensitivity`, `data_boundary`.

It distinguishes two cases:

- **Initialization.** A boundary field added with no prior value, set to a
  value that discloses nothing (`private` or `sensitive` for `audience`), is
  recorded as a fail-closed default rather than a disclosure decision. It
  commits without review. This is what tooling writes when it fills in missing
  front matter, so kit-generated metadata never needs a human to unjam it.
- **Change.** Anything else — widening, narrowing, removing an existing value,
  or introducing a field already set to a disclosing value — needs a human.

To approve a change, put a review marker in the diff:

```
<!-- Atelier-Boundary-Review: approved — why this exposure is correct -->
```

The marker must travel **in the same file's diff** as the change it approves.
A marker committed in a sibling file, or already sitting elsewhere in a file
that this commit does not touch, approves nothing — the guard reads the diff,
not the working tree.

## Non-Goals

Repo Boundary Guard V1 does not:

- create, invite, or permission GitHub users;
- move files between repositories automatically;
- write to the MNSTRY runtime;
- send telemetry;
- contact cloud services;
- mutate browser state or write directly from a browser view.

## Review Checklist

Use this as a defensive review before copying preview content into real repos:

- Every private user has exactly one private domain repo entry.
- Private domain repos use `readBoundary: "private"`.
- Shared project repos do not contain private or sensitive source nodes.
- `rg -n "kg.visibility|visibility:"` over source files finds no local source
  front matter misuse.
- `repo-access.v1.json` covers every repo listed in `atelier.project.json`.
- `atelier.lock.json` is written in the copied workspace with
  `atelier lock write`, not copied from the package root.
- Generated `atelier-output/` files are not treated as source authority.

When in doubt, fail closed: move the source into the private domain repo first,
then project a reviewed summary into shared project material later.

## Upgrade Review

When upgrading a copied workspace, review package, lockfile, and boundary
changes together. The `atelier.lock.json` refresh should be limited to the
copied workspace's Atelier package metadata, contracts, and migration state,
while private-domain and shared-project source boundaries remain unchanged.

See `docs/upgrade.md` for the upgrade sequence.

## Repo Identity

Every Atelier-side reference to a repository used to key on its name. Hosting
providers let repos be renamed and redirect the old URL indefinitely, so a
rename leaves stale clones that keep fetching happily under a name that no
longer exists — the failure is silent, which is why two Client zero repos stopped
syncing for weeks before anyone noticed.

Record a provider-stable identity in `atelier.project.json`:

```json
{
  "name": "studio-journal",
  "path": "studio-journal",
  "readBoundary": "team",
  "identity": { "provider": "github", "id": "900001" },
  "aliases": ["frequency", "hardware"]
}
```

Get the id with `gh api repos/{owner}/{name} --jq .id`. It survives renames;
the name does not.

`resolveRepoIdentity(cloneDir)` answers from the provider's stable id when the
provider is reachable, then from the recorded identity, then from declared
aliases, and reports which of those it used in `source` rather than guessing
silently. **It never keys on the root commit.** Repos created from one template
share a root commit, so that heuristic reports false duplicates; it also cannot
see a rename at all. A rename is a metadata update, not a new identity.

`atelier doctor` reports:

- `repo-renamed-upstream` — the provider's canonical name has moved on
- `repo-folder-name-stale` — the config name is not the canonical name
- `repo-name-alias-deprecated` — resolved through a recorded alias
- `repo-identity-duplicate` — two clones are one repository; park the retired one
- `repo-identity-undeclared` — no recorded id, so a rename during an outage is unresolvable
- `repo-identity-unresolved` — no origin remote to identify the clone by
