# Upgrade with your agent

Ask your agent to prepare an upgrade using the bundled
`atelier-guided-upgrade` skill. It is available in both packaged skill surfaces.
For an older installation, the operator first selects and verifies the new
package. Reading its skill is not permission to install or execute it in your
working Atelier.

> Prepare an Atelier upgrade in an isolated candidate. Preserve my authored
> work, local customizations and existing approvals. Identify an exact trusted
> release, explain its effect here and run the appropriate checks. Show me what
> is ready and ask before applying changes to my working installation, merging
> or restarting services. Report unsupported configurations explicitly.

## What the owner reviews

The agent prepares a short explanation with inspectable evidence:

| Item | Required information |
| --- | --- |
| Source | Old and selected package identities, source commit when verified, artifact integrity, dependency lock and trust source. |
| Local impact | Benefit, actual changed paths, preserved customizations, migrations and unsupported participants. |
| Validation | Exact candidate tested, commands, results, skipped coverage and remaining acceptance checks. |
| Consent | The specific installation, commit, merge or activation effects requested; prior applicable authority and any new decision. |
| Recovery | What remains untouched, retained backups and conflicts; whether restoration is manual. |
| Outcome | Prepared, installed in candidate, committed, merged, running and owner-accepted are distinct states. |

Do not attach private authored content to an upstream issue or public release.
Even generated readiness output can contain account paths. Retain full evidence
privately and publish only an explicitly approved summary.

## Exact-plan explanation

After selecting/installing the executor in an eligible candidate, follow
[exact upgrades](exact-upgrades.md) for enrollment and preparation. Use the
verified installed binary (these examples assume a root-local npm install):

```sh
./node_modules/.bin/atelier upgrade plan --save --project ./atelier.project.json
./node_modules/.bin/atelier upgrade explain --plan SAVED_PLAN_PATH --project ./atelier.project.json
./node_modules/.bin/atelier upgrade explain --plan SAVED_PLAN_PATH --format markdown --project ./atelier.project.json
```

Both explanations derive from the same verified saved plan. They expose paths,
before/after hashes, executor evidence, expiry and consent limits, without
printing the proposed base64 contents. Inspect the saved bytes separately.
The command is read-only: it neither records consent nor regenerates output.
JSON `bindingsCurrent: false` and `blockers` identify observed staleness even
when explanation succeeds. `bindingsCurrent: true` is not a reservation or a
complete application admission; apply performs its full checks again.

The owner's decision must bind the displayed plan and effects. An agent records
the exact words and conversation reference privately with the report digest,
candidate, target and decision. Use `humanApprovalAuthenticated: false` and
`recordedBy: agent`; the record is an attestation of the conversation, not a
cryptographic human signature. Hashes identify content and detect changes. A
trusted host/harness must enforce any stronger approval boundary. Merely
writing an approval-looking JSON file grants no authority.

## Existing workspaces outside the first slice

A managed subdirectory, multiple repositories, external packs, overlays or an
unsupported host require a separate operator procedure. Keep those boundaries;
changing a graph root to `.` can expose previously excluded material. Never
remove a guard to make the exact planner accept a workspace.

Use the consuming repository's documented procedure, retaining the old source
and lock history, an exact dependency pin and a before/after manifest. Label the
result as an operator-prepared candidate. The exact transaction receipt and its
guarantees do not apply. If no procedure exists, prepare a migration proposal and
stop before application. The legacy flag-based apply command is not an automatic
substitute for the saved-plan workflow.

An isolated snapshot may preserve active local edits for a rehearsal, provided
its manifest is stable and the original remains untouched. It does not settle
ownership of those edits or include ignored answer history. Reconcile with the
active writer before eventual adoption. Test reopening/resuming owned state at
the actual recipient before claiming owner acceptance.

## Release and pilot checklist

Maintainers retain a release candidate with `ATELIER_RELEASE_OUTPUT_DIR` and
`npm run prepublishOnly`: one archive is audited and exercised by installed
consumer and distribution smokes. This proves the candidate artifact, not that
it was published or that an adopter trusts its publisher. Include the candidate
commit/tree, artifact digest, release notes, supported runtimes, migration limits
and original review qualifications in the release handoff.

The publishing workflow rebuilds and verifies its own retained artifact after
the release commit lands. Its published integrity is the consumer's installation
reference; do not substitute a different local tarball's digest. Publication
uses a separately authorized version tag. An alpha version in source is not
evidence that npm already contains it.

Pilot one explicitly selected workspace: inspect, prepare separately, explain,
record a real decision, apply the authorized effects, verify and confirm the
owner can continue their work. Candidate tests alone do not complete that last
step. Background discovery, unattended installation and automatic recovery are
not provided by this workflow.
