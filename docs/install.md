# Install

This is the install guide for Atelier workspaces. The workspace pattern it
installs — Repo Boundary Guard V1 — keeps private domain source in
user-owned Git repositories and keeps shared project work in shared project
repositories.

## Posture

- No telemetry.
- No cloud service is required by Atelier.
- No MNSTRY runtime mutation.
- No direct browser writes or apply endpoints.
- No GitHub provisioning from this package.

Git repository access is the hard read boundary for source files. Local
`kg.audience` labels guide projection and review, but they do not hide files
from anyone who can read the repository.

For adapters whose source repositories live elsewhere, see
[project options](project-options.md) for shared CLI overrides, precedence and
resolution diagnostics. Moving a repository does not change its read authority.

Two command forms ship, and each has a place. Inside an installed
workspace, use `atelier` — it resolves from `node_modules/.bin`, so npm
scripts and workspace shells get the real binary. From outside a
workspace, always use the branded `npx mnstry-atelier` form: the unscoped
npm name `atelier` belongs to an unrelated third-party package, so a bare
`npx atelier` outside a workspace runs someone else's code.

## Install shape

The registry is the distribution channel of record, as `docs/continuity.md`
commits:

```bash
npm install --save-dev @mnstry/atelier@0.2.0-alpha.7
```

Installing from the matching Git tag resolves to the same reviewed commit:

```bash
npm install --save-dev "git+https://github.com/MNSTRY/atelier.git#v0.2.0-alpha.7"
```

Or over SSH:

```bash
npm install --save-dev "git+ssh://git@github.com/MNSTRY/atelier.git#v0.2.0-alpha.7"
```

Keep the `@mnstry/` scope — see the command-form note above for why the
unscoped name is dangerous.

Do not install from `v0.2.0-alpha.0`. That tag is the **contract epoch
marker** — `contracts/compat-baseline.json` pins the compatibility gate to it,
so it stays where it is permanently. It predates the current tree and carries
`publishConfig.access: "restricted"`.

The workspace `atelier.lock.json` should record the resolved version or Git
SHA from the install. Treat the tag or version as the friendly handle and the
SHA as the review authority.

### Adapter runners must bind package identity

An early downstream adapter exposed a subtle failure mode worth making a
general rule: a wrapper that scans arbitrary sibling checkouts and accepts the
first matching binary can validate against an archived tree while appearing
current. Adapter and distribution runners must therefore:

1. declare one exact `@mnstry/atelier` version in their package manifest;
2. prefer the installed `node_modules/@mnstry/atelier` package over incidental
   sibling checkouts;
3. accept an explicit local checkout only when its package name and version
   match the declared dependency;
4. run `atelier --version` and `atelier lock check` as part of adapter proof;
5. fail closed when the declared version, resolved package, and lock disagree.

This rule binds which Atelier implementation ran. It does not make generated
output authoritative or grant runtime mutation.

Use one private domain repository per user:

```text
github.com/<org>/<github-login>-private-domain
```

Use shared project repositories for project work that the team can read:

```text
github.com/<org>/project-<project-slug>
github.com/<org>/project-shared-library
```

The repository names above are examples. Create and permission repositories in
GitHub or your internal Git host before pointing Atelier at them.

## Tenant workspace example

Default placeholder shape:

- Actor id: `tenant-user`
- GitHub login placeholder: `TENANT_GITHUB_LOGIN_PLACEHOLDER`
- Private domain repo: `github.com/<org>/tenant-private-domain`
- Shared project repo: `github.com/<org>/project-alpha`

`TENANT_GITHUB_LOGIN_PLACEHOLDER` is not a real account. Set real identity
values only inside the copied private workspace or through initializer flags.
The example repositories are placeholders, not repositories created by this
package release.

## Local setup

Copy one of the starter templates:

- `templates/private-domain-workspace/` for one user's private domain repo.
- `templates/shared-project-workspace/` for shared project repositories.

Prefer the CLI initializer when possible:

