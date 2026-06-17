# Author Onboarding

This is the default private-preview example for Author. It is intentionally a
placeholder and does not provision accounts or repositories.

## Identity Placeholders

- Display name: `Author`
- GitHub login placeholder: `AUTHOR_GITHUB_LOGIN_PLACEHOLDER`
- Private domain repo: `github.com/<org>/author-private`
- Shared Mystery project repo: `github.com/<org>/mystery-private-preview`

`AUTHOR_GITHUB_LOGIN_PLACEHOLDER` is not a real account. Keep committed templates
placeholder-only; set Author's real GitHub login or email only inside the copied
private workspace or by passing initializer flags.

## Repo Layout

Author gets one private domain repository:

```text
author-private/
  atelier.project.json
  repo-access.v1.json
  boundary-policy.v1.json
  atelier.lock.json
  domain/
```

Shared Mystery project work stays in shared repositories:

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

Use `atelier` as the primary CLI command. `mnstry-atelier` remains a legacy
alias for older copied workspaces.

1. Run `atelier init --template private-domain --target ./author-private --actor author`.
2. Run `atelier init --template shared-project --target ./mystery-private-preview --actor author`.
3. Replace placeholder repo names and local paths.
4. Run `atelier lock write --project ./atelier.project.json` after
   choosing the exact Atelier package source.
5. Keep Author-only source in the private domain repo.
6. Put only reviewed shared source in the Mystery shared project repo.
7. Run `atelier boundary check --staged` before committing.

The preview does not send data, mutate runtime state, or write through the
browser. Local commands only read source files and generate local outputs.

Track project config and source documents. Ignore the local overlay:
`atelier.local.json`, `atelier.workspace.local.json`, `.atelier-local/`,
proposals/current/presence/nonce/grants/audit/session/support state, support
bundles, prompts, transcripts, generated projections, `node_modules/`, and
`.DS_Store`.

Use `docs/upgrade.md` when refreshing the copied workspace package version.
