# Shared Project Workspace

Starter for shared project repositories.

Default example:

- Project: `project-alpha`
- Shared repo: `github.com/<org>/project-alpha`
- Example collaborator: `Owner`
- Example collaborator login placeholder: `USER_GITHUB_LOGIN_PLACEHOLDER`

`USER_GITHUB_LOGIN_PLACEHOLDER` is a placeholder, not a real account. Keep
committed starter files placeholder-only; set a real login or email only in the
copied private workspace.

## Boundary

Shared project repos are readable by the project group. Do not place
private or sensitive personal domain source here. Use a private domain repo per
user for that material.

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

`atelier init --template shared-project` writes `atelier.lock.json`.
If this template was copied manually, create the lock before the first commit:

```bash
atelier lock write --project ./atelier.project.json
```
