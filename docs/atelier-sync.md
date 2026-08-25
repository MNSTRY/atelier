# Atelier Sync: Deliverable Zero

Atelier Sync is the collaborator-facing name for the resident repository
supervisor. Deliverable Zero is deliberately headless: it proves the Git,
filesystem, state-machine, recovery, and user-authority boundaries before a
tray shell or installer is allowed to make the product feel finished.

This is repository mechanics, not MNSTRY runtime authority. A Git commit
changes the enrolled repository. It does not mutate MNSTRY identity, consent,
visibility, provisioning, commerce, sessions, audit, or any other managed
runtime object.

## Authority contract

- Enrollment names exactly one repository. Atelier never scans a home folder.
- One resolved absolute system Git executable owns Git semantics for the
  enrollment. Git `2.39.0` or newer is required.
- Every cycle observes the full repository. There is no watcher correctness
  dependency in Deliverable Zero.
- Fetch and fast-forward-only reconciliation are mechanical operations.
- Commit creation is a two-phase, user-confirmed operation. Planning records
  the head, branch, complete status digest, exact file paths, commit message,
  reviewed blob/mode manifest, diff summary, and exact optional upstream
  identity. The remote identity includes a secret-safe digest of the complete
  configured URL, while persisted display evidence strips authentication
  material. Every authoritative field is bound into the operation id.
  Execution requires that exact id and refuses if the plan, repository,
  staged bytes/modes, commit tree, or publish target changed.
- A commit plan cannot absorb pre-existing staged work. It stages only literal,
  explicitly reviewed paths.
- Configured Atelier boundary policy is checked against the staged change set
  before commit creation. Ordinary Git hooks still run; the resulting commit
  tree must equal the reviewed staged tree or the local commit is rolled back
  and publication is refused.
- Push is present only when the reviewed plan requested it. Push is never
  forced, and a failed push preserves the local commit and creates one stable
  attention state.
- Semantic conflict resolution, merge commits, rebase, reset, force push,
  browser apply, broad path scans, telemetry, and hidden upload are absent.

## Repository completeness

`atelier sync status` emits an `atelier-repository-observation@v1` document.
It cannot report `complete: true` when any of these are unresolved:

- provider-managed, UNC/network, WSL-cross-boundary, or unclassified external
  filesystem roots;
- an unsupported Git engine or bare repository;
- sparse checkout or partial clone state;
- missing or unhealthy submodules;
- required Git LFS content without a working LFS integration;
- an unclassified custom clean, smudge, or process filter; or
- a remote URL whose authentication shape cannot be classified.
- any required Git evidence read that fails, times out, exceeds its budget, or
  cannot be parsed.

HTTPS through Git Credential Manager, SSH through the user's existing SSH
configuration, and local test remotes are classified explicitly. Atelier does
not collect or store provider credentials.

## Local operation state

Ignored `.atelier-local/runtime/` contains:

- `enrollment.json` — exact repository and Git engine;
- `state.json` — healthy, attention, or paused state;
- `control.json` — user pause/freeze state;
- `plans/` — reviewed commit plans;
- `operations.ndjson` — sequence- and hash-chained resident trace with explicit
  hash-bound checkpoints before its byte or record ceiling; and
- an atomic per-repository operation lock.

Every directory component is containment-checked and every state leaf is
opened without following redirects where the platform supports it, with leaf
type and identity checks on every platform. Stale-lock recovery uses an
exclusive recovery claim and quarantines only the claimed stale directory; it
never recursively deletes a newly acquired lock.

Deleting this directory removes convenience and diagnostics. It cannot change
repository meaning. Git plus readable files remain authoritative.

## Engineering commands

```bash
atelier sync enroll --repo /absolute/path/to/repository
atelier sync status --repo /absolute/path/to/repository
atelier sync reconcile --repo /absolute/path/to/repository
atelier sync run --repo /absolute/path/to/repository --once

atelier sync plan \
  --repo /absolute/path/to/repository \
  --path docs/decision.md \
  --message "docs: record decision" \
  --publish

# Repeat the exact operation id printed by plan:
atelier sync commit \
  --repo /absolute/path/to/repository \
  --operation operation-... \
  --confirm operation-...
```

The future native shell may label the final two commands **Commit & sync**.
It must not bypass either phase.

## Evidence boundary

Deliverable Zero proves the headless supervisor contract on Linux, macOS, and
Windows CI. It does not prove signed installation, background launch at user
login, Windows Home/Pro device behavior, macOS notarization, or a
nontechnical-user workflow. Those belong to the signed collaborator beta.
