---
name: atelier-public-boundary
description: Generalize a lesson from a private or tenant implementation into the public Atelier repository without carrying proprietary material across the trust boundary.
---

# Atelier public boundary

Use this skill whenever a public Atelier change is informed by work in a
private, client, tenant, or internal repository.

## Extract the invariant, not the source

1. State the reusable failure mode or contract without client vocabulary.
2. Identify every source-specific name, path, port, field, content structure,
   example, and operational fact. Keep those in the source repository.
3. Re-derive the public mechanism against an invented fixture. Neutral wording
   is not enough if the fixture still reproduces a proprietary structure.
4. Keep private disclosure patterns in the ignored denylist or CI secret. Do
   not place them in code, tests, docs, branch names, or commit messages.
5. Add a regression test for the general control and run an evidence-backed
   defensive review when a guard changes.

## Required gates

Before staging, run the repository's disclosure check. After staging, scan the
staged index with the private denylist, then inspect the exact diff and release
tarball. A structural-only pass is useful on an untrusted fork but is not a
complete maintainer verdict.

If the private denylist is unavailable, stop short of claiming the public
boundary is green. Do not replace it with remembered client names.
