<!--
Thank you for the work. This template is short on purpose — the checks below
are the ones that are expensive to discover late.

If this changes a contract, a runtime dependency, a guard, or network
behavior, it needs an issue first. See CONTRIBUTING.md -> "What needs a
conversation first".
-->

## What this changes

<!-- One or two sentences. What was true before, what is true after. -->

## Why

<!-- The problem, not the patch. Link the issue if there is one. -->

## The failing case, now a test

<!--
This project's standing rule: every demonstrated defect becomes a permanent
regression test. Name the test that fails without this change and passes with
it. If this is docs-only or a pure refactor, say so.
-->

## Before submitting

- [ ] Every commit carries a DCO sign-off (`git commit -s`). Unsigned commits are not merged.
- [ ] No client material, private methodology, key material, or absolute home paths — in code, fixtures, comments, or commit messages.
- [ ] Any new fixture is fictional: invented brands, invented content, real mechanics.
- [ ] Gates run locally and pass:

```bash
npm run syntax:check
ATELIER_ALLOW_MISSING_DENYLIST=1 npm test
npm run contract && npm run contract:compat
npm run egress:check && npm run migrations:check
```

## Scope

- [ ] This does **not** change a published contract, add a runtime dependency, touch a guard, or introduce network behavior.
- [ ] Or: it does, and issue #___ agreed the approach first.

<!--
Fork pull requests: `secret-sweep` will fail on your PR. That is by design —
fork PRs never receive repository secrets, and the job fails rather than skips
because a skipped job would satisfy a required check. A maintainer verifies
your head SHA and dispatches the fork-sweep workflow to clear it. Nothing is
wrong with your patch.
-->
