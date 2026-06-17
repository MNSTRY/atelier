# MNSTRY Readiness

Use this skill when preparing or reviewing MNSTRY Atelier readiness outputs for
a tenant or project workspace.

## Protocol

- Use the repository's Atelier readiness protocols: `docs/tenant-readiness.md`,
  `docs/atelier-runtime.md`, `contracts/atelier-readiness.v1.schema.json`, and
  `contracts/atelier-claim.v1.schema.json`.
- Treat local source, Git state, project config, repo access, boundary policy,
  and lockfiles as review authority.
- Treat generated graph, projection, and readiness output as evidence from the
  current package checks, not source authority.
- Treat model/provider output as proposed `atelier-claim@v1` records only.
- Keep runtime identity, consent, visibility, provisioning, bookings, commerce,
  sessions, audit, and client-grade sharing under MNSTRY runtime authority.

## Output Shape

Produce claim-first outputs:

- Claim: the readiness statement being made.
- Evidence: file paths, schema names, commands run, and observed behavior.
- Authority: source, generated evidence, proposed claim, or runtime-owned.
- Status: ready, warning, blocked, or proposed.
- Fix path: the smallest next reviewable change.

Do not introduce independent tenant semantics, new visibility terms, hidden
provider boundaries, or runtime mutation claims. If a check cannot run, report
the exact command, stderr, and blocker.

## Safety And Hygiene

- Keep package-facing output generic and placeholder-only.
- Do not include person-specific, tenant-private, project-private, transcript,
  support-bundle, local absolute path, agent-local state, key, token, or
  credential material.
- Prefer static inspection and existing defensive tests for security-sensitive
  review work.
- Frame checks as verifying that a control refuses, blocks, or fails closed.
