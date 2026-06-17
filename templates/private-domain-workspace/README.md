# Private Domain Workspace

Starter for one user's private domain repository.

Default example user:

- Name: `Owner`
- GitHub login placeholder: `USER_GITHUB_LOGIN_PLACEHOLDER`
- Repo: `github.com/<org>/tenant-private-domain`

`USER_GITHUB_LOGIN_PLACEHOLDER` is a placeholder, not a real account. Keep
committed starter files placeholder-only; set a real login or email only in the
copied private workspace.

## Boundary

This repo is the Git read boundary for the user's private source. Do not place
private domain source in a shared project repository and rely on projection
filters to hide it.

## Tracked Config And Local Overlay

Track `atelier.project.json`, `repo-access.v1.json`, `boundary-policy.v1.json`,
`atelier.lock.json`, governance files, and source documents. Ignore local
operator state such as `atelier.local.json`, `atelier.workspace.local.json`,
`.atelier-local/`, proposals/current/presence/nonce/grants/audit/session/support
state, support bundles, transcripts, prompts, generated projections,
`node_modules/`, and `.DS_Store`.

## Local Commands

```bash
atelier graph --project ./atelier.project.json
atelier project --project ./atelier.project.json
atelier readiness --project ./atelier.project.json
atelier lock check --project ./atelier.project.json
atelier upgrade --dry-run --project ./atelier.project.json
```

Atelier performs no telemetry, cloud sync, runtime mutation, or direct browser
writes for this preview.

## Atelier Lockfile

`atelier init --template private-domain` writes `atelier.lock.json`.
If this template was copied manually, create the lock before the first commit:

```bash
atelier lock write --project ./atelier.project.json
```