```bash
atelier init --template private-domain --target ./tenant-private-domain --actor tenant-user
atelier init --template shared-project --target ./project-alpha --actor tenant-user
```

`--actor` rewrites the copied boundary policy actor entry and binds it to the
local Git email when available. Use `--github-login` or `--git-email` to set
those values explicitly during onboarding. Initialization does not infer a
GitHub login from the environment or actor slug; without `--github-login` it
retains an actor-specific placeholder. At check time, explicit selectors are validated even for shared-only work.
Unknown `--actor`/`MNSTRY_ATELIER_ACTOR` values or conflicting explicit selectors
are always errors. Boundary ownership is scoped to configured repository names;
these names do not authenticate a checkout's identity. Duplicate configured names
are refused case-insensitively.

Derived attribution is needed only when the project operates a private-domain
repository with a declared owner. Shared-only checks skip platform, Git-email and
`gh` lookup entirely. When ownership requires attribution, precedence is:

| Input | Result |
| --- | --- |
| `--actor` or `MNSTRY_ATELIER_ACTOR` | Must name one declared actor; wins over derived inputs. |
| `GITHUB_ACTOR` | Must uniquely match a declared `githubLogin`, case-insensitively. Unmapped/ambiguous values do not fall through. Actor keys and login placeholders are not login mappings. |
| Configured Git email | Used only without either input above; must map to one actor. Commit history is never used. |
| Optional `gh api user` | Used only when the inputs above are absent or configured email has no match; must uniquely match a declared login. Sync disables this lookup. |

Unresolved derived attribution and ownership mismatches are errors in strict
mode and warnings in ordinary `legacy-warning` mode. Sync forces ownership errors
in both modes. Reports retain the resolution reason and affected repository.
`allowHistoryActorResolution` is a deprecated, accepted no-op: setting it to true
never enables history-based attribution. These are attribution hints, not
authenticated authorization. In particular `GITHUB_ACTOR` describes the supplied
platform value, not an authenticated human operating a phone or a workflow rerun.
Shared-host deployment must establish its own trusted identity boundary.

`init` refuses existing scaffold files or an existing project/lock; use `adopt`
for existing content and `upgrade` for managed changes. Adoption validates the
selected policy before creating a first lock, preserves existing locks, and
refuses drift rather than reporting success. Choose and install the intended
package before adoption. Preview configs resolve `@mnstry/atelier/cli` from the
workspace through parent `node_modules` directories using Node, without registry
fallback. This supports the documented subdirectory target and hoisted install.
Generate `graph` and `project` output before starting the preview. Existing launch
configs are not rewritten by these template changes.

Then update:

- `atelier.project.json` repo paths.
- `repo-access.v1.json` read boundaries.
- `atelier.lock.json`: inspect `atelier lock check`; use the reviewed upgrade path for a changed package or policy rather than silently rewriting the baseline.
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
atelier readiness journey --project ./atelier.project.json
atelier readiness run mnstry.readiness:identity-map --project ./atelier.project.json
atelier readiness packet --project ./atelier.project.json
atelier readiness export --dry-run --project ./atelier.project.json
```

These commands read local files and write generated local outputs only.

## Upgrade path

The starter commands create `atelier.lock.json` inside the copied workspace so
the installed Atelier package source, version, contracts, and migration state
are reviewable. Refresh it from inside the copied workspace after choosing a
registry or Git tag install. Local tarballs remain release-audit and
smoke-test tools; they are not the default install path.

See `docs/tenant-readiness.md` for the readiness review format and
`docs/upgrade.md` for the full upgrade flow and boundary review checklist.

## External source adapters and local review

Use `atelier init --template external-project --target NEW_DIRECTORY` for the
invented adapter/source starter. See [local review](local-review.md) for the
complete installed workflow, source ownership, asserted identity and save/resume.
`atelier lock provenance` distinguishes declared install origin, observed package
bytes and verified clean-checkout binding. It never substitutes the consumer
repository's HEAD for the installed package.
