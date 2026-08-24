# Install

This is the install guide for Atelier workspaces. The workspace pattern it
installs — Repo Boundary Guard V1 — keeps private domain source in
user-owned Git repositories and keeps shared project work in shared project
repositories.

## Posture

- No telemetry.
- No cloud service is required by Atelier.
- No MNSTRY runtime mutation.
- No direct browser writes or apply endpoints.
- No GitHub provisioning from this package.

Git repository access is the hard read boundary for source files. Local
`kg.audience` labels guide projection and review, but they do not hide files
from anyone who can read the repository.

Two command forms ship, and each has a place. Inside an installed
workspace, use `atelier` — it resolves from `node_modules/.bin`, so npm
scripts and workspace shells get the real binary. From outside a
workspace, always use the branded `npx mnstry-atelier` form: the unscoped
npm name `atelier` belongs to an unrelated third-party package, so a bare
`npx atelier` outside a workspace runs someone else's code.

## Install shape

The registry is the distribution channel of record, as `docs/continuity.md`
commits:

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.4
```

Installing from the matching Git tag resolves to the same reviewed commit:

```bash
npm install --save-dev "git+https://github.com/MNSTRY/atelier.git#v0.2.0-alpha.4"
```

Or over SSH:

```bash
npm install --save-dev "git+ssh://git@github.com/MNSTRY/atelier.git#v0.2.0-alpha.4"
```

Keep the `@mnstry/` scope — see the command-form note above for why the
unscoped name is dangerous.

Do not install from `v0.2.0-alpha.0`. That tag is the **contract epoch
marker** — `contracts/compat-baseline.json` pins the compatibility gate to it,
so it stays where it is permanently. It predates the current tree and carries
`publishConfig.access: "restricted"`.

The workspace `atelier.lock.json` should record the resolved version or Git
SHA from the install. Treat the tag or version as the friendly handle and the
SHA as the review authority.

### Adapter runners must bind package identity

An early downstream adapter exposed a subtle failure mode worth making a
general rule: a wrapper that scans arbitrary sibling checkouts and accepts the
first matching binary can validate against an archived tree while appearing
current. Adapter and distribution runners must therefore:

1. declare one exact `@mnstry/atelier` version in their package manifest;
2. prefer the installed `node_modules/@mnstry/atelier` package over incidental
   sibling checkouts;
3. accept an explicit local checkout only when its package name and version
   match the declared dependency;
4. run `atelier --version` and `atelier lock check` as part of adapter proof;
5. fail closed when the declared version, resolved package, and lock disagree.

This rule binds which Atelier implementation ran. It does not make generated
output authoritative or grant runtime mutation.

Use one private domain repository per user:

```text
github.com/<org>/<github-login>-private-domain
```

Use shared project repositories for project work that the team can read:

```text
github.com/<org>/project-<project-slug>
github.com/<org>/project-shared-library
```

The repository names above are examples. Create and permission repositories in
GitHub or your internal Git host before pointing Atelier at them.

## Tenant workspace example

Default placeholder shape:

- Actor id: `tenant-user`
- GitHub login placeholder: `TENANT_GITHUB_LOGIN_PLACEHOLDER`
- Private domain repo: `github.com/<org>/tenant-private-domain`
- Shared project repo: `github.com/<org>/project-alpha`

`TENANT_GITHUB_LOGIN_PLACEHOLDER` is not a real account. Set real identity
values only inside the copied private workspace or through initializer flags.
The example repositories are placeholders, not repositories created by this
package release.

## Local setup

Copy one of the starter templates:

- `templates/private-domain-workspace/` for one user's private domain repo.
- `templates/shared-project-workspace/` for shared project repositories.

Prefer the CLI initializer when possible:

```bash
atelier init --template private-domain --target ./tenant-private-domain --actor tenant-user
atelier init --template shared-project --target ./project-alpha --actor tenant-user
```

`--actor` rewrites the copied boundary policy actor entry and binds it to the
local Git email when available. Use `--github-login` or `--git-email` to set
those values explicitly during onboarding.

Then update:

- `atelier.project.json` repo paths.
- `repo-access.v1.json` read boundaries.
- `atelier.lock.json` with `atelier lock write` after choosing the exact Atelier package source.
- README placeholders for project names and Git remotes.

Keep project configuration tracked and local overlay state ignored. Track
`atelier.project.json`, `repo-access.v1.json`, `boundary-policy.v1.json`,
`atelier.lock.json`, and source documents. Do not track `atelier.local.json`,
`atelier.workspace.local.json`, `.atelier-local/`, proposals/current/presence/
nonce/grants/audit/session/support state, prompts, transcripts, support
bundles, or generated projections.

Run local-only checks from the copied workspace:

```bash
atelier graph --project ./atelier.project.json
atelier project --project ./atelier.project.json
atelier readiness --project ./atelier.project.json
atelier readiness journey --project ./atelier.project.json
atelier readiness run mnstry.readiness:identity-map --project ./atelier.project.json
atelier readiness packet --project ./atelier.project.json
atelier readiness export --dry-run --project ./atelier.project.json
```

These commands read local files and write generated local outputs only.

## Upgrade path

The starter commands create `atelier.lock.json` inside the copied workspace so
the installed Atelier package source, version, contracts, and migration state
are reviewable. Refresh it from inside the copied workspace after choosing a
registry or Git tag install. Local tarballs remain release-audit and
smoke-test tools; they are not the default install path.

See `docs/tenant-readiness.md` for the readiness review format and
`docs/upgrade.md` for the full upgrade flow and boundary review checklist.
