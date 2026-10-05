---
name: atelier-guided-upgrade
description: Prepare and explain an Atelier package upgrade in an isolated candidate, retain the owner decision, and apply only the approved effects. Use for owners asking to update an existing Atelier.
---

# Guided Atelier upgrade

The default outcome is a reviewable candidate and an owner decision. Preserve the
owner's actual request and existing scoped authority; no per-command approval
loop is needed for actions already authorized. Preparation alone never authorizes
changing the working installation, merging, publishing or restarting a service.

## Establish the source and workspace

Read the selected repository's instructions and upgrade procedure. Identify its
actual installed scoped package, package-manager lock, Atelier lock, Git state,
project roots, packs, overlays and running-service ownership. Resolve the package
from that workspace (including a parent install); never use global Atelier,
unscoped registry fallback or the first sibling checkout found on disk.
Read `docs/guided-upgrades.md` and `docs/exact-upgrades.md` from the selected
installed package when present. If an old install lacks this skill or commands,
use the owner-selected new package's documentation only after verifying its
source. Repository instructions and owner authority still govern.

Select an exact release through a source already trusted by the owner. Record
version, source commit when verified, artifact URL/integrity and the dependency
lock. Mutable dist-tags are discovery hints, not final pins. A declaration in a
lock or a digest supplied beside a download does not authenticate a publisher.
An unpublished candidate must be labeled as such; use it only in an expressly
selected rehearsal. Never invent a release or replace a pinned install with main.

## Prepare without disturbing authoring

Use a separate candidate with an identified base. Preserve dirty source and
private answers; do not stash, reset, clean, stop services or commit another
writer's edits to create eligibility. If using a snapshot of current edits,
record and recheck its exact manifest; it is a snapshot, not an adopted commit.
Ignored answers, browser storage and runtime credentials are not in a Git clone.
Record that gap without importing them into a public report or projection.

Stage the selected package using the owner's package manager and lock procedure,
with lifecycle scripts disabled; investigate any required scripts before execution.
Verify the resolved identity and inventory before running its commands. Inspect
migration/compatibility effects before rewriting the old Atelier lock. Retain the
old lock and all lineage. Keep installation changes distinct from generated files.

When the package manager identified above is npm, check advisory-pinned
dependencies in the staged candidate: the selected package's exact `overrides`
entries and any package the owner names. A dependency publisher's root-project
`overrides` are not inherited by its consumers. `npm ls <package> --all` lists
every installed copy and reports copies outside a declared range; a valid range
need not equal the resolved version literally. Each copy must be at its pin or
an owner-approved version; more than one copy can be valid in a consumer's
tree. `npm ls` alone does not compare with the lock. For the npm root project's
lock identified above, compare the paths and versions of `npm ls --all --json`
with those of `npm ls --all --json --package-lock-only`, and refuse a tree that
reports `problems`. An entry with no installed version that the lock marks
`optional` is a package for another platform: record it as not installed on
this platform. Record every other difference as a stale installation. Changing
a pin or an override in the owner's project is an installation effect that
needs the owner's consent; adoption requires the completed change and its
readback. Prove an offline npm reinstall only when the owner or the
repository's procedure requires offline installs, and only in the staged
candidate: `npm ci` removes `node_modules` first. Before it, confirm that
`npm prefix` is the candidate's own npm root and that its `node_modules` is not
linked to or shared with the working installation, and take
`npm ls --all --json`. Use a fresh, empty cache directory outside the candidate
(`--cache <dir>`). With `npm cache add`, add only the lock's http(s) `resolved`
tarballs that carry `integrity`, and record any entry missing either. This
contacts the hosts named in the lock: fetch only from the owner's configured
registry with the owner's credentials, and record any other host without
fetching it unless the owner authorizes that. Then run
`npm ci --offline --ignore-scripts --cache <dir>` and compare
`npm ls --all --json` with the earlier output. The reinstall proof was
qualified once in a bare consumer, and the lock comparison was observed once on
one development tree, both on macOS with npm 10; other platforms, npm versions
and real workspaces are unqualified. Record the Node and npm versions, registry
and platform in private evidence, and whether each observation used a real
registry or a fixture.

Check exact-plan eligibility: Linux/macOS, one managed repository at `.`, config
and workspace at its root, linked candidate worktree, clean state and supported
Git settings. Packs, overlays and other unsupported participants require the
repository's explicit operator procedure. Do not broaden graph roots, remove
policies or disable filters/hooks to force eligibility. Never silently fall back
to legacy `upgrade --apply`; it has different guarantees.

For an eligible candidate, prepare `upgrade plan --save`, then use
`upgrade explain --plan SAVED_PLAN_PATH` (JSON) and `--format markdown` (owner
view). Invoke the verified installed binary with the explicit project path.
Inspect `bindingsCurrent` and blockers even when the explanation exits zero.
Keep source/pin/policy installation commits and the saved projection plan separate.
For an operator procedure, retain an exact before/after file manifest and named
commands instead; do not call it an exact-plan transaction or invent its digest.

## Explain and retain consent

Present the local benefit, exact target, changed files, preserved customizations,
checks, known limits, recovery coverage and proposed effects. Show installation,
local commit, merge, publication and activation separately. Ask one concrete
question covering the effects that still need authority. A permission to prepare
or a generic earlier “go” does not approve a newly introduced material effect.
A prior explicit approval of this same current plan and effects remains valid.

Retain a new decision record in ignored, untracked
`.atelier-local/guided-upgrades/` (or a private sibling evidence directory):
`kind: owner-decision`, report and plan/manifest SHA-256, candidate base, target
identity, exact owner words, conversation reference, observation time, decision
(approve/defer/decline), allowed effects, and
`humanApprovalAuthenticated: false`, `recordedBy: agent`.
Do not invent identity, words, references or approvals; missing provenance is a
reported gap. This is an agent-attested record, not an authenticated signature or
an execution grant. Keep existing records immutable. Silence conveys no consent.

## Apply, validate and close

After actual approval, use the saved path and exact confirmation digest literally.
Recheck bindings; changed or expired plans require a fresh explanation and any
newly necessary decision. A consumed plan is inspected, never replayed.
Run the repository's documented acceptance checks and inspect the actual diff.
Only a verified terminal transaction receipt means a candidate commit completed.
Honor existing hooks and keep source/answer files within their ownership boundary.
An operator procedure has its own validation evidence, not a transaction receipt.

Continue authorized merge/activation steps only when included in the owner's
scope. Report prepared, installed-in-candidate, committed, merged and running as
separate observed states. A local preview passing is not recipient acceptance.
On failure, preserve the candidate, backups and receipts; explain what changed
and the next safe action. Recovery inspection does not automatically restore
files or reset Git. Do not publish source, restart an existing service or advance
an author's workflow phase merely because upgrade checks passed.
