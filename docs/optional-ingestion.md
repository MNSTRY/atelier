# Optional ingestion suppliers

Atelier's semantic runner remains the source of truth for ingestion attempts,
captured output and proposed knowledge. The optional supplier APIs compose an
ordinary host-selected extractor with Jev judgments, Graphify operations and
LightRAG extraction or retrieval. No tool, account or Python SDK is required to
import the JavaScript APIs. Importing them performs no extraction or network call.

```js
import {
  createComposition,
  createVanillaCompositionBinding,
  createCompositionJudgmentBinding,
  createGraphifyCompositionBinding,
  createLightRAGCompositionBinding,
  PRESENCE_PROFILES,
} from '@mnstry/atelier/ingestion/optional'
```

Each binding accepts the consuming host's existing ports. The vanilla binding
receives the semantic runner, the same-workspace intake capture callback and the
host's selected extractor. Jev receives the existing decision contracts and
prepared-request transport. Graphify and LightRAG receive an explicitly supplied
native dispatcher. A dispatcher must preserve the original operation receipt,
source bindings, artifacts, generation and retry-inclusive usage; an artifact
digest alone is not an authenticated operation receipt.

`createComposition` receives `bindings`, `operationRoles`, `invoke`,
`readKnowledgeView` and `eligible`. These are the existing capability, knowledge
and evidence owners' ports. The returned `execute` method accepts an explicit
route, input and question. Every supported presence profile retains vanilla;
select one extractor and one answerer for a route. Jev adds judgments rather
than a second extraction pass. LightRAG's coupled native answer is a distinct
route from retrieval followed by the ordinary answerer. Mere tool presence
never invokes it or selects a fallback.

The eight profiles are exposed by `PRESENCE_PROFILES`: vanilla alone, each single
optional tool, each pair and all three tools. Missing selected operations refuse
before execution. Accepted, current, located evidence can serve an answer;
native labels and scores do not create canonical identities or accepted claims.
Qualifiers, direction, time, negation and unresolved mappings survive ingestion.
Partial failures retain their original outputs and unknown costs. Retrying,
accepting knowledge, enabling a provider and publishing a projection remain
decisions of their existing owners.

## Native Python adapters

The package includes the authored adapter source under
`src/ingestion/optional/graphify/` and
`src/ingestion/optional/lightrag/atelier_lightrag_supplier/`. It does not bundle
the third-party SDKs or download them. A consuming host supplies its compatible
Python runtime, separately installed SDK, pinned source, isolated storage and
existing operation lifecycle.

Graphify's `json_bridge.py` supports a host-owned persistent process so dependent
operations share one supplier and generation. Preserve its separate source,
cache and artifact roots. Its operations include extraction, query, topology,
diagnostics, incremental updates and exports. The adapter uses POSIX filesystem
locking; a host must qualify its actual platform before selecting this route.

LightRAG's `LightRAGSupplier` accepts a native factory and role instrumentation
before initialization, with one event loop per workspace and generation. It
supports native insertion, custom knowledge projections, retrieval, coupled
answers and storage lifecycle. Accepted canonical projections and editable
native exploration use distinct workspaces. Native embeddings and model calls
remain explicitly configured host capabilities.

Source replacement, withdrawal, tool removal and recovery must use the current
source/evidence owners and the host's existing lifecycle. Unknown native cleanup
or provider execution is retained as unknown and grants no implicit replay.

## Qualification

`@mnstry/atelier/ingestion/qualification` exports the trial executor, accounting
and independent-assessment receiving helpers. They preserve failed attempts,
retries, shared costs and unknown accounting. Useful-answer scoring requires a
separate verified assessor receipt; a task's own success claim does not count.

The repository tests cover portable composition, all eight presence profiles,
invented judgments, receipt boundaries and failure custody. These establish
source behavior. Actual installed native workflows, provider authorization,
independent semantic quality and measured time or cost improvements require
qualification by the consuming host.
