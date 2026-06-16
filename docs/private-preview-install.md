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

Then update:

- `atelier.project.json` repo paths.
- `repo-access.v1.json` read boundaries.
- README placeholders for project names and Git remotes.

Run local-only checks from the copied workspace:

```bash
mnstry atelier graph --project ./atelier.project.json
mnstry atelier project --project ./atelier.project.json
mnstry atelier readiness --project ./atelier.project.json
```

These commands read local files and write generated local outputs only.
