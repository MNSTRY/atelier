# Vanilla semantic proposal processor

`src/ingestion/semantic.mjs` connects a host's extractor to Atelier's existing
ingestion evidence reader. It produces qualified entity and assertion proposals
and a fresh searchable proposal view. The host chooses and invokes its extractor;
this module has no provider selection, model call, subprocess, network client,
runtime dependency, durable write, or graph mutation. Graphify, LightRAG, and Jev
are optional host adapters and are not required for this processor.

This is an internal first-consumer module. Its `atelier.semantic-candidate/v0`,
`atelier.semantic-input/v0`, `atelier.semantic-proposals/v0`, and
`atelier.semantic-proposal-view/v0` formats are not registered public contracts.
There is no package subpath export or CLI command for them. Published v1 records
and their closed extension fields remain unchanged.

## Host flow

1. Establish the existing permission to read the **whole ingestion plan** and
   supply the current owner-adopted knowledge domain. `readScope: 'all-plan'` is
   a reader precondition, not a permission granted by this module.
2. Complete structural intake using the existing ingestion store. Select exact
   evidence references from its completed attempts.
3. Call `prepareSemanticInput({store, plan, domain, references,
   identityCandidates})`. It reads each selected span using `store.getEvidence`
   and pins the domain definition, source bytes, attempt, and locator.
4. Invoke the chosen extractor with that input in the host. Include the returned
   input digest in its candidate envelope. An extractor may be local,
   deterministic, or model-backed; its permissions, budgets, retries, and
   provider calls belong to the host.
5. Call `prepareSemanticProposals({store, input, candidates})`. It rereads the
   exact evidence, verifies the binding, and validates the candidate envelope.
6. Use `readSemanticProposals({store, input, proposals, query, limit})` for a
   fresh, literal search over assertions. It matches all whitespace-separated
   query terms against endpoint IDs and labels, the predicate, the assertion's
   own quotes, and its time expression. It excludes JSON field names, digests,
   domain scope boilerplate and endpoint evidence from other assertions. It
   verifies the same evidence and candidate binding before returning results.
7. Present the proposals to the existing knowledge evaluation and review owner.
   That owner separately decides identity, semantic acceptance, activation, and
   any permitted canonical projection. This module never performs those steps.

An edit to an original source makes the earlier attempt stale. Intake and extract
the changed source again, then create a new input and proposals. The module
processes one source per input, so hosts can keep independent extraction caches
and correction histories. It does not implement those caches or histories.
Serving a saved proposal object without the fresh read does not revalidate it.

## Input and candidate shape

`plan` has exactly `planId` and `planDigest`. Each selected reference has exactly
`sourceId`, `sourceDigest`, `attemptId`, and `locator: {kind, value}`. Locator kinds
are the existing `line`, `csv-cell`, and `json-pointer` formats. Source digests
are 64-character hexadecimal values; plan and input digests have a `sha256:`
prefix. Evidence receipts must be current, verified, unsynthesized, and pending
semantic acceptance, and must match every requested binding.

The domain is an existing v1 knowledge `domain` or `domain-revision` record.
Duplicate type or predicate IDs are refused. Identity candidates are optional
host-supplied `{id, label, type}` proposals with unique IDs and vocabulary types.
Their presence does not establish canonical identity or authenticate an owner.

A candidate envelope has exactly:

```js
{
  schema: SEMANTIC_CANDIDATE_VERSION,
  inputDigest: input.digest,
  entities: [{
    id: 'nora', label: 'Nora', type: 'person',
    identity: {status: 'source-local', candidateIds: []},
    evidence: ['span-1'],
  }],
  assertions: [{
    id: 'availability', subjectId: 'nora', predicate: 'available',
    objectId: null, direction: 'subject-only', negated: true,
    modality: 'asserted', scope: input.domain.data.scope,
    time: {from: null, until: null, expression: 'Friday', unknowns: ['calendar-date']},
    evidence: [{id: 'span-1', quote: 'Nora is not available on Friday.'}],
  }],
  unknowns: [],
}
```

The example assumes `span-1` is that exact located source passage and the domain
contains `person` and `available`. Candidate IDs use lowercase ASCII letters,
digits, and hyphens, begin with a letter, and are at most 64 characters. IDs are
unique across entities, assertions, and unknown findings. Labels never merge
entities: two objects named Atlas can have different types and identities.

Entity identity status is `source-local`, `existing-candidate`, or `unknown`.
Only `existing-candidate` includes nonempty `candidateIds`; each must be a
supplied candidate of the same type. Resolution remains pending even with one
matching candidate.

