# Private Preview Install

Repo Boundary Guard V1 is a local-first preview pattern for Atelier workspaces.
It keeps private domain source in user-owned Git repositories and keeps shared
Mystery project work in shared project repositories.

## Preview Posture

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

Install the private preview from the accepted Git tag. Public npm publishing is
deferred until the public package path is ready:

```bash
npm install --save-dev git+https://github.com/mnstry/atelier.git#v0.1.0-alpha.0
```

Invited users who prefer SSH may use:

```bash
npm install --save-dev git+ssh://git@github.com/mnstry/atelier.git#v0.1.0-alpha.0
```

The workspace `atelier.lock.json` should record the resolved Git SHA from this
tag install. Treat the tag as the collaborator-friendly handle and the SHA as
the review authority.

Use one private domain repository per user:

```text
github.com/<org>/<github-login>-private-domain
```

Use shared Mystery project repositories for project work that the team can read:

```text
github.com/<org>/mystery-<project-slug>
github.com/<org>/mystery-shared-library
```

The repository names above are examples. Create and permission repositories in
GitHub or your internal Git host before pointing Atelier at them.

## Author Example

Default example user:

- Name: `Author`
- GitHub login placeholder: `AUTHOR_GITHUB_LOGIN_PLACEHOLDER`
- Private domain repo: `github.com/<org>/author-private`
- Shared Mystery project repo: `github.com/<org>/mystery-private-preview`

`AUTHOR_GITHUB_LOGIN_PLACEHOLDER` is not a real account and the templates do not
include Author's real GitHub login or email. Set real identity values only inside
the copied private workspace or through initializer flags. `author-private` and
`mystery-private-preview` are the proof-repo defaults, not repositories created by
this package release.

## Local Setup

Copy one of the starter templates:

- `templates/private-domain-workspace/` for one user's private domain repo.
- `templates/shared-project-workspace/` for shared Mystery project repositories.

Prefer the CLI initializer when possible:

```bash
atelier init --template private-domain --target ./author-private --actor author
atelier init --template shared-project --target ./mystery-private-preview --actor author
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
```

These commands read local files and write generated local outputs only.

## Upgrade Path

The starter commands create `atelier.lock.json` inside the copied workspace so
the installed Atelier package source, version, contracts, and migration state
are reviewable. Refresh it from inside the copied workspace after choosing a
private GitHub tag install. Local tarballs remain release-audit and smoke-test
tools; they are not the default collaborator install path.

See `docs/upgrade.md` for the full upgrade flow and boundary review checklist.
