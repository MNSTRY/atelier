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

## Owner-signed operator delegation

A private-domain repository names one `ownerActor`. When anyone else runs
`atelier boundary check` or commits through the installed `pre-commit` hook,
the guard refuses with `private-domain-actor-mismatch`. That check is
attribution under the reviewed configuration, not authentication: the policy is
a workspace file. The owner can let one named operator pass it, without handing
over ownership, by signing a delegation.

- **Where it lives.** Delegations are kept in `boundary-delegations.v1.json`
  beside the boundary policy (`atelier-boundary-delegations@v1`). The policy
  contract is unchanged.
- **What it covers.** One operator, the listed private-domain repositories, and
  the operations `boundary-check` and `pre-commit` (a staged check is the commit
  path). Expiry is required, at most 90 days after `notBefore`. Ownership,
  audiences, the read boundary, forbidden paths, content rules and their
  exceptions, promotion, push-content checks and publication are never changed.
  Every other finding is still reported, and the operator still appears as the
  actor.
- **Who signs.** The owner, with their own key from `atelier attestation
  keygen`. `atelier boundary delegation draft` prepares the document;
  `atelier boundary delegation sign <draft> --key <owner key>` signs it. Nobody
  else needs the private key.
- **What the host supplies.** The owner's public key, and any revocations, in an
  `atelier-boundary-owner-keys@v1` file outside the project. The CLI reads
  `--owner-keys FILE`, else `ATELIER_BOUNDARY_OWNER_KEYS`, else
  `/etc/atelier/boundary-owner-keys.json` (on Windows,
  `%ProgramData%\atelier\boundary-owner-keys.json`). On macOS and Linux the file
  must be a regular file that the current user does not own and cannot write or
  replace, in directories the user cannot write, and not group- or
  world-writable; the root account is refused. On Windows only location, link,
  regular-file and writability checks apply. Keys in the policy, the delegations
  document, the environment or `ext` are never trusted. A library host passes
  `ownerKeys` and `delegations` to `checkBoundaryPolicy` directly.
- **Binding.** Each delegation records a digest of the repository's policy entry
  and the policy-wide protections (mode, forbidden paths, content rules, their
  exceptions and promotion). Editing any of them voids the delegation until the
  owner signs again, so a delegated operator cannot loosen them.
- **Revocation.** The host adds the delegation id to `revokedDelegations`, or
  removes the owner's key. Removing the delegation from the operator-writable
  document also stops it, but only the host list is a revocation the owner can
  rely on.
- **Outcome.** A delegation that applies replaces the mismatch with the
  informational finding `private-domain-delegated-operator`, naming the operator,
  owner, delegation id and expiry. Otherwise the mismatch stays, with a typed
  `details.delegationReason`: `delegation-missing`, `delegation-scope`,
  `delegation-ambiguous`, `delegation-malformed`, `delegation-owner-key-missing`,
  `delegation-owner-keys-untrusted`, `delegation-owner-keys-invalid`,
  `delegation-signature-invalid`, `delegation-revoked`, `delegation-not-yet-valid`,
  `delegation-expired` or `delegation-policy-binding-changed`. An invalid
  delegations document is reported as `boundary-delegations-invalid` and grants
  nothing.
- **Limit.** This protects against an operator who cannot write the host key
  location. An administrator of the same machine can replace that file, and
  nothing local prevents it. The operator can still edit the policy itself, as
  before; a delegation does not make the policy tamper-proof.

The policy validator now also accepts the `contractVersion` and `ext` members
the v1 schema already declared. `ext` is ignored and never carries authority.

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
longer exists — the failure is silent, which is why two client-zero repos stopped
syncing for weeks before anyone noticed.

Record a provider-stable identity in `atelier.project.json`:

```json
{
  "name": "studio-journal",
  "path": "studio-journal",
  "readBoundary": "team",
  "identity": { "provider": "github", "id": "900001" },
  "aliases": ["journal", "press"]
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

## Content Rules and Exceptions

Content rules judge **what is being pushed**, not the whole tree. A whole-tree
scan cannot tell "you are about to push a new violation" from "a known, accepted
usage exists", so one legitimate use anywhere blocks every push of everything in
that repo, forever — including work that has nothing to do with the finding.
That is how a public site's owner-authorized mock cart stranded real work on a
machine for weeks.

- `pre-commit` runs `atelier boundary check --staged` — added lines in the
  staged diff.
- `pre-push` runs `atelier boundary push-check` — git writes the ref updates to
  the hook's stdin, and only that range is judged. A brand-new branch is diffed
  against the empty tree, so nothing slips through unscanned.
- `atelier boundary audit` scans the current working tree by default and
  **reports without blocking**, listing matches, incomplete-read diagnostics,
  and declared exceptions with their reasons. Use `--head` for a committed
  snapshot. The output names its source so a dirty tree cannot be mistaken for
  `HEAD` evidence.

If the guard cannot work out which repo it is running in, it fails closed. A
guard that silently judges nothing is worse than one that stops you.

Path scopes are segment-aware globs: `*` does not cross `/`, `**` does, and
patterns are matched against normalized repository-relative paths. Explicitly
declaring `contentRules: []` is invalid; omit the field to receive defaults.
Git diff output and binary reads have per-file and aggregate budgets. A failed,
truncated, oversized, or unparsable evidence read produces a blocking
completeness diagnostic rather than a partial clean verdict.

### Declaring an exception

Exceptions live in the boundary policy, not in the guard script. A repo-specific
product decision must not require editing shared infrastructure that every repo
runs:

```json
"contentRuleExceptions": [
  {
    "rule": "browser-persistence",
    "repo": "example-site",
    "paths": ["src/scripts/cart.ts"],
    "reason": "owner-authorized mock cart on a public demo site; localStorage is its whole design"
  }
]
```

Every field is required, because the exception **is** the approval record. There
is no blanket repo-wide skip: `paths` must name real paths, and a bare `*` or
`**` is rejected as disabling the rule rather than excepting it. `reason` must
say something a reviewer can act on. Removing the exception re-blocks the path.
