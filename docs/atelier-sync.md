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
- One resolved absolute system Git executable, version, and executable digest
  owns Git semantics for the enrollment. Every inherited `GIT_*` variable is
  stripped from supervised Git calls before Atelier adds its small fixed
  safety environment. Custom SSH transport belongs in the user's SSH config;
  credentials continue through ordinary Git credential helpers. Git `2.40.0`
  or newer is required so global and system attribute provenance is observable.
- Every cycle observes the full repository. There is no watcher correctness
  dependency in Deliverable Zero.
- Fetch and fast-forward-only reconciliation are mechanical operations.
- Commit creation is a two-phase, user-confirmed operation. Planning records
  the head, branch, complete status digest, exact file paths, commit message,
  reviewed blob/mode manifest, diff summary, and exact optional upstream push
  identity. The push identity digest covers the single resolved, normalized,
  credential-free execution destination; persisted display evidence likewise
  strips authentication material, query strings, and fragments. Multiple push
  URLs and `url.*.insteadOf`/`pushInsteadOf` rewrites are refused as ambiguous.
  Every authoritative field is bound into the operation id.
  Execution requires that exact id and refuses if the plan, repository,
  staged bytes/modes, written tree, commit parent/message, or publish target
  changed. A publish plan is refused while any earlier local commit remains
  unpublished, and publication names the exact verified commit object rather
  than a movable `HEAD` ref. Plans expire after 24 hours, are consumed by a
  definitive execution attempt, and are held under resident file/count
  ceilings. Expired, malformed, or oversized retained plan files are removed
  under the repository lock before those ceilings are enforced; redirected
  plan state remains a hard refusal.
- A commit plan cannot absorb pre-existing staged work. It stages only literal,
  explicitly reviewed paths.
- Configured Atelier boundary policy is checked against the staged change set
  before commit creation using the enrolled Git executable. When that policy
  declares private-domain ownership, actor verification is blocking even in
  legacy-warning mode. The Sync path disables the boundary command's optional
  network `gh api user` fallback and fails closed when local actor evidence is
  insufficient. Commit history is provenance, not current-user identity, and
  is not accepted as actor evidence on this path. Policies without a declared private-domain owner do not invent
  an actor requirement. Ordinary Git hooks still run; the resulting commit tree,
  single parent, and message must equal the reviewed authority or the local
  commit is rolled back and publication is refused.
- Push is present only when the reviewed plan requested it, the branch had no
  prior unpublished commits, and HEAD still names the exact verified commit.
  Atelier re-resolves the single push URL immediately before publication and
  pushes the exact commit object directly to that reviewed destination. Push is
  never forced, never follows tags, and never recursively publishes submodule
  refs. When fetch and push resolve to the same credential-free identity,
  Atelier refreshes the exact remote-tracking branch and re-observes before it
  reports `committed-and-published`. A distinct configured push URL is honored,
  but remains an explicit attention state because it cannot prove the fetch
  upstream synchronized. A failed push or post-push tracking refresh preserves
  the local commit, creates one stable attention state, and returns a non-zero
  command exit.
- Semantic conflict resolution, merge commits, rebase, reset, force push,
  browser apply, broad path scans, telemetry, and hidden upload are absent.

## Repository completeness

`atelier sync status` emits a supervisor envelope whose `state.observation`
contains the current `atelier-repository-observation@v1` document. That
observation cannot report `complete: true` when any of these are unresolved:

- lexically identifiable provider-managed, UNC/network, WSL-cross-boundary, or
  unclassified external filesystem roots (mapped-drive classification remains
  an operating-system integration concern for the signed beta);
- an unsupported Git engine or bare repository;
- sparse checkout, partial clone, or shallow repository state;
- tracked paths carrying `assume-unchanged` or `skip-worktree` index flags;
- missing or unhealthy submodules;
- required Git LFS content without a working LFS integration, including LFS
  semantics declared by tracked or untracked worktree attributes, repository
  info attributes, and default global or system attributes;
- an unclassified custom clean, smudge, or process filter;
- a configured `core.hooksPath` whose executable behavior is outside the
  reviewed repository contract;
- a remote URL whose authentication shape cannot be classified;
- multiple push destinations or any configured Git URL rewrite rule;
- any required Git evidence read that fails, times out, exceeds its budget, or
  cannot be parsed.
- a change set above the 4,096-entry resident observation ceiling; or
- a `core.attributesFile` outside the repository-owned/tracked attributes
  boundary whose filter semantics have not been classified.

HTTPS through Git Credential Manager, SSH through the user's existing SSH
configuration, and local test remotes are classified explicitly. Atelier does
not collect or store provider credentials.

## Local operation state

Ignored `.atelier-local/runtime/` contains:

- `enrollment.json` — exact repository and Git engine;
- `state.json` — a bounded projection of healthy, attention, or paused state;
- `control.json` — user pause/freeze state;
- `plans/` — expiring, consumed reviewed commit plans under count/byte ceilings;
- `operations.ndjson` — sequence- and hash-chained resident trace with explicit
  hash-bound checkpoints before its byte or record ceiling, with a fresh
  digest-linked generation after a torn or corrupt chain; and
- an atomic per-repository operation lock.

Every directory component is containment-checked and every state leaf is
opened without following redirects where the platform supports it, with leaf
type and identity checks on every platform. Stale-lock recovery uses an
exclusive recovery claim, ages out an abandoned recovery claim after the owner
grace interval, identity-checks the lock directory before and after quarantine,
and quarantines only the claimed stale directory; it never recursively deletes
a newly acquired lock. A live PID without durable process identity cannot wedge
the repository forever: its owner record becomes recoverable after the 24-hour
maximum operation age. Enrollment takes the same lock as every other
authoritative state mutation.

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

`status`, `audit`, `reconcile`, `run --once`, and `commit` return a non-zero
process exit when their result is not healthy, so automation cannot treat a
paused state, attention state, or failed publication as success merely because
JSON was emitted.

The future native shell may label the final two commands **Commit & sync**.
It must not bypass either phase.

The repeated operation id is a visible user-intent confirmation gate, not an
authorization secret. Local software able to read and modify the repository is
inside the same operating-system trust domain; the control prevents implicit
or stale execution, not a hostile process with the user's filesystem access.

## Evidence boundary

Deliverable Zero proves the headless supervisor contract on Linux and macOS,
with Windows CI covering the portable observation, state, and direct-process
contract. POSIX executable-wrapper substitution is explicitly skipped on
Windows; native Windows wrapper-injection proof, signed installation,
background launch at user login, Windows Home/Pro device behavior, macOS
notarization, and a nontechnical-user workflow belong to the signed
collaborator beta. Repositories without an initial commit are not supported by
this deliverable. A Git executable upgrade changes enrolled identity and
requires re-enrollment.
