# Assessment API and existing commands

The additive `@mnstry/atelier/knowledge-health` export joins existing checker,
graph, parser and bounded context implementations. It adds no graph rule,
canonical model, editor/store, provider dispatch or root CLI.

```js
import { resolveProjectConfig } from '@mnstry/atelier/project'
import { assessKnowledgeHealth } from '@mnstry/atelier/knowledge-health'
const project = resolveProjectConfig({
  cwd: workspace, argv: ['--project', projectConfig], writeLocalState: false,
})
const result = assessKnowledgeHealth({
  project, planPath: 'knowledge-plan.json',
  relationId: 'checklist-pilot', questionId: 'readiness',
  sourceRevisions, binding, currentSourceBytes,
})
```

Those workspace/binding variables are caller inputs. The installed public
`initializeKnowledgeHealthExample` / `assessKnowledgeHealthExample` helpers
provide a complete invented invocation. The [example implementation](../../../src/knowledge-health/example.mjs)
shows its data binding; callers import the supported public entry above.

`sourceRevisions` is an explicit `[{repo,path,revision}]` entry for every censused
source. A binding contains:

```json
{
  "source":{"id":"demo:checklist","repo":"records","path":"checklist.md","sha256":"CURRENT_SHA256","revision":"OWNER_REVISION"},
  "field":{"id":"kg.relations.supports","pointer":"/kg/relations/supports","format":"markdown-inline-array","start":0,"end":2,"quote":"[]"},
  "authoring":{"storeId":"EXISTING_STORE","sourceId":"demo:checklist","artifactId":"EXISTING_ARTIFACT","fieldId":"kg.relations.supports","actorBindingId":"EXISTING_ACTOR_BINDING"}
}
```

The offsets above are placeholders. Supply exact half-open UTF-8 offsets in
current source bytes, the owner's revision and existing authoring identity. The
parser probe proves the range addresses that declaration rather than matching
prose or another field. Only typed inline Markdown relation arrays are supported.
Wrong quotes, source pins, missing IDs, prose or unsupported profiles refuse.
Resolve project config again after it changes. Config/access/plan changes during
a read refuse. Effective resolved repository bindings join the scope digest.
The plan ceiling is 65,536 bytes; project/access ceilings are 1 MiB each.

| Result field | Meaning |
| --- | --- |
| `assessment` | Original native report/diagnostics/context, exact source/rule/read-set/declaration evidence, selected findings, coverage/currency and refusals. |
| `retrievalEvaluation` | Native graph-versus-lexical evaluation against frozen explicit expectations. Expected IDs never enter retrieval. |
| `context` | Existing-output projection with observations/denominators, provenance and explicit semantic/repository unknowns. It is not an accepted canonical. |

Complete current evidence produces native `needs-attention` or
`structurally-valid`. Omissions produce `partial` with no actionable edit target;
binding/evidence refusals produce `uncertain`; native invalid plan/graph produces
`invalid`. Both native invalid-report shapes remain original. None establishes
source rights, meaning, source application, human acceptance or repository use.

`createAssessmentProjector` is also available for qualified injected callers. It
requires original checker commit/tree/blob/source/schema/graph identities, raw
plan bytes, exact read-set/scope, native graph/context and the same owner binding.
Optional native evaluation makes stale expected pins a refusal for an
evaluation-dependent task. The workspace join reports structural reassessment
and frozen evaluation separately, preserving both facts after a correction.

`knowledgeHealthContext({assessment,graph,planBytes,agentSuggestions,
repositoryEvidence})` verifies exact native graph and raw plan digests. Suggestions
require bounded nonempty text, selected-source citations and provenance
`{actorId,method,version,recordId,planSha256,readSetSha256}`. They remain supplied,
unreviewed and semantically unknown; no provider runs. Repository evidence remains
caller-supplied/unverified and never infers declared/adopted/consumed/executed.

Graph digests include native location-dependent options. Relocation changes that
digest; source/read-set/field pins remain independently visible. Repeating the
same bounded workspace inputs is deterministic. Changed source/scope/rules
invalidate comparison identity; a package version alone cannot pin rules.

Existing corresponding-source commands are:

```sh
atelier knowledge check --project ./kh-example/atelier.project.json --plan knowledge-plan.json
atelier knowledge context --project ./kh-example/atelier.project.json --plan knowledge-plan.json --question "What supports pilot readiness?" --mode graph
atelier knowledge evaluate --project ./kh-example/atelier.project.json --plan knowledge-plan.json
atelier graph --project ./kh-example/atelier.project.json
atelier graph --check --project ./kh-example/atelier.project.json
```

`graph` writes a generated artifact; `--check` tests its exact freshness. The
legacy artifact keeps declared edges; the canonical API exposes ordinary links
and their origin too. Neither ordinary links nor reverse edges satisfy this rule.
`knowledge check` exits nonzero for invalid inputs/graph; `ok:true` may coexist
with warnings. Set CI warning policy explicitly. `knowledge evaluate` exits
nonzero for missing/stale graph-mode expected evidence. Omitted evidence can
yield `abstain-unverified`, not a verified answer.

There is no `atelier knowledge-health` command here. Use the public API and
[capability map](capabilities.md), which distinguishes inspected source commands
from executed supplier tests and published baseline availability.
