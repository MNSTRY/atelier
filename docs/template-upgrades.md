# Local template adoption

The built-in `local-template-profile@1` participant prepares an inert template
profile, graph selection and read-only projection in the existing exact-plan
upgrade engine. It uses the same exclusive writer, exact preimages, saved bytes,
append-only private journal, backups, commit hooks and commit verification.
It is not a plugin registry or a second transaction engine.

## Prepare and inspect

Use an isolated linked worktree with one managed root repository. Commit the
profile and selection JSON inputs before preparing. Both paths must be literal,
distinct, root-relative regular non-executable files outside managed output.
The selection has exactly `projectRef`, `roleNodeIds`, `target`, and optional
`theme`. Source selection and disclosure are enforced by the existing canonical
graph, projection policy and template composition adapter.

Explicit enrollment uses `atelier.adoption-policy.json`:

```json
{
  "schema": "mnstry.atelier-adoption-policy@v2",
  "enabled": true,
  "participant": "local-template-profile@1",
  "mode": "manual-exact-plan",
  "maxAgeSeconds": 86400,
  "recoveryCoverage": "local-only",
  "allowedEffects": ["template-adoption", "lock-and-projections", "git-commit"]
}
```

The API is exported through the existing `@mnstry/atelier/upgrade` subpath:

```js
import { prepareTemplateUpgrade, explainSavedUpgrade, applySavedUpgrade }
  from '@mnstry/atelier/upgrade'

const prepared = prepareTemplateUpgrade({
  project,
  profileFile: 'next-profile.json',
  selectionFile: 'next-selection.json',
})
const explanation = explainSavedUpgrade({ project, planFile: prepared.savedPlan })
// Inspect the exact changes and obtain the owner's selection before applying.
// A digest identifies bytes; it does not authenticate a human decision.
const result = applySavedUpgrade({
  project,
  planFile: prepared.savedPlan,
  confirm: prepared.plan.digest,
})
```

There is no new CLI command family. The existing saved-plan apply, explain,
status and recovery entry points understand the new v3 plan. Existing v2 plans
remain supported and still refuse execution when their pinned executor changes.
Policies are never silently converted.

## Installed state

The engine owns only these template paths:

- `atelier-template/profile.json` and `selection.json`: Exact inert input bytes.
- `atelier-template/adoption.json`: Validated installed state with typed refs,
  raw input digests and the four managed-content digests/modes.
- `atelier-template/history/<digest>.json`: Exact immutable prior adoption
  manifest on subsequent adoption.
- `atelier-output/template.html` and `template-binding.json`: Read-only
  rendering and its validated source binding.

The existing lock and normal four graph/projection/readiness files are refreshed
through their original builders. The v1 lock keeps unrelated fields, provenance,
migration history, historical success metadata, and the complete workspace
template lineage in `lock.template`. Only package and generated information
are refreshed. The separate adoption document owns the profile's typed identity,
version, and digest. A profile adoption never replaces the workspace template
identity or version. The adoption document does not hash itself recursively.

First adoption refuses orphan reserved state. Later adoption verifies every
managed preimage and the complete prior-manifest chain. Committed local changes
to managed files refuse rather than being overwritten. Source documents and
ordinary local configuration are never template write targets.

Repeating the same valid inputs is another explicit adoption, not an implicit
no-op: it appends a new adoption manifest linked to the previous one. Identical
profile, selection and projection bytes are not rewritten. Existing history is
verified and retained. Empty reserved root/history directories are harmless;
unknown reserved child directories are refused, including empty ones.

Before mutation the engine recomputes the template output using current canonical
source and compares it to the saved bytes. After writes it verifies the installed
profile, selection, binding and rendering against that same source. A partial or
failed operation never reports completed adoption.

## Limits and recovery

External packs, runtime profiles, extension handlers, local overlays, custom
callbacks, package installation, network retrieval, source migrations and
automatic consent remain unsupported. This first participant does not claim
full template migration or all-carrier conformance.

The exact-plan POSIX, clean-worktree, path, Git, hook, expiry, bounded-inventory
and local-evidence controls still apply. Only regular create/update writes are
supported; no deletion, rename, executable mode change or arbitrary scaffolding
is added. An accepted attempt consumes its plan, including an interrupted attempt.

Use the existing operation status and recovery dry-run API. Recovery describes
verified backups and conflicts; it never restores files, resets history, clears
a lease, resumes a consumed plan or supplies new consent automatically. A later
restoration needs a separately reviewed operation. Corrupted or missing evidence
cannot become success.

A completed transaction means a local candidate commit only. Independent review,
CI, merge, publisher authentication, package release, recipient adoption,
runtime activation and human acceptance remain separate.
