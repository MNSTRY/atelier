# Capability map and qualification limits

`KNOWLEDGE_HEALTH_CAPABILITIES` from the public assessment entry contains exact
source commit/tree/blob/file references, baseline availability, verification
scope and smallest receiving corrections. It is an inventory projection, not
release certification or semantic/human acceptance.

| Need | Actual existing surface | Evidence and limit |
| --- | --- | --- |
| Graph structure | `./graph`: `buildCanonicalGraph`, `createGraphFileCache`; `graph` / `graph --check` | Native API used in this receiving rehearsal; public alpha.12 includes canonical graph. Legacy generated artifact has declared edges only. |
| Typed relation | Internal `inspectKnowledgePlan`; current `knowledge check` | Actual existing checker used; alpha.12 lacks knowledge-plan modules. Additive API joins it without rewriting rules. |
| Agent-readable evidence | Internal `createKnowledgeContext`; current `knowledge context --mode graph|lexical` | Native function used. Source bytes/digests, census, omissions and resource limits retained; no provider execution or recipient-sharing authority. |
| Task evidence/abstention | Internal `evaluateKnowledgeQuestions`; current `knowledge evaluate` | Native function used. Expected pins stay outside retrieval. It does not judge answer meaning or unseen/human value. |
| Ingestion evaluation | Current `./ingestion/evaluation`: `evaluateIngestionTrial`, `ingestionEvaluationDigest` | Actual evaluator used on invented calibration. Exact multiset scoring and null costs; no held-out/semantic pass. Alpha.12 lacks this module. |
| Local extraction/proposals | Current `./ingestion`: `createIngestionStore`; `ingest plan/run/status/query`; current `./knowledge` contribution/context helpers | Static inspection. Bounded local text/CSV/JSON and lexical evidence; no semantic acceptance or raw graph enrollment. |
| Semantic lifecycle | Internal `createSemanticOperation`, dependency witnesses and reconsideration | Static only, not a public knowledge export here. Owner-bound recorded callbacks remain proposal-only; acceptance pending. |
| Repository freshness | `./runtime/observation`: `observeRepository`, `validateRepositoryObservation`; owning `sync status` / `sync trace` | Public baseline file/export verified, current source inspected. Git/runtime observation cannot prove adoption/consumption/execution, causal lineage or remote freshness. |
| Repository handoff | Current `./harnesses`: `inspectHarness`, `createHarnessHandoff`, `verifyHarnessHandoff`, `reconcileKnowledge`; `harness inspect/verify` | Static only. Complete ledgers and explicit dependency snapshots; actual adopter/execution evidence separate. |
| Readiness/freshness | `./readiness`: `buildReadiness`; `readiness --check`, `generated check` | Public baseline verified, source inspected. Existing artifact/schema/freshness checks do not establish source meaning or human value. |
| Authoring/hosts | `./coauthor`: `createSession`, `transition`, `replaySession`; existing store/presentation/runtime/Obsidian; current knowledge dashboard/session and sidecar | Static only in this supplier. Mounted editor/store owns apply/save; native and participant proof separate. |
| Normal initialization | Current `atelier init --template knowledge-workspace --target ./workspace` and its shipped template | Source dispatch inspected; public alpha.12 lacks this dispatch/template. Test both from the exact official new archive and published version. The explicit fixture helper is not that test. |

Semantic support, contradiction/identity judgments and human usefulness require
source-supported trials. Declared, adopted, consumed and executed use remain
distinct; this context defaults all four stages to unobserved. Installed-host
keyboard, input-method, zoom, accessible alternatives, recovery and scale require
host-specific measurements. The supplier proof here is limited to Node22/macOS.

Preserve source evidence, structure, interpretations, proposals, owner decisions
and execution as distinct records. Reuse existing canonicals and one editor/store
write boundary. No replacement graph, health score or canonical registry is added.
