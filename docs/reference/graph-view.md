# Renderer-neutral graph view

`atelier.graph-view@v1` is an additive, bounded JSON projection for independent
renderers. The source graph, repository identities, knowledge plan, edge policy
and consuming host retain their respective authority. The existing `atelier graph`
artifact and knowledge outputs remain unchanged. This module does not extract
sources, verify grants, admit assertions or fetch source bodies.

The implementation lives in `src/graph-view/index.mjs`; package export and shared
CLI dispatch adoption require the owning program's separate integration. No
published release or hosted permission implementation is established by this source.
The schema is `contracts/atelier-graph-view.v1.schema.json`. The two fixtures under
`fixtures/graph-view/` are invented data, not access grants or provider receipts.

## Host binding

The host creates a reader with closures over its actual authenticated context:

```js
const reader = createGraphViewReader({
  loadAuthorizedGraph: options => access.loadAuthorizedGraph(trustedContext, options),
  revalidate: binding => access.revalidate(binding),
})
const view = await reader.readGraphView({ focusRef, direction: 'out', depth: 1, limit: 50 })
const bytes = await reader.exportGraphView({ snapshot: view.snapshot, limit: 50 })
```

The loader returns `{graph,binding}`. Only the already-authorized graph enters the
query. The binding stays private and is revalidated after preparation, immediately
before return, including when query preparation fails. Expired or revoked bindings
refuse delivery. Host failures produce fixed errors without raw exception details.
No cache exists here. A receiving host still owns current access checks, output
transport, separately authorized evidence reads, and clearing previous views after
access changes. Parsing an existing file does not authorize reading or sharing it.

Browser requests cannot supply `readerScope`, identity, grant data, a graph payload
or a host binding. Unknown request fields refuse. The trusted access adapter is
responsible for excluding denied repositories, nodes, edge homes, endpoints,
evidence, text, diagnostics and suggestions before the serializer is called.
Closed serialization removes body fields, raw relations, arbitrary extensions,
principal identity and private edge binding IDs. It cannot detect confidential
information embedded inside metadata that an upstream host incorrectly admits.

## Projection and provenance

Qualified references are `{repoId,localId}` from the source owner. Two repositories
with the same local identifier remain distinct. A source pointer is
`{repoId,path,revision,digest,locator?}`. `revision` is the exact repository snapshot
digest, including dirty bytes; `digest` is the file's raw-byte digest. Both are
`sha256:` followed by 64 lowercase hex digits. A locator retains the source owner's
`pointer`, half-open `range`, and/or `targetRange`; ranges preserve text offsets and
optional raw-byte offsets. No passage or full body is included.

`sourceSnapshot.repositories` preserves each delivered source snapshot's repo id,
HEAD, tree, dirty observation, scope and full snapshot digest. Its file list contains
only source pins needed by this slice; `omittedFiles` reports the other authorized
files. `inputs.config` and `inputs.plan` are exact verified source pointers or null;
no global config or plan pin is invented. The full snapshot digest still identifies
the complete input observation. An approved but unavailable repository has no
invented snapshot: `completeness` becomes `incomplete`, with one fixed authorized
unavailable diagnostic. Denied repositories have no placeholders or count effects.

Distinct edges retain `edgeId`, qualified directed endpoints, native predicate,
family, assurance, active admission state, every support and review reference,
qualifications, and record/policy digests. Families are `hyperlink`,
`source-declaration`, and `reviewed-assertion`. An edge's `sourceRef` is its origin
**evidence ID**, included in `supportRefs`; node/evidence `sourceRef` is the source
pointer object. Equivalent triples are not merged. Supporting evidence pointers
must all be present for an emitted edge. This projection does not infer review,
semantic acceptance or continuing currency. Optional `verification.checkedAt` means
verified at that time; absence means unavailable. A live currency claim requires
an actual current host binding.

Questions preserve decision, node/evidence refs, contradicting evidence refs,
coverage (`supported`, `partial`, `abstain`, `unknown`), omission state and modeling
gaps. Bounded node omissions are labelled on the question. An explicit abstention
can have no sources. The current access adapter supplies no question records;
an authorized knowledge-output binding is a separate receiving dependency.

## Requests, bounds and determinism

`readGraphView` and `exportGraphView` accept only `snapshot`, `questionId`,
`focusRef`, `relationFilter`, `direction` (`in`, `out`, `both`), `depth`, `limit`,
`cursor` and metadata `search`. Search covers title, summary and tags. Focused
queries traverse admitted directed edges, with optional native predicate filters.
Questions select their declared source refs. Incoming focus expansion supplies
source-impact navigation; edge supports supply the pointer path to evidence.

Depth is at most two. A page contains at most 500 nodes (default 100), 2,000 edges,
4,000 evidence pointers, 100 questions and 500 diagnostics, and canonical output
is at most 2 MiB. Hosts may lower node/depth limits. An individual record exceeding
the closed schema or an unrepresentable evidence closure refuses rather than
silently trimming provenance. File paths are portable relative paths. Queries
consume at most 20,000 input records in each table; the host owns source loading
budgets. Camera state, temporary clusters and visual coordinates are not graph data.

Ordering uses stable qualified refs and identifiers. Set-valued metadata is sorted.
The existing RFC 8785 serializer supplies canonical JSON. `projectionDigest` hashes
the entire payload with only that field excluded; exported bytes add one newline.
`snapshot` hashes the complete normalized authorized input, including access context,
source pins and producer version. Same inputs/request produce identical bytes.
Source or grant changes invalidate requested snapshots and cursors. Cursors are
opaque pagination recipes bound to that snapshot and query; they grant no authority.

`page.returned` counts emitted records. `page.omitted.nodes/edges` counts records
from the authorized matching query absent from this page; other omitted counters
refer to the authorized input universe. Counts include records on other pages and
never denied records. `nextCursor` pages nodes; cross-page edges are intentionally
omitted because both endpoints must be in the emitted slice. Use focused expansion
to inspect a particular relationship. `truncated` means any authorized records were
omitted; an exhausted node cursor alone does not imply all related data was emitted.

## Consumer intents and command adapter

The browser-safe `src/graph-view/intents.mjs` exports `assertGraphViewIntent`.
Every intent binds `projectionDigest`. `select` carries exactly one `ref` or
`edgeId`; `expand` carries `ref` and `direction`; `openEvidence` carries `evidenceId`;
`setQuestion` carries `questionId`. `compareSnapshots` carries two snapshot digests;
`proposeModelChange` carries a draft ref and requires the host-advertised capability.
Validation returns data only; it performs no action and confers no write rights.
Focus and selection remain consumer state. A stale-sensitive host operation must
revalidate current source/access even when an intent passed structural validation.

`runGraphViewCommand(argv,{reader,...io})` is a host-injected CLI adapter. `--request`
reads a closed query and `--out` writes an authorized export to a new file with
exclusive creation and private permissions; existing files are never overwritten.
Without a bound reader, export refuses. The local fixture validator runs as:

```sh
node src/graph-view/cli.mjs --validate fixtures/graph-view/synthetic-view.v1.json
```

Validation prints only a fixed success label; it cannot write or re-export the file.
`parseGraphView` verifies schema, digest and reference closure, and
`serializeGraphView` emits canonical bytes. These functions verify a transport
contract, not host grants, provenance authenticity, semantic acceptance or live ACLs.
