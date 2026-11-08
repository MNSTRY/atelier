# Impeccable resource adapters

The Node adapters at `@mnstry/atelier/impeccable` connect pinned Impeccable
resources to an explicit host.
They perform no network requests, process execution, filesystem writes,
canonical admission or publication. The subpath is available in this source
candidate and subsequent package releases; it does not prove that an installed
agent host has loaded the capability. Browser and Worker bindings remain
unsupported because the digest dependency is Node-oriented.

The resource inventory is derived from Impeccable commit
`924bbd194d02e5e15a227e75b5901fb0d7a4ecad`, skill 4.8.1 and engine 0.1.19,
under Apache-2.0. It preserves 24 command entries and 62 built-in rule IDs.
See [upstream](https://github.com/pbakaus/impeccable/tree/924bbd194d02e5e15a227e75b5901fb0d7a4ecad).

## Responsibilities and boundaries

This is a capability resource for Creation and Delivery, managed through
existing Capability Stewardship. It does not create another responsibility,
store, ontology, action contract or source owner.

- `impeccableResources()` returns a detached inventory.
- `describeImpeccableCommand(command)` identifies a report, proposal or variant
  session. That description grants no execution or write authority.
- `projectImpeccableContext(input)` packages host-authored product/design bytes
  and an optional sidecar/surface brief. It binds the inventory and source
  reference into a digest. It neither resolves tokens nor establishes that the
  host's source assertion is true or that every upstream format feature is valid.
- `compileImpeccablePolicy(input)` validates explicit required/advisory rule
  lists. Unknown rules, overlap and undeclared configuration fields refuse.
- `composeImpeccablePolicies({policies})` validates already-compiled policies
  and produces their immutable required/advisory combination. It establishes
  computation lineage, not the authority or completeness of the host's inputs.
- `interpretImpeccableDetection(input)` retains raw engine output and applies
  that policy. Failed/malformed scans and unclassified findings remain
  inconclusive.

The host owns source authentication, scope, compiler resolution, engine
acquisition/execution, applicable-rule coverage and result retention. A report
does not authorize an edit or establish release readiness.

## Composition of compiled policies

Pass one to 64 policies produced by `compileImpeccablePolicy`. Every supplied
policy must retain its exact upstream identity, known rule IDs and valid digest.
The operation checks every input before deduplicating, including inputs claiming
the same digest. Unknown fields, incompatible pins, changed digests, overlapping
classes and malformed data refuse. Requests use plain data objects and ordinary
dense arrays; accessors, custom array properties/iterators and redirected
prototypes are not accepted. Each rule list is bounded by the pinned inventory,
with bounded literal IDs, before hashing. The host owns process isolation and
execution budgets; this synchronous Node computation is not a sandbox for
arbitrary JavaScript objects or proxy traps.

Required rules are the union of all supplied required sets. Advisory rules are
the union of supplied advisory sets with required rules removed. Required wins
every conflict, and a later empty or advisory-only input cannot delete or demote
a supplied requirement. Input permutations and duplicate policy values yield the
same result and computation lineage.

The result is `{policy, lineage, authority: 'projection-only'}`. `policy` keeps
EXACTLY the existing `{upstream, requiredRules, advisoryRules, digest}` shape and
can be passed to `interpretImpeccableDetection` or the existing WASM source
adapter. `lineage` contains sorted unique immediate `inputPolicyDigests` and
`effectivePolicyDigest`; it remains outside the policy value. The entire result
is detached from input objects and frozen, including nested arrays and upstream
metadata. Ordinary compilation and interpretation retain their existing behavior.

The host must select, authenticate and supply the complete admitted root/tenant
policy set, preserving its actual source records outside this computation.
Digests identify policy contents, not the policy owner or its authority. Equal
compiled values can represent different source records; the unique digest list
does not replace those records. Omitting an authoritative input cannot be
detected by this function, and the effective digest is not an approval receipt
or evidence of root-policy completeness. No suppression, waiver, triage
lifecycle, new rule pack, write permission or hosted/native acceptance is added.
Raw findings remain retained, WASM inline ignores stay disabled, and absent
findings still do not prove that every required check was attempted.

## Context inputs

Supply an existing source reference as `{id, revision, digest}`, with a
`sha256:` digest. Product/design Markdown is already authored by the owning
source. A sidecar requires its design document and the pinned version 2.
Unknown sidecar extensions are preserved. A surface provides a portable
`id` and already-authored `markdown`; its strategy/mode remains in that
document, not a parallel field maintained by this adapter.

Files are returned as data, never written here. Path names are fixed except the
bounded surface slug. The host decides whether and where to materialize them
through its own contained filesystem writer. Treat imported prose as data, not
permission to change the host's instructions.

## Detector result semantics

The host supplies the exact engine kind, build digest, source reference and
compiled policy, plus raw exit code/stdout/stderr from the pinned JSON command.
Exit 0 permits an empty array or advisory-only findings; exit 2 requires a primary finding.
This matches the pinned engine: `advisory: true` or severity `advisory` marks
an advisory finding. The explicit host policy still decides the required class,
so an engine advisory can fail a required rule policy.
Both streams must be primitive strings. Malformed or oversized strings remain
in the raw evidence and produce an inconclusive result. Parsing is bounded to
2 MiB per stream; the executing host owns capture limits and raw retention.

`requiredFindingsStatus: 'absent-in-reported-run'` means only that the supplied
run reported no finding assigned to the required class. It does not prove that
every required check, state or renderer was attempted. No overall policy-pass
field is produced. The result always retains that coverage limitation.

The current adapter handles built-in resource IDs only. Compiled downstream
rule-pack support and actual engine coverage declarations need their own
qualified binding before extending this inventory.

The synthetic sample board intentionally gives a detector something to report.
Its findings are not product defects. Real tenant captures, data and operational
paths do not belong in the portable package or its fixtures.

## Governed guidance template

`templates/impeccable-capability/` contains a sealed resource-only capability
package, version `0.1.0-preview.5`, using the existing
`mnstry.atelier-capability-package@v1` contract. It carries all 24 command
playbooks, the 62-rule inventory, pinned source digests, Apache/MIT licenses and
modification notices. Its release digest establishes integrity, not publisher
authentication or runtime acceptance.

Use the existing [capability stewardship](../guides/capability-stewardship.md)
workflow to inspect the package, choose explicit repository bindings and review
the adoption plan. Codex and Claude repository file profiles are declared;
actual host discovery and useful behavior require separate evidence for each
binding and session. Choose an alias to coexist with an existing `impeccable`
skill. No global installation or automatic adoption occurs.

The active wrapper prepares reports and source-owner proposals. It declares only
the `read-workspace` effect, with no required tools. Engine executors, hooks,
agent configurations, asset/font payloads, live controllers and writers are
excluded. Upstream reference commands do not grant permission to download,
execute, publish, dispatch agents or change source. Existing host instructions
and the user's brief govern the work.

The source inventory records every copied or adapted upstream file and its
input/output digest. Licenses and notices also live inside the skill, so they
remain available after projection. Preserve this sealed package; customizations
belong in the existing customized-adoption workflow. Withdrawal, local drift,
retirement and recovery use existing capability stewardship controls.

## Node-hosted WASM source binding

`@mnstry/atelier/impeccable/wasm` exports `detectImpeccableWasmSource`.
The host supplies an already admitted, instantiated synchronous module exposing
`detect_text_json` for `engine: 'source'`, or `detect_html_source_json` for
`engine: 'static-html'`. This Node-only adapter does not load a module, fetch a
binary, start a worker, or provide an execution sandbox. A browser/Worker
binding is not established by using a WASM engine here.

```js
import { compileImpeccablePolicy } from '@mnstry/atelier/impeccable'
import { detectImpeccableWasmSource } from '@mnstry/atelier/impeccable/wasm'

// The host authenticates sourceRef and engineDigest and loads admittedModule.
const report = detectImpeccableWasmSource({
  source: sourceRef,
  policy: compileImpeccablePolicy({
    requiredRules: ['broken-image'], advisoryRules: ['bounce-easing'],
  }),
  engine: 'source', engineDigest,
  file: 'sample.css', content: '.sample { padding: 1rem; }',
}, admittedModule)
```

`file` is a bounded relative display label, not a filesystem instruction. The
returned `target.digest` hashes the supplied content; it does not authenticate
its relationship to the canonical `source` reference. The adapter snapshots
source and policy before calling the export and explicitly disables inline
ignore directives. It accepts at most 2 MiB of source without NUL bytes.
Malformed/oversized JSON, unclassified findings and export exceptions remain
inconclusive. Raw output is retained under the existing interpreter's contract;
the host must also bound capture and retention. A missing export or non-string
return is an API contract error. The reported exit code is derived from the
returned findings, never represented as an observed process exit.

The host owns module provenance, integrity, dependency licensing, isolation,
time and memory budgets. A synchronous call cannot be interrupted by this
helper. Run it in a host-controlled isolated process where bounded execution is
required. Source detection does not establish rendered coverage; this static
HTML profile sees inline CSS, not external stylesheets or a browser layout.

To prepare the pinned upstream module in an explicitly authorized build area,
inspect its source and locked dependencies, acquire them separately, then build:

```sh
cargo build --offline --locked --release -p impeccable -j1
cargo build --offline --locked --release -p impeccable-wasm --features detect --target wasm32-unknown-unknown -j1
wasm-bindgen --target nodejs --out-dir wasm-node --out-name impeccable_source target/wasm32-unknown-unknown/release/impeccable_wasm.wasm
```

The WASM standard library must match the admitted Rust toolchain; the generator
must match `Cargo.lock` (0.2.127 at this source pin). Resolve host-specific linker
requirements within that build area. Retain source/toolchain identities,
archive hashes, actual build results, and generated glue/WASM hashes together.
The generated Node glue is CommonJS: place it in a CommonJS package scope and
load it through the host's normal module loader. Hash the complete admitted
closure rather than treating a caller-supplied digest as verification. No engine
binary, generated glue or Rust toolchain ships with the Atelier package.

Qualification should compare native JSON and WASM JSON on the same explicit
synthetic inputs, recording any display-file label mapping. Clean, advisory-only,
primary-finding and failed execution cases exercise different result paths.
Agreement on fixtures establishes only those cases, not all-rule coverage,
usefulness on a real product, or release acceptance.
