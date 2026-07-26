# Changelog

## Unreleased

- Staged boundary guard now separates boundary-field *initialization* from
  *change*. A field added with no prior value, set to a non-disclosing default,
  commits without a review marker; widening, narrowing, and removal still
  require one. This removes the deadlock where the kit's own front-matter
  tooling produced changes the kit's own gate refused.
- `semantic-field-change-needs-review` findings now name the file and the exact
  field transition instead of failing a whole repo with one opaque message.
- Review markers are now scoped to the file they appear in. A marker in a
  sibling file no longer approves an unrelated boundary change.
- Graph and sidecar walks now skip git-ignored paths via one batched
  `git ls-files --others --ignored --exclude-standard --directory` per repo
  root, so committed graph artifacts describe the repository rather than one
  machine's working tree. Multi-machine workspaces no longer churn.
- Adds `test/graph-determinism.test.mjs`, a mutation-tested regression guard
  that builds twice with git-ignored junk planted in between and fails on any
  byte change to a committed artifact.

## 0.1.0-alpha.2

- Adds bundled `mnstry-readiness-pack@v1` with twelve claim-first readiness
  protocols for MNSTRY tenant preparation.
- Adds readiness protocol and readiness run contracts with AJV fixtures.
- Adds `atelier readiness protocols`, `journey`, `run`, `packet`, and
  `export --dry-run` commands.
- Adds tenant-readiness journey data to generated local projections.
- Adds neutral Codex and Claude readiness skill wrappers.
- Keeps readiness output local, proposal-first, non-importing, non-mutating,
  no-send, and free of project-specific package content.

## 0.1.0-alpha.0

- Introduces the alpha `@mnstry/atelier` package.
- Adds the `mnstry atelier ...` and `mnstry-atelier ...` local CLI entrypoints.
- Adds `atelier-export@v1` schema validation.
- Adds dry-run validation for export artifacts.
- Adds fictional sample fixtures and fail-closed negative fixtures.
- Keeps runtime import, runtime mutation, telemetry, and external egress out of
  scope.
