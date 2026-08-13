# Install

Repo Boundary Guard V1 is a local-first pattern for Atelier workspaces. It
keeps private domain source in user-owned Git repositories and keeps shared
project work in shared project repositories.

## Posture

- No telemetry.
- No cloud service is required by Atelier.
- No MNSTRY runtime mutation.
- No direct browser writes or apply endpoints.
- No GitHub provisioning from this package.

Git repository access is the hard read boundary for source files. Local
`kg.audience` labels guide projection and review, but they do not hide files
from anyone who can read the repository.

Use `atelier` as the primary CLI command in copied workspaces. The older
`mnstry-atelier` binary is a legacy alias for compatibility.

## Install Shape

The registry is the distribution channel of record, as `docs/continuity.md`
commits:

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.1
```

Installing from the matching Git tag resolves to the same reviewed commit:

```bash
npm install --save-dev "git+https://github.com/MNSTRY/atelier.git#v0.2.0-alpha.1"
```

Or over SSH:

```bash
npm install --save-dev "git+ssh://git@github.com/MNSTRY/atelier.git#v0.2.0-alpha.1"
```

Keep the `@mnstry/` scope. The unscoped name `atelier` on npm belongs to an
unrelated third-party package, so a bare `npx atelier` runs someone else's code.

Do not install from `v0.2.0-alpha.0`. That tag is the **contract epoch
marker** — `contracts/compat-baseline.json` pins the compatibility gate to it,
so it stays where it is permanently. It predates the current tree and carries
`publishConfig.access: "restricted"`.

The workspace `atelier.lock.json` should record the resolved version or Git
SHA from the install. Treat the tag or version as the friendly handle and the
SHA as the review authority.

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

## Tenant Workspace Example

Default placeholder shape:

- Actor id: `tenant-user`
- GitHub login placeholder: `TENANT_GITHUB_LOGIN_PLACEHOLDER`
- Private domain repo: `github.com/<org>/tenant-private-domain`
- Shared project repo: `github.com/<org>/project-alpha`

`TENANT_GITHUB_LOGIN_PLACEHOLDER` is not a real account. Set real identity
values only inside the copied private workspace or through initializer flags.
The example repositories are placeholders, not repositories created by this
package release.

## Local Setup

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

## Upgrade Path

The starter commands create `atelier.lock.json` inside the copied workspace so
the installed Atelier package source, version, contracts, and migration state
are reviewable. Refresh it from inside the copied workspace after choosing a
registry or Git tag install. Local tarballs remain release-audit and
smoke-test tools; they are not the default install path.

See `docs/tenant-readiness.md` for the readiness review format and
`docs/upgrade.md` for the full upgrade flow and boundary review checklist.
