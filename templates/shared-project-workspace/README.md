# Shared Mystery Workspace

Starter for shared Mystery project repositories.

Default example:

- Project: `mystery-private-preview`
- Shared repo: `github.com/<org>/mystery-private-preview`
- Example collaborator: `Author`
- Example collaborator login: `AUTHOR_GITHUB_LOGIN_PLACEHOLDER`

`AUTHOR_GITHUB_LOGIN_PLACEHOLDER` is a placeholder, not a real account.

## Boundary

Shared Mystery repos are readable by the project group. Do not place private or
sensitive personal domain source here. Use a private domain repo per user for
that material.

## Local Commands

```bash
mnstry atelier graph --project ./atelier.project.json
mnstry atelier project --project ./atelier.project.json
mnstry atelier readiness --project ./atelier.project.json
mnstry atelier lock check --project ./atelier.project.json
mnstry atelier upgrade --dry-run --project ./atelier.project.json
```

Atelier performs no telemetry, cloud sync, runtime mutation, or direct browser
writes for this preview.

## Atelier Lockfile

`mnstry-atelier init --template shared-project` writes `atelier.lock.json`.
If this template was copied manually, create the lock before the first commit:

```bash
mnstry-atelier lock write --project ./atelier.project.json
```
