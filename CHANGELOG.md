# Changelog

## 0.2.0-alpha.0

- **Breaking:** the `atelier-export@v1` runtime owner vocabulary is now
  vendor-neutral. The closed `runtimeOwnerName` enum, the `RUNTIME_OWNERS`
  constant, the bundled readiness protocols, and the fixtures all move to the
  domain terms `identity`, `catalog`, `commitments`, `events`, `projection`,
  `consent`, `messaging`, `providers`, `audit` (see `docs/ontology.md`).
  Documents and validators from earlier tags do not interoperate across this
  change; regenerate exports rather than hand-editing owner values.
- **Breaking:** `protocol.outputs` on bundled readiness protocols is now the
  contract's object shape (`{ runSchema, artifacts }`) instead of an informal
  array of artifact slugs, and the undeclared `outputArtifacts` key is gone.
  All twelve bundled protocols now validate against
  `atelier-readiness-protocol@v1`.
- **Breaking:** every document contract enters the contract-stability epoch:
  each schema declares an optional root `contractVersion` and a reserved
  optional `ext` extension container on every closed object, and bundled
  readiness protocols emit `contractVersion: "1.0.0"`. Validators pinned to
  earlier tags reject documents that carry the new fields. See
  `docs/contract-stability.md`.
- **Breaking:** the `atelier-claim@v1` provider enum gains
  `atelier-readiness`, so claims emitted by readiness runs validate against
  the standalone claim contract. Claim validators pinned to earlier tags
  reject the new provider.
- **Breaking:** the analysis adapter manifest schema const is now
  `analysis-adapter-manifest@v1` (was
  `mnstry.atelier-analysis-adapter-manifest@v1`), matching the published
  contract and fixtures. Local manifests emitted before this change must
  update their `schema` field.
- **Breaking:** boundary promote events are now recorded with schema
  `git-promote-event@v1` (was `mnstry.git-promote-event@v1`), matching the
  published contract. Previously recorded ledger lines carrying the old
  const are not rewritten.
- **Breaking:** the agent-harness context envelope schema const is now
  `atelier-context@v1` (was `mnstry.atelier-context@v1`), matching the local
  sidecar contract.
- **Breaking:** the alignment projection ships no default root-graph name
  list; the default is empty and workspaces supply their own via
  `sduiMap.rootGraphs` in project configuration. Nodes previously classified
  by the built-in name list no longer match without configuration.
- Adds `atelier-attestation@v1`, a contract for recording admission
  decisions: issuer, attested payload with an RFC 8785 (JCS) + SHA-256
  payload hash, an admission-scoped verdict (a conformance-scoped verdict is
  structurally unexpressible), and a required-but-nullable signature where
  null means advisory and non-authoritative. See `docs/attestation.md`.
- Adds the contract compatibility gate: `scripts/check-contract-compat.mjs`
  (`npm run contract:compat`) validates the current fixture and
  generated-document corpus against validators from the baseline tag recorded
  in `contracts/compat-baseline.json`. The gate is inert until the first
  post-epoch tag is recorded as the baseline.
- Adds `docs/ontology.md` — the public export vocabulary: the nine runtime
  owners, the object classes and collections they govern, the six runtime
  targets, and the audience/visibility boundary — and
  `docs/contract-stability.md` — the stability epoch, `contractVersion`,
  `ext` and must-ignore rules, the widening ban, the deprecation policy, and
  the compatibility gate.
- Expunges client-zero-identifying names from tests, fixtures, docs, and the
  release audit. Name-based scrub patterns now load from the gitignored
  `release-denylist.local.json`; when that file is absent the audit warns and
  applies structural checks only, and the readiness-pack neutrality test skips
  the name assertions.

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
- Adds the reserved repo kind `external` for git folders a workspace
  acknowledges but does not manage. External repos imply no read boundary, are
  excluded from graph walking, sidecar requirements, projection, the staged
  guard, and hook installation, and must not appear in repo-access or boundary
  policy. Undeclared git folders remain an error, and the message now names
  `external` as the resolution.
- `atelier graph` prints the remote host of each external repo so a workspace
  surfaces where its unmanaged folders push.
- **Breaking:** `fileClasses` is now required in the kit manifest. Every file
  the kit ships or generates is classified `source`, `generated-projection`, or
  `distributed-runtime-copy`, and a runtime copy must declare the repo role in
  which it is canonical. Adds `classifyPath(path, { repoRole })` so sync loops,
  merge policies, upgrade tooling, and CI guards read one declaration instead of
  each keeping a list that drifts.
- The graph walker's generated-file skip list and the boundary policy's glob
  matcher are now derived from shared modules rather than restated inline, with
  a drift test asserting the kit keeps no second copy of either.
- Repo entries accept `identity` (provider + stable id) and `aliases` (former
  names), so a repository survives a rename. Adds
  `resolveRepoIdentity(cloneDir)`, which resolves from the provider's stable id,
  then a recorded identity, then declared aliases — and never from a root commit
  or a folder name.
- `atelier doctor` now audits repo identity: upstream renames, stale config
  names, deprecated aliases, clones that are secretly the same repository, and
  repos with no recorded id or no origin remote.
- Adds boundary-policy `contentRules` and `contentRuleExceptions`. Rules judge
  added lines and added file paths rather than the whole tree, so a pre-existing
  accepted usage no longer blocks every push of everything in a repo. Exceptions
  are reviewable policy config — per repo, per path, per rule, each requiring a
  reason — instead of hardcoded pathspecs inside a fleet-wide guard script.
  Blanket wildcards are rejected.
- Adds `atelier boundary push-check`, which reads pre-push ref updates from
  stdin and judges only the pushed range (new branches diff against the empty
  tree), and `atelier boundary audit`, the whole-tree view that reports without
  blocking. The installed `pre-push` hook now uses `push-check`.
- The push guard fails closed when it cannot identify the repo it is running in,
  and matches its repo through symlinked paths and subdirectories.

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
