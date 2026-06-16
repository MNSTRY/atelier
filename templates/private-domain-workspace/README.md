# Private Domain Workspace

Starter for one user's private domain repository.

Default example user:

- Name: `Author`
- GitHub login: `AUTHOR_GITHUB_LOGIN_PLACEHOLDER`
- Repo: `github.com/<org>/mnstry-private-author`

`AUTHOR_GITHUB_LOGIN_PLACEHOLDER` is a placeholder, not a real account.

## Boundary

This repo is the Git read boundary for the user's private source. Do not place
private domain source in a shared Mystery repository and rely on projection
filters to hide it.

## Local Commands

```bash
mnstry atelier graph --project ./atelier.project.json
mnstry atelier project --project ./atelier.project.json
mnstry atelier readiness --project ./atelier.project.json
```

Atelier performs no telemetry, cloud sync, runtime mutation, or direct browser
writes for this preview.
