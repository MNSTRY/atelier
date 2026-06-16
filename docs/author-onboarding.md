# Author Onboarding

This is the default private-preview example for Author. It is intentionally a
placeholder and does not provision accounts or repositories.

## Identity Placeholders

- Display name: `Author`
- GitHub login: `AUTHOR_GITHUB_LOGIN_PLACEHOLDER`
- Private domain repo: `github.com/<org>/mnstry-private-author`
- Shared Mystery repo: `github.com/<org>/mystery-private-preview`

Replace `AUTHOR_GITHUB_LOGIN_PLACEHOLDER` with Author's real GitHub login before
using the starter templates.

## Repo Layout

Author gets one private domain repository:

```text
mnstry-private-author/
  atelier.project.json
  repo-access.v1.json
  boundary-policy.v1.json
  domain/
```

Shared Mystery work stays in shared repositories:

```text
mystery-private-preview/
  atelier.project.json
  repo-access.v1.json
  boundary-policy.v1.json
  mystery/
```

## First Local Pass

1. Copy `templates/private-domain-workspace/` for Author's private domain repo.
2. Copy `templates/shared-project-workspace/` for shared Mystery work.
3. Replace placeholder repo names and local paths.
4. Keep Author-only source in the private domain repo.
5. Put only reviewed shared source in the Mystery repo.
6. Run `mnstry-atelier boundary check --staged` before committing.

The preview does not send data, mutate runtime state, or write through the
browser. Local commands only read source files and generate local outputs.
