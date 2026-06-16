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
  atelier.lock.json
  domain/
```

Shared Mystery work stays in shared repositories:

```text
mystery-private-preview/
  atelier.project.json
  repo-access.v1.json
  boundary-policy.v1.json
  atelier.lock.json
  mystery/
```

## First Local Pass

Install the private-preview package from the accepted Git tag before running the
initializer. Public npm publishing remains deferred:

```bash
npm install --save-dev git+https://github.com/mnstry/atelier.git#v0.1.0-alpha.0
```

1. Run `mnstry-atelier init --template private-domain --target ./mnstry-private-author --actor author`.
2. Run `mnstry-atelier init --template shared-project --target ./mystery-private-preview --actor author`.
3. Replace placeholder repo names and local paths.
4. Run `mnstry-atelier lock write --project ./atelier.project.json` after
   choosing the exact Atelier package source.
5. Keep Author-only source in the private domain repo.
6. Put only reviewed shared source in the Mystery repo.
7. Run `mnstry-atelier boundary check --staged` before committing.

The preview does not send data, mutate runtime state, or write through the
browser. Local commands only read source files and generate local outputs.

Use `docs/upgrade.md` when refreshing the copied workspace package version.
