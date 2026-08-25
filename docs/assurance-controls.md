# Assurance controls and evidence map

This ledger maps public trust claims to the control that enforces them, the
test that challenges the control, and the limit that remains. It describes the
source tree; a release decision must additionally record the exact candidate
commit and packed-tarball digest.

| Claim | Enforcing control | Defensive evidence | Stated limit |
| --- | --- | --- | --- |
| Boundary rules cannot silently switch themselves off | `src/boundary/policy.mjs`, `src/boundary/content-rules.mjs`, and generated Git hooks | `boundary:test`; boundary case in `assurance:mutation-smoke` | Repository access remains the source read boundary; an audience label is not encryption |
| A clean boundary verdict uses complete evidence | Typed Git reads with diff and binary budgets; incomplete reads become blocking diagnostics | `test/boundary-content-rules.test.mjs` | Budgets intentionally refuse evidence too large to inspect rather than claiming it is clean |
| Graph classification has one meaning | `src/graph/knowledge-graph.mjs` is canonical; `src/graph/graph.mjs` adapts its result | `graph:test`; graph case in `assurance:mutation-smoke` | Unclassified Markdown is retained as private diagnostic material, not admitted as governed content |
| The package has no undisclosed runtime egress path | Canonical forbidden-egress scanner plus exact packed-file inventory in `release:audit`; Atelier Sync confines network Git to bounded fetch and an exact-plan, non-force push | egress tests, marker-inventory test, runtime fetch/push refusal tests, and egress case in `assurance:mutation-smoke` | Data-only files are not interpreted; reviewed `gh` actor resolution and explicitly enrolled Git fetch/push are documented subprocess exceptions |
| User-confirmed repository writes match what was reviewed | Content-bound, expiring plan identifiers; fresh complete observations; exact staged and written-tree blob/mode manifests; post-hook tree, single-parent, and message verification with compare-and-swap rollback; and publish-target revalidation | `sync:test` plan, expiry, hook/index, remote-drift, and evidence-failure cases | Ordinary Git hooks may run, but a hook cannot change the reviewed tree, parent, or message and still publish |
| Resident Sync state cannot escape or grow without bound | Contained private directories, no-follow/identity-checked leaves, nonce-bound locks with atomic stale recovery, consumed plans under age/file/byte ceilings, and hash-chained trace checkpointing with per-event and resident ceilings | `sync:test` redirected-state, redirected-lock, plan-lifecycle, concurrent-recovery, corruption, and trace-ceiling cases | Machine-local state is diagnostic convenience; Git and readable repository files remain authoritative |
| Local review serves only generated publication output | Loopback-only bind, required `atelier.manifest.json`, realpath containment, enrolled safe types, POSIX no-follow plus cross-platform leaf type/identity validation for local state, and host/fetch-site/origin/method/nonce checks | `server:security:test`; sidecar case in `assurance:mutation-smoke` | The sidecar is a local review tool, not user authentication or runtime authorization |
| Collaboration cannot become a hidden apply path | Proposal authority is capability-derived; records are typed; POSIX ledger and snapshot leaves are no-follow, while every platform rejects redirected leaves and validates opened file identity when available; ledger reads are bounded, one-pass for lists, and corrupt tails fail closed | `collaboration:test` and ledger ceiling/performance tests | Collaboration remains copy-only proposal metadata; snapshots are rebuildable projections and Git review owns source changes |
| Expected operator failures are actionable without leaking internals | Typed project/JSON diagnostics and the CLI execution wrapper | `test/cli-brand.test.mjs` | Unexpected stacks require the operator to opt in with `ATELIER_DEBUG=1` |
| Published APIs do not disappear silently | Tag-derived subpath and named-export baseline plus version/tag identity refusal | `public-api:compat`; `test/public-api-compat.test.mjs` | Additive API checks do not decide whether a new version number is appropriate |
| The published artifact is the artifact tested | `release:candidate` packs once, binds SHA-256, sends that exact archive through allowlist/content audit, bare-consumer install, all-export import, and branded distribution smoke, then the trusted-publishing workflow retains and publishes that same tarball path | `release:audit`, `consumer:smoke`, `distribution:smoke`, `assurance:mutation-smoke`, `publish-workflow.test.mjs` | Passing gates does not publish, deploy, or constitute an external reviewer’s approval |

The release-blocking command is `npm run prepublishOnly`. It includes positive
regression suites and deliberately broken local fixtures. The latter prove
that boundary, graph, egress, sidecar, and distribution controls still refuse
their named failure modes; they do not exercise a live abuse path.

## Exact-candidate evidence

At candidate cut, retain all of the following together:

1. the Git commit SHA and a clean working-tree check;
2. the `npm pack --json` inventory and tarball SHA-256;
3. outputs from syntax, contracts, public-API compatibility, migrations, repository disclosure,
   release audit, full tests, mutation smoke, bare consumer, and distribution
   smoke;
4. a defensive review tied to that same commit and digest; and
5. explicit human decisions for versioning, publication, deployment, or any
   external communication.

Evidence for a different commit or a dirty tree is not evidence for the
candidate.
