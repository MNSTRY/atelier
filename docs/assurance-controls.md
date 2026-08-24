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
| The package has no undisclosed runtime egress path | Canonical forbidden-egress scanner plus exact packed-file inventory in `release:audit` | egress tests, marker-inventory test, and egress case in `assurance:mutation-smoke` | Data-only files are not interpreted; reviewed `gh` subprocess fallbacks are documented exceptions |
| Local review serves only generated publication output | Loopback-only bind, required `atelier.manifest.json`, realpath containment, enrolled safe types, host/fetch-site/origin/method/nonce checks | `server:security:test`; sidecar case in `assurance:mutation-smoke` | The sidecar is a local review tool, not user authentication or runtime authorization |
| Collaboration cannot become a hidden apply path | Proposal authority is capability-derived; records are typed; ledger reads are bounded and corrupt tails fail closed | `collaboration:test` and ledger performance tests | Collaboration remains copy-only proposal metadata; Git review owns source changes |
| Expected operator failures are actionable without leaking internals | Typed project/JSON diagnostics and the CLI execution wrapper | `test/cli-brand.test.mjs` | Unexpected stacks require the operator to opt in with `ATELIER_DEBUG=1` |
| The published artifact is the artifact tested | Exact `npm pack` allowlist/content scan, bare-consumer install without publisher overrides, all-export import, branded distribution smoke | `release:audit`, `consumer:smoke`, `distribution:smoke`, `assurance:mutation-smoke` | Passing gates does not publish, deploy, or constitute an external reviewer’s approval |

The release-blocking command is `npm run prepublishOnly`. It includes positive
regression suites and deliberately broken local fixtures. The latter prove
that boundary, graph, egress, sidecar, and distribution controls still refuse
their named failure modes; they do not exercise a live abuse path.

## Exact-candidate evidence

At candidate cut, retain all of the following together:

1. the Git commit SHA and a clean working-tree check;
2. the `npm pack --json` inventory and tarball SHA-256;
3. outputs from syntax, contracts, migrations, repository disclosure,
   release audit, full tests, mutation smoke, bare consumer, and distribution
   smoke;
4. a defensive review tied to that same commit and digest; and
5. explicit human decisions for versioning, publication, deployment, or any
   external communication.

Evidence for a different commit or a dirty tree is not evidence for the
candidate.
