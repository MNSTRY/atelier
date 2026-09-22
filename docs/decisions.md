# Typed decision proposals

The optional `@mnstry/atelier/decisions` API validates finite questions and
their proposed answers. It performs no provider calls, credential lookup,
source mutation, or acceptance. A consuming host supplies the provider and
independently checks authorization before disclosure or use.

For a development pilot, pin the reviewed source commit or its verified
tarball. Check that the installed package exports `./decisions`; an older
published alpha may not contain this API. A source merge does not publish a
new registry version.

This API is suitable for a small, explicit choice, an ordered score, or a
Boolean probability. It does not extract missing evidence or generate prose.
The fixtures describe an invented reading room; their answers and usage are
synthetic examples, not model evaluation results.

```js
import {
  decisionRequestDigest,
  validateDecisionRequest,
  validateDecisionResult,
} from '@mnstry/atelier/decisions'

const requestCheck = validateDecisionRequest(request)
if (!requestCheck.ok) throw new Error('Invalid decision request')
const digest = decisionRequestDigest(request)

// The host obtains a result under its own provider and disclosure policy.
const resultCheck = validateDecisionResult(request, result)
if (!resultCheck.ok) throw new Error('Invalid decision result')
```

The adjacent TypeScript declarations export `DecisionRequest`,
`DecisionQuestion`, `DecisionResult`, `DecisionAnswer`, `DecisionScope`,
`DecisionUsage`, and `DecisionValidation`, including the individual question
and answer variants. Runtime validation remains required for external data.

For hosts that need only question and answer validation, use
`validateDecisionAnswers(questions, answers)`. It checks bounded plain JSON,
question structure, exact answer keys and types, probability distributions,
and score expectations. It accepts no state, computes no hash, performs no
provider execution, and writes nothing. The host supplies its own transient
request binding and enforces its privacy policy.

```js
import { validateDecisionAnswers } from '@mnstry/atelier/decisions'

const answerCheck = validateDecisionAnswers(questions, answers)
if (!answerCheck.ok) throw new Error('Invalid decision answers')
```

This separate API checks evidence reference syntax, uniqueness and bounds,
but cannot establish membership in a source snapshot that it has not received.
The request and result validators still enforce that membership. A successful
answer check establishes neither authorization nor semantic correctness.

## Requests

`atelier-decision-request@v1` records a request ID, task, rubric version,
host-reported scope, state, evidence references, and questions. The
`scope.workspaceId` and `scope.authorizationRef` fields bind the assessment to
the host's reported snapshot. They do not authenticate a caller, prove
consent, or grant access. The host must revalidate current permissions and
revocation before sending data or acting on a cached result.

Each question includes instructions and at least one `evidenceIds` entry
referring to the request's evidence. Evidence identities are unique; their
`sourceRef` strings are opaque references preserved for the host. Validation
does not fetch them or prove that the state faithfully represents a source.

| Question | Criteria | Answer |
| --- | --- | --- |
| `choice` | A map of 2–64 option IDs to descriptions | A selected option, complete probability map, and provider confidence statistic |
| `score` | An ordered list of 2–10 descriptions | A zero-index weighted expectation, complete probability list, and provider confidence statistic |
| `boolean` | Explicit `true` and `false` descriptions | A probability between zero and one |

Identifiers are 1–128 ASCII characters, beginning with a letter or digit and
continuing with letters, digits, `.`, `_`, `:`, or `-`. The names `__proto__`,
`constructor`, and `prototype` are refused as object keys and identifiers.
State and descriptions support Unicode; validation does not normalize text.

Requests are limited to 64 questions, 256 evidence entries, 32,000 state
characters, 4,000 instruction characters per question, 2,000 characters per
criterion, and 2,048 characters per source reference. String limits count
Unicode code points. Empty state is allowed so the host can record an
insufficient-evidence abstention; instructions and descriptions must contain
non-whitespace text.

## Results and integrity

`atelier-decision-result@v1` copies the request ID, task, rubric version and
scope, and carries `requestDigest`, provider ID, concrete model name,
elapsed milliseconds, and usage. Token counts are nonnegative safe integers;
`usage: null` records unavailable usage without treating it as zero.

`authority` is always `proposal-only`. `mode` is `shadow` or `advisory`;
neither value grants execution authority. An `assessed` result contains
exactly the requested answer keys and types. An `abstained` result contains
an empty answer map and one explicit reason: `insufficient-evidence`,
`ambiguous`, `no-match`, `budget-exhausted`, `provider-unavailable`, `timeout`,
`invalid-response`, or `unauthorized`.

The validator checks that distributions sum to one within `1e-6`, a chosen
option has maximum probability, and a score equals its zero-index weighted
expectation within `1e-6`. Tied maximum choices are valid. Boolean answers
have no confidence field. Confidence is a provider statistic, not measured
semantic correctness; a structurally valid high-confidence answer can still
be wrong. The host owns evaluation data, calibrated thresholds, escalation,
and fallback behavior. The host must also compare the recorded model with
its requested concrete model pin; the request contract does not prescribe a
provider or model.

`decisionRequestDigest` returns lowercase SHA-256 over canonical JSON with
object keys recursively sorted in JavaScript string order. Array order and
exact Unicode content are retained. It includes the full request, scope,
evidence, rubric, and optional extensions. Reordering object insertion does
not change the digest; changing any represented value does. This is local
integrity evidence, not a signature or proof of provenance. Invalid requests
throw a generic `TypeError`; validators return `{ ok, errors }` without
echoing source text, unknown field names, or provider response content.

Content hashes can themselves be sensitive. A host whose policy forbids
hashing a passage must use its own transient request binding instead of this
digest-bearing envelope. It can reuse the question and answer types without
calling `decisionRequestDigest` or retaining a full request. The public
contract does not override the host's privacy policy.

## Closed fields and extensions

The standalone JSON Schemas are
`atelier-decision-request.v1.schema.json` and
`atelier-decision-result.v1.schema.json`. They validate static shape. Use the
JavaScript validator as well for request binding, evidence relationships,
distribution semantics, and bounded in-process JSON.

As with other Atelier contracts, the roots allow optional
`contractVersion: "1.0.0"`, and closed objects allow an optional object-valued
`ext`. Unknown first-class fields are refused. Namespaced extension members
are inert metadata: consumers must ignore unrecognized members and must
never derive authority from them. Dynamic question, choice and answer maps
contain only their declared entries; they have no reserved metadata entry.

Both requests and results, including extensions, are limited to 16,777,216
canonical JSON bytes, 100,000 values, and 32 levels of nesting below the root.
Cycles, symbols, sparse arrays, accessors, non-finite numbers, undefined
values and custom prototypes are refused. Plain objects with a null
prototype are accepted. No input is mutated.

## Host integration

1. Build bounded questions from already authorized evidence. Preserve all
   source passages and coverage independently of a proposed prioritization.
2. Validate the request, then check the host's current consent, destination,
   concrete model pin, input limit, evaluation budget and timeout policy.
3. Call a provider through the host adapter. Keep credentials, private
   criteria, raw responses and provider execution outside the public kit.
4. Normalize and validate the result against the exact request. Retain full
   distributions and unknown usage; represent failures as explicit
   abstentions without accepting partial answer sets.
5. Compare shadow results with an independently labeled evaluation set.
   Enable an advisory consumer only after task-specific acceptance. Keep the
   host's existing behavior as the fallback and recheck authorization on
   cache access.

This module does not change the existing analysis adapter's default-disabled
execution policy or accept a model proposal as an authored fact.
