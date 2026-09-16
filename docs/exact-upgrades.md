# Local exact-plan upgrades

The explicit `atelier upgrade plan/apply/status/recover` commands prepare a
local candidate from an already installed Atelier executor. They preserve an
adopter's source branch and configuration, show the exact changes, and retain
local evidence of what was selected and what Git actually committed.

Execution in this first slice requires Linux or macOS with working directory
fsync. Other hosts, including native Windows, refuse before transaction state
creation; existing Atelier commands remain available. The platform refusal is
tested separately from the POSIX execution scenarios.

This first slice supports **one configuration repository in a linked Git
worktree**, with its project config and workspace at the root. Its single
managed repo must point to `.`. It refreshes the lock, graph, HTML projection,
manifest and readiness output. Generated paths must be distinct paths within
`atelier-output/`. Distribution branding is retained. External packs, local
overlays, private readiness runs, submodules, sparse checkouts, attribute/filter
transformations and runtime/alignment participants are refused. These limits
are explicit eligibility checks, not assurances about unsupported setups.

There is no package installation, network discovery, hook replacement, runtime
activation, or automatic policy mode. Existing legacy `upgrade --apply` remains
a separate workflow; it does not acquire these transaction guarantees.

## Enroll and prepare

Create a dedicated candidate worktree using your usual Git workflow, then add
and commit `atelier.adoption-policy.json` there:

```json
{
  "schema": "mnstry.atelier-adoption-policy@v1",
  "enabled": true,
  "mode": "manual-exact-plan",
  "maxAgeSeconds": 86400,
  "recoveryCoverage": "local-only",
  "allowedEffects": ["lock-and-projections", "git-commit"]
}
```

Ignore `.atelier-local/` and keep every file beneath it untracked. Start with a
clean index and worktree. From the candidate worktree:

```sh
atelier upgrade plan --save --project ./atelier.project.json
```

The result names a private saved plan and its `sha256:` confirmation digest.
Inspect its `writes`: concrete paths, ownership, old/new byte digests and modes,
and the proposed bytes in base64. `readSet` inventories the entire enrolled
repository except Git administration and private local state. The plan also
binds the repository identity, HEAD, branch, policy, Git executable,
configuration, Git auxiliary ignore/attribute files, hook directory and files, executor and imported dependency bytes,
and a fixed expiry. Default lifetime is 24 hours; policy may shorten it.

Generation uses an isolated private preparation directory and the existing
builders. Only five registered output paths can be written, and a complete
before/after inventory checks that boundary. The executor then saves those
bytes; application does not recalculate or silently replace the selected plan.
This is a bounded trusted executor, not a sandbox for arbitrary migration code.

## Apply the reviewed bytes

Use the returned path and digest literally:

```sh
atelier upgrade apply --plan SAVED_PLAN_PATH --confirm sha256:REVIEWED_DIGEST --project ./atelier.project.json
```

The digest selects content; it is not an authenticated human signature. Host
permissions must establish any stronger authority. The command takes an
exclusive local writer lease, checks current bindings before mutation and at
safe boundaries, records original bytes and write intents, writes only expected
preimages, stages only the frozen paths, and runs the existing commit hooks.
No commit uses `--no-verify`. Hook execution is existing adopter code with its
normal host privileges, not a new sandbox or a promise of no hook side effects.
Relevant hook changes invalidate the plan; files or executables that hooks
consult outside their directory are not transitively fingerprinted.

A successful Git exit is insufficient: the commit's parent, tree and message,
staged blobs, branch and worktree must match. A refused commit retains its index
and worktree as `commit-refused`. Unexpected changes become `recovery-required`.
Neither case causes an automatic retry, reset, hook bypass or success claim.
Every accepted attempt consumes the plan, including an interrupted attempt.

## Status and recovery evidence

```sh
atelier upgrade status --operation OPERATION_ID --project ./atelier.project.json
atelier upgrade recover --operation OPERATION_ID --dry-run --project ./atelier.project.json
```

The operation ID is the hexadecimal part of the plan digest. Events live in
`.atelier-local/upgrades/operations/OPERATION_ID/events/`, with original bytes in
`backups/`. Events are exclusive, fsynced publications with sequence numbers,
previous-event digests and verified rereads. Missing, truncated or altered events
refuse success. This is local integrity evidence; a host owner who can replace
all records can rewrite a chain. It is not externally authenticated provenance.

Only a verified terminal receipt asserts completion. The v1 lock retains prior
migration history, template lineage and successful-upgrade metadata. Its success
fields deliberately lag the new receipt; the command never writes the hash of
an uncreated commit into that commit. No automatic metadata refresh is shipped.

An interruption after Git commits but before the terminal event remains
`recovery-required`, even when the commit exists. Recovery dry-run reports
current HEAD/index evidence, safely restorable bytes and conflicts. Subsequent
user edits and any moved HEAD prevent automatic restoration. This release offers
**no recovery mutation**: restoring files or reverting a commit requires a
separately reviewed operation with current authority. It never resets history.

A crash may leave the writer lease in place. Inspect its owner and verify that
process has stopped before separately handling the stale lease; elapsed time
alone never releases it. Status and recovery inspection remain available.

Evidence has no automatic deletion. Inventory limits (4,096 files, 64 MiB) and a
32 MiB retained-state admission threshold and 8 MiB saved-plan limit bound this small-workspace slice.
Exhaustion refuses another operation; export and verify evidence before any
separate retention maintenance. Ignored state is not backed up or inherited by
another clone. Enrollment explicitly acknowledges local-only recovery.

## Provenance and acceptance boundaries

The plan pins installed executor and dependency bytes. It does not authenticate
an upstream publisher or verify a newly downloaded release. Release discovery,
authenticated artifact intake, dependency installation, multi-repository
transactions and standing automatic consent remain separate future work.

A completed transaction means a prepared local candidate commit. It does not
mean a merged upstream change, CI acceptance, adoption in another workspace,
published package or activated service. Use the adopter's normal review and
landing process to accept the candidate.
