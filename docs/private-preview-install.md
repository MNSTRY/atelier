# Private Preview Install

Repo Boundary Guard V1 is a local-first preview pattern for Atelier workspaces.
It keeps private domain source in user-owned Git repositories and keeps shared
Mystery work in shared project repositories.

## Preview Posture

- No telemetry.
- No cloud service is required by Atelier.
- No MNSTRY runtime mutation.
- No direct browser writes or apply endpoints.
- No GitHub provisioning from this package.

Git repository access is the hard read boundary for source files. Local
`kg.audience` labels guide projection and review, but they do not hide files
from anyone who can read the repository.

## Install Shape

Use one private domain repository per user:

```text
github.com/<org>/<github-login>-private-domain
```

Use shared Mystery repositories for project work that the team can read:

```text
github.com/<org>/mystery-<project-slug>
github.com/<org>/mystery-shared-library
```

The repository names above are examples. Create and permission repositories in
GitHub or your internal Git host before pointing Atelier at them.

## Author Example

Default example user:

- Name: `Author`
- GitHub login: `AUTHOR_GITHUB_LOGIN_PLACEHOLDER`
- Private domain repo: `github.com/<org>/AUTHOR_GITHUB_LOGIN_PLACEHOLDER-private-domain`
- Shared Mystery repo: `github.com/<org>/mystery-private-preview`

`AUTHOR_GITHUB_LOGIN_PLACEHOLDER` is not a real account. Replace it before using
the template.

## Local Setup

Copy one of the starter templates:

- `templates/private-domain-workspace/` for one user's private domain repo.
- `templates/shared-project-workspace/` for shared Mystery repositories.

Prefer the CLI initializer when possible:

```bash
mnstry-atelier init --template private-domain --target ./mnstry-private-author --actor author
mnstry-atelier init --template shared-project --target ./mystery-private-preview --actor author
```

`--actor` rewrites the copied boundary policy actor entry and binds it to the
local Git email when available. Use `--github-login` or `--git-email` to set
those values explicitly during onboarding.

Then update:

- `atelier.project.json` repo paths.
- `repo-access.v1.json` read boundaries.
- `atelier.lock.json` with `mnstry-atelier lock write` after choosing the exact Atelier package source.
- README placeholders for project names and Git remotes.

Run local-only checks from the copied workspace:

```bash
mnstry atelier graph --project ./atelier.project.json
mnstry atelier project --project ./atelier.project.json
mnstry atelier readiness --project ./atelier.project.json
```

These commands read local files and write generated local outputs only.

## Upgrade Path

The starter commands create `atelier.lock.json` inside the copied workspace so
the installed Atelier package source, version, contracts, and migration state
are reviewable. Refresh it from inside the copied workspace after choosing a
published package version, private GitHub install, or local tarball.

See `docs/upgrade.md` for the full upgrade flow and boundary review checklist.