Binary assertions require two supplied entity IDs and `subject-to-object`.
Unary assertions require `objectId: null` and `subject-only`. The predicate must
belong to the domain vocabulary. Negation is a Boolean. Modality is `asserted`,
`conditional`, `proposed`, `possible`, `uncertain`, or `unknown`. Scope must equal
the supplied domain scope. Separate assertions between the same entities remain
separate, including statements with different polarity or time.

Time has exactly `from`, `until`, `expression`, and `unknowns`. Dates are nullable
valid `YYYY-MM-DD` calendar dates, with an ordered interval when both are given.
A temporal expression must occur in a cited quote. An unresolved expression such
as Friday or through June requires explicit unknowns when neither boundary is
resolved. Quote matching establishes location; it does not establish that a
date interpretation, predicate, polarity, or identity is semantically correct.

Unknown findings have exactly `{id, relatedCandidateId, reason, evidence}`.
The optional related ID refers to a supplied entity or assertion, or is null.
The nonempty reason and supporting span IDs remain visible. An unmodeled
predicate must be reported as a finding instead of an unsupported assertion.
An assertion without evidence is refused; the caller can separately report a
retrieval gap without presenting it as a supported assertion.

## Results and refusals

Proposals hydrate each support with the source ID, source digest, attempt ID,
locator, relative source ref, and exact quote. They retain the original candidate
envelope, pending identity and assertion acceptance, declared unknowns, input
digest, and domain ref. The read model reports total assertion matches and omitted
assertion matches when its limit truncates results. Entities and unknown findings
are returned without filtering, to retain interpretation context. The view carries
the pinned domain reference. It does not synthesize an answer.

Every proposal and view declares `authority: 'none'`, `canonicalMutation: false`,
`semanticAcceptance: 'pending'`, and `coverage: 'selected-spans-only'`.
Counts report proposed entities, assertions, and explicit unknown findings
(`abstentions`); successful validation reports zero refusals. A refused request
throws `SemanticProposalError` with `refusalCount: 1` and a typed code:

| Code | Boundary |
| --- | --- |
| `SEMANTIC_INVALID` | Closed, bounded plain JSON and valid query |
| `SEMANTIC_PROFILE` | Existing domain definition and unique vocabulary |
| `SEMANTIC_LIMIT` | Input, candidate, or result bounds |
| `SEMANTIC_READ_SCOPE` | Whole-plan reader profile |
| `SEMANTIC_EVIDENCE` | Available verified spans and literal quote support |
| `SEMANTIC_STALE` | Original source is no longer current |
| `SEMANTIC_BINDING` | Exact plan, source, attempt, locator, and input digest |
| `SEMANTIC_IDENTITY` | Unique IDs, supplied identity mappings, and endpoints |
| `SEMANTIC_TYPE` / `SEMANTIC_PREDICATE` | Declared vocabulary |
| `SEMANTIC_DIRECTION` / `SEMANTIC_NEGATION` | Participant roles and Boolean polarity |
| `SEMANTIC_MODALITY` / `SEMANTIC_SCOPE` | Declared qualification |
| `SEMANTIC_TIME` / `SEMANTIC_UNKNOWN` | Retained time and explicit findings |

The first failing rule refuses the entire request; there is no partial admission.
There are at most 64 references, identity candidates, entities, assertions, or
unknown findings per input, and at most 16 supporting spans per candidate.
The existing ingestion plain-JSON bounds apply, including the 256 KiB payload
limit, to caller inputs, assembled semantic inputs, hydrated proposals and read
views. Hydration can exceed this limit even when raw candidates fit: entity
supports include source span text and proposals retain raw candidates as well.
Count, text-length, depth, member and byte overflow reports `SEMANTIC_LIMIT`;
malformed JSON, invalid identifiers and invalid field shapes retain their typed
validation codes. Oversized input or output is refused instead of silently
truncated. This is a bounded evidence selection, not a complete-document
extraction guarantee.

## Qualification limits

The tests exercise invented candidates, individually targeted rule mutations,
direct receipt bindings, saved-proposal tampering, every declared collection
bound, text/query/result limits, assembled and hydrated byte overflow, search
exclusion and literal escaped characters, and the real local
ingestion evidence reader. They check fidelity and refusal mechanics, including
source correction. They do not qualify a semantic extractor, human review,
permissions of an installed host, or economic benefit.

This profile supports unary or binary entity-valued assertions and one domain
scope string. It does not yet represent literal-valued assertions, structured
per-assertion scope, attributed speakers, UTF-8 byte-range locators, or native
engine graph projection. A richer adapter needs an explicitly reviewed mapping
that retains those qualifications and reports projection omissions. A document
graph's `related` edge must not replace a qualified real-world assertion.

Graphify, LightRAG, and Jev integration must separately qualify their native
capabilities, provenance mapping, optional configuration, lifecycle, and composed
behavior. These tests make no quality, latency, token, or cost savings claim.
