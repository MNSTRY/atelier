# Learning from corrections and outcomes

The learning module records feedback in context, preserves proposals and human
decisions, and supplies explicitly activated lessons to a named harness. It is
an experimental local source capability. It requires consumer integration and
does not establish availability in a published package or installed desktop.

A person defines the task and scope, an agent can propose a lesson, and the
person reviews its wording and consequences. Evidence can be represented before
acceptance. Only accepted, activated content is eligible for task context.

## Records and authority

Four kinds of records describe the main path:

1. An **observation** preserves feedback or a tool outcome, its interpretation,
   provenance reference, project and activity. Source digests are assertions
   supplied by the caller; the store never follows a source reference. A null
   digest explicitly represents unavailable original-byte verification.
2. A **lesson proposal** names evidence observations, purpose, principle,
   exceptions and a complete proposed artifact. Artifacts can be instructions,
   skills, principles or descriptions of checks. Check artifacts are inert;
   this module does not turn prose into executable validators.
3. A **decision** accepts, rejects or defers one exact proposal digest. The
   digest binds its artifact, scope and cited observation digests. Editing any
   of them requires a new proposal and decision.
4. An **activation** binds that decision and artifact to one harness. It makes
   content eligible for subsequent context requests; it neither installs files
   nor grants permissions. Withdrawal is a new record, preserving history.

The local CLI accepts an explicit actor assertion. It does not authenticate
people. A network or multi-user host must resolve actors from its own trusted
session and enforce access, capture consent and action capabilities before
calling the library. A field that says `human` is not authentication.

Scope always names an exact project. An activity can be an explicitly reviewed
`*`; context requests always name a concrete activity. There is no global
workspace-to-workspace inheritance. Only a local human actor may decide,
activate or withdraw. Capture and proposal creation never confer those powers.

Two active artifacts with the same kind and name and different content are
withheld when their scopes overlap the requested activity. The context result
explains the conflict. This deterministic slot check does not establish that
differently named lessons are semantically compatible.

## CLI workflow

Run inside the intended Git workspace with `.atelier-local/` ignored and
untracked. The existing `atelier setup` command can prepare local state for an
adopted project. Every command reads a JSON object from stdin, up to 256 KiB,
and prints JSON. Keep request and export files private.

For `capture`, `propose`, `decide`, `activate` and `withdraw`, the envelope is:

```json
{
  "workspaceId": "sample-workspace",
  "actor": { "id": "local-owner", "kind": "human" },
  "requestId": "capture-one",
  "expectedRevision": 0,
  "input": {
    "id": "observation-one",
    "signal": "user-correction",
    "text": "Put shortages first in the inventory summary.",
    "interpretation": "explicit",
    "scope": { "project": "sample-project", "activity": "inventory-summary" },
    "source": { "ref": "manual-user-entry", "digest": null }
  }
}
```

Pass this to `atelier learn capture`. Use the returned revision for the next
write and a new request identifier. Retrying identical request bytes and actor
returns the original receipt. Reusing an identifier for changed content refuses.
A stale revision requires reloading and reviewing the current state.

The subsequent command inputs are:

| Command | Input |
| --- | --- |
| `propose` | `id`, `title`, `principle`, `rationale`, `exceptions`, `evidenceIds`, `scope`, `artifact: {kind, name, content}`; optional `supersedes` |
| `decide` | `lessonId`, returned `lessonDigest`, `verdict: accepted/rejected/deferred`, `reason` |
| `activate` | New activation `id`, `lessonId`, `lessonDigest`, returned `decisionId`, `harnessId` |
| `withdraw` | `activationId`, `reason` |

For a proposal, an example complete artifact is:

```json
{
  "kind": "instruction",
  "name": "inventory-summary",
  "content": "For inventory summaries, list shortages before storage locations."
}
```

An exception such as “A location audit can lead with storage locations” stays
beside the artifact in selected context. Skill artifacts contain the complete
reviewed text; rendering never asks a model to add unreviewed steps.

Read commands take `{"workspaceId":"sample-workspace"}`:

- `atelier learn list` returns current records and activation states.
- `atelier learn graph` returns a private graph with typed evidence, proposal,
  decision, activation and withdrawal nodes and their relationships.
- `atelier learn plan` groups pending evidence by exact scope and suggests a
  processing route. Counts are not independent corroboration or promotion rules.
- `atelier learn export` returns a digest-bound private history archive. There
  is no automatic send path, canonical graph enrollment or trusted import.

