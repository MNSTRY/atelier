# Tenant Readiness Guide

Use this guide when preparing a tenant or project workspace for an Atelier
readiness review. The review is local-only and evidence-first: it does not
provision repositories, contact external services, mutate a MNSTRY runtime, or
write through a browser view.

## Authority Order

1. Treat local source files, Git history, `atelier.project.json`,
   `repo-access.v1.json`, `boundary-policy.v1.json`, and `atelier.lock.json` as
   review authority.
2. Treat generated graph, projection, support, and readiness files as evidence
   from the current package checks.
3. Treat optional model/provider analysis as proposed `atelier-claim@v1`
   records only. Proposed claims cannot define tenant semantics, mutate
   canonical source, or bypass project-owner review.
4. Treat runtime identity, consent, visibility, provisioning, bookings,
   commerce, sessions, audit, and client-grade sharing as MNSTRY runtime
   authority.

## Local Review Pass

Run checks from the copied workspace:

```bash
atelier graph --project ./atelier.project.json
atelier project --project ./atelier.project.json
atelier readiness --project ./atelier.project.json
atelier boundary check --project ./atelier.project.json
atelier lock check --project ./atelier.project.json
atelier upgrade --dry-run --project ./atelier.project.json
```

Use `--check` modes where available when validating committed generated output.
If a command is unavailable in an older workspace, report the exact command and
stderr instead of substituting a new protocol.

## Claim-First Output

Readiness summaries should lead with claims, then evidence:

- Claim: the specific readiness statement.
- Evidence: file paths, schema names, command output, or observed generated
  artifact state.
- Authority: source, generated evidence, proposed claim, or runtime-owned.
- Status: ready, warning, blocked, or proposed.
- Fix path: the smallest next reviewable change.

Do not invent independent tenant semantics. Use the Atelier contracts,
readiness report, boundary policy, and local source as the vocabulary.

## Review Hygiene

- Keep package docs, fixtures, skills, and release notes generic.
- Do not include person-specific, tenant-private, project-private, support
  bundle, transcript, absolute local path, agent-local state, key, token, or
  credential material.
- Prefer static inspection and existing defensive tests for security-sensitive
  review work.
- Frame boundary checks as verifying that a control refuses, blocks, or fails
  closed.
- Findings still need concrete evidence, severity, confidence, impact, and a
  fix path.