`render` and `context` also require a `query`. A render query is
`{"lessonId":"lesson-one","lessonDigest":"<digest returned by propose>"}`.
A context query is:

```json
{
  "workspaceId": "sample-workspace",
  "query": {
    "scope": { "project": "sample-project", "activity": "inventory-summary" },
    "harnessId": "sample-harness"
  }
}
```

Pass it to `atelier learn context` at each new task boundary. The response
includes applicable artifacts, source provenance and exceptions. Proposed,
rejected, deferred, withdrawn and superseded material is not active guidance.
The harness remains responsible for instruction hierarchy and actual tool
permission enforcement. Withdrawing a lesson affects future context selection;
it cannot erase content a running model already received.

An application outcome can be captured with `lessonId` to link subsequent
feedback back to the lesson. Revision uses a new proposal with `supersedes`.
The replacement must retain the exact scope and artifact slot. Acceptance alone
does not replace active content; activating the accepted replacement retires the
previous activation in that harness atomically. Changing an active lesson's
decision requires withdrawing its active bindings first.

## Persistence and recovery

Private state lives under `.atelier-local/learning`. Immutable events retain a
content digest, previous digest, request, actor assertion and resulting record.
Existing private-state helpers provide containment, no-follow regular-file
checks, exclusive writer ownership and non-overwriting durable publication.
Replay verifies the chain and transitions; projections are rebuilt from it.

There are explicit input, event-count and journal-byte ceilings. Unknown files,
missing events, broken chains and corrupt records refuse. Pending staging files
are not committed events. A lost reply after a durable write can be reconciled
by retrying exactly the same request. No automatic compaction or destructive
history repair occurs. Export before capacity maintenance; do not truncate
history to make an error disappear.

Admission reserves one event and the maximum valid event size for every active
binding that would remain after the write. Ordinary writes also preserve a
minimum maintenance margin. This can refuse a new activation before the journal
is full, ensuring every existing activation retains room for withdrawal.
Withdrawal consumes its own reservation while preserving the others. This is a
journal-capacity guarantee; filesystem failure or lost disk space can still
prevent a durable write.

Digests prove internal consistency against the retained bytes, not that an
authorized person authored them. An owner with filesystem write access can
replace local state. Multi-user trust and signed admission require independent
host authority. Retention or deletion of source material must also account for
private learning text and exports; a source reference is not a deletion policy.

## Optional assistance and compatibility

`@mnstry/atelier/learning/assistance` provides mechanical work planning, exact
bounded evidence batches and a proposal-only adapter driver. The host supplies
the selected adapter, its qualification evidence, authorization for the exact
payload and adapter version, and durable budget reservation and settlement.
The driver makes at most one adapter call for an admitted attempt. Unknown
completion is retained as unknown; there is no fallback or automatic retry.
Invalid responses still settle their returned attempt. Unknown usage remains
unknown. Cancellation, time limits, provider credentials and budget persistence
belong to the injected host. Tests qualify the adapter contract with synthetic
implementations; they do not qualify any real model.

Returned drafts still need ordinary `propose`, human decision and activation.
No expensive model pass is required for capture, integrity checks, grouping,
context selection, rendering, export or withdrawal. Stronger reasoning can be
reserved for exceptions and conflicting interpretations.

`@mnstry/atelier/learning/adapters` converts an existing skill-observation
receipt into a tool-attributed observation. The original feedback words remain
explicitly unavailable. A legacy lesson can become a fresh proposal with
caller-selected local evidence and scope; old acceptance and activation never
transfer. The existing `atelier feedback` support-report command and
proposal-only `atelier-claim@v1` contract keep their original meaning.

## Public foundation and hosts

The open-source package owns the portable records, validation, local store,
CLI, evidence graph, context selection, inert rendering and conformance cases.
Campaigns may stay in their own workspaces; selected references do not change
their writer ownership. Private evidence projections stay outside committed
canonical graphs unless an owner explicitly authors an appropriate source.

A desktop or other host owns integrated capture, authenticating its caller,
background jobs, provider access, budgets, review controls and actual harness
integration. Private feedback, preferences, methods and authored skills remain
in their owning workspace. A commercial host should consume these contracts
without making basic local learning or export depend on an account.

Run `node --test test/learning-*.test.mjs` on the supported Node version for
the local acceptance cases. They cover terminal capture through withdrawal
across process restarts, concurrent/stale writes, source and decision binding,
conflicts, supersession, retention of history, adapter budgets and refusal paths.
Installed desktop behavior and real-model quality require their own evidence.
